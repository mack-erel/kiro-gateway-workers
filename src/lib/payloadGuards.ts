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
 * Trim oldest history entries (in pairs) so the serialized payload fits under
 * `maxBytes`. Keeps at least 2 entries, aligns to a user boundary, and repairs
 * orphaned toolResults afterward. Mutates `payload`.
 */
export function trimPayloadToLimit(
  payload: Json,
  maxBytes: number,
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

  return {
    originalBytes,
    finalBytes: checkPayloadSize(payload),
    originalEntries,
    finalEntries: history.length,
    trimmed: originalEntries !== history.length,
  };
}
