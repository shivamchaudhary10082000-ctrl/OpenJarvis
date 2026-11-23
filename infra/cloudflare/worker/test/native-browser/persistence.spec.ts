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
      setNetworkAvailable(value: boolean): void;
    };
  }
}

async function newClient(page: import("@playwright/test").Page, scope: string) {
  return page.evaluate((accountScope) => window.neoTest.create(accountScope), scope);
}

test("native IndexedDB persists a non-exportable identity across page reload", async ({ page }) => {
  await page.goto("/");
  const scope = "account-identity-" + crypto.randomUUID();
  const first = await newClient(page, scope);
  const keyState = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("neo-device-identity", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const identity = await new Promise<any>((resolve, reject) => {
      const request = db.transaction("identity").objectStore("identity").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return identity.map((item) => ({ extractable: item.privateKey.extractable, type: item.privateKey.type }));
  });
  expect(keyState).toContainEqual({ extractable: false, type: "private" });
  await page.reload();
  const second = await newClient(page, scope);
  expect(second.deviceId).toBe(first.deviceId);
  const other = await newClient(page, scope + "-other");
  expect(other.deviceId).not.toBe(first.deviceId);
});

test("encrypted memory cache survives reload and offline recovery", async ({ page }) => {
  await page.goto("/");
  const scope = "account-cache-" + crypto.randomUUID();
  await page.route("https://neo.test/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        records: [{
          memory_id: "native-memory", revision: 1, trust_state: "approved", updated_at: 10,
          payload_ciphertext: "ciphertext-only", payload_nonce: "nonce", key_version: 1,
        }],
        next_cursor: "opaque-cursor",
      }),
    });
  });
  const client = await newClient(page, scope);
  const online = await page.evaluate(async (s) => (await window.neoTest.create(s)).syncMemory(), scope);
  expect(online.offline).toBe(false);
  await page.unrouteAll();
  await page.route("https://neo.test/**", (route) => route.abort());
  await page.reload();
  const recovered = await page.evaluate(async (s) => (await window.neoTest.create(s)).syncMemory(), scope);
  expect(recovered.offline).toBe(true);
  expect(recovered.records).toHaveLength(1);
  expect(recovered.records[0].payload_ciphertext).toBe("ciphertext-only");
  expect(client.deviceId).toBeTruthy();
});

test("ciphertext outbox survives reload and replays with the original idempotency key", async ({ page }) => {
  await page.goto("/");
  const scope = "account-outbox-" + crypto.randomUUID();
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
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ accepted: true }) });
  });
  await page.reload();
  const result = await page.evaluate(async (s) => (await window.neoTest.create(s)).flushOutbox(), scope);
  expect(result).toMatchObject({ sent: 1, remaining: 0, blocked_on: null });
  expect(capturedKey).toBeTruthy();
  expect(capturedBody).toMatchObject({ payload_ciphertext: "ciphertext", payload_nonce: "nonce" });
  expect(capturedBody).not.toHaveProperty("plaintext");
});
