/**
 * Payload size guard for Kiro API requests.
 *
 * Kiro rejects payloads over ~615KB with a misleading "Improperly formed
 * request." (reason: null) error. This trims oldest history entries (in
 * user/assistant pairs) to fit under the limit. Ported from `payload_guards.py`.
 */

export interface PayloadTrimStats {
  originalBytes: number;
  finalBytes: number;
  originalEntries: number;
  finalEntries: number;
  trimmed: boolean;
  /** Message bodies shortened because dropping history alone did not fit. */
  truncatedSlots: number;
  /** Bytes reclaimed by shortening message bodies. */
  truncatedBytes: number;
}

/**
 * Thrown when a payload exceeds the size limit and auto-trim is disabled.
 * Mirrors the Python behavior of surfacing a clear error instead of forwarding
 * an oversize request that Kiro rejects with a misleading 400.
 */
export class PayloadTooLargeError extends Error {
  readonly actualBytes: number;
  readonly maxBytes: number;
  constructor(actualBytes: number, maxBytes: number) {
    super(
      `Request payload is ${actualBytes} bytes, exceeding the ${maxBytes}-byte limit. ` +
        `Reduce the conversation/context size, or enable AUTO_TRIM_PAYLOAD to trim ` +
        `oldest history automatically.`,
    );
    this.name = "PayloadTooLargeError";
    this.actualBytes = actualBytes;
    this.maxBytes = maxBytes;
  }
}

type Json = Record<string, any>;

/** Serialized byte size of the payload as compact UTF-8 JSON. */
export function checkPayloadSize(payload: Json): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}

/** Remove empty `toolUses: []` arrays in-place (Kiro quirk). */
function stripEmptyToolUses(history: Json[]): void {
  for (const entry of history) {
    const assistant = entry["assistantResponseMessage"];
    if (
      assistant &&
      "toolUses" in assistant &&
      Array.isArray(assistant["toolUses"]) &&
      assistant["toolUses"].length === 0
    ) {
      delete assistant["toolUses"];
    }
  }
}

/** Drop leading entries until history starts with a userInputMessage. */
function alignToUserMessage(history: Json[]): void {
  while (history.length > 0 && !("userInputMessage" in history[0])) {
    history.shift();
  }
}

/**
 * Remove toolResults that reference toolUseIds absent from the preceding
 * assistant turn, preserving orphaned text inline with a marker.
 */
function repairOrphanedToolResults(history: Json[]): void {
  for (let i = 0; i < history.length; i++) {
    const userMsg = history[i]["userInputMessage"];
    if (!userMsg) continue;

    const ctx = userMsg["userInputMessageContext"];
    if (!ctx || !("toolResults" in ctx)) continue;

    const validIds = new Set<string>();
    if (i > 0) {
      const prevAssistant = history[i - 1]["assistantResponseMessage"];
      if (prevAssistant) {
        for (const tu of prevAssistant["toolUses"] ?? []) {
          if (tu["toolUseId"]) validIds.add(tu["toolUseId"]);
        }
      }
    }

    const kept: Json[] = [];
    const orphanedText: string[] = [];
    for (const tr of ctx["toolResults"]) {
      if (validIds.has(tr["toolUseId"])) {
        kept.push(tr);
      } else {
        const content = tr["content"];
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part && typeof part === "object" && part["text"]) {
              orphanedText.push(part["text"]);
            }
          }
        } else if (typeof content === "string" && content) {
          orphanedText.push(content);
        }
      }
    }

    if (kept.length !== ctx["toolResults"].length) {
      if (kept.length > 0) {
        ctx["toolResults"] = kept;
      } else {
        delete ctx["toolResults"];
        if (Object.keys(ctx).length === 0) {
          delete userMsg["userInputMessageContext"];
        }
      }

      if (orphanedText.length > 0) {
        const marker = "\n[trimmed tool result] " + orphanedText.join("; ");
        userMsg["content"] = (userMsg["content"] ?? "") + marker;
      }
    }
  }
}

/**
 * Re-attach the system prompt to the first surviving user message after
 * trimming. The system prompt is prepended (by the converter) to the FIRST
 * history user message; trimming shifts oldest entries off the front, so the
 * message carrying the system prompt is exactly what gets discarded first.
 * Without this, auto-trim silently drops the system prompt — the model loses
 * its instructions with no trace. We re-prepend it to whatever user message is
 * now first (history, or the current message if history was fully trimmed).
 */
