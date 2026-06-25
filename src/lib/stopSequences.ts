/**
 * Stop-sequence handling for streamed and collected output.
 *
 * The Kiro upstream has no native stop-sequence concept, so the gateway honors
 * OpenAI `stop` / Anthropic `stop_sequences` by post-filtering generated text:
 * when a stop sequence appears, output is truncated immediately before it and
 * generation is reported as stopped.
 *
 * Streaming is the hard case — a stop sequence can straddle chunk boundaries
 * ("...ST" then "OP..."). Emitting eagerly would leak the first half before the
 * match is known. {@link StopSequenceMatcher} therefore holds back the smallest
 * trailing slice that could still become a stop sequence and only releases text
 * that is provably safe.
 */

/** Normalize a raw `stop` value (string | string[] | null) into a clean list. */
export function normalizeStopSequences(
  stop: string | string[] | null | undefined,
): string[] {
  if (stop === null || stop === undefined) return [];
  const arr = typeof stop === "string" ? [stop] : stop;
  // Drop empties — an empty stop sequence would match at every position and is
  // meaningless (both OpenAI and Anthropic ignore it).
  return arr.filter((s) => typeof s === "string" && s.length > 0);
}

export interface StopPushResult {
  /** Text safe to emit downstream now (stop sequence excluded). */
  emit: string;
  /** True once a stop sequence has been matched; no more output should follow. */
  stopped: boolean;
  /** The stop sequence that matched, or null. */
  matched: string | null;
}

/**
 * Incremental stop-sequence detector with cross-chunk safety.
 *
 * Feed streamed text through {@link push}; emit only the returned `emit`. On a
 * full match, `stopped` is true, `matched` names the sequence, and all text from
 * the match onward (including the sequence itself) is discarded. When the stream
 * ends without a match, {@link flush} returns any held-back tail.
 */
export class StopSequenceMatcher {
  private readonly sequences: string[];
  private readonly maxLen: number;
  private buffer = "";
  private done = false;

  constructor(sequences: string[]) {
    this.sequences = sequences;
    this.maxLen = sequences.reduce((m, s) => Math.max(m, s.length), 0);
  }

  /** True if this matcher can never match (no sequences configured). */
  get inactive(): boolean {
    return this.sequences.length === 0;
  }

  /**
   * Longest suffix of `text` that is a proper prefix of some stop sequence.
   * That slice must be held back: it might complete into a stop sequence on the
   * next push. Bounded by the longest sequence length for efficiency.
   */
  private holdbackLength(text: string): number {
    const maxK = Math.min(text.length, this.maxLen - 1);
    for (let k = maxK; k > 0; k--) {
      const suffix = text.slice(text.length - k);
      for (const seq of this.sequences) {
        if (seq.length > k && seq.startsWith(suffix)) return k;
      }
    }
    return 0;
  }

  /** Earliest full-match position across all sequences, or -1. */
  private earliestMatch(text: string): { index: number; seq: string } | null {
    let best = -1;
    let bestSeq: string | null = null;
    for (const seq of this.sequences) {
      const idx = text.indexOf(seq);
      if (idx !== -1 && (best === -1 || idx < best)) {
        best = idx;
        bestSeq = seq;
      }
    }
    return bestSeq === null ? null : { index: best, seq: bestSeq };
  }

  push(text: string): StopPushResult {
    if (this.done) return { emit: "", stopped: true, matched: null };
    if (this.inactive) return { emit: text, stopped: false, matched: null };

    this.buffer += text;

    const match = this.earliestMatch(this.buffer);
    if (match) {
      const emit = this.buffer.slice(0, match.index);
      this.buffer = "";
      this.done = true;
      return { emit, stopped: true, matched: match.seq };
    }

    // No full match: release everything except the trailing maybe-prefix.
    const hold = this.holdbackLength(this.buffer);
    const emit = this.buffer.slice(0, this.buffer.length - hold);
    this.buffer = this.buffer.slice(this.buffer.length - hold);
    return { emit, stopped: false, matched: null };
  }

  /** Held-back tail to emit when the stream ends with no stop match. */
  flush(): string {
    if (this.done) return "";
    const out = this.buffer;
    this.buffer = "";
    return out;
  }
}

export interface StopApplyResult {
  /** Text up to (excluding) the first stop sequence. */
  text: string;
  /** True if a stop sequence was found. */
  stopped: boolean;
  /** The matched sequence, or null. */
  matched: string | null;
}

/**
 * One-shot stop application for fully-collected (non-streaming) text. Truncates
 * at the earliest stop sequence and reports which one matched.
 */
export function applyStopToText(
  text: string,
  sequences: string[],
): StopApplyResult {
  let best = -1;
  let bestSeq: string | null = null;
  for (const seq of sequences) {
    const idx = text.indexOf(seq);
    if (idx !== -1 && (best === -1 || idx < best)) {
      best = idx;
      bestSeq = seq;
    }
  }
  if (bestSeq === null) return { text, stopped: false, matched: null };
  return { text: text.slice(0, best), stopped: true, matched: bestSeq };
}
