import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NeoDeviceClient } from "../../clients/web/neo-client";

const account = () => "browser-test-account-" + crypto.randomUUID();
const token = async () => "test-access-token";

afterEach(() => vi.unstubAllGlobals());

describe("browser IndexedDB persistence and recovery", () => {
  it("persists a non-exportable device identity across client reconstruction and isolates accounts", async () => {
    const scope = account();
    const first = await NeoDeviceClient.create("https://neo.test", token, scope);
    const second = await NeoDeviceClient.create("https://neo.test", token, scope);
    const otherAccount = await NeoDeviceClient.create("https://neo.test", token, account());

    expect(first.deviceId).toBe(second.deviceId);
    expect(first.deviceId).not.toBe(otherAccount.deviceId);
  });

  it("recovers an encrypted memory cache after a simulated offline restart", async () => {
    const scope = account();
    const client = await NeoDeviceClient.create("https://neo.test", token, scope);
    const record = {
      memory_id: "memory-1",
      revision: 1,
      trust_state: "approved",
      updated_at: 100,
      payload_ciphertext: "ciphertext-only",
      payload_nonce: "nonce",
      key_version: 1,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      records: [record],
      next_cursor: "opaque-cursor",
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const online = await client.syncMemory();
    expect(online.records).toEqual([record]);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const recoveredClient = await NeoDeviceClient.create("https://neo.test", token, scope);
    const offline = await recoveredClient.syncMemory();
    expect(offline.offline).toBe(true);
    expect(offline.records).toEqual([record]);
  });

  it("replays durable ciphertext outbox entries after reconstruction and keeps account scopes separate", async () => {
    const scope = account();
    const first = await NeoDeviceClient.create("https://neo.test", token, scope);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const queued = await first.createMemory({
      memory_id: "memory-offline",
      payload_ciphertext: "encrypted-content",
      payload_nonce: "nonce",
      key_version: 1,
    });
    expect(queued).toMatchObject({ status: "queued_offline", kind: "memory.create" });

    const recovered = await NeoDeviceClient.create("https://neo.test", token, scope);
    const isolated = await NeoDeviceClient.create("https://neo.test", token, account());
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ memory_id: "memory-offline" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await isolated.flushOutbox()).toMatchObject({ sent: 0, remaining: 0 });
    expect(await recovered.flushOutbox()).toMatchObject({ sent: 1, remaining: 0, blocked_on: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("idempotency-key")).toBeTruthy();
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ payload_ciphertext: "encrypted-content", payload_nonce: "nonce" });
    expect(body).not.toHaveProperty("plaintext");
  });
});
