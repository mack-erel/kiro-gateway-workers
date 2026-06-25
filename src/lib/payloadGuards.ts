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

/**
 * Trim oldest history entries (in pairs) so the serialized payload fits under
 * `maxBytes`. Keeps at least 2 entries, aligns to a user boundary, and repairs
 * orphaned toolResults afterward. Mutates `payload`.
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
    return {
      originalBytes,
      finalBytes: originalBytes,
      originalEntries: 0,
      finalEntries: 0,
      trimmed: false,
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

  return {
    originalBytes,
    finalBytes: checkPayloadSize(payload),
    originalEntries,
    finalEntries: history.length,
    trimmed: originalEntries !== history.length,
  };
}
