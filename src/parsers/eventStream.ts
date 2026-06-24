/**
 * AWS Event Stream "scraping" parser.
 *
 * Despite the name, Kiro's stream is NOT a binary eventstream-codec frame
 * format that needs `@aws-sdk/eventstream-codec`. The original `parsers.py`
 * simply decodes each chunk as UTF-8 (errors ignored) and substring-scans for
 * JSON event prefixes (`{"content":`, `{"name":`, …), using a brace matcher to
 * find each JSON object's end. This is a faithful 1:1 port of that approach.
 *
 * Divergence note: Python uses `bytes.decode('utf-8', errors='ignore')` (drops
 * bad bytes); we use a streaming `TextDecoder` (default `fatal:false`, inserts
 * U+FFFD). The brace/pattern logic is unaffected, and the streaming decoder is
 * actually more correct across multibyte chunk boundaries.
 */
import { generateToolCallId } from "../lib/utils";
import { logWarn } from "../lib/log";

/** A tool call collected by the parser (OpenAI function-call shape). */
export interface ParsedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  _truncationDetected?: boolean;
  _truncationInfo?: TruncationInfo;
}

export interface TruncationInfo {
  isTruncated: boolean;
  reason: string;
  sizeBytes: number;
}

/** Event emitted by {@link AwsEventStreamParser.feed}. */
export type ParsedEvent =
  | { type: "content"; data: string }
  | { type: "usage"; data: unknown }
  | { type: "context_usage"; data: number };

/**
 * Find the position of the closing brace matching the `{` at `startPos`,
 * accounting for quoted strings and escape sequences. Returns -1 if not found.
 */
export function findMatchingBrace(text: string, startPos: number): number {
  if (startPos >= text.length || text[startPos] !== "{") return -1;

  let braceCount = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startPos; i < text.length; i++) {
    const char = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === "\\" && inString) {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === "{") {
        braceCount++;
      } else if (char === "}") {
        braceCount--;
        if (braceCount === 0) return i;
      }
    }
  }
  return -1;
}

/**
 * Parse tool calls written inline as `[Called func_name with args: {...}]`.
 * Some models emit tool calls as text rather than structured events.
 */
export function parseBracketToolCalls(responseText: string): ParsedToolCall[] {
  if (!responseText || !responseText.includes("[Called")) return [];

  const toolCalls: ParsedToolCall[] = [];
  const pattern = /\[Called\s+(\w+)\s+with\s+args:\s*/gi;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(responseText)) !== null) {
    const funcName = match[1];
    const argsStart = match.index + match[0].length;

    const jsonStart = responseText.indexOf("{", argsStart);
    if (jsonStart === -1) continue;

    const jsonEnd = findMatchingBrace(responseText, jsonStart);
    if (jsonEnd === -1) continue;

    const jsonStr = responseText.slice(jsonStart, jsonEnd + 1);
    try {
      const args = JSON.parse(jsonStr);
      toolCalls.push({
        id: generateToolCallId(),
        type: "function",
        function: { name: funcName, arguments: JSON.stringify(args) },
      });
    } catch {
      // Malformed args — the bracket-style tool call is dropped (data loss).
      logWarn("toolcall.bracket.malformed", { tool: funcName });
    }
  }
  return toolCalls;
}

/**
 * Remove duplicate tool calls: first by id (keeping the one with richer
 * arguments), then by name+arguments. Mirrors `deduplicate_tool_calls`.
 */
