import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NeoDeviceClient } from "../../clients/web/neo-client";

// Node's WebCrypto CryptoKey is not structured-cloneable in every Node runtime,
// while real browsers support storing CryptoKey in IndexedDB. Preserve CryptoKey
// references in this fake IndexedDB adapter; plain data still uses structuredClone.
const nativeStructuredClone = globalThis.structuredClone.bind(globalThis);
globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
  try {
    return nativeStructuredClone(value, options);
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "DataCloneError") throw error;
    const clone = (item: any): any => {
      if (item && typeof item === "object" && item.constructor?.name === "CryptoKey") return item;
      if (Array.isArray(item)) return item.map(clone);
      if (item && Object.getPrototypeOf(item) === Object.prototype) {
        return Object.fromEntries(Object.entries(item).map(([key, nested]) => [key, clone(nested)]));
      }
      return item;
    };
    return clone(value);
  }
}) as typeof structuredClone;

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
    const bodyBytes = init.body instanceof Uint8Array ? init.body : new Uint8Array(init.body as ArrayBuffer);
    const body = JSON.parse(new TextDecoder().decode(bodyBytes)) as Record<string, unknown>;
    expect(body).toMatchObject({ payload_ciphertext: "encrypted-content", payload_nonce: "nonce" });
    expect(body).not.toHaveProperty("plaintext");
  });

  it("supports Cloudflare Access cookie sessions without a JavaScript token callback", async () => {
    const client = await NeoDeviceClient.create("https://neo.test", undefined, account());
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await client.request("/health");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toBeNull();
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe("same-origin");
  });

  it("uses same-origin Access cookies for first device enrolment without a JavaScript bearer token", async () => {
    const client = await NeoDeviceClient.create("https://neo.test", undefined, account());
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ status: "enrolled" }),
      { status: 201, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await client.enrol("Browser cookie device", "browser");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).get("authorization")).toBeNull();
  });

  it("uses a fresh host-provided access token for enrolment and every request without persisting it", async () => {
    const scope = account();
    let issued = 0;
    const accessToken = async () => `ephemeral-access-token-${++issued}`;
    const client = await NeoDeviceClient.create("https://neo.test", accessToken, scope);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "enrolled" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await client.enrol("Browser token device", "browser");
    await client.request("/health");
    await client.request("/health");

    expect(issued).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization"))
      .toBe("Bearer ephemeral-access-token-1");
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("authorization"))
      .toBe("Bearer ephemeral-access-token-2");
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get("authorization"))
      .toBe("Bearer ephemeral-access-token-3");

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("neo-device-identity", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const stores = Array.from(db.objectStoreNames);
      const tx = db.transaction(stores, "readonly");
      const values = await Promise.all(stores.map((storeName) => new Promise<unknown[]>((resolve, reject) => {
        const request = tx.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })));
      expect(JSON.stringify(values)).not.toContain("ephemeral-access-token-");
    } finally {
      db.close();
    }
  });
});
