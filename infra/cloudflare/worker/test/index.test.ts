import { describe, expect, it } from "vitest";
import worker, { decodeMemoryCursor, encodeMemoryCursor, modelRouteMetadata, readRequestBodyBounded } from "../src/index";
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


describe("bounded request body reader", () => {
  it("accepts a body exactly at the configured limit", async () => {
    const req = new Request("https://neo.example/upload", { method: "POST", body: "12345" });
    const body = await readRequestBodyBounded(req, 5);
    expect(new TextDecoder().decode(body)).toBe("12345");
  });

  it("rejects a streamed body that exceeds the limit without buffering the remainder", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("1234"));
        controller.enqueue(new TextEncoder().encode("5678"));
      },
      cancel() { cancelled = true; },
    });
    const req = new Request("https://neo.example/upload", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    await expect(readRequestBodyBounded(req, 5)).rejects.toThrow("Request body too large");
    expect(cancelled).toBe(true);
  });

  it("rejects an oversized declared Content-Length before reading", async () => {
    const req = new Request("https://neo.example/upload", {
      method: "POST", headers: { "content-length": "999" }, body: "x",
    });
    await expect(readRequestBodyBounded(req, 10)).rejects.toThrow("Request body too large");
  });
});
