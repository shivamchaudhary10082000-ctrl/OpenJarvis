import { describe, expect, it } from "vitest";
import worker, { decodeMemoryCursor, encodeMemoryCursor, modelRouteMetadata } from "../src/index";
const env = {} as any;
describe("NEO Worker unauthenticated surface", () => {
  it("exposes a minimal health response without authentication", async () => {
    const response = await worker.fetch(new Request("https://neo.example/v1/health"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects protected endpoints without a Cloudflare Access token", async () => {
    const response = await worker.fetch(new Request("https://neo.example/v1/devices"), env);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
  });
});


describe("NEO memory sync cursor", () => {
  it("round-trips monotonically increasing D1 row ids", () => {
    for (const rowId of [0, 1, 199, 200, Number.MAX_SAFE_INTEGER]) {
      const token = encodeMemoryCursor(rowId);
      expect(decodeMemoryCursor(token)).toBe(rowId);
      expect(token).not.toMatch(/[+/=]/);
    }
  });

  it("rejects malformed, negative, fractional, and unsafe cursors", () => {
    for (const token of ["not-a-cursor", btoa(JSON.stringify({ n: -1 })), btoa(JSON.stringify({ n: 1.5 })), btoa(JSON.stringify({ n: Number.MAX_SAFE_INTEGER + 1 }))]) {
      expect(decodeMemoryCursor(token)).toBeNull();
    }
  });

  it("rejects invalid row ids before encoding", () => {
    expect(() => encodeMemoryCursor(-1)).toThrow("Invalid memory cursor row id");
    expect(() => encodeMemoryCursor(1.25)).toThrow("Invalid memory cursor row id");
  });
});


describe("NEO model route disclosure", () => {
  it("labels an explicitly selected backup as backup without claiming fallback", () => {
    expect(modelRouteMetadata("backup-model", "primary-model", false, true, "not_used", 12)).toEqual({
      tier: "backup", fallback_used: false, fallback_reason: null, latency_ms: 12, account_scope: "private",
    });
  });

  it("discloses automatic failover when the primary was available but failed", () => {
    expect(modelRouteMetadata("backup-model", "primary-model", true, true, "provider_http_503", 34)).toEqual({
      tier: "backup", fallback_used: true, fallback_reason: "provider_http_503", latency_ms: 34, account_scope: "private",
    });
  });

  it("does not claim fallback when only the backup is configured", () => {
    expect(modelRouteMetadata("backup-model", "primary-model", true, false, "not_used", 20).fallback_used).toBe(false);
  });
});
