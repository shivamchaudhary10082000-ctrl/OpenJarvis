import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    neoTest: {
      create(scope: string): Promise<{
        deviceId: string;
        syncMemory(cursor?: string, includePending?: boolean): Promise<any>;
        createMemory(input: { memory_id: string; payload_ciphertext: string; payload_nonce: string; key_version: number }): Promise<any>;
        flushOutbox(): Promise<any>;
      }>;
    };
  }
}
const newScope = () => "account-" + Date.now() + "-" + Math.random().toString(36).slice(2);

test("native IndexedDB persists a non-exportable identity across page reload", async ({ page }) => {
  await page.goto("/");
  const scope = newScope();
  const firstId = await page.evaluate(async (s) => (await window.neoTest.create(s)).deviceId, scope);
  const keyState = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("neo-device-identity", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const identity = await new Promise<any[]>((resolve, reject) => {
      const request = db.transaction("identity").objectStore("identity").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return identity.map((item) => ({ extractable: item.privateKey.extractable, type: item.privateKey.type }));
  });
  expect(keyState).toContainEqual({ extractable: false, type: "private" });
  await page.reload();
  const secondId = await page.evaluate(async (s) => (await window.neoTest.create(s)).deviceId, scope);
  expect(secondId).toBe(firstId);
  const otherId = await page.evaluate(async (s) => (await window.neoTest.create(s)).deviceId, scope + "-other");
  expect(otherId).not.toBe(firstId);
});

test("encrypted memory cache survives reload and offline recovery", async ({ page }) => {
  await page.goto("/");
  const scope = newScope();
  await page.route("https://neo.test/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, x-neo-device-id, x-neo-timestamp, x-neo-nonce, x-neo-signature, idempotency-key",
      } });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
      body: JSON.stringify({
        records: [{
          memory_id: "native-memory", revision: 1, trust_state: "approved", updated_at: 10,
          payload_ciphertext: "ciphertext-only", payload_nonce: "nonce", key_version: 1,
        }],
        next_cursor: "opaque-cursor",
      }),
    });
  });
  const online = await page.evaluate(async (s) => (await window.neoTest.create(s)).syncMemory(), scope);
  expect(online.offline).toBe(false);
  await page.unrouteAll();
  await page.route("https://neo.test/**", (route) => route.abort());
  await page.reload();
  const recovered = await page.evaluate(async (s) => (await window.neoTest.create(s)).syncMemory(), scope);
  expect(recovered.offline).toBe(true);
  expect(recovered.records).toHaveLength(1);
  expect(recovered.records[0].payload_ciphertext).toBe("ciphertext-only");
});

test("ciphertext outbox survives reload and replays with the original idempotency key", async ({ page }) => {
  await page.goto("/");
  const scope = newScope();
  await page.route("https://neo.test/**", (route) => route.abort());
  const queued = await page.evaluate(async (s) => (await window.neoTest.create(s)).createMemory({
    memory_id: "offline-memory", payload_ciphertext: "ciphertext", payload_nonce: "nonce", key_version: 1,
  }), scope);
  expect(queued.status).toBe("queued_offline");
  await page.unrouteAll();
  let capturedKey: string | null = null;
  let capturedBody: any = null;
  await page.route("https://neo.test/**", async (route) => {
    capturedKey = route.request().headers()["idempotency-key"] ?? null;
    capturedBody = route.request().postDataJSON();
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, x-neo-device-id, x-neo-timestamp, x-neo-nonce, x-neo-signature, idempotency-key",
      } });
      return;
    }
    await route.fulfill({ status: 201, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: JSON.stringify({ accepted: true }) });
  });
  await page.reload();
  const result = await page.evaluate(async (s) => (await window.neoTest.create(s)).flushOutbox(), scope);
  expect(result).toMatchObject({ sent: 1, remaining: 0, blocked_on: null });
  expect(capturedKey).toBeTruthy();
  expect(capturedBody).toMatchObject({ payload_ciphertext: "ciphertext", payload_nonce: "nonce" });
  expect(capturedBody).not.toHaveProperty("plaintext");
});


test("memory management lists every page, including pending and rejected revisions", async ({ page }) => {
  await page.goto("/");
  const scope = newScope();
  const requests: URL[] = [];
  await page.route("https://neo.test/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, x-neo-device-id, x-neo-timestamp, x-neo-nonce, x-neo-signature, idempotency-key, if-match",
      } });
      return;
    }
    const url = new URL(route.request().url());
    requests.push(url);
    const cursor = url.searchParams.get("cursor");
    await route.fulfill({
      status: 200,
      headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
      body: JSON.stringify(cursor ? {
        records: [{ memory_id: "rejected-memory", revision: 2, trust_state: "rejected", payload_ciphertext: "ciphertext", payload_nonce: "nonce", key_version: 1 }],
        next_cursor: null,
      } : {
        records: [{ memory_id: "pending-memory", revision: 1, trust_state: "pending", payload_ciphertext: "ciphertext", payload_nonce: "nonce", key_version: 1 }],
        next_cursor: "page-two",
      }),
    });
  });
  const records = await page.evaluate(async (s) => (await window.neoTest.create(s)).listMemoryForManagement(), scope);
  expect(records.map((record) => [record.memory_id, record.trust_state])).toEqual([
    ["pending-memory", "pending"],
    ["rejected-memory", "rejected"],
  ]);
  expect(requests).toHaveLength(2);
  expect(requests[0].searchParams.get("include_pending")).toBe("true");
  expect(requests[0].searchParams.has("cursor")).toBe(false);
  expect(requests[1].searchParams.get("include_pending")).toBe("true");
  expect(requests[1].searchParams.get("cursor")).toBe("page-two");
});

test("memory review actions send revision preconditions to their exact endpoints", async ({ page }) => {
  await page.goto("/");
  const scope = newScope();
  const mutations: Array<{ method: string; path: string; revision: string | null }> = [];
  await page.route("https://neo.test/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, x-neo-device-id, x-neo-timestamp, x-neo-nonce, x-neo-signature, idempotency-key, if-match",
      } });
      return;
    }
    const request = route.request();
    mutations.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      revision: request.headers()["if-match"] ?? null,
    });
    await route.fulfill({
      status: request.method() === "DELETE" ? 204 : 200,
      headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
      body: request.method() === "DELETE" ? "" : JSON.stringify({ accepted: true }),
    });
  });
  await page.evaluate(async (s) => {
    const client = await window.neoTest.create(s);
    await client.approveMemory("pending-memory", 4);
    await client.rejectMemory("pending-memory", 5);
    await client.deleteMemory("approved-memory", 8);
  }, scope);
  expect(mutations).toEqual([
    { method: "POST", path: "/memory/pending-memory/approve", revision: "4" },
    { method: "POST", path: "/memory/pending-memory/reject", revision: "5" },
    { method: "DELETE", path: "/memory/approved-memory", revision: "8" },
  ]);
});