function reattachSystemPrompt(
  payload: Json,
  history: Json[],
  systemPrompt: string,
): void {
  const prefix = `${systemPrompt}\n\n`;
  // Prefer the first user message still in history.
  for (const entry of history) {
    const userMsg = entry["userInputMessage"];
    if (userMsg) {
      const content = typeof userMsg["content"] === "string" ? userMsg["content"] : "";
      if (!content.startsWith(systemPrompt)) {
        userMsg["content"] = prefix + content;
      }
      return;
    }
  }
  // History fully trimmed: fall back to the current message.
  const current = payload["conversationState"]?.["currentMessage"]?.["userInputMessage"];
  if (current) {
    const content = typeof current["content"] === "string" ? current["content"] : "";
    if (!content.startsWith(systemPrompt)) {
      current["content"] = prefix + content;
    }
  }
}

/** Bytes every truncated body keeps, split between its head and tail. */
const MIN_SLOT_KEEP = 4096;

/** Headroom per shortening step for JSON escape growth (see below). */
const ESCAPE_SLACK = 256;

/** Shrink attempts before giving up and letting the caller reject. */
const MAX_TRUNCATE_PASSES = 4;

/** Head/tail split of a truncated body. Head is favored: it carries the system
 *  prompt and, for a pasted blob, usually the user's actual instruction. */
const HEAD_SHARE = 0.6;

function byteLen(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Longest prefix of `text` that fits in `maxBytes`, never splitting a UTF-8
 * sequence. Continuation bytes match 10xxxxxx, so we back off until the cut
 * lands on a lead byte.
 */
function sliceHeadBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** Longest suffix of `text` that fits in `maxBytes`, on a UTF-8 boundary. */
function sliceTailBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - Math.max(0, maxBytes);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.subarray(start));
}

/**
 * Shorten `text` to roughly `targetBytes` by removing its middle, keeping the
 * head and tail. A system prompt prefix is preserved verbatim and only the
 * remainder is shortened — the prompt is instructions, not content, and losing
 * it silently is exactly the failure this guard exists to prevent.
 */
function truncateMiddle(
  text: string,
  targetBytes: number,
  systemPrompt?: string,
): string {
  const total = byteLen(text);
  if (total <= targetBytes) return text;

  let prefix = "";
  let body = text;
  if (systemPrompt && text.startsWith(systemPrompt)) {
    prefix = systemPrompt;
    body = text.slice(systemPrompt.length);
  }

  const bodyBudget = targetBytes - byteLen(prefix);
  // The system prompt alone already blows the budget; shortening the little
  // that remains would not save the request. Leave it for the caller to reject.
  if (bodyBudget <= 0) return text;

  const marker = `\n\n[... gateway truncated ${total - targetBytes} bytes to fit Kiro's payload limit ...]\n\n`;
  const keep = bodyBudget - byteLen(marker);
  if (keep <= 0) return prefix + marker;

  const headBudget = Math.ceil(keep * HEAD_SHARE);
  const head = sliceHeadBytes(body, headBudget);
  const tail = sliceTailBytes(body, keep - headBudget);
  return prefix + head + marker + tail;
}

interface TextSlot {
  read(): string;
  write(value: string): void;
}

/** Every shortenable text body in the payload: message contents and the text
 *  parts of tool results, across history and the current message. */
function collectTextSlots(payload: Json): TextSlot[] {
  const slots: TextSlot[] = [];

  const addMessageSlots = (msg: Json | undefined): void => {
    if (!msg) return;
    if (typeof msg["content"] === "string") {
      slots.push({
        read: () => msg["content"],
        write: (v) => { msg["content"] = v; },
      });
    }
    for (const tr of msg["userInputMessageContext"]?.["toolResults"] ?? []) {
      const content = tr["content"];
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part && typeof part === "object" && typeof part["text"] === "string") {
          slots.push({
            read: () => part["text"],
            write: (v) => { part["text"] = v; },
          });
        }
      }
    }
  };

  for (const entry of payload["conversationState"]?.["history"] ?? []) {
    addMessageSlots(entry["userInputMessage"]);
    addMessageSlots(entry["assistantResponseMessage"]);
  }
  addMessageSlots(payload["conversationState"]?.["currentMessage"]?.["userInputMessage"]);

  return slots;
}

