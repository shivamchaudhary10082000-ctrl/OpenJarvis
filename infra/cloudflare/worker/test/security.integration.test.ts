import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import worker, { type Env } from "../src/index";

const encoder = new TextEncoder();
const bindings = env as unknown as Env;
const issuer = bindings.ACCESS_TEAM_DOMAIN.replace(/\/$/, "");
const audience = bindings.ACCESS_AUD;
const baseUrl = "https://neo.integration.test";
let accessKeys: CryptoKeyPair;
let accessPublicJwk: JsonWebKey;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlJson(value: unknown): string {
  return base64Url(encoder.encode(JSON.stringify(value)));
}

async function accessToken(
  subject: string,
  overrides: Partial<{ iss: string; aud: string | string[]; exp: number }> = {},
): Promise<string> {
  const header = base64UrlJson({ alg: "RS256", kid: "neo-test-key" });
  const payload = base64UrlJson({
    sub: subject,
    iss: issuer,
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  });
  const input = header + "." + payload;
  const signature = new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    accessKeys.privateKey,
    encoder.encode(input),
  ));
  return input + "." + base64Url(signature);
}

function mockAccessCerts(upstream?: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const requested = String(input);
    if (requested === issuer + "/cdn-cgi/access/certs") {
      return new Response(JSON.stringify({ keys: [accessPublicJwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (upstream) return upstream(requested, init);
    return new Response(JSON.stringify({ error: "unexpected upstream request" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  });
}

type TestDevice = {
  id: string;
  account: string;
  token: string;
  privateKey: CryptoKey;
};

async function enrolDevice(
  account: string,
  label: string,
  capabilities: string[] = ["cpu"],
): Promise<TestDevice> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const id = crypto.randomUUID().replace(/-/g, "");
  const token = await accessToken(account);
  const response = await worker.fetch(new Request(baseUrl + "/v1/devices", {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      "x-neo-device-id": id,
    },
    body: JSON.stringify({
      label,
      platform: "browser",
      public_key_jwk: publicJwk,
      capabilities,
    }),
  }), bindings);
  expect(response.status).toBe(201);
  return { id, account, token, privateKey: pair.privateKey };
}

async function signedRequest(
  device: TestDevice,
  path: string,
  init: RequestInit = {},
  nonceOverride?: string,
): Promise<Request> {
  const url = new URL(path, baseUrl);
  const bodyBytes = typeof init.body === "string"
    ? encoder.encode(init.body)
    : init.body instanceof Uint8Array
      ? new Uint8Array(init.body)
      : init.body instanceof ArrayBuffer
        ? new Uint8Array(init.body)
        : new Uint8Array();
  const ownedBodyBytes = new Uint8Array(bodyBytes.byteLength);
  ownedBodyBytes.set(bodyBytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ownedBodyBytes.buffer));
  const bodyHash = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = nonceOverride || base64Url(crypto.getRandomValues(new Uint8Array(18)));
  const canonical = [
    (init.method || "GET").toUpperCase(),
    url.host,
    url.pathname + url.search,
    timestamp,
    nonce,
    bodyHash,
  ].join("\n");
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    device.privateKey,
    encoder.encode(canonical),
  ));
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer " + device.token);
  headers.set("x-neo-device-id", device.id);
  headers.set("x-neo-timestamp", String(timestamp));
  headers.set("x-neo-nonce", nonce);
  headers.set("x-neo-signature", base64Url(signature));
  return new Request(url, { ...init, headers });
}

async function call(device: TestDevice, path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(await signedRequest(device, path, init), bindings);
}

function encryptedPayload(extra: Record<string, unknown> = {}) {
  return {
    payload_ciphertext: "C".repeat(32),
    payload_nonce: "N".repeat(16),
    key_version: 1,
    ...extra,
  };
}

beforeAll(async () => {
  accessKeys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  accessPublicJwk = await crypto.subtle.exportKey("jwk", accessKeys.publicKey);
});

beforeEach(() => mockAccessCerts());
afterEach(() => vi.unstubAllGlobals());

describe("D1-backed Access and device proof", () => {
  it("rejects invalid JWT signature, issuer, audience, and expiry", async () => {
    const account = "jwt-negative-" + crypto.randomUUID();
    const device = await enrolDevice(account, "JWT test device");

    const badIssuer = await accessToken(account, { iss: "https://attacker.invalid" });
    const issuerResponse = await worker.fetch(new Request(baseUrl + "/v1/devices", {
      headers: { authorization: "Bearer " + badIssuer, "x-neo-device-id": device.id },
    }), bindings);
    expect(issuerResponse.status).toBe(401);

    const badAudience = await accessToken(account, { aud: "wrong-audience" });
    const audienceResponse = await worker.fetch(new Request(baseUrl + "/v1/devices", {
      headers: { authorization: "Bearer " + badAudience, "x-neo-device-id": device.id },
    }), bindings);
    expect(audienceResponse.status).toBe(401);

    const expired = await accessToken(account, { exp: 1 });
    const expiryResponse = await worker.fetch(new Request(baseUrl + "/v1/devices", {
      headers: { authorization: "Bearer " + expired, "x-neo-device-id": device.id },
    }), bindings);
    expect(expiryResponse.status).toBe(401);

    const valid = await accessToken(account);
    const parts = valid.split(".");
    const tampered = parts[0] + "." + parts[1] + "." + (parts[2].slice(0, -1) + (parts[2].endsWith("A") ? "B" : "A"));
    const signatureResponse = await worker.fetch(new Request(baseUrl + "/v1/devices", {
      headers: { authorization: "Bearer " + tampered, "x-neo-device-id": device.id },
    }), bindings);
    expect(signatureResponse.status).toBe(401);
  });

  it("accepts a valid device proof once and rejects a replayed nonce", async () => {
    const device = await enrolDevice("proof-" + crypto.randomUUID(), "Proof device");
    const request = await signedRequest(device, "/v1/devices");
    const replay = new Request(request.url, { method: request.method, headers: request.headers });
    expect((await worker.fetch(request, bindings)).status).toBe(200);
    const replayResponse = await worker.fetch(replay, bindings);
    expect(replayResponse.status).toBe(401);
    expect(await replayResponse.json()).toMatchObject({
      error: { message: "Replayed device request" },
    });
  });

  it("isolates accounts and prevents a device id from crossing account boundaries", async () => {
    const first = await enrolDevice("account-a-" + crypto.randomUUID(), "A device");
    const second = await enrolDevice("account-b-" + crypto.randomUUID(), "B device");

    const crossAccount = await worker.fetch(await signedRequest(
      { ...first, id: second.id },
      "/v1/devices",
    ), bindings);
    expect(crossAccount.status).toBe(401);

    const ownDevices = await call(first, "/v1/devices");
    expect(ownDevices.status).toBe(200);
    const body = await ownDevices.json() as { devices: Array<{ device_id: string }> };
    expect(body.devices.map(item => item.device_id)).toEqual([first.id]);
  });

  it("revokes a second device and rejects all later requests from it", async () => {
    const account = "revocation-" + crypto.randomUUID();
    const owner = await enrolDevice(account, "Owner device");
    const secondary = await enrolDevice(account, "Secondary device");

    const revoke = await call(owner, "/v1/devices/" + secondary.id, { method: "DELETE" });
    expect(revoke.status).toBe(204);

    const revokedRequest = await call(secondary, "/v1/devices");
    expect(revokedRequest.status).toBe(403);
  });

  it("enforces the D1-backed per-account fixed-window request limit", async () => {
    const device = await enrolDevice("rate-" + crypto.randomUUID(), "Rate test device");
    for (let index = 0; index < 59; index++) {
      const response = await call(device, "/v1/devices");
      expect(response.status).toBe(200);
    }
    const limited = await call(device, "/v1/devices");
    expect(limited.status).toBe(429);
  });
});

describe("D1-backed provider budgets, failover, and voice", () => {
  it("fails over to the backup, discloses the route, and settles the D1 reservation", async () => {
    const device = await enrolDevice("provider-failover-" + crypto.randomUUID(), "Provider test device");
    const upstreamCalls: string[] = [];
    mockAccessCerts(async (url) => {
      upstreamCalls.push(url);
      if (url.startsWith("https://primary.provider.test/")) {
        return new Response(JSON.stringify({ error: "primary unavailable" }), { status: 503 });
      }
      return new Response(JSON.stringify({
        id: "test-response",
        choices: [{ message: { role: "assistant", content: "backup response" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const response = await call(device, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "Hello" }] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: "backup response" } }],
      neo: { provider: "backup-model", tier: "backup", fallback_used: true },
    });
    expect(upstreamCalls).toHaveLength(2);

    const usage = await bindings.DB.prepare(
      "SELECT reserved_microusd, spent_microusd FROM provider_spend_usage WHERE account_id = ?",
    ).bind(device.account).first<{ reserved_microusd: number; spent_microusd: number }>();
    expect(usage?.reserved_microusd).toBe(0);
    expect(usage?.spent_microusd).toBeGreaterThan(0);
  });

  it("does not call the backup for an explicit primary model and blocks requests at the monthly cap", async () => {
    const device = await enrolDevice("provider-cap-" + crypto.randomUUID(), "Budget test device");
    let primaryCalls = 0;
    let backupCalls = 0;
    mockAccessCerts(async (url) => {
      if (url.startsWith("https://primary.provider.test/")) {
        primaryCalls++;
        return new Response(JSON.stringify({ error: "primary unavailable" }), { status: 503 });
      }
      if (url.startsWith("https://backup.provider.test/")) backupCalls++;
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    });

    const request = () => call(device, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "primary-model", messages: [{ role: "user", content: "A" }] }),
    });
    const first = await request();
    expect(first.status).toBe(502);
    expect(primaryCalls).toBe(1);
    expect(backupCalls).toBe(0);

    const blocked = await request();
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: { code: "spend_budget_exceeded" } });
    expect(primaryCalls).toBe(1);
  });

  it("proxies transcription audio and records the configured maximum request cost", async () => {
    const device = await enrolDevice("voice-" + crypto.randomUUID(), "Voice test device");
    let receivedFormData = false;
    mockAccessCerts(async (url, init) => {
      if (!url.endsWith("/audio/transcriptions")) return new Response("unexpected", { status: 404 });
      receivedFormData = init?.body instanceof FormData;
      return new Response(JSON.stringify({ text: "hello from test audio" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const response = await call(device, "/v1/voice/transcribe", {
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ text: "hello from test audio" });
    expect(receivedFormData).toBe(true);
    const usage = await bindings.DB.prepare(
      "SELECT reserved_microusd, spent_microusd FROM provider_spend_usage WHERE account_id = ?",
    ).bind(device.account).first<{ reserved_microusd: number; spent_microusd: number }>();
    expect(usage?.reserved_microusd).toBe(0);
    expect(usage?.spent_microusd).toBe(1000);
  });
});

describe("D1-backed encrypted memory and task concurrency", () => {
  it("allocates distinct memory revisions under concurrent writes", async () => {
    const device = await enrolDevice("memory-race-" + crypto.randomUUID(), "Memory race device");
    const requests = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      signedRequest(device, "/v1/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(encryptedPayload({ memory_id: "shared-memory", source_kind: "user-" + index })),
      }),
    ));
    const responses = await Promise.all(requests.map(request => worker.fetch(request, bindings)));
    const statuses = responses.map(response => response.status);
    expect(statuses).toEqual(Array(8).fill(201));
    const revisions = await Promise.all(responses.map(async response =>
      (await response.json() as { revision: number }).revision,
    ));
    expect([...revisions].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("only leases a task to a device with every required capability", async () => {
    const account = "capability-" + crypto.randomUUID();
    const cpu = await enrolDevice(account, "CPU-only", ["cpu"]);
    const gpu = await enrolDevice(account, "GPU worker", ["cpu", "gpu"]);
    const taskResponse = await call(cpu, "/v1/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "capability-task-" + crypto.randomUUID(),
      },
      body: JSON.stringify(encryptedPayload({ task_kind: "model.infer", required_capabilities: ["gpu"] })),
    });
    expect(taskResponse.status).toBe(202);

    const unsupported = await call(cpu, "/v1/tasks/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(unsupported.status).toBe(200);
    expect(await unsupported.json()).toMatchObject({ task: null });

    const supported = await call(gpu, "/v1/tasks/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(supported.status).toBe(200);
    expect(await supported.json()).toMatchObject({ task: { state: "leased" } });
  });

  it("allows only one concurrent device to acquire a queued task lease", async () => {
    const account = "lease-race-" + crypto.randomUUID();
    const first = await enrolDevice(account, "First worker", ["cpu"]);
    const second = await enrolDevice(account, "Second worker", ["cpu"]);
    const created = await call(first, "/v1/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "lease-race-" + crypto.randomUUID(),
      },
      body: JSON.stringify(encryptedPayload({ task_kind: "cpu.compute" })),
    });
    expect(created.status).toBe(202);

    const claimInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    };
    const [left, right] = await Promise.all([
      call(first, "/v1/tasks/claim", claimInit),
      call(second, "/v1/tasks/claim", claimInit),
    ]);
    expect(left.status).toBe(200);
    expect(right.status).toBe(200);
    const results = await Promise.all([left.json(), right.json()]) as Array<{ task: { task_id: string } | null }>;
    expect(results.filter(result => result.task !== null)).toHaveLength(1);
  });

  it("requeues an expired lease so another device can recover the task", async () => {
    const account = "lease-expiry-" + crypto.randomUUID();
    const first = await enrolDevice(account, "First worker", ["cpu"]);
    const second = await enrolDevice(account, "Backup worker", ["cpu"]);
    const created = await call(first, "/v1/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "lease-expiry-" + crypto.randomUUID(),
      },
      body: JSON.stringify(encryptedPayload({ task_kind: "cpu.compute" })),
    });
    expect(created.status).toBe(202);
    const claimed = await call(first, "/v1/tasks/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lease_seconds: 30 }),
    });
    expect(claimed.status).toBe(200);
    const payload = await claimed.json() as { task: { task_id: string } };
    expect(payload.task.task_id).toBeTruthy();

    await bindings.DB.prepare("UPDATE task_leases SET lease_expires_at = 0 WHERE task_id = ?")
      .bind(payload.task.task_id).run();

    const recovered = await call(second, "/v1/tasks/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      task: { task_id: payload.task.task_id, state: "leased" },
    });
  });
});
