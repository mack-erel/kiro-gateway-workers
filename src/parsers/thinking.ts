/**
 * Thinking-block parser FSM for streaming responses.
 *
 * Faithful port of `kiro/thinking_parser.py`. Detects a thinking tag
 * (<thinking>, <think>, …) ONLY at the start of the response and reliably
 * handles tags split across network chunks via "cautious" buffering. Once the
 * block closes, everything after is treated as regular content.
 */
import {
  FAKE_REASONING_OPEN_TAGS,
  type FakeReasoningHandling,
} from "../config";

export const enum ParserState {
  PRE_CONTENT = 0,
  IN_THINKING = 1,
  STREAMING = 2,
}

/** Result of feeding a content chunk through the parser. */
export interface ThinkingParseResult {
  thinkingContent: string | null;
  regularContent: string | null;
  isFirstThinkingChunk: boolean;
  isLastThinkingChunk: boolean;
  stateChanged: boolean;
}

function emptyResult(): ThinkingParseResult {
  return {
    thinkingContent: null,
    regularContent: null,
    isFirstThinkingChunk: false,
    isLastThinkingChunk: false,
    stateChanged: false,
  };
}

export interface ThinkingParserOptions {
  handlingMode?: FakeReasoningHandling;
  openTags?: readonly string[];
  initialBufferSize?: number;
}

export class ThinkingParser {
  private readonly handlingMode: FakeReasoningHandling;
  private readonly openTags: readonly string[];
  private readonly initialBufferSize: number;
  private readonly maxTagLength: number;

  private state: ParserState = ParserState.PRE_CONTENT;
  private initialBuffer = "";
  private thinkingBuffer = "";
  private openTag: string | null = null;
  private closeTag: string | null = null;
  private isFirstThinkingChunk = true;
  private thinkingBlockFound = false;

  constructor(opts: ThinkingParserOptions = {}) {
    this.handlingMode = opts.handlingMode ?? "as_reasoning_content";
    this.openTags = opts.openTags ?? FAKE_REASONING_OPEN_TAGS;
    this.initialBufferSize = opts.initialBufferSize ?? 20;
    // Buffer enough trailing chars to never split a closing tag mid-chunk.
    this.maxTagLength =
      Math.max(...this.openTags.map((t) => t.length)) * 2;
  }

  /** Process a chunk of streamed content. */
  feed(content: string): ThinkingParseResult {
    let result = emptyResult();
    if (!content) return result;

    if (this.state === ParserState.PRE_CONTENT) {
      result = this.handlePreContent(content);
    }

    if (this.state === ParserState.IN_THINKING && result.stateChanged) {
      // Content after the opening tag was already routed in handlePreContent.
    } else if (this.state === ParserState.IN_THINKING && !result.stateChanged) {
      result = this.handleInThinking(content);
    }

    if (this.state === ParserState.STREAMING && !result.stateChanged) {
      result.regularContent = content;
    }

    return result;
  }

  private handlePreContent(content: string): ThinkingParseResult {
    const result = emptyResult();
    this.initialBuffer += content;

    const stripped = this.initialBuffer.replace(/^\s+/, "");

    // Opening tag found at the start?
    for (const tag of this.openTags) {
      if (stripped.startsWith(tag)) {
        this.state = ParserState.IN_THINKING;
        this.openTag = tag;
        this.closeTag = `</${tag.slice(1)}`; // <thinking> -> </thinking>
        this.thinkingBlockFound = true;
        result.stateChanged = true;

        this.thinkingBuffer = stripped.slice(tag.length);
        this.initialBuffer = "";

        const tr = this.processThinkingBuffer();
        if (tr.thinkingContent) {
          result.thinkingContent = tr.thinkingContent;
          result.isFirstThinkingChunk = tr.isFirstThinkingChunk;
        }
        if (tr.isLastThinkingChunk) result.isLastThinkingChunk = true;
        if (tr.regularContent) result.regularContent = tr.regularContent;

        return result;
      }
    }

    // Still possibly receiving a tag (buffer is a strict prefix of some tag)?
    for (const tag of this.openTags) {
      if (tag.startsWith(stripped) && stripped.length < tag.length) {
        return result; // keep buffering
      }
    }

    // No tag, and buffer is too long or can't be a tag prefix → STREAMING.
    if (
      this.initialBuffer.length > this.initialBufferSize ||
      !this.couldBeTagPrefix(stripped)
    ) {
      this.state = ParserState.STREAMING;
      result.stateChanged = true;
      result.regularContent = this.initialBuffer;
      this.initialBuffer = "";
    }

    return result;
  }