/**
 * Last-resort guard: shorten oversized message bodies so the payload fits.
 *
 * History trimming cannot save a request whose bulk sits somewhere it may not
 * touch — the current message (which is never trimmed) or the two history
 * entries it always keeps. A single pasted log or query dump lands exactly
 * there, which is why an oversize request could fail even with auto-trim on.
 *
 * Biggest body first: by this point history is already down to its floor, so
 * the remaining bulk is concentrated in one or two bodies, and going largest
 * first shortens the fewest of them. Mutates `payload`.
 */
export function truncateOversizedBodies(
  payload: Json,
  maxBytes: number,
  systemPrompt?: string,
): { truncatedSlots: number; truncatedBytes: number } {
  let truncatedBytes = 0;
  const truncated = new Set<number>();

  // Truncation only rewrites strings in place, so slot identity stays stable.
  const slots = collectTextSlots(payload);

  // A body's raw UTF-8 length understates what it costs in the payload, which
  // is measured after JSON.stringify — every quote, newline and backslash
  // escapes to two bytes. Rather than model the escaping, each pass re-measures
  // the real payload and shrinks again until it fits.
  for (let pass = 0; pass < MAX_TRUNCATE_PASSES; pass++) {
    if (checkPayloadSize(payload) <= maxBytes) break;

    const ordered = slots
      .map((slot, index) => ({ slot, index, size: byteLen(slot.read()) }))
      .sort((a, b) => b.size - a.size);

    let progressed = false;
    for (const { slot, index, size } of ordered) {
      const current = checkPayloadSize(payload);
      if (current <= maxBytes) break;
      if (size <= MIN_SLOT_KEEP) continue;

      const target = Math.max(MIN_SLOT_KEEP, size - (current - maxBytes) - ESCAPE_SLACK);
      const before = slot.read();
      const after = truncateMiddle(before, target, systemPrompt);
      if (after === before) continue;

      slot.write(after);
      truncated.add(index);
      truncatedBytes += size - byteLen(after);
      progressed = true;
    }

    // Everything left is at its floor or is the system prompt; the caller
    // rejects rather than looping forever.
    if (!progressed) break;
  }

  return { truncatedSlots: truncated.size, truncatedBytes };
}

/**
 * Trim oldest history entries (in pairs) so the serialized payload fits under
 * `maxBytes`. Keeps at least 2 entries, aligns to a user boundary, and repairs
 * orphaned toolResults afterward. If dropping history is not enough, oversized
 * message bodies are shortened middle-out as a last resort. Mutates `payload`.
 *
 * When `systemPrompt` is provided, it is re-attached to the first surviving
 * user message after trimming — the system prompt rides on the first history
 * user message, which is the first thing trimmed, so it would otherwise be lost.
 */
export function trimPayloadToLimit(
  payload: Json,
  maxBytes: number,
  systemPrompt?: string,
): PayloadTrimStats {
  const originalBytes = checkPayloadSize(payload);
  const history: Json[] | undefined =
    payload["conversationState"]?.["history"];

  if (!history) {
    // No history to drop, but a single oversized message still needs saving.
    const { truncatedSlots, truncatedBytes } =
      originalBytes > maxBytes
        ? truncateOversizedBodies(payload, maxBytes, systemPrompt)
        : { truncatedSlots: 0, truncatedBytes: 0 };
    return {
      originalBytes,
      finalBytes: checkPayloadSize(payload),
      originalEntries: 0,
      finalEntries: 0,
      trimmed: false,
      truncatedSlots,
      truncatedBytes,
    };
  }

  const originalEntries = history.length;

  stripEmptyToolUses(history);

  while (history.length > 2 && checkPayloadSize(payload) > maxBytes) {
    history.shift();
    history.shift();
  }

  alignToUserMessage(history);
  repairOrphanedToolResults(history);

  // Re-attach the system prompt only if trimming actually removed entries (the
  // original system-prompt-bearing message may have been shifted off).
  if (systemPrompt && originalEntries !== history.length) {
    reattachSystemPrompt(payload, history, systemPrompt);
  }

  // Runs after re-attachment so the system prompt is in place and can be
  // protected from the shortening below.
  const { truncatedSlots, truncatedBytes } =
    checkPayloadSize(payload) > maxBytes
      ? truncateOversizedBodies(payload, maxBytes, systemPrompt)
      : { truncatedSlots: 0, truncatedBytes: 0 };

  return {
    originalBytes,
    finalBytes: checkPayloadSize(payload),
    originalEntries,
    finalEntries: history.length,
    trimmed: originalEntries !== history.length,
    truncatedSlots,
    truncatedBytes,
  };
}
