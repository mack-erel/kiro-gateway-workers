import { describe, it, expect } from "vitest";
import {
  normalizeUsageLimits,
  formatUsageSummary,
} from "../src/lib/usageLimits";

/**
 * Unit tests for usage-limits normalization, focused on the overage
 * ("크레딧 초과 사용 허용 여부") fields surfaced through the MCP credits tool.
 *
 * The fixture mirrors the real `KiroControlPlaneBearerService.GetUsageLimits`
 * payload shape (AWS-JSON 1.0), including `overageConfiguration` and the
 * per-resource overage fields.
 */
const RAW_ENABLED = {
  nextDateReset: 1782864000.0,
  overageConfiguration: { overageStatus: "ENABLED" },
  subscriptionInfo: {
    overageCapability: "OVERAGE_CAPABLE",
    subscriptionTitle: "KIRO POWER",
    type: "Q_DEVELOPER_STANDALONE_POWER",
  },
  usageBreakdownList: [
    {
      currency: "USD",
      currentOverages: 0,
      currentOveragesWithPrecision: 0.0,
      currentUsage: 7880,
      currentUsageWithPrecision: 7880.97,
      displayName: "Credit",
      overageCap: 10000,
      overageCapWithPrecision: 10000.0,
      overageCharges: 0.0,
      overageRate: 0.04,
      resourceType: "CREDIT",
      unit: "INVOCATIONS",
      usageLimit: 10000,
      usageLimitWithPrecision: 10000.0,
    },
  ],
};

describe("normalizeUsageLimits — overage fields", () => {
  it("surfaces overageEnabled/status/capability from the payload", () => {
    const u = normalizeUsageLimits(RAW_ENABLED);
    expect(u.overageEnabled).toBe(true);
    expect(u.overageStatus).toBe("ENABLED");
    expect(u.overageCapability).toBe("OVERAGE_CAPABLE");
  });

  it("maps per-resource overage fields", () => {
    const u = normalizeUsageLimits(RAW_ENABLED);
    const b = u.breakdown[0];
    expect(b.currentOverages).toBe(0);
    expect(b.overageCap).toBe(10000);
    expect(b.overageRate).toBe(0.04);
    expect(b.overageCharges).toBe(0);
    expect(b.currency).toBe("USD");
  });

  it("treats a DISABLED status as overageEnabled=false", () => {
    const u = normalizeUsageLimits({
      ...RAW_ENABLED,
      overageConfiguration: { overageStatus: "DISABLED" },
    });
    expect(u.overageEnabled).toBe(false);
    expect(u.overageStatus).toBe("DISABLED");
  });

  it("yields null overageEnabled when no overageConfiguration is present", () => {
    const { overageConfiguration, ...noCfg } = RAW_ENABLED;
    void overageConfiguration;
    const u = normalizeUsageLimits(noCfg);
    expect(u.overageEnabled).toBeNull();
    expect(u.overageStatus).toBeNull();
  });

  it("prefers the *WithPrecision overage variants", () => {
    const u = normalizeUsageLimits({
      ...RAW_ENABLED,
      usageBreakdownList: [
        {
          ...RAW_ENABLED.usageBreakdownList[0],
          currentOverages: 12,
          currentOveragesWithPrecision: 12.34,
          overageCap: 5000,
          overageCapWithPrecision: 5000.5,
        },
      ],
    });
    expect(u.breakdown[0].currentOverages).toBe(12.34);
    expect(u.breakdown[0].overageCap).toBe(5000.5);
  });
});

describe("formatUsageSummary — overage rendering", () => {
  it("includes the overage status in the suffix", () => {
    const summary = formatUsageSummary(normalizeUsageLimits(RAW_ENABLED));
    expect(summary).toContain("overage ENABLED");
    expect(summary).toContain("plan KIRO POWER");
  });

  it("renders an inline overage breakdown once overage is consumed", () => {
    const u = normalizeUsageLimits({
      ...RAW_ENABLED,
      usageBreakdownList: [
        {
          ...RAW_ENABLED.usageBreakdownList[0],
          currentOverages: 150,
          currentOveragesWithPrecision: 150.0,
          overageCharges: 6.0,
        },
      ],
    });
    const summary = formatUsageSummary(u);
    expect(summary).toContain("overage 150");
    expect(summary).toContain("/ 10000");
    expect(summary).toContain("USD6");
  });
});
