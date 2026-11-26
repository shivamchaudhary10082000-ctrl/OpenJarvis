import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import worker, { cleanupExpiredDeviceNonces, reconcileStaleProviderSpendReservations, type Env } from "../src/index";
import { createDeviceIdentity, selectRecallableMemory } from "../../clients/web/neo-client";

const encoder = new TextEncoder();
const bindings = env as unknown as Env;
const issuer = (bindings.ACCESS_TEAM_DOMAIN || "").replace(/\/$/, "");
const audience = bindings.ACCESS_AUD || "";
const baseUrl = "https://neo.integration.test";
let accessKeys: CryptoKeyPair;
let accessPublicJwk: JsonWebKey;
let googleKeys: CryptoKeyPair;
let googlePublicJwk: JsonWebKey;

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
  overrides: Partial<{ iss: string; aud: string | string[]; exp: number; nbf: number }> = {},
): Promise<string> {
  const header = base64UrlJson({ alg: "RS256", kid: "neo-test-key" });
  const payload = base64UrlJson({
    sub: subject,
    iss: issuer,
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 300,
    nbf: Math.floor(Date.now() / 1000) - 1,
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

async function googleIdToken(subject: string, nonce: string, kid: string): Promise<string> {
  const header = base64UrlJson({ alg: "RS256", kid });
  const payload = base64UrlJson({
    sub: subject, iss: "https://accounts.google.com", aud: "neo-browser-test-client",
    exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce,
  });
  const input = header + "." + payload;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", googleKeys.privateKey, encoder.encode(input)));
  return input + "." + base64Url(signature);
}
function mockGoogleCerts(kid: string): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const requested = String(input);
    if (requested === "https://www.googleapis.com/oauth2/v3/certs") {
      return new Response(JSON.stringify({ keys: [{ ...googlePublicJwk, kid, alg: "RS256" }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (requested === issuer + "/cdn-cgi/access/certs") {
      return new Response(JSON.stringify({ keys: [accessPublicJwk] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("unexpected upstream", { status: 502 });
  });
}
async function sha256Text(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
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
  if (response.status !== 201) throw new Error("Device enrolment failed (" + response.status + "): " + await response.text());
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
  accessPublicJwk = { ...(await crypto.subtle.exportKey("jwk", accessKeys.publicKey)), kid: "neo-test-key" } as JsonWebKey;
  googleKeys = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
  }, true, ["sign", "verify"]);
  googlePublicJwk = await crypto.subtle.exportKey("jwk", googleKeys.publicKey);
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

    const notYetValid = await accessToken(account, { nbf: Math.floor(Date.now() / 1000) + 60 });
    const notBeforeResponse = await worker.fetch(new Request(baseUrl + "/v1/devices", {
      headers: { authorization: "Bearer " + notYetValid, "x-neo-device-id": device.id },
    }), bindings);
    expect(notBeforeResponse.status).toBe(401);

    const valid = await accessToken(account);
    const parts = valid.split(".");
    const tampered = parts[0] + "." + parts[1] + "." + (parts[2].slice(0, -1) + (parts[2].endsWith("A") ? "B" : "A"));
    const signatureResponse = await worker.fetch(new Request(baseUrl + "/v1/devices", {
      headers: { authorization: "Bearer " + tampered, "x-neo-device-id": device.id },
    }), bindings);
    expect(signatureResponse.status).toBe(401);
  });

  it("issues a hashed HttpOnly browser session after Google nonce-bound device enrollment and revokes it on logout", async () => {
    const kid = "neo-google-session-" + crypto.randomUUID();
    mockGoogleCerts(kid);
    const googleBindings = { ...bindings, GOOGLE_OAUTH_CLIENT_IDS: "neo-browser-test-client" } as Env;
    const challengeResponse = await worker.fetch(new Request(baseUrl + "/v1/auth/challenge", {
      headers: { "cf-connecting-ip": "198.51.100.42" },
    }), googleBindings);
    expect(challengeResponse.status).toBe(200);
    const challenge = await challengeResponse.json() as { nonce: string };
    const token = await googleIdToken("browser-session-subject", challenge.nonce, kid);
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const deviceId = crypto.randomUUID().replace(/-/g, "");
    const enrolled = await worker.fetch(new Request(baseUrl + "/v1/devices", {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        "x-neo-device-id": deviceId,
      },
      body: JSON.stringify({ label: "Browser session test", platform: "browser", public_key_jwk: publicJwk, capabilities: ["chat"] }),
    }), googleBindings);
    expect(enrolled.status).toBe(201);
    const setCookie = enrolled.headers.get("set-cookie") || "";
    expect(setCookie).toMatch(/^__Host-neo_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Strict$/);
    const rawSession = setCookie.split(";")[0].split("=")[1];
    const sessionHash = await sha256Text(rawSession);
    const stored = await bindings.DB.prepare("SELECT session_hash,account_id,device_id,public_key_hash,expires_at,absolute_expires_at FROM browser_sessions WHERE session_hash=?")
      .bind(sessionHash).first<{session_hash:string;account_id:string;device_id:string;public_key_hash:string;expires_at:number;absolute_expires_at:number}>();
    expect(stored).toMatchObject({ session_hash: sessionHash, account_id: "google:browser-session-subject", device_id: deviceId });
    expect(stored?.session_hash).not.toBe(rawSession);
    expect(stored?.expires_at).toBeLessThanOrEqual(stored?.absolute_expires_at || 0);

    const device: TestDevice = {
      id: deviceId, account: "google:browser-session-subject",
      token: await accessToken("different-bearer-subject"), privateKey: pair.privateKey,
    };
    const bootstrap = await worker.fetch(new Request(baseUrl + "/v1/session", {
      headers: { cookie: "__Host-neo_session=" + rawSession },
    }), googleBindings);
    expect(bootstrap.status).toBe(200);
    expect(await bootstrap.json()).toMatchObject({ account_id: device.account, device_id: deviceId, session_type: "browser" });

    const crossOriginRequest = await signedRequest(device, "/v1/devices/heartbeat", { method: "POST" });
    crossOriginRequest.headers.set("cookie", "__Host-neo_session=" + rawSession);
    crossOriginRequest.headers.set("origin", "https://attacker.example");
    crossOriginRequest.headers.set("sec-fetch-site", "cross-site");
    const crossOrigin = await worker.fetch(crossOriginRequest, googleBindings);
    expect(crossOrigin.status).toBe(403);

    const logout = await worker.fetch(new Request(baseUrl + "/v1/auth/logout", {
      method: "POST",
      headers: { cookie: "__Host-neo_session=" + rawSession, origin: baseUrl, "sec-fetch-site": "same-origin" },
    }), googleBindings);
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("__Host-neo_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict");
    const afterLogout = await worker.fetch(await signedRequest(device, "/v1/devices/heartbeat", {
      method: "POST", headers: { cookie: "__Host-neo_session=" + rawSession, origin: baseUrl, "sec-fetch-site": "same-origin" },
    }), googleBindings);
    expect(afterLogout.status).toBe(401);
  });

  it("device revocation invalidates every browser session bound to that device", async () => {
    const device = await enrolDevice("session-device-revoke-" + crypto.randomUUID(), "Session device revoke");
    const publicKey = await bindings.DB.prepare("SELECT public_key_jwk FROM devices WHERE device_id=?")
      .bind(device.id).first<{public_key_jwk:string}>();
    const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const hash = await sha256Text(token);
    const timestamp = Math.floor(Date.now() / 1000);
    const jwk = JSON.parse(publicKey!.public_key_jwk) as JsonWebKey;
    const keyHash = await sha256Text("P-256." + jwk.x + "." + jwk.y);
    await bindings.DB.prepare("INSERT INTO browser_sessions(session_hash,account_id,device_id,public_key_hash,created_at,last_seen_at,expires_at,absolute_expires_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(hash, device.account, device.id, keyHash, timestamp, timestamp, timestamp + 3600, timestamp + 86400).run();
    const revoke = await signedRequest(device, "/v1/devices/" + device.id, {
      method: "DELETE", headers: { cookie: "__Host-neo_session=" + token, origin: baseUrl, "sec-fetch-site": "same-origin" },
    });
    const response = await worker.fetch(revoke, bindings);
    expect(response.status).toBe(204);
    const stored = await bindings.DB.prepare("SELECT revoked_at FROM browser_sessions WHERE session_hash=?")
      .bind(hash).first<{revoked_at:number|null}>();
    expect(stored?.revoked_at).not.toBeNull();
    const afterRevoke = await signedRequest(device, "/v1/devices/heartbeat", {
      method: "POST", headers: { cookie: "__Host-neo_session=" + token, origin: baseUrl, "sec-fetch-site": "same-origin" },
    });
    expect((await worker.fetch(afterRevoke, bindings)).status).toBe(403);
  });

  it("invalid or revoked browser cookies never fall back to a valid bearer token", async () => {
    const device = await enrolDevice("session-no-downgrade-" + crypto.randomUUID(), "Session no downgrade");
    const publicKey = await bindings.DB.prepare("SELECT public_key_jwk FROM devices WHERE device_id=?")
      .bind(device.id).first<{public_key_jwk:string}>();
    const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const hash = await sha256Text(token);
    const timestamp = Math.floor(Date.now() / 1000);
    const jwk = JSON.parse(publicKey!.public_key_jwk) as JsonWebKey;
    const keyHash = await sha256Text("P-256." + jwk.x + "." + jwk.y);
    await bindings.DB.prepare("INSERT INTO browser_sessions(session_hash,account_id,device_id,public_key_hash,created_at,last_seen_at,expires_at,absolute_expires_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(hash, device.account, device.id, keyHash, timestamp, timestamp, timestamp + 3600, timestamp + 86400).run();
    await bindings.DB.prepare("UPDATE browser_sessions SET revoked_at=? WHERE session_hash=?").bind(timestamp, hash).run();
    const request = await signedRequest(device, "/v1/devices/heartbeat", { method: "POST" });
    request.headers.set("cookie", "__Host-neo_session=" + token);
    expect((await worker.fetch(request, bindings)).status).toBe(401);
  });

  it("returns only the verified Access subject for browser account-scope bootstrap", async () => {
    const subject = "browser-bootstrap-" + crypto.randomUUID();
    const token = await accessToken(subject);
    const response = await worker.fetch(new Request(baseUrl + "/v1/session", {
      headers: { "cf-access-jwt-assertion": token },
    }), bindings);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ account_id: subject });

    // A present invalid assertion remains authoritative even if a valid bearer
    // token is also supplied; the bootstrap route must not weaken precedence.
    const fallback = await accessToken("must-not-be-used-" + crypto.randomUUID());
    const rejected = await worker.fetch(new Request(baseUrl + "/v1/session", {
      headers: {
        "cf-access-jwt-assertion": "invalid.assertion.value",
        authorization: "Bearer " + fallback,
      },
    }), bindings);
    expect(rejected.status).toBe(401);
  });

  it("accepts the Cloudflare Access injected browser assertion with the same JWT validation", async () => {
    const device = await enrolDevice("access-assertion-" + crypto.randomUUID(), "Browser assertion device");
    const bearerRequest = await signedRequest(device, "/v1/devices");
    const assertionHeaders = new Headers(bearerRequest.headers);
    assertionHeaders.delete("authorization");
    assertionHeaders.set("cf-access-jwt-assertion", device.token);
    const assertionRequest = new Request(bearerRequest.url, {
      method: bearerRequest.method,
      headers: assertionHeaders,
    });
    expect((await worker.fetch(assertionRequest, bindings)).status).toBe(200);

    // A present but invalid Access assertion must not silently fall back to a
    // valid bearer token; this preserves the selected browser auth boundary.
    const invalidBearerRequest = await signedRequest(device, "/v1/devices");
    const invalidAssertionHeaders = new Headers(invalidBearerRequest.headers);
    invalidAssertionHeaders.set("cf-access-jwt-assertion", "invalid.assertion.value");
    const invalidAssertionRequest = new Request(invalidBearerRequest.url, {
      method: invalidBearerRequest.method,
      headers: invalidAssertionHeaders,
    });
    expect((await worker.fetch(invalidAssertionRequest, bindings)).status).toBe(401);
  });

  it("supports first browser-device enrolment through the Access assertion and fails closed on an invalid assertion", async () => {
    const account = "browser-cookie-enrolment-" + crypto.randomUUID();
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const deviceId = crypto.randomUUID().replace(/-/g, "");
    const token = await accessToken(account);
    const response = await worker.fetch(new Request(baseUrl + "/v1/devices", {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": token,
        "content-type": "application/json",
        "x-neo-device-id": deviceId,
      },
      body: JSON.stringify({
        label: "Browser cookie device",
        platform: "browser",
        public_key_jwk: publicJwk,
        capabilities: ["cpu"],
      }),
    }), bindings);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      device_id: deviceId,
      account_id: account,
      status: "enrolled",
    });

    const repeatEnrolment = await worker.fetch(new Request(baseUrl + "/v1/devices", {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": token,
        "content-type": "application/json",
        "x-neo-device-id": deviceId,
      },
      body: JSON.stringify({
        label: "Browser cookie device",
        platform: "browser",
        public_key_jwk: publicJwk,
        capabilities: ["cpu"],
      }),
    }), bindings);
    expect(repeatEnrolment.status).toBe(200);
    expect(await repeatEnrolment.json()).toMatchObject({
      device_id: deviceId,
      account_id: account,
      status: "enrolled",
    });

    const rejectedDeviceId = crypto.randomUUID().replace(/-/g, "");
    const fallbackBearer = await accessToken("invalid-assertion-enrolment-" + crypto.randomUUID());
    const rejectedPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const rejectedPublicJwk = await crypto.subtle.exportKey("jwk", rejectedPair.publicKey);
    const rejected = await worker.fetch(new Request(baseUrl + "/v1/devices", {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": "invalid.assertion.value",
        authorization: "Bearer " + fallbackBearer,
        "content-type": "application/json",
        "x-neo-device-id": rejectedDeviceId,
      },
      body: JSON.stringify({
        label: "Must not enrol",
        platform: "browser",
        public_key_jwk: rejectedPublicJwk,
        capabilities: ["cpu"],
      }),
    }), bindings);
    expect(rejected.status).toBe(401);
    const rejectedRow = await bindings.DB.prepare(
      "SELECT device_id FROM devices WHERE device_id = ?",
    ).bind(rejectedDeviceId).first();
    expect(rejectedRow).toBeNull();
  });

  it("rejects first-time device enrolment for a suspended account", async () => {
    const account = "suspended-enrolment-" + crypto.randomUUID();
    await bindings.DB.prepare(
      "INSERT INTO accounts(account_id, created_at, status) VALUES(?, ?, 'suspended')",
    ).bind(account, Math.floor(Date.now() / 1000)).run();

    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const deviceId = crypto.randomUUID().replace(/-/g, "");
    const token = await accessToken(account);
    const response = await worker.fetch(new Request(baseUrl + "/v1/devices", {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        "x-neo-device-id": deviceId,
      },
      body: JSON.stringify({
        label: "Suspended account device",
        platform: "browser",
        public_key_jwk: publicJwk,
        capabilities: ["cpu"],
      }),
    }), bindings);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "account_inactive" },
    });
    const stored = await bindings.DB.prepare(
      "SELECT COUNT(*) AS count FROM devices WHERE device_id = ?",
    ).bind(deviceId).first<{ count: number }>();
    expect(stored?.count).toBe(0);
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
    expect(crossAccount.status).toBe(403);

    const ownDevices = await call(first, "/v1/devices");
    expect(ownDevices.status).toBe(200);
    const body = await ownDevices.json() as { devices: Array<{ device_id: string }> };
    expect(body.devices.map(item => item.device_id)).toEqual([first.id]);
  });

  it("reports device presence and refreshes it with an authenticated heartbeat", async () => {
    const account = "presence-" + crypto.randomUUID();
    const owner = await enrolDevice(account, "Owner device");
    const secondary = await enrolDevice(account, "Secondary device");
    await bindings.DB.prepare("UPDATE devices SET last_seen_at = 0 WHERE device_id = ?")
      .bind(secondary.id).run();

    const offlineList = await call(owner, "/v1/devices");
    const offlineBody = await offlineList.json() as { devices: Array<{ device_id: string; presence: string }> };
    expect(offlineBody.devices.find(device => device.device_id === secondary.id)?.presence).toBe("offline");

    const heartbeat = await call(secondary, "/v1/devices/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(heartbeat.status).toBe(200);
    expect(await heartbeat.json()).toMatchObject({ device_id: secondary.id, status: "active" });

    const onlineList = await call(owner, "/v1/devices");
    const onlineBody = await onlineList.json() as { devices: Array<{ device_id: string; presence: string }> };
    expect(onlineBody.devices.find(device => device.device_id === secondary.id)?.presence).toBe("online");
  });

  it("marks a device offline after the 90-second heartbeat freshness window", async () => {
    const account = "presence-expiry-" + crypto.randomUUID();
    const owner = await enrolDevice(account, "Presence owner");
    const secondary = await enrolDevice(account, "Presence secondary");
    await bindings.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE device_id = ?")
      .bind(Math.floor(Date.now() / 1000) - 91, secondary.id).run();

    const response = await call(owner, "/v1/devices");
    const body = await response.json() as { devices: Array<{ device_id: string; presence: string }> };
    expect(body.devices.find(device => device.device_id === secondary.id)?.presence).toBe("offline");

    const heartbeat = await call(secondary, "/v1/devices/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(heartbeat.status).toBe(200);
    const refreshed = await call(owner, "/v1/devices");
    const refreshedBody = await refreshed.json() as { devices: Array<{ device_id: string; presence: string }> };
    expect(refreshedBody.devices.find(device => device.device_id === secondary.id)?.presence).toBe("online");
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

  it("cleans expired device nonces while preserving live replay records", async () => {
    const device = await enrolDevice("nonce-cleanup-" + crypto.randomUUID(), "Nonce cleanup device");
    const nowSeconds = Math.floor(Date.now() / 1000);
    await bindings.DB.prepare("INSERT INTO device_nonces(device_id,nonce,expires_at) VALUES(?,?,?)")
      .bind(device.id, "expired-nonce-123456", nowSeconds - 1).run();
    await bindings.DB.prepare("INSERT INTO device_nonces(device_id,nonce,expires_at) VALUES(?,?,?)")
      .bind(device.id, "live-nonce-123456789", nowSeconds + 600).run();

    const removed = await cleanupExpiredDeviceNonces(bindings);
    expect(removed).toBe(1);
    const remaining = await bindings.DB.prepare("SELECT nonce FROM device_nonces WHERE device_id=?")
      .bind(device.id).all<{ nonce: string }>();
    expect(remaining.results.map(row => row.nonce)).toEqual(["live-nonce-123456789"]);
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

describe("Offline memory recall selection", () => {
  it("keeps approved revisions through pending updates and applies tombstones", () => {
    const records = [
      { memory_id: "a", revision: 1, trust_state: "approved", updated_at: 1 },
      { memory_id: "a", revision: 2, trust_state: "pending", updated_at: 2 },
      { memory_id: "b", revision: 1, trust_state: "approved", updated_at: 1 },
      { memory_id: "b", revision: 2, trust_state: "deleted", updated_at: 2 },
      { memory_id: "c", revision: 1, trust_state: "approved", updated_at: 1 },
      { memory_id: "c", revision: 3, trust_state: "approved", updated_at: 3 },
      { memory_id: "d", revision: 1, trust_state: "approved", updated_at: 1 },
      { memory_id: "d", revision: 2, trust_state: "quarantined", updated_at: 2 },
    ];
    expect(selectRecallableMemory(records).map(record => [record.memory_id, record.revision])).toEqual([
      ["a", 1], ["d", 1], ["c", 3],
    ]);
    expect(selectRecallableMemory(records, true).map(record => [record.memory_id, record.revision])).toEqual([
      ["a", 1], ["d", 1], ["a", 2], ["c", 3],
    ]);
  });
});

describe("Browser device identity key safety", () => {
  it("persists only a non-exportable P-256 private CryptoKey while retaining an exportable public JWK", async () => {
    const identity = await createDeviceIdentity();
    expect(identity.privateKey.type).toBe("private");
    expect(identity.privateKey.extractable).toBe(false);
    expect(identity.publicJwk.kty).toBe("EC");
    expect(identity.publicJwk.crv).toBe("P-256");

    const verifyKey = await crypto.subtle.importKey(
      "jwk", identity.publicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
    );
    const message = new TextEncoder().encode("NEO browser device key proof");
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, identity.privateKey, message);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyKey, signature, message)).toBe(true);
  });
});

describe("D1-backed provider budgets, failover, and voice", () => {
  it("fails over to the backup, discloses the route, and settles the D1 reservation", async () => {
    const device = await enrolDevice("provider-failover-" + crypto.randomUUID(), "Provider test device");
    const upstreamCalls: string[] = [];
    let forwardedBody: Record<string, unknown> | null = null;
    mockAccessCerts(async (url, init) => {
      upstreamCalls.push(url);
      if (url.startsWith("https://backup.provider.test/") && typeof init?.body === "string") forwardedBody = JSON.parse(init.body) as Record<string, unknown>;
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
      body: JSON.stringify({ model: "auto", allow_fallback: true, max_completion_tokens: 32, messages: [{ role: "user", content: "Hello" }] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: "backup response" } }],
      neo: { provider: "backup-model", tier: "backup", fallback_used: true },
    });
    expect(upstreamCalls).toHaveLength(2);
    expect(forwardedBody).not.toHaveProperty("allow_fallback");
    expect(forwardedBody).toMatchObject({ max_completion_tokens: 32 });
    expect(forwardedBody).not.toHaveProperty("max_tokens");

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

    const second = await request();
    expect(second.status).toBe(502);
    expect(primaryCalls).toBe(2);
    expect(backupCalls).toBe(0);

    const blocked = await request();
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: { code: "spend_budget_exceeded" } });
    expect(primaryCalls).toBe(2);
  });

  it("rejects malformed model routing policy before any provider call", async () => {
    const device = await enrolDevice("provider-policy-validation-" + crypto.randomUUID(), "Policy validation device");
    let providerCalls = 0;
    mockAccessCerts(async () => {
      providerCalls++;
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    });
    const invalidFallback = await call(device, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", allow_fallback: "false", messages: [{ role: "user", content: "x" }] }),
    });
    expect(invalidFallback.status).toBe(400);
    const invalidModel = await call(device, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: 123, messages: [{ role: "user", content: "x" }] }),
    });
    expect(invalidModel.status).toBe(400);
    expect(providerCalls).toBe(0);
  });

  it("honours allow_fallback=false and never contacts the backup provider", async () => {
    const device = await enrolDevice("provider-no-fallback-" + crypto.randomUUID(), "No-fallback device");
    let backupCalls = 0;
    mockAccessCerts(async (url) => {
      if (url.startsWith("https://primary.provider.test/")) return new Response("unavailable", { status: 503 });
      if (url.startsWith("https://backup.provider.test/")) backupCalls++;
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    });
    const response = await call(device, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", allow_fallback: false, messages: [{ role: "user", content: "Do not fallback" }] }),
    });
    expect(response.status).toBe(502);
    expect(backupCalls).toBe(0);
  });

  it("charges a bounded reservation when a provider connection fails", async () => {
    const device = await enrolDevice("provider-network-error-" + crypto.randomUUID(), "Provider network error device");
    mockAccessCerts(async () => { throw new Error("simulated provider network timeout"); });
    const response = await call(device, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "primary-model", messages: [{ role: "user", content: "timeout" }] }),
    });
    expect(response.status).toBe(502);
    const usage = await bindings.DB.prepare(
      "SELECT reserved_microusd, spent_microusd FROM provider_spend_usage WHERE account_id = ?",
    ).bind(device.account).first<{ reserved_microusd: number; spent_microusd: number }>();
    expect(usage?.reserved_microusd).toBe(0);
    expect(usage?.spent_microusd).toBeGreaterThan(0);
  });

  it("settles the maximum voice reservation once on upstream failure and does not blindly retry billable audio", async () => {
    const device = await enrolDevice("voice-failure-" + crypto.randomUUID(), "Voice failure device");
    let upstreamCalls = 0;
    mockAccessCerts(async () => {
      upstreamCalls++;
      throw new Error("simulated upstream timeout");
    });
    const response = await call(device, "/v1/voice/transcribe", {
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(response.status).toBe(502);
    expect(upstreamCalls).toBe(1);
    const usage = await bindings.DB.prepare(
      "SELECT reserved_microusd, spent_microusd FROM provider_spend_usage WHERE account_id = ?",
    ).bind(device.account).first<{ reserved_microusd: number; spent_microusd: number }>();
    expect(usage?.reserved_microusd).toBe(0);
    expect(usage?.spent_microusd).toBe(1000);
  });

  it("proxies speech synthesis and charges its configured maximum request cost", async () => {
    const device = await enrolDevice("voice-synthesis-" + crypto.randomUUID(), "Voice synthesis device");
    let receivedJson = false;
    mockAccessCerts(async (url, init) => {
      if (!url.endsWith("/audio/speech")) return new Response("unexpected", { status: 404 });
      receivedJson = init?.headers !== undefined && (init.headers as Record<string, string>)["content-type"] === "application/json";
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    });
    const response = await call(device, "/v1/voice/synthesize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "tts-1", input: "hello", voice: "alloy" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(receivedJson).toBe(true);
    const usage = await bindings.DB.prepare(
      "SELECT reserved_microusd, spent_microusd FROM provider_spend_usage WHERE account_id = ?",
    ).bind(device.account).first<{ reserved_microusd: number; spent_microusd: number }>();
    expect(usage?.reserved_microusd).toBe(0);
    expect(usage?.spent_microusd).toBe(1000);
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
  it("replays an offline memory write idempotently and rejects key reuse with changed content", async () => {
    const device = await enrolDevice("memory-idempotency-" + crypto.randomUUID(), "Memory idempotency device");
    const key = "memory-idem-" + crypto.randomUUID();
    const input = encryptedPayload({ memory_id: "offline-memory" });
    const send = (payload: Record<string, unknown>) => call(device, "/v1/memory", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(payload),
    });
    const first = await send(input);
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { revision: number };
    const replay = await send(input);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ revision: firstBody.revision, memory_id: "offline-memory" });

    const changed = await send({ ...input, payload_ciphertext: "D".repeat(32) });
    expect(changed.status).toBe(409);
    const count = await bindings.DB.prepare(
      "SELECT COUNT(*) AS count FROM memory_records WHERE account_id=? AND memory_id=?",
    ).bind(device.account, "offline-memory").first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

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

  it("replays encrypted task enqueue with the same key and rejects changed payloads", async () => {
    const device = await enrolDevice("task-idempotency-" + crypto.randomUUID(), "Task idempotency device");
    const key = "task-idem-" + crypto.randomUUID();
    const input = encryptedPayload({ task_kind: "offline.compute" });
    const send = (payload: Record<string, unknown>) => call(device, "/v1/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(payload),
    });
    const first = await send(input);
    expect(first.status).toBe(202);
    const firstBody = await first.json() as { task_id: string };
    const replay = await send(input);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ task_id: firstBody.task_id, state: "queued" });

    const changed = await send({ ...input, payload_ciphertext: "D".repeat(32) });
    expect(changed.status).toBe(409);
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


describe("D1 spend ledger invariants", () => {
  it("conservatively reconciles stale reservations once and leaves fresh requests untouched", async () => {
    const device = await enrolDevice("spend-reconcile-" + crypto.randomUUID(), "Spend reconciliation device");
    const timestamp = Math.floor(Date.now() / 1000);
    const month = new Date(timestamp * 1000).toISOString().slice(0, 7);
    await bindings.DB.prepare(
      "INSERT INTO provider_spend_usage(account_id,month_key,budget_microusd,monthly_input_token_limit,monthly_output_token_limit,reserved_microusd,spent_microusd,reserved_input_tokens,reserved_output_tokens,input_tokens,output_tokens,updated_at) VALUES(?,?,1000,100,100,0,0,0,0,0,0,?)",
    ).bind(device.account, month, timestamp).run();

    const staleId = crypto.randomUUID();
    const freshId = crypto.randomUUID();
    await bindings.DB.prepare(
      "INSERT INTO provider_spend_reservations(reservation_id,account_id,month_key,reserved_microusd,reserved_input_tokens,reserved_output_tokens,state,provider_label,created_at) VALUES(?,?,?,250,10,20,'reserved','stale-provider',?)",
    ).bind(staleId, device.account, month, timestamp - 3601).run();
    await bindings.DB.prepare(
      "INSERT INTO provider_spend_reservations(reservation_id,account_id,month_key,reserved_microusd,reserved_input_tokens,reserved_output_tokens,state,provider_label,created_at) VALUES(?,?,?,100,5,5,'reserved','fresh-provider',?)",
    ).bind(freshId, device.account, month, timestamp).run();

    expect(await reconcileStaleProviderSpendReservations(bindings, timestamp - 1800, timestamp)).toBeGreaterThanOrEqual(1);
    const stale = await bindings.DB.prepare(
      "SELECT state,settled_microusd,settled_input_tokens,settled_output_tokens FROM provider_spend_reservations WHERE reservation_id=?",
    ).bind(staleId).first<{state:string;settled_microusd:number;settled_input_tokens:number;settled_output_tokens:number}>();
    expect(stale).toEqual({
      state: "settled",
      settled_microusd: 250,
      settled_input_tokens: 10,
      settled_output_tokens: 20,
    });
    const fresh = await bindings.DB.prepare(
      "SELECT state FROM provider_spend_reservations WHERE reservation_id=?",
    ).bind(freshId).first<{state:string}>();
    expect(fresh?.state).toBe("reserved");

    const usage = await bindings.DB.prepare(
      "SELECT reserved_microusd,spent_microusd,reserved_input_tokens,reserved_output_tokens,input_tokens,output_tokens FROM provider_spend_usage WHERE account_id=? AND month_key=?",
    ).bind(device.account, month).first<Record<string, number>>();
    expect(usage).toEqual({
      reserved_microusd: 100,
      spent_microusd: 250,
      reserved_input_tokens: 5,
      reserved_output_tokens: 5,
      input_tokens: 10,
      output_tokens: 20,
    });
    expect(await reconcileStaleProviderSpendReservations(bindings, timestamp - 1800, timestamp + 1)).toBe(0);
  });

  it("admits only reservations that fit under the monthly cap under concurrency", async () => {
    const account = "spend-race-" + crypto.randomUUID();
    const month = new Date().toISOString().slice(0, 7);
    await bindings.DB.prepare(
      "INSERT INTO accounts(account_id, created_at, status) VALUES(?, ?, 'active')",
    ).bind(account, Math.floor(Date.now() / 1000)).run();
    await bindings.DB.prepare(
      "INSERT INTO provider_spend_usage(account_id, month_key, budget_microusd, reserved_microusd, spent_microusd, updated_at) VALUES(?,?,1000,0,0,?)",
    ).bind(account, month, Math.floor(Date.now() / 1000)).run();

    const attempts = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      bindings.DB.prepare(
        "INSERT INTO provider_spend_reservations(reservation_id, account_id, month_key, reserved_microusd, state, provider_label, created_at) VALUES(?,?,?,200,'reserved',?,?)",
      ).bind(crypto.randomUUID(), account, month, "race-" + index, Math.floor(Date.now() / 1000)).run()
        .then(() => true)
        .catch(() => false),
    ));
    expect(attempts.filter(Boolean)).toHaveLength(5);
    const usage = await bindings.DB.prepare(
      "SELECT reserved_microusd, spent_microusd FROM provider_spend_usage WHERE account_id=? AND month_key=?",
    ).bind(account, month).first<{ reserved_microusd: number; spent_microusd: number }>();
    expect(usage).toMatchObject({ reserved_microusd: 1000, spent_microusd: 0 });
  });

  it("admits only concurrent output-token reservations that fit the monthly token budget", async () => {
    const account = "token-race-" + crypto.randomUUID();
    const month = new Date().toISOString().slice(0, 7);
    const timestamp = Math.floor(Date.now() / 1000);
    await bindings.DB.prepare(
      "INSERT INTO accounts(account_id, created_at, status) VALUES(?, ?, 'active')",
    ).bind(account, timestamp).run();
    await bindings.DB.prepare(
      "INSERT INTO provider_spend_usage(account_id,month_key,budget_microusd,monthly_input_token_limit,monthly_output_token_limit,reserved_microusd,spent_microusd,reserved_input_tokens,reserved_output_tokens,input_tokens,output_tokens,updated_at) VALUES(?,?,10000,1000,1000,0,0,0,0,0,0,?)",
    ).bind(account, month, timestamp).run();

    const attempts = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      bindings.DB.prepare(
        "INSERT INTO provider_spend_reservations(reservation_id,account_id,month_key,reserved_microusd,reserved_input_tokens,reserved_output_tokens,state,provider_label,created_at) VALUES(?,?,?,100,10,200,'reserved',?,?)",
      ).bind(crypto.randomUUID(), account, month, "token-race-" + index, timestamp).run()
        .then(() => true)
        .catch(() => false),
    ));
    expect(attempts.filter(Boolean)).toHaveLength(5);
    const usage = await bindings.DB.prepare(
      "SELECT reserved_input_tokens,reserved_output_tokens,input_tokens,output_tokens FROM provider_spend_usage WHERE account_id=? AND month_key=?",
    ).bind(account, month).first<{ reserved_input_tokens: number; reserved_output_tokens: number; input_tokens: number; output_tokens: number }>();
    expect(usage).toMatchObject({ reserved_input_tokens: 50, reserved_output_tokens: 1000, input_tokens: 0, output_tokens: 0 });
  });

  it("counts settled input/output tokens before admitting new monthly reservations", async () => {
    const account = "token-monthly-total-" + crypto.randomUUID();
    const month = new Date().toISOString().slice(0, 7);
    const timestamp = Math.floor(Date.now() / 1000);
    await bindings.DB.prepare(
      "INSERT INTO accounts(account_id, created_at, status) VALUES(?, ?, 'active')",
    ).bind(account, timestamp).run();
    await bindings.DB.prepare(
      "INSERT INTO provider_spend_usage(account_id,month_key,budget_microusd,monthly_input_token_limit,monthly_output_token_limit,reserved_microusd,spent_microusd,reserved_input_tokens,reserved_output_tokens,input_tokens,output_tokens,updated_at) VALUES(?,?,10000,1000,1000,0,0,0,0,0,0,?)",
    ).bind(account, month, timestamp).run();

    const firstReservation = crypto.randomUUID();
    await bindings.DB.prepare(
      "INSERT INTO provider_spend_reservations(reservation_id,account_id,month_key,reserved_microusd,reserved_input_tokens,reserved_output_tokens,state,provider_label,created_at) VALUES(?,?,?,100,100,200,'reserved','first-request',?)",
    ).bind(firstReservation, account, month, timestamp).run();
    await bindings.DB.prepare(
      "UPDATE provider_spend_reservations SET state='settled',settled_microusd=80,settled_input_tokens=100,settled_output_tokens=200,settled_at=? WHERE reservation_id=?",
    ).bind(timestamp, firstReservation).run();

    // 100 input and 200 output tokens are already spent. These new reservations
    // would take their respective monthly totals over 1,000 and must fail.
    await expect(bindings.DB.prepare(
      "INSERT INTO provider_spend_reservations(reservation_id,account_id,month_key,reserved_microusd,reserved_input_tokens,reserved_output_tokens,state,provider_label,created_at) VALUES(?,?,?,100,901,0,'reserved','input-over-limit',?)",
    ).bind(crypto.randomUUID(), account, month, timestamp).run()).rejects.toThrow(/token_budget_exceeded/);
    await expect(bindings.DB.prepare(
      "INSERT INTO provider_spend_reservations(reservation_id,account_id,month_key,reserved_microusd,reserved_input_tokens,reserved_output_tokens,state,provider_label,created_at) VALUES(?,?,?,100,0,801,'reserved','output-over-limit',?)",
    ).bind(crypto.randomUUID(), account, month, timestamp).run()).rejects.toThrow(/token_budget_exceeded/);

    const usage = await bindings.DB.prepare(
      "SELECT reserved_input_tokens,reserved_output_tokens,input_tokens,output_tokens FROM provider_spend_usage WHERE account_id=? AND month_key=?",
    ).bind(account, month).first<{reserved_input_tokens:number;reserved_output_tokens:number;input_tokens:number;output_tokens:number}>();
    expect(usage).toEqual({
      reserved_input_tokens: 0,
      reserved_output_tokens: 0,
      input_tokens: 100,
      output_tokens: 200,
    });
  });

  it("rejects token settlement above the reservation and settles within the reserved token counts", async () => {
    const account = "token-settle-" + crypto.randomUUID();
    const month = new Date().toISOString().slice(0, 7);
    const timestamp = Math.floor(Date.now() / 1000);
    await bindings.DB.prepare(
      "INSERT INTO accounts(account_id, created_at, status) VALUES(?, ?, 'active')",
    ).bind(account, timestamp).run();
    await bindings.DB.prepare(
      "INSERT INTO provider_spend_usage(account_id,month_key,budget_microusd,monthly_input_token_limit,monthly_output_token_limit,reserved_microusd,spent_microusd,reserved_input_tokens,reserved_output_tokens,input_tokens,output_tokens,updated_at) VALUES(?,?,10000,1000,1000,0,0,0,0,0,0,?)",
    ).bind(account, month, timestamp).run();
    const reservation = crypto.randomUUID();
    await bindings.DB.prepare(
      "INSERT INTO provider_spend_reservations(reservation_id,account_id,month_key,reserved_microusd,reserved_input_tokens,reserved_output_tokens,state,provider_label,created_at) VALUES(?,?,?,300,10,20,'reserved','token-settlement-test',?)",
    ).bind(reservation, account, month, timestamp).run();

    await expect(bindings.DB.prepare(
      "UPDATE provider_spend_reservations SET state='settled',settled_microusd=250,settled_input_tokens=11,settled_output_tokens=20,settled_at=? WHERE reservation_id=?",
    ).bind(timestamp, reservation).run()).rejects.toThrow(/token_settlement_exceeds_reservation/);

    await bindings.DB.prepare(
      "UPDATE provider_spend_reservations SET state='settled',settled_microusd=250,settled_input_tokens=10,settled_output_tokens=15,settled_at=? WHERE reservation_id=?",
    ).bind(timestamp, reservation).run();
    const usage = await bindings.DB.prepare(
      "SELECT reserved_input_tokens,reserved_output_tokens,input_tokens,output_tokens FROM provider_spend_usage WHERE account_id=? AND month_key=?",
    ).bind(account, month).first<{ reserved_input_tokens: number; reserved_output_tokens: number; input_tokens: number; output_tokens: number }>();
    expect(usage).toMatchObject({ reserved_input_tokens: 0, reserved_output_tokens: 0, input_tokens: 10, output_tokens: 15 });
  });

  it("rejects settlement above the reservation and accepts settlement within it", async () => {
    const account = "spend-settle-" + crypto.randomUUID();
    const month = new Date().toISOString().slice(0, 7);
    const timestamp = Math.floor(Date.now() / 1000);
    await bindings.DB.prepare(
      "INSERT INTO accounts(account_id, created_at, status) VALUES(?, ?, 'active')",
    ).bind(account, timestamp).run();
    await bindings.DB.prepare(
      "INSERT INTO provider_spend_usage(account_id, month_key, budget_microusd, reserved_microusd, spent_microusd, updated_at) VALUES(?,?,1000,0,0,?)",
    ).bind(account, month, timestamp).run();
    const reservation = crypto.randomUUID();
    await bindings.DB.prepare(
      "INSERT INTO provider_spend_reservations(reservation_id, account_id, month_key, reserved_microusd, state, provider_label, created_at) VALUES(?,?,?,300,'reserved','settlement-test',?)",
    ).bind(reservation, account, month, timestamp).run();

    await expect(bindings.DB.prepare(
      "UPDATE provider_spend_reservations SET state='settled', settled_microusd=301, settled_at=? WHERE reservation_id=?",
    ).bind(timestamp, reservation).run()).rejects.toThrow(/spend_settlement_exceeds_reservation/);

    await bindings.DB.prepare(
      "UPDATE provider_spend_reservations SET state='settled', settled_microusd=250, settled_at=? WHERE reservation_id=?",
    ).bind(timestamp, reservation).run();
    const usage = await bindings.DB.prepare(
      "SELECT reserved_microusd, spent_microusd FROM provider_spend_usage WHERE account_id=? AND month_key=?",
    ).bind(account, month).first<{ reserved_microusd: number; spent_microusd: number }>();
    expect(usage).toMatchObject({ reserved_microusd: 0, spent_microusd: 250 });
  });
});

