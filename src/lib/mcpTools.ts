/**
 * MCP tools support: web_search via the Kiro MCP API. Port of `mcp_tools.py`.
 *
 * Path A (native): handle a client's server-side web_search tool by calling the
 * MCP API directly and emulating the SSE response — bypassing
 * generateAssistantResponse. Path B (streaming interception) lives in the
 * streaming adapters, which call callKiroMcpApi + generateSearchSummary.
 *
 * Workers adaptations: global fetch instead of httpx, crypto-based random IDs.
 */
import type { KiroAuthContext } from "../types";
import { getKiroHeaders, generateCompletionId } from "./utils";
import { countTokens, countMessageTokens } from "./tokenizer";

const ALPHANUM =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Random alphanumeric string of the given length (crypto-backed). */
export function generateRandomId(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHANUM[bytes[i] % ALPHANUM.length];
  return out;
}

/** uuid4 hex (no dashes), sliced to `len`. */
function uuidHexSlice(len: number): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, len);
}

export interface McpSearchResult {
  toolUseId: string | null;
  results: Record<string, any> | null;
}

/**
 * Call the Kiro MCP API for web_search.
 * POST {qHost}/mcp (JSON-RPC 2.0 tools/call). Returns {toolUseId, results} or
 * nulls on error. NOTE: `result.content[0].text` is a JSON *string* — reparse.
 */
export async function callKiroMcpApi(
  query: string,
  auth: KiroAuthContext,
): Promise<McpSearchResult> {
  const random22 = generateRandomId(22);
  const timestamp = Date.now();
  const random8 = generateRandomId(8);
  const requestId = `web_search_tooluse_${random22}_${timestamp}_${random8}`;
  const toolUseId = `srvtoolu_${uuidHexSlice(32)}`;

  const mcpRequest = {
    id: requestId,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: "web_search", arguments: { query } },
  };

  try {
    // Passthrough: the bearer token is the client's ksk_ key.
    const baseHeaders = getKiroHeaders(auth, auth.token);
    const headers: Record<string, string> = {
      Authorization: baseHeaders["Authorization"],
      "x-amzn-codewhisperer-optout": "false",
      "Content-Type": "application/json",
    };
    if (baseHeaders["tokentype"]) headers["tokentype"] = baseHeaders["tokentype"];

    const mcpUrl = `${auth.qHost}/mcp`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    let response: Response;
    try {
      response = await fetch(mcpUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(mcpRequest),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status !== 200) {
      console.error(`MCP API error: ${response.status}`);
      return { toolUseId: null, results: null };
    }

    const mcpResponse = (await response.json()) as Record<string, any>;
    if (mcpResponse["error"] != null) {
      console.error("MCP API returned error");
      return { toolUseId: null, results: null };
    }

    const resultText =
      mcpResponse["result"]?.["content"]?.[0]?.["text"] ?? "{}";
    const results = JSON.parse(resultText); // content text is a JSON string
    return { toolUseId, results };
  } catch (e) {
    console.error("MCP API call failed", e);
    return { toolUseId: null, results: null };
  }
}

