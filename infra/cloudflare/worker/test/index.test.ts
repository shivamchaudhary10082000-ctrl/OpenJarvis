import { describe, expect, it } from "vitest";
import worker from "../src/index";
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