describe("Google OIDC identity bootstrap", () => {
  const clientId = "neo-web-test.apps.googleusercontent.com";
  let googleKeys: CryptoKeyPair;
  let googlePublicJwk: JsonWebKey & { kid?: string; alg?: string; use?: string };

  beforeAll(async () => {
    googleKeys = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    googlePublicJwk = { ...(await crypto.subtle.exportKey("jwk", googleKeys.publicKey)), kid: "neo-google-test-key", alg: "RS256", use: "sig" };
  });

  async function token(overrides: Record<string, unknown> = {}, signingKey = googleKeys.privateKey) {
    const header = base64UrlJson({ alg: "RS256", kid: "neo-google-test-key" });
    const payload = base64UrlJson({
      iss: "https://accounts.google.com",
      aud: clientId,
      sub: "google-test-subject-123",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...overrides,
    });
    const input = header + "." + payload;
    const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, encoder.encode(input)));
    return input + "." + base64Url(signature);
  }

  function mockGoogleKeys() {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input) === "https://www.googleapis.com/oauth2/v3/certs") {
        return new Response(JSON.stringify({ keys: [googlePublicJwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
  }

  it("accepts a Google-signed ID token with the configured audience and namespaces the account", async () => {
    mockGoogleKeys();
    const identityToken = await token();
    const response = await worker.fetch(new Request(baseUrl + "/v1/session", {
      headers: { authorization: "Bearer " + identityToken },
    }), { ...bindings, GOOGLE_OAUTH_CLIENT_IDS: clientId } as Env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ account_id: "google:google-test-subject-123" });
  });

  it("requires a fresh server-issued nonce for first Google device enrollment and rejects replay", async () => {
    mockGoogleKeys();
    const challengeResponse = await worker.fetch(new Request(baseUrl + "/v1/auth/challenge"), bindings);
    expect(challengeResponse.status).toBe(200);
    const challenge = await challengeResponse.json() as { nonce: string; expires_at: number };
    expect(challenge.nonce).toMatch(/^[A-Za-z0-9_-]{40,64}$/);
    expect(challenge.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const identityToken = await token({ nonce: challenge.nonce });
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
    );
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const firstDeviceId = crypto.randomUUID().replace(/-/g, "");
    const enrol = (deviceId: string, jwk: JsonWebKey) => worker.fetch(new Request(baseUrl + "/v1/devices", {
      method: "POST",
      headers: {
        authorization: "Bearer " + identityToken,
        "content-type": "application/json",
        "x-neo-device-id": deviceId,
      },
      body: JSON.stringify({
        label: "Google nonce test device",
        platform: "browser",
        public_key_jwk: jwk,
        capabilities: ["chat"],
      }),
    }), { ...bindings, GOOGLE_OAUTH_CLIENT_IDS: clientId } as Env);

    const first = await enrol(firstDeviceId, publicJwk);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ device_id: firstDeviceId, status: "enrolled" });

    const secondPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
    );
    const secondPublicJwk = await crypto.subtle.exportKey("jwk", secondPair.publicKey);
    const replay = await enrol(crypto.randomUUID().replace(/-/g, ""), secondPublicJwk);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: { code: "oidc_challenge_invalid" } });
  });

  it("atomically rate-limits OIDC challenge issuance per requester IP", async () => {
    const ip = "198.51.100.42";
    for (let index = 0; index < 10; index++) {
      const response = await worker.fetch(new Request(baseUrl + "/v1/auth/challenge", {
        headers: { "cf-connecting-ip": ip },
      }), bindings);
      expect(response.status).toBe(200);
    }
    const limited = await worker.fetch(new Request(baseUrl + "/v1/auth/challenge", {
      headers: { "cf-connecting-ip": ip },
    }), bindings);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: "challenge_rate_limited" } });
  });

  it("rejects first Google device enrollment when the ID token has no nonce", async () => {
    mockGoogleKeys();
    const identityToken = await token();
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
    );
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const response = await worker.fetch(new Request(baseUrl + "/v1/devices", {
      method: "POST",
      headers: {
        authorization: "Bearer " + identityToken,
        "content-type": "application/json",
        "x-neo-device-id": crypto.randomUUID().replace(/-/g, ""),
      },
      body: JSON.stringify({
        label: "Missing nonce test",
        platform: "browser",
        public_key_jwk: publicJwk,
        capabilities: ["chat"],
      }),
    }), { ...bindings, GOOGLE_OAUTH_CLIENT_IDS: clientId } as Env);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "oidc_challenge_invalid" } });
  });

  it.each([
    ["wrong issuer", { iss: "https://attacker.invalid" }],
    ["wrong audience", { aud: "another-client.apps.googleusercontent.com" }],
    ["expired token", { exp: 1 }],
    ["future issued-at", { iat: Math.floor(Date.now() / 1000) + 120 }],
  ])("rejects Google ID tokens with %s", async (_label, overrides) => {
    mockGoogleKeys();
    const identityToken = await token(overrides as Record<string, unknown>);
    const response = await worker.fetch(new Request(baseUrl + "/v1/session", {
      headers: { authorization: "Bearer " + identityToken },
    }), { ...bindings, GOOGLE_OAUTH_CLIENT_IDS: clientId } as Env);
    expect(response.status).toBe(401);
  });

  it("rejects a Google ID token with an invalid signature", async () => {
    mockGoogleKeys();
    const unrelated = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const identityToken = await token({}, unrelated.privateKey);
    const response = await worker.fetch(new Request(baseUrl + "/v1/session", {
      headers: { authorization: "Bearer " + identityToken },
    }), { ...bindings, GOOGLE_OAUTH_CLIENT_IDS: clientId } as Env);
    expect(response.status).toBe(401);
  });
});