export function deduplicateToolCalls(
  toolCalls: ParsedToolCall[],
): ParsedToolCall[] {
  const byId = new Map<string, ParsedToolCall>();
  for (const tc of toolCalls) {
    const id = tc.id || "";
    if (!id) continue;

    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, tc);
    } else {
      const existingArgs = existing.function?.arguments || "{}";
      const currentArgs = tc.function?.arguments || "{}";
      if (
        currentArgs !== "{}" &&
        (existingArgs === "{}" || currentArgs.length > existingArgs.length)
      ) {
        byId.set(id, tc);
      }
    }
  }

  const withId = Array.from(byId.values());
  const withoutId = toolCalls.filter((tc) => !tc.id);

  const seen = new Set<string>();
  const unique: ParsedToolCall[] = [];
  for (const tc of [...withId, ...withoutId]) {
    const func = tc.function || { name: "", arguments: "{}" };
    const key = `${func.name || ""}-${func.arguments || "{}"}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(tc);
    }
  }
  return unique;
}

/** Coerce an event's `input` field (string | object | empty) to a string. */
function inputToString(inputData: unknown): string {
  if (typeof inputData === "object" && inputData !== null) {
    return Object.keys(inputData).length > 0 ? JSON.stringify(inputData) : "";
  }
  return inputData ? String(inputData) : "";
}

const EVENT_PATTERNS: Array<[string, string]> = [
  ['{"content":', "content"],
  ['{"name":', "tool_start"],
  ['{"input":', "tool_input"],
  ['{"stop":', "tool_stop"],
  ['{"followupPrompt":', "followup"],
  ['{"usage":', "usage"],
  ['{"contextUsagePercentage":', "context_usage"],
];

/**
 * Streaming parser that scrapes JSON events out of the Kiro response. Feed it
 * decoded chunks; it returns content/usage/context_usage events immediately and
 * accumulates tool calls (retrieve via {@link getToolCalls}).
 */
export class AwsEventStreamParser {
  private buffer = "";
  private lastContent: string | null = null;
  private currentToolCall: ParsedToolCall | null = null;
  private toolCalls: ParsedToolCall[] = [];
  private readonly toolNameMap: Record<string, string>;
  private readonly decoder = new TextDecoder("utf-8");

  constructor(toolNameMap?: Record<string, string>) {
    this.toolNameMap = toolNameMap ?? {};
  }

  /** Feed a raw byte chunk; returns any complete content/usage events. */
  feed(chunk: Uint8Array): ParsedEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain();
  }

  /** Flush the decoder (end of stream) and drain any remaining events. */
  flush(): ParsedEvent[] {
    this.buffer += this.decoder.decode();
    return this.drain();
  }

  private drain(): ParsedEvent[] {
    const events: ParsedEvent[] = [];

    for (;;) {
      let earliestPos = -1;
      let earliestType: string | null = null;

      for (const [pattern, eventType] of EVENT_PATTERNS) {
        const pos = this.buffer.indexOf(pattern);
        if (pos !== -1 && (earliestPos === -1 || pos < earliestPos)) {
          earliestPos = pos;
          earliestType = eventType;
        }
      }

      if (earliestPos === -1) break;

      const jsonEnd = findMatchingBrace(this.buffer, earliestPos);
      if (jsonEnd === -1) break; // JSON incomplete — wait for more data.

      const jsonStr = this.buffer.slice(earliestPos, jsonEnd + 1);
      this.buffer = this.buffer.slice(jsonEnd + 1);

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(jsonStr);
      } catch {
        // A scraped event JSON didn't parse — the event is dropped. Log a
        // bounded preview (no full body) so the loss is visible.
        logWarn("event.malformed", {
          eventType: earliestType,
          preview: jsonStr.slice(0, 80),
        });
        continue;
      }

      const event = this.processEvent(data, earliestType as string);
      if (event) events.push(event);
    }

    return events;
  }

  private processEvent(
    data: Record<string, unknown>,
    eventType: string,
  ): ParsedEvent | null {
    switch (eventType) {
      case "content":
        return this.processContent(data);
      case "tool_start":
        this.processToolStart(data);
        return null;
      case "tool_input":
        this.processToolInput(data);
        return null;
      case "tool_stop":
        this.processToolStop(data);
        return null;
      case "usage":
        return { type: "usage", data: data["usage"] ?? 0 };
      case "context_usage":
        return {
          type: "context_usage",
          data: (data["contextUsagePercentage"] as number) ?? 0,
        };
      default:
        return null; // followup and unknown types are ignored
    }
  }

  private processContent(data: Record<string, unknown>): ParsedEvent | null {
    if (data["followupPrompt"]) return null;
    const content = (data["content"] as string) ?? "";
    if (content === this.lastContent) return null; // dedup repeats
    this.lastContent = content;
    return { type: "content", data: content };
  }

  private processToolStart(data: Record<string, unknown>): void {
    if (this.currentToolCall) this.finalizeToolCall();

    const rawName = (data["name"] as string) ?? "";
    const toolName = this.toolNameMap[rawName] ?? rawName;

    this.currentToolCall = {
      id: (data["toolUseId"] as string) || generateToolCallId(),
      type: "function",
      function: { name: toolName, arguments: inputToString(data["input"]) },
    };

    if (data["stop"]) this.finalizeToolCall();
  }

  private processToolInput(data: Record<string, unknown>): void {
    if (this.currentToolCall) {
      this.currentToolCall.function.arguments += inputToString(data["input"]);
    }
  }

  private processToolStop(data: Record<string, unknown>): void {
    if (this.currentToolCall && data["stop"]) this.finalizeToolCall();
  }

  private finalizeToolCall(): void {
    const tc = this.currentToolCall;
    if (!tc) return;

    const args = tc.function.arguments;
    if (args.trim()) {
      try {
        const parsed = JSON.parse(args);
        tc.function.arguments = JSON.stringify(parsed);
      } catch {
        const info = diagnoseJsonTruncation(args);
        if (info.isTruncated) {
          tc._truncationDetected = true;
          tc._truncationInfo = info;
        } else {
          // Not truncated but still unparseable: genuine data loss — the tool
          // call's arguments are discarded. Truncation is tracked separately
          // (recovery state), so only log the malformed case here.
          logWarn("toolcall.args.malformed", {
            tool: tc.function.name,
            reason: info.reason,
            argChars: args.length,
          });
        }
        tc.function.arguments = "{}";
      }
    } else {
      tc.function.arguments = "{}";
    }

    this.toolCalls.push(tc);
    this.currentToolCall = null;
  }

  /** Finalize any in-flight tool call and return the deduped list. */
  getToolCalls(): ParsedToolCall[] {
    if (this.currentToolCall) this.finalizeToolCall();
    return deduplicateToolCalls(this.toolCalls);
  }

  reset(): void {
    this.buffer = "";
    this.lastContent = null;
    this.currentToolCall = null;
    this.toolCalls = [];
  }
}

/**
 * Heuristically determine whether a malformed JSON string was truncated
 * (Kiro cutting off large tool arguments) vs genuinely malformed. Mirrors
 * `_diagnose_json_truncation`.
 */
export function diagnoseJsonTruncation(jsonStr: string): TruncationInfo {
  const sizeBytes = new TextEncoder().encode(jsonStr).length;
  const stripped = jsonStr.trim();

  if (!stripped) {
    return { isTruncated: false, reason: "empty string", sizeBytes };
  }

  const count = (s: string, ch: string) =>
    s.split(ch).length - 1;
  const openBraces = count(stripped, "{");
  const closeBraces = count(stripped, "}");
  const openBrackets = count(stripped, "[");
  const closeBrackets = count(stripped, "]");

  if (stripped.startsWith("{") && !stripped.endsWith("}")) {
    return {
      isTruncated: true,
      reason: `missing ${openBraces - closeBraces} closing brace(s)`,
      sizeBytes,
    };
  }
  if (stripped.startsWith("[") && !stripped.endsWith("]")) {
    return {
      isTruncated: true,
      reason: `missing ${openBrackets - closeBrackets} closing bracket(s)`,
      sizeBytes,
    };
  }
  if (openBraces !== closeBraces) {
    return {
      isTruncated: true,
      reason: `unbalanced braces (${openBraces} open, ${closeBraces} close)`,
      sizeBytes,
    };
  }
  if (openBrackets !== closeBrackets) {
    return {
      isTruncated: true,
      reason: `unbalanced brackets (${openBrackets} open, ${closeBrackets} close)`,
      sizeBytes,
    };
  }

  // Unclosed string literal: count unescaped quotes.
  let quoteCount = 0;
  let i = 0;
  while (i < stripped.length) {
    if (stripped[i] === "\\" && i + 1 < stripped.length) {
      i += 2;
      continue;
    }
    if (stripped[i] === '"') quoteCount++;
    i += 1;
  }
  if (quoteCount % 2 !== 0) {
    return { isTruncated: true, reason: "unclosed string literal", sizeBytes };
  }

  return { isTruncated: false, reason: "malformed JSON", sizeBytes };
}
