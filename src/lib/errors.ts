/**
 * Error classification and user-friendly messaging.
 * Ports `network_errors.py` (transport failures) and `kiro_errors.py`
 * (upstream Kiro error enhancement).
 *
 * Workers note: global fetch throws TypeError / DOMException("AbortError"|
 * "TimeoutError") rather than httpx exception types, so network classification
 * is message/name-based here.
 */

// ============================================================================
// Network errors (transport-level)
// ============================================================================

export type ErrorCategory =
  | "dns_resolution"
  | "connection_refused"
  | "connection_reset"
  | "network_unreachable"
  | "timeout_connect"
  | "timeout_read"
  | "ssl_error"
  | "proxy_error"
  | "too_many_redirects"
  | "unknown";

export interface NetworkErrorInfo {
  category: ErrorCategory;
  userMessage: string;
  troubleshootingSteps: string[];
  technicalDetails: string;
  isRetryable: boolean;
  suggestedHttpCode: number;
}

/** Classify a thrown fetch/transport error into structured info. */
export function classifyNetworkError(error: unknown): NetworkErrorInfo {
  const name = error instanceof Error ? error.name : "Error";
  const msg = error instanceof Error ? error.message : String(error);
  const technicalDetails = `${name}: ${msg}`;
  const lower = msg.toLowerCase();

  // Aborts/timeouts (AbortController, first-token timeout).
  if (name === "TimeoutError" || name === "AbortError" || lower.includes("timed out")) {
    return {
      category: "timeout_read",
      userMessage: "Request timeout - the server stopped responding.",
      troubleshootingSteps: [
        "The server may be processing a complex request",
        "Check your connection stability",
        "Try again in a few moments",
      ],
      technicalDetails,
      isRetryable: true,
      suggestedHttpCode: 504,
    };
  }

  // SSL/TLS — not retryable.
  if (lower.includes("ssl") || lower.includes("tls") || lower.includes("certificate")) {
    return {
      category: "ssl_error",
      userMessage: "SSL/TLS error - secure connection could not be established.",
      troubleshootingSteps: [
        "Check system date and time",
        "Verify the server's SSL certificate is valid",
      ],
      technicalDetails,
      isRetryable: false,
      suggestedHttpCode: 502,
    };
  }

  if (lower.includes("dns") || lower.includes("getaddrinfo") || lower.includes("name not resolved")) {
    return {
      category: "dns_resolution",
      userMessage: "DNS resolution failed - cannot resolve the provider's domain name.",
      troubleshootingSteps: [
        "Check your internet connection",
        "Verify the domain name is correct and the service is operational",
      ],
      technicalDetails,
      isRetryable: true,
      suggestedHttpCode: 502,
    };
  }

  if (lower.includes("refused") || lower.includes("econnrefused")) {
    return {
      category: "connection_refused",
      userMessage: "Connection refused - the server is not accepting connections.",
      troubleshootingSteps: ["The service may be temporarily down", "Try again in a few moments"],
      technicalDetails,
      isRetryable: true,
      suggestedHttpCode: 502,
    };
  }

  if (lower.includes("reset") || lower.includes("econnreset")) {
    return {
      category: "connection_reset",
      userMessage: "Connection reset - the server closed the connection unexpectedly.",
      troubleshootingSteps: ["This is usually a temporary server issue", "Try again in a few moments"],
      technicalDetails,
      isRetryable: true,
      suggestedHttpCode: 502,
    };
  }

  // Generic transport error (catch-all) — retryable.
  return {
    category: "unknown",
    userMessage: "Network request failed due to an unexpected error.",
    troubleshootingSteps: [
      "Check your internet connection",
      "Try again in a few moments",
    ],
    technicalDetails,
    isRetryable: true,
    suggestedHttpCode: 502,
  };
}

/** Format a NetworkErrorInfo for an OpenAI or Anthropic error response body. */
export function formatErrorForUser(
  info: NetworkErrorInfo,
  formatType: "openai" | "anthropic" = "openai",
  includeTroubleshooting = true,
): Record<string, any> {
  let message = info.userMessage;
  if (includeTroubleshooting && info.troubleshootingSteps.length) {
    message += "\n\nTroubleshooting steps:\n";
    info.troubleshootingSteps.forEach((step, i) => {
      message += `${i + 1}. ${step}\n`;
    });
  }
  message = message.trim();

  if (formatType === "anthropic") {
    return { type: "error", error: { type: "connectivity_error", message } };
  }
  return { error: { message, type: "connectivity_error", code: info.category, param: null } };
}

// ============================================================================
// Kiro upstream error enhancement
// ============================================================================

export interface KiroErrorInfo {
  reason: string;
  userMessage: string;
  originalMessage: string;
}

/** Map a raw Kiro error JSON to a user-friendly message. */
export function enhanceKiroError(errorJson: Record<string, any>): KiroErrorInfo {
  const originalMessage = errorJson["message"] ?? "Unknown error";
  const reason = errorJson["reason"] ?? "UNKNOWN";

  let userMessage: string;
  if (reason === "CONTENT_LENGTH_EXCEEDS_THRESHOLD") {
    userMessage = "Model context limit reached. Conversation size exceeds model capacity.";
  } else if (reason === "MONTHLY_REQUEST_COUNT") {
    userMessage = "Monthly request limit exceeded. Account has reached its monthly quota.";
  } else if (reason === "INVALID_MODEL_ID") {
    userMessage = "Invalid model ID or insufficient subscription level to use it.";
  } else if (
    originalMessage === "Improperly formed request." &&
    (reason === "UNKNOWN" || reason === "null")
  ) {
    userMessage =
      "Kiro API rejected the request. If problem persists, open issue with info and attached debug logs at:" +
      "https://github.com/jwadow/kiro-gateway/issues";
  } else if ("reason" in errorJson && reason !== "UNKNOWN") {
    userMessage = `${originalMessage} (reason: ${reason})`;
  } else {
    userMessage = originalMessage;
  }

  return { reason, userMessage, originalMessage };
}

/** Try to parse a Kiro error response body (JSON) and enhance it. */
export function enhanceKiroErrorText(text: string): KiroErrorInfo {
  try {
    return enhanceKiroError(JSON.parse(text));
  } catch {
    return { reason: "UNKNOWN", userMessage: text || "Unknown error", originalMessage: text };
  }
}