/** Two-digit pad. */
const p2 = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Format a ms timestamp as "13 Mar 2025 14:23:45" (UTC). */
function formatPublishedDate(ms: number): string | null {
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  return `${p2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}

/**
 * Build a human-readable search summary wrapped in <web_search> tags, with full
 * (untruncated) snippets. Mirrors `generate_search_summary`.
 */
export function generateSearchSummary(
  query: string,
  results: Record<string, any>,
): string {
  let summary = `\n<web_search>\nSearch results for "${query}":\n\n`;

  if (results && Array.isArray(results["results"])) {
    let i = 1;
    for (const r of results["results"]) {
      const title = r["title"] ?? "Untitled";
      const url = r["url"] ?? "";
      const snippet = r["snippet"] ?? "";
      const publishedMs = r["publishedDate"];

      summary += `${i}. Title: **${title}**\n`;
      if (publishedMs) {
        const dateStr = formatPublishedDate(publishedMs);
        if (dateStr) summary += `   Published: ${dateStr}\n`;
      }
      if (url) summary += `   URL: ${url}\n`;
      if (snippet) summary += `   ${snippet}\n`;
      summary += "\n";
      i++;
    }
  } else {
    summary += "No results found.\n";
  }

  summary += "</web_search>\n";
  return summary;
}

/** Format an Anthropic SSE event line. */
function formatSseEvent(eventType: string, data: Record<string, any>): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Build the web_search_result content blocks from MCP results. */
function buildSearchContent(results: Record<string, any>): Record<string, any>[] {
  return (results["results"] ?? []).map((r: Record<string, any>) => ({
    type: "web_search_result",
    title: r["title"] ?? "",
    url: r["url"] ?? "",
    encrypted_content: r["snippet"] ?? "",
    page_age: null,
  }));
}

/** Emulate the Anthropic SSE stream for a web_search result (11+ events). */
export function* generateAnthropicWebSearchSse(
  model: string,
  query: string,
  toolUseId: string,
  results: Record<string, any>,
  inputTokens: number,
): Generator<string, void, unknown> {
  const messageId = `msg_${uuidHexSlice(24)}`;
  const summary = generateSearchSummary(query, results);
  const outputTokens = countTokens(summary, false);

  yield formatSseEvent("message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });

  yield formatSseEvent("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { id: toolUseId, type: "server_tool_use", name: "web_search", input: {} },
  });
  yield formatSseEvent("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: JSON.stringify({ query }) },
  });
  yield formatSseEvent("content_block_stop", { type: "content_block_stop", index: 0 });

  yield formatSseEvent("content_block_start", {
    type: "content_block_start",
    index: 1,
    content_block: {
      type: "web_search_tool_result",
      tool_use_id: toolUseId,
      content: buildSearchContent(results),
    },
  });
  yield formatSseEvent("content_block_stop", { type: "content_block_stop", index: 1 });

  yield formatSseEvent("content_block_start", {
    type: "content_block_start",
    index: 2,
    content_block: { type: "text", text: "" },
  });
  for (let i = 0; i < summary.length; i += 100) {
    yield formatSseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 2,
      delta: { type: "text_delta", text: summary.slice(i, i + 100) },
    });
  }
  yield formatSseEvent("content_block_stop", { type: "content_block_stop", index: 2 });

  yield formatSseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  yield formatSseEvent("message_stop", { type: "message_stop" });
}

/** Emulate the OpenAI SSE stream for a web_search result. */
export function* generateOpenAiWebSearchSse(
  model: string,
  query: string,
  _toolUseId: string,
  results: Record<string, any>,
  inputTokens: number,
): Generator<string, void, unknown> {
  const completionId = generateCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const summary = generateSearchSummary(query, results);
  const outputTokens = countTokens(summary, false);

  const chunk = (delta: Record<string, any>, finishReason: string | null, usage?: Record<string, any>) => {
    const c: Record<string, any> = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage) c["usage"] = usage;
    return `data: ${JSON.stringify(c)}\n\n`;
  };

  yield chunk({ role: "assistant" }, null);
  for (let i = 0; i < summary.length; i += 100) {
    yield chunk({ content: summary.slice(i, i + 100) }, null);
  }
  yield chunk({}, "stop", {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  });
  yield "data: [DONE]\n\n";
}

/** Extract a search query from the first user message (single-turn). */
export function extractQueryFromMessages(messages: any[]): string | null {
  if (!messages || messages.length === 0) return null;
  const first = messages[0];
  const content = first?.content;
  if (content == null) return null;

  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && block.type === "text") {
        parts.push(block.text ?? "");
      }
    }
    text = parts.join("");
  } else {
    return null;
  }

  const prefix = "Perform a web search for the query: ";
  const query = text.startsWith(prefix) ? text.slice(prefix.length) : text;
  return query.trim() || null;
}

/** Re-export for callers building input-token counts for web_search. */
export { countMessageTokens };
