/**
 * Kiro usage / credit limits.
 *
 * Calls `KiroControlPlaneBearerService.GetUsageLimits` on the management host
 * (`https://management.{region}.kiro.dev`) — the same bearer-authenticated host
 * the gateway already uses for `ListAvailableModels`. Authentication is the
 * client's own ksk_ API key (used directly as the bearer token, plus the
 * `tokentype: API_KEY` header), so no extra credentials are required.
 *
 * Protocol is AWS-JSON 1.0 (plain JSON, dispatched via the `x-amz-target`
 * header) — not the CBOR web-portal service used by app.kiro.dev.
 */
import { getKiroManagementHost } from "../config";

/** One credit/resource line from `usageBreakdownList`. */
export interface UsageBreakdownEntry {
  /** Human label, e.g. "Credit". */
  resourceName: string;
  /** Machine type, e.g. "CREDIT". */
  resourceType: string | null;
  /** Consumed so far this period (fractional). */
  used: number;
  /** Total allotment for the period (fractional). */
  limit: number;
  /** `limit - used`, clamped at 0. */
  remaining: number;
  /** Fraction consumed in [0, 1], or null when limit is 0/unknown. */
  usedFraction: number | null;
  /** Unit of measure, e.g. "INVOCATIONS". */
  unit: string | null;
  /** Overage consumed beyond the allotment so far this period (fractional). */
  currentOverages: number;
  /** Max overage permitted beyond the allotment, or null if not provided. */
  overageCap: number | null;
  /** Per-unit overage price, or null if not provided. */
  overageRate: number | null;
  /** Money charged for overage so far this period. */
  overageCharges: number;
  /** ISO-4217 currency for overage charges/rate, e.g. "USD". */
  currency: string | null;
}

/** Normalized result of a usage-limits lookup. */
export interface UsageLimits {
  /** Subscription plan title, e.g. "KIRO POWER". */
  plan: string | null;
  /** Subscription type code, e.g. "Q_DEVELOPER_STANDALONE_POWER". */
  planType: string | null;
  /** ISO-8601 date when usage resets, or null if not provided. */
  nextResetDate: string | null;
  /**
   * Whether spending beyond the plan allotment is allowed.
   * `true` when `overageConfiguration.overageStatus === "ENABLED"`,
   * `false` for an explicit disabled status, `null` when not provided.
   */
  overageEnabled: boolean | null;
  /** Raw overage status string, e.g. "ENABLED" / "DISABLED". */
  overageStatus: string | null;
  /** Account-level overage capability, e.g. "OVERAGE_CAPABLE". */
  overageCapability: string | null;
  /** Per-resource breakdown (usually a single "Credit" entry). */
  breakdown: UsageBreakdownEntry[];
  /** Raw upstream payload, for callers that want everything. */
  raw: Record<string, any>;
}