  private couldBeTagPrefix(text: string): boolean {
    if (!text) return true;
    return this.openTags.some((tag) => tag.startsWith(text));
  }

  private handleInThinking(content: string): ThinkingParseResult {
    this.thinkingBuffer += content;
    return this.processThinkingBuffer();
  }

  private processThinkingBuffer(): ThinkingParseResult {
    const result = emptyResult();
    if (!this.closeTag) return result;

    const idx = this.thinkingBuffer.indexOf(this.closeTag);
    if (idx !== -1) {
      const thinkingContent = this.thinkingBuffer.slice(0, idx);
      const afterTag = this.thinkingBuffer.slice(idx + this.closeTag.length);

      if (thinkingContent) {
        result.thinkingContent = thinkingContent;
        result.isFirstThinkingChunk = this.isFirstThinkingChunk;
        this.isFirstThinkingChunk = false;
      }
      result.isLastThinkingChunk = true;

      this.state = ParserState.STREAMING;
      result.stateChanged = true;
      this.thinkingBuffer = "";

      if (afterTag) {
        const strippedAfter = afterTag.replace(/^\s+/, "");
        if (strippedAfter) result.regularContent = strippedAfter;
      }
      return result;
    }

    // No closing tag yet — cautious send, retaining a tag-length tail.
    if (this.thinkingBuffer.length > this.maxTagLength) {
      const sendPart = this.thinkingBuffer.slice(0, -this.maxTagLength);
      this.thinkingBuffer = this.thinkingBuffer.slice(-this.maxTagLength);

      result.thinkingContent = sendPart;
      result.isFirstThinkingChunk = this.isFirstThinkingChunk;
      this.isFirstThinkingChunk = false;
    }

    return result;
  }

  /** Flush remaining buffered content at end of stream. */
  finalize(): ThinkingParseResult {
    const result = emptyResult();

    if (this.thinkingBuffer) {
      if (this.state === ParserState.IN_THINKING) {
        result.thinkingContent = this.thinkingBuffer;
        result.isFirstThinkingChunk = this.isFirstThinkingChunk;
        result.isLastThinkingChunk = true;
      } else {
        result.regularContent = this.thinkingBuffer;
      }
      this.thinkingBuffer = "";
    }

    if (this.initialBuffer) {
      result.regularContent =
        (result.regularContent ?? "") + this.initialBuffer;
      this.initialBuffer = "";
    }

    return result;
  }

  reset(): void {
    this.state = ParserState.PRE_CONTENT;
    this.initialBuffer = "";
    this.thinkingBuffer = "";
    this.openTag = null;
    this.closeTag = null;
    this.isFirstThinkingChunk = true;
    this.thinkingBlockFound = false;
  }

  get foundThinkingBlock(): boolean {
    return this.thinkingBlockFound;
  }

  /** Transform thinking content according to the handling mode. */
  processForOutput(
    thinkingContent: string | null,
    isFirst: boolean,
    isLast: boolean,
  ): string | null {
    if (!thinkingContent) return null;
    if (this.handlingMode === "remove") return null;

    if (this.handlingMode === "pass") {
      const prefix = isFirst && this.openTag ? this.openTag : "";
      const suffix = isLast && this.closeTag ? this.closeTag : "";
      return `${prefix}${thinkingContent}${suffix}`;
    }

    // "strip_tags" and "as_reasoning_content" both return the raw content.
    return thinkingContent;
  }
}