/** Coerce an unknown numeric field to a finite number, or null. */
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Convert an epoch-seconds value to an ISO date string, or null. */
function epochSecondsToIso(v: unknown): string | null {
  const n = numOrNull(v);
  if (n === null) return null;
  // Upstream sends seconds (e.g. 1.782864e9). Guard against ms just in case.
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  // An absurd-but-finite magnitude (e.g. 1e300) yields an Invalid Date whose
  // toISOString() throws RangeError. Validate before formatting.
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Fetch and normalize the caller's Kiro usage limits.
 *
 * @param apiKey The client's ksk_ API key (used directly as the bearer token).
 * @param region Kiro API region (e.g. "us-east-1").
 * @param timeoutMs Abort after this many ms (default 30s).
 * @throws Error on non-200 or network failure.
 */
export async function fetchUsageLimits(
  apiKey: string,
  region: string,
  timeoutMs = 30000,
): Promise<UsageLimits> {
  const url = `${getKiroManagementHost(region)}/`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    tokentype: "API_KEY",
    "Content-Type": "application/x-amz-json-1.0",
    "x-amz-target": "KiroControlPlaneBearerService.GetUsageLimits",
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    if (response.status !== 200) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `GetUsageLimits returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
    }
    const data = (await response.json()) as Record<string, any>;
    return normalizeUsageLimits(data);
  } finally {
    clearTimeout(timer);
  }
}

/** Shape the raw `GetUsageLimits` payload into {@link UsageLimits}. */
export function normalizeUsageLimits(data: Record<string, any>): UsageLimits {
  const sub = (data["subscriptionInfo"] as Record<string, any>) ?? {};
  const list = Array.isArray(data["usageBreakdownList"])
    ? (data["usageBreakdownList"] as Array<Record<string, any>>)
    : [];

  const breakdown: UsageBreakdownEntry[] = list.map((e) => {
    const used = numOrNull(e["currentUsageWithPrecision"]) ?? numOrNull(e["currentUsage"]) ?? 0;
    const limit = numOrNull(e["usageLimitWithPrecision"]) ?? numOrNull(e["usageLimit"]) ?? 0;
    const remaining = Math.max(0, limit - used);
    return {
      resourceName: (e["displayName"] as string) ?? "Usage",
      resourceType: (e["resourceType"] as string) ?? null,
      used,
      limit,
      remaining,
      usedFraction: limit > 0 ? used / limit : null,
      unit: (e["unit"] as string) ?? null,
      currentOverages:
        numOrNull(e["currentOveragesWithPrecision"]) ?? numOrNull(e["currentOverages"]) ?? 0,
      overageCap:
        numOrNull(e["overageCapWithPrecision"]) ?? numOrNull(e["overageCap"]),
      overageRate: numOrNull(e["overageRate"]),
      overageCharges: numOrNull(e["overageCharges"]) ?? 0,
      currency: (e["currency"] as string) ?? null,
    };
  });

  const overageCfg = (data["overageConfiguration"] as Record<string, any>) ?? {};
  const overageStatus = (overageCfg["overageStatus"] as string) ?? null;

  return {
    plan: (sub["subscriptionTitle"] as string) ?? null,
    planType: (sub["type"] as string) ?? null,
    nextResetDate: epochSecondsToIso(data["nextDateReset"]),
    overageEnabled:
      overageStatus === null ? null : overageStatus.toUpperCase() === "ENABLED",
    overageStatus,
    overageCapability: (sub["overageCapability"] as string) ?? null,
    breakdown,
    raw: data,
  };
}

/** Render a one-line-per-resource human summary, e.g.
 *  "Credit: 6357.93 / 10000 used (3642.07 remaining, 63.6%) · overage ENABLED · plan KIRO POWER · resets 2026-07-01". */
export function formatUsageSummary(u: UsageLimits): string {
  if (u.breakdown.length === 0) {
    return `No usage breakdown returned${u.plan ? ` (plan ${u.plan})` : ""}.`;
  }
  const reset = u.nextResetDate ? u.nextResetDate.slice(0, 10) : null;
  const round = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  const lines = u.breakdown.map((b) => {
    const pct = b.usedFraction !== null ? `, ${(b.usedFraction * 100).toFixed(1)}%` : "";
    let line =
      `${b.resourceName}: ${round(b.used)} / ${round(b.limit)} used` +
      ` (${round(b.remaining)} remaining${pct})`;
    if (b.currentOverages > 0) {
      const cap = b.overageCap !== null ? ` / ${round(b.overageCap)}` : "";
      const charges =
        b.overageCharges > 0
          ? `, ${b.currency ?? ""}${round(b.overageCharges)}`.trimEnd()
          : "";
      line += ` · overage ${round(b.currentOverages)}${cap}${charges}`;
    }
    return line;
  });
  const overageLabel =
    u.overageStatus !== null
      ? `overage ${u.overageStatus}`
      : u.overageEnabled !== null
        ? `overage ${u.overageEnabled ? "ENABLED" : "DISABLED"}`
        : null;
  const suffix = [
    overageLabel,
    u.plan ? `plan ${u.plan}` : null,
    reset ? `resets ${reset}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return suffix ? `${lines.join("; ")} · ${suffix}` : lines.join("; ");
}
