export interface Env {
  DB: D1Database;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  MODEL_PRIMARY_URL?: string;
  MODEL_PRIMARY_NAME?: string;
  MODEL_PRIMARY_API_KEY?: string;
  MODEL_BACKUP_URL?: string;
  MODEL_BACKUP_NAME?: string;
  MODEL_BACKUP_API_KEY?: string;
  NEO_ENV?: string;
  MAX_BODY_BYTES?: string;
  MAX_REQUESTS_PER_MINUTE?: string;
  MAX_MONTHLY_SPEND_USD_MICROS?: string;
  MAX_MONTHLY_INPUT_TOKENS?: string;
  MAX_MONTHLY_OUTPUT_TOKENS?: string;
  MAX_PROMPT_BYTES?: string;
  MAX_OUTPUT_TOKENS?: string;
  MODEL_PRIMARY_INPUT_USD_MICROS_PER_1M?: string;
  MODEL_PRIMARY_OUTPUT_USD_MICROS_PER_1M?: string;
  MODEL_BACKUP_INPUT_USD_MICROS_PER_1M?: string;
  MODEL_BACKUP_OUTPUT_USD_MICROS_PER_1M?: string;
  VOICE_TRANSCRIBE_MAX_COST_USD_MICROS?: string;
  VOICE_SYNTHESIS_MAX_COST_USD_MICROS?: string;
}
type Claims = { sub: string; iss: string; aud: string | string[]; exp: number; nbf?: number; email?: string };
type Device = { device_id: string; account_id: string; public_key_jwk: string; revoked_at: number | null };
const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status);
const b64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
export function encodeBytesBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

const enc = new TextEncoder();
async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}
const now = () => Math.floor(Date.now() / 1000);
class RateLimitExceeded extends Error {}
const spendMonth = () => new Date().toISOString().slice(0, 7);
function positiveConfig(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function costMicros(inputTokens: number, outputTokens: number, inputRate: number, outputRate: number): number {
  const raw = inputTokens * inputRate + outputTokens * outputRate;
  if (!Number.isSafeInteger(raw) || raw < 0) throw new Error("Provider price calculation overflow");
  return Math.ceil(raw / 1_000_000);
}
async function reserveProviderSpend(
  account: string,
  env: Env,
  amountMicros: number,
  providerLabel: string,
  reservedInputTokens = 0,
  reservedOutputTokens = 0,
): Promise<string | null> {
  const limit = positiveConfig(env.MAX_MONTHLY_SPEND_USD_MICROS);
  const inputTokenLimit = positiveConfig(env.MAX_MONTHLY_INPUT_TOKENS);
  const outputTokenLimit = positiveConfig(env.MAX_MONTHLY_OUTPUT_TOKENS);
  if (!limit || !Number.isSafeInteger(amountMicros) || amountMicros <= 0) return null;
  if (!Number.isSafeInteger(reservedInputTokens) || reservedInputTokens < 0 ||
      !Number.isSafeInteger(reservedOutputTokens) || reservedOutputTokens < 0) return null;
  if ((reservedInputTokens > 0 && !inputTokenLimit) || (reservedOutputTokens > 0 && !outputTokenLimit)) return null;
  const month = spendMonth();
  const timestamp = now();
  await env.DB.prepare(
    "INSERT INTO provider_spend_usage(account_id,month_key,budget_microusd,monthly_input_token_limit,monthly_output_token_limit,reserved_microusd,spent_microusd,reserved_input_tokens,reserved_output_tokens,input_tokens,output_tokens,updated_at) VALUES(?,?,?,?,?,0,0,0,0,0,0,?) ON CONFLICT(account_id,month_key) DO UPDATE SET budget_microusd=excluded.budget_microusd,monthly_input_token_limit=excluded.monthly_input_token_limit,monthly_output_token_limit=excluded.monthly_output_token_limit,updated_at=excluded.updated_at",
  ).bind(account, month, limit, inputTokenLimit || 0, outputTokenLimit || 0, timestamp).run();
  const reservationId = id();
  try {
    await env.DB.prepare(
      "INSERT INTO provider_spend_reservations(reservation_id,account_id,month_key,reserved_microusd,reserved_input_tokens,reserved_output_tokens,state,provider_label,created_at) VALUES(?,?,?,?,?,?,'reserved',?,?)",
    ).bind(reservationId, account, month, amountMicros, reservedInputTokens, reservedOutputTokens, providerLabel.slice(0, 160), timestamp).run();
    return reservationId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("spend_budget_exceeded") || message.includes("token_budget_exceeded")) return null;
    throw error;
  }
}
async function settleProviderSpend(
  env: Env,
  reservationId: string,
  spentMicros: number,
  settledInputTokens = 0,
  settledOutputTokens = 0,
): Promise<void> {
  if (!Number.isSafeInteger(spentMicros) || spentMicros < 0 ||
      !Number.isSafeInteger(settledInputTokens) || settledInputTokens < 0 ||
      !Number.isSafeInteger(settledOutputTokens) || settledOutputTokens < 0) throw new Error("Invalid provider spend settlement");
  const result = await env.DB.prepare(
    "UPDATE provider_spend_reservations SET state='settled',settled_microusd=?,settled_input_tokens=?,settled_output_tokens=?,settled_at=? WHERE reservation_id=? AND state='reserved'",
  ).bind(spentMicros, settledInputTokens, settledOutputTokens, now(), reservationId).run();
  if (!result.meta.changes) throw new Error("Provider spend reservation was already settled or missing");
}
async function enforceAccountRateLimit(account: string, env: Env): Promise<void> {
  const configured = Number(env.MAX_REQUESTS_PER_MINUTE || 60);
  const limit = Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 600) : 60;
  const windowStart = Math.floor(now() / 60) * 60;
  const row = await env.DB.prepare("INSERT INTO api_rate_limits(account_id,window_start,request_count) VALUES(?,?,1) ON CONFLICT(account_id) DO UPDATE SET request_count=CASE WHEN api_rate_limits.window_start=excluded.window_start THEN api_rate_limits.request_count+1 ELSE 1 END, window_start=excluded.window_start WHERE api_rate_limits.window_start<>excluded.window_start OR api_rate_limits.request_count < ? RETURNING request_count")
    .bind(account, windowStart, limit).first<{ request_count: number }>();
  if (!row) throw new RateLimitExceeded("Account request rate limit exceeded");
}

function jsonBodyLimit(env: Env): number {
  const configured = Number(env.MAX_BODY_BYTES || 1_000_000);
  return Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 5_000_000) : 1_000_000;
}
function urlPathBodyLimit(req: { url: string }, env: Env): number {
  const path = new URL(req.url).pathname.replace(/^\/v1/, "");
  return path.startsWith("/voice/") ? 15_000_000 : jsonBodyLimit(env);
}
export async function readRequestBodyBounded(req: { headers: Headers; body: ReadableStream<Uint8Array> | null }, maxBytes: number): Promise<Uint8Array> {
  const declared = req.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) throw new Error("Request body too large");
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("Request body too large");
        throw new Error("Request body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}


// D1's implicit rowid is an insertion sequence for this append-only revision
// log. It prevents same-second writes/revisions from being skipped by cursors.
export function encodeMemoryCursor(rowId: number): string {
  if (!Number.isSafeInteger(rowId) || rowId < 0) throw new Error("Invalid memory cursor row id");
  return btoa(JSON.stringify({ n: rowId })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
export function decodeMemoryCursor(token: string): number | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(b64u(token))) as { n?: number };
    return Number.isSafeInteger(parsed.n) && Number(parsed.n) >= 0 ? Number(parsed.n) : null;
  } catch {
    return null;
  }
}
const id = () => crypto.randomUUID();
const safeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let n = 0; for (let i = 0; i < a.length; i++) n |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return n === 0;
};
async function accessClaims(token: string, env: Env): Promise<Claims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed access token");
  const header = JSON.parse(new TextDecoder().decode(b64u(parts[0]))) as { alg?: string; kid?: string };
  if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported access token algorithm");
  const issuer = env.ACCESS_TEAM_DOMAIN.replace(/\/$/, "");
  const response = await fetch(issuer + "/cdn-cgi/access/certs");
  if (!response.ok) throw new Error("Unable to validate access issuer");
  const jwks = await response.json() as { keys: Array<JsonWebKey & { kid?: string }> };
  const jwk = jwks.keys.find(k => k.kid === header.kid && k.kty === "RSA");
  if (!jwk) throw new Error("Unknown access signing key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(parts[2]), enc.encode(parts[0] + "." + parts[1]));
  if (!valid) throw new Error("Invalid access token signature");
  const claims = JSON.parse(new TextDecoder().decode(b64u(parts[1]))) as Claims;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const currentTime = now();
  const notBeforeValid = claims.nbf === undefined ||
    (Number.isFinite(claims.nbf) && claims.nbf <= currentTime);
  if (
    claims.iss !== issuer ||
    !aud.includes(env.ACCESS_AUD) ||
    typeof claims.sub !== "string" ||
    !claims.sub.trim() ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= currentTime ||
    !notBeforeValid
  ) throw new Error("Invalid access token claims");
  return claims;
}
function accessTokenFromRequest(req: Request): string {
  // Cloudflare Access injects this signed assertion for protected browser
  // requests. If present, it is authoritative even when empty or invalid.
  const assertion = req.headers.get("cf-access-jwt-assertion");
  if (assertion !== null) return assertion.trim();
  const authorization = req.headers.get("authorization") || "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}
async function accessClaimsFromRequest(req: Request, env: Env): Promise<Claims> {
  const token = accessTokenFromRequest(req);
  if (!token) throw new Error("Missing Cloudflare Access token");
  return accessClaims(token, env);
}
async function authenticate(req: Request, env: Env): Promise<{ account: string; device: Device }> {
  // Browser assertions and native/controlled bearer tokens share the exact
  // same RS256, issuer, audience and expiry validation.
  const claims = await accessClaimsFromRequest(req, env);
  const account = claims.sub;
  await env.DB.prepare("INSERT OR IGNORE INTO accounts(account_id, created_at, status) VALUES(?, ?, 'active')").bind(account, now()).run();
  const accountRow = await env.DB.prepare("SELECT status FROM accounts WHERE account_id = ?").bind(account).first<{status:string}>();
  if (!accountRow || accountRow.status !== "active") throw new Error("Account is not active");
  const deviceId = req.headers.get("x-neo-device-id") || "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(deviceId)) throw new Error("Invalid or missing device id");
  const row = await env.DB.prepare("SELECT device_id, account_id, public_key_jwk, revoked_at FROM devices WHERE device_id = ? AND account_id = ?").bind(deviceId, account).first<Device>();
  if (!row || row.revoked_at !== null) throw new Error("Device is not enrolled or has been revoked");
  {
    const ts = Number(req.headers.get("x-neo-timestamp"));
    const nonce = req.headers.get("x-neo-nonce") || "";
    const signature = req.headers.get("x-neo-signature") || "";
    if (!Number.isInteger(ts) || Math.abs(now() - ts) > 300 || !/^[A-Za-z0-9_-]{16,96}$/.test(nonce) || !signature) throw new Error("Missing or expired device proof");
    const bodyLimit = urlPathBodyLimit(req, env);
    const body = await readRequestBodyBounded(req.clone(), bodyLimit);
    const bodyBytes = new Uint8Array(body.byteLength);
    bodyBytes.set(body);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bodyBytes.buffer));
    const bodyHash = Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
    const requestUrl = new URL(req.url);
    const canonical = [req.method.toUpperCase(), requestUrl.host, requestUrl.pathname + requestUrl.search, ts, nonce, bodyHash].join("\n");
    const jwk = JSON.parse(row.public_key_jwk) as JsonWebKey;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const signatureBytes = new Uint8Array(b64u(signature));
    if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signatureBytes.buffer, enc.encode(canonical))) throw new Error("Invalid device signature");
    try {
      await env.DB.prepare("INSERT INTO device_nonces(device_id, nonce, expires_at) VALUES(?, ?, ?)").bind(deviceId, nonce, ts + 600).run();
    } catch { throw new Error("Replayed device request"); }
  }
  await enforceAccountRateLimit(account, env);
  await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE device_id = ? AND account_id = ?").bind(now(), deviceId, account).run();
  return { account, device: row };
}
async function bodyJson<T>(req: Request, env: Env): Promise<T> {
  const max = jsonBodyLimit(env);
  const declaredLength = Number(req.headers.get("content-length") || 0);
  if (declaredLength > max) throw new Error("Request body too large");
  const raw = await readRequestBodyBounded(req, max);
  return JSON.parse(new TextDecoder().decode(raw)) as T;
}
export function isValidCapabilityList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 32 &&
    value.every((item: unknown) => typeof item === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(item)) &&
    new Set(value).size === value.length;
}
function validCipher(x: any): boolean {
  return typeof x?.payload_ciphertext === "string" && x.payload_ciphertext.length >= 16 &&
    typeof x?.payload_nonce === "string" && x.payload_nonce.length >= 12 &&
    Number.isInteger(x?.key_version) && x.key_version > 0;
}
async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/v1/, "") || "/";
  if (req.method === "GET" && path === "/health") return json({ status: "ok", environment: env.NEO_ENV || "unset" });
  // Browser bootstrap needs the verified account subject before the client can
  // select its account-scoped IndexedDB identity. This endpoint deliberately
  // requires Access authentication but no device proof, because enrolment has
  // not happened yet. Return no other identity-provider claims.
  if (req.method === "GET" && path === "/session") {
    try {
      const claims = await accessClaimsFromRequest(req, env);
      return json({ account_id: claims.sub });
    } catch {
      return fail(401, "unauthorized", "A valid Cloudflare Access session is required");
    }
  }
  if (!path.startsWith("/")) return fail(404, "not_found", "Route not found");
  // First enrolment uses Access identity and binds a client-generated P-256 key.
  if (path === "/devices" && req.method === "POST") {
    try {
      // First enrolment must support the same cookie/assertion browser flow as
      // every subsequent signed request. A present invalid assertion fails closed.
      const claims = await accessClaimsFromRequest(req, env);
      const x = await bodyJson<any>(req, env);
      const deviceId = req.headers.get("x-neo-device-id") || "";
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(deviceId) || typeof x.label !== "string" ||
          x.label.length < 1 || x.label.length > 80 ||
          !["android","ios","windows","macos","linux","browser","other"].includes(x.platform) ||
          !x.public_key_jwk || x.public_key_jwk.kty !== "EC" || x.public_key_jwk.crv !== "P-256" ||
          typeof x.public_key_jwk.x !== "string" || typeof x.public_key_jwk.y !== "string" ||
          !isValidCapabilityList(x.capabilities)) return fail(400, "invalid_device", "Invalid device registration");
      await env.DB.prepare("INSERT OR IGNORE INTO accounts(account_id, created_at, status) VALUES(?, ?, 'active')").bind(claims.sub, now()).run();
      const accountRow = await env.DB.prepare("SELECT status FROM accounts WHERE account_id = ?")
        .bind(claims.sub).first<{ status: string }>();
      if (!accountRow || accountRow.status !== "active") {
        return fail(403, "account_inactive", "Account is not active");
      }
      await enforceAccountRateLimit(claims.sub, env);
      const existingDevice = await env.DB.prepare(
        "SELECT account_id, public_key_jwk, revoked_at FROM devices WHERE device_id = ?",
      ).bind(deviceId).first<{account_id:string;public_key_jwk:string;revoked_at:number|null}>();
      if (existingDevice) {
        let existingKey: JsonWebKey | null = null;
        try { existingKey = JSON.parse(existingDevice.public_key_jwk) as JsonWebKey; } catch {}
        const sameKey = existingKey?.kty === "EC" && existingKey.crv === "P-256" &&
          existingKey.x === x.public_key_jwk.x && existingKey.y === x.public_key_jwk.y;
        if (existingDevice.account_id !== claims.sub || !sameKey) {
          return fail(409, "device_id_conflict", "Device ID is already bound to a different account or key");
        }
        if (existingDevice.revoked_at !== null) {
          return fail(409, "device_revoked", "This device identity was revoked; create a new local device identity to enrol again");
        }
        return json({ device_id: deviceId, account_id: claims.sub, status: "enrolled" }, 200);
      }
      await env.DB.prepare("INSERT INTO devices(device_id, account_id, label, platform, public_key_jwk, capabilities_json, created_at) VALUES(?,?,?,?,?,?,?)")
        .bind(deviceId, claims.sub, x.label, x.platform, JSON.stringify(x.public_key_jwk), JSON.stringify(x.capabilities.slice(0,32)), now()).run();
      await env.DB.prepare("INSERT INTO audit_events(event_id,account_id,device_id,event_type,created_at) VALUES(?,?,?,?,?)")
        .bind(id(), claims.sub, deviceId, "device.enrolled", now()).run();
      return json({ device_id: deviceId, account_id: claims.sub, status: "enrolled" }, 201);
    } catch (e) {
      if (e instanceof RateLimitExceeded) return fail(429, "rate_limited", "Account request rate limit exceeded; retry after the current minute");
      return fail(401, "enrolment_failed", e instanceof Error ? e.message : "Device enrolment failed");
    }
  }
  let auth: { account: string; device: Device };
  try { auth = await authenticate(req, env); } catch (e) {
    if (e instanceof RateLimitExceeded) return fail(429, "rate_limited", "Account request rate limit exceeded; retry after the current minute");
    const message = e instanceof Error ? e.message : "Authentication failed";
    return fail(message.includes("revoked") || message.includes("not enrolled") ? 403 : 401, "unauthorized", message);
  }
  const { account, device } = auth;
  try {
    if (path === "/devices/heartbeat" && req.method === "POST") {
      return json({ device_id: device.device_id, status: "active", last_seen_at: now(), server_time: now() });
    }
    if (path === "/devices" && req.method === "GET") {
      const result = await env.DB.prepare("SELECT device_id, label, platform, capabilities_json, created_at, last_seen_at, revoked_at FROM devices WHERE account_id = ? ORDER BY created_at").bind(account).all();
      const devices = result.results.map((row: any) => {
        let capabilities: string[] = [];
        try { const parsed = JSON.parse(row.capabilities_json || "[]"); if (isValidCapabilityList(parsed)) capabilities = parsed; } catch {}
        return {
          device_id: row.device_id, label: row.label, platform: row.platform, capabilities,
          status: row.revoked_at === null ? "active" : "revoked",
          presence: row.revoked_at !== null ? "revoked" : (row.last_seen_at !== null && Number(row.last_seen_at) >= now() - 90 ? "online" : "offline"),
          created_at: row.created_at, last_seen_at: row.last_seen_at,
        };
      });
      return json({ devices });
    }
    if (path === "/devices" && req.method === "POST") {
      const x = await bodyJson<any>(req, env);
      if (typeof x.label !== "string" || x.label.length < 1 || x.label.length > 80 || !["android","ios","windows","macos","linux","browser","other"].includes(x.platform) || !x.public_key_jwk || x.public_key_jwk.kty !== "EC" || x.public_key_jwk.crv !== "P-256" || !isValidCapabilityList(x.capabilities)) return fail(400,"invalid_device","Invalid device registration");
      const deviceId = req.headers.get("x-neo-device-id") || id().replace(/-/g,"");
      await env.DB.prepare("INSERT INTO devices(device_id, account_id, label, platform, public_key_jwk, capabilities_json, created_at) VALUES(?,?,?,?,?,?,?)").bind(deviceId,account,x.label,x.platform,JSON.stringify(x.public_key_jwk),JSON.stringify(x.capabilities.slice(0,32)),now()).run();
      await env.DB.prepare("INSERT INTO audit_events(event_id,account_id,device_id,event_type,created_at) VALUES(?,?,?,?,?)").bind(id(),account,deviceId,"device.enrolled",now()).run();
      return json({ device_id: deviceId, account_id: account, status: "enrolled" },201);
    }
    const revoke = path.match(/^\/devices\/([A-Za-z0-9_-]{16,128})$/);
    if (revoke && req.method === "DELETE") {
      const result = await env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE device_id = ? AND account_id = ? AND revoked_at IS NULL").bind(now(),revoke[1],account).run();
      if (!result.meta.changes) return fail(404,"not_found","Device not found");
      await env.DB.prepare("INSERT INTO audit_events(event_id,account_id,device_id,event_type,created_at) VALUES(?,?,?,?,?)").bind(id(),account,revoke[1],"device.revoked",now()).run();
      return new Response(null,{status:204});
    }
    if (path === "/memory" && req.method === "GET") {
      const token = url.searchParams.get("cursor");
      const cursorRowId = token ? decodeMemoryCursor(token) : 0;
      if (cursorRowId === null) return fail(400, "invalid_cursor", "Invalid memory sync cursor");
      const includePending = url.searchParams.get("include_pending") === "true";
      const pendingState = includePending ? "pending" : "approved";
      const rows = await env.DB.prepare("SELECT rowid AS sync_id, memory_id, revision, trust_state, payload_ciphertext, payload_nonce, key_version, source_device_id, source_kind, created_at, updated_at, tombstoned_at FROM memory_records WHERE account_id = ? AND rowid > ? AND trust_state IN ('approved','deleted',?) ORDER BY rowid LIMIT 200").bind(account,cursorRowId,pendingState).all();
      const last = rows.results.length ? rows.results[rows.results.length - 1] as any : null;
      const next = last ? encodeMemoryCursor(Number(last.sync_id)) : null;
      const records = rows.results.map((row: any) => ({
        ...row,
        payload_ciphertext: encodeBytesBase64Url(new Uint8Array(row.payload_ciphertext)),
        payload_nonce: encodeBytesBase64Url(new Uint8Array(row.payload_nonce)),
      }));
      return json({ records, next_cursor: next });
    }
    if (path === "/memory" && req.method === "POST") {
      const x = await bodyJson<any>(req,env);
      if (!validCipher(x) || typeof x.memory_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(x.memory_id)) return fail(400,"invalid_memory","Invalid encrypted memory payload");
      const t=now();
      const sourceKind=String(x.source_kind || "user").slice(0,40);
      const idempotencyKey=req.headers.get("idempotency-key")||"";
      if(idempotencyKey){
        if(!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey))return fail(400,"idempotency_required","A valid Idempotency-Key is required");
        const requestHash=await sha256Hex(JSON.stringify({memory_id:x.memory_id,payload_ciphertext:x.payload_ciphertext,payload_nonce:x.payload_nonce,key_version:x.key_version,source_kind:sourceKind}));
        const findPrior=async()=>env.DB.prepare("SELECT i.memory_id,i.revision,i.request_hash,m.trust_state,m.created_at,m.updated_at FROM memory_write_idempotency i JOIN memory_records m ON m.account_id=i.account_id AND m.memory_id=i.memory_id AND m.revision=i.revision WHERE i.account_id=? AND i.idempotency_key=?").bind(account,idempotencyKey).first<any>();
        const prior=await findPrior();
        if(prior){
          if(prior.memory_id!==x.memory_id||prior.request_hash!==requestHash)return fail(409,"idempotency_conflict","Idempotency-Key was already used for a different memory payload");
          return json({memory_id:prior.memory_id,revision:prior.revision,trust_state:prior.trust_state,created_at:prior.created_at,updated_at:prior.updated_at},200);
        }
        try{
          await env.DB.batch([
            env.DB.prepare("INSERT INTO memory_records(memory_id,revision,account_id,trust_state,payload_ciphertext,payload_nonce,key_version,source_device_id,source_kind,created_at,updated_at) SELECT ?, COALESCE(MAX(revision),0)+1, ?, 'pending', ?, ?, ?, ?, ?, ?, ? FROM memory_records WHERE account_id=? AND memory_id=?")
              .bind(x.memory_id,account,b64u(x.payload_ciphertext),b64u(x.payload_nonce),x.key_version,device.device_id,sourceKind,t,t,account,x.memory_id),
            env.DB.prepare("INSERT INTO memory_write_idempotency(account_id,idempotency_key,memory_id,revision,request_hash,created_at) SELECT ?,?,?,MAX(revision),?,? FROM memory_records WHERE account_id=? AND memory_id=?")
              .bind(account,idempotencyKey,x.memory_id,requestHash,t,account,x.memory_id),
          ]);
        }catch{
          const raced=await findPrior();
          if(raced&&raced.memory_id===x.memory_id&&raced.request_hash===requestHash)
            return json({memory_id:raced.memory_id,revision:raced.revision,trust_state:raced.trust_state,created_at:raced.created_at,updated_at:raced.updated_at},200);
          if(raced)return fail(409,"idempotency_conflict","Idempotency-Key was already used for a different memory payload");
          return fail(409,"revision_conflict","Memory revision could not be allocated; retry the request");
        }
        const saved=await findPrior();
        if(!saved)return fail(409,"revision_conflict","Memory revision could not be allocated; retry the request");
        return json({memory_id:saved.memory_id,revision:saved.revision,trust_state:saved.trust_state,created_at:saved.created_at,updated_at:saved.updated_at},201);
      }
      const inserted=await env.DB.prepare("INSERT INTO memory_records(memory_id,revision,account_id,trust_state,payload_ciphertext,payload_nonce,key_version,source_device_id,source_kind,created_at,updated_at) SELECT ?, COALESCE(MAX(revision),0)+1, ?, 'pending', ?, ?, ?, ?, ?, ?, ? FROM memory_records WHERE account_id=? AND memory_id=? RETURNING revision")
        .bind(x.memory_id,account,b64u(x.payload_ciphertext),b64u(x.payload_nonce),x.key_version,device.device_id,sourceKind,t,t,account,x.memory_id).first<{revision:number}>();
      const first=inserted || await env.DB.prepare("INSERT INTO memory_records(memory_id,revision,account_id,trust_state,payload_ciphertext,payload_nonce,key_version,source_device_id,source_kind,created_at,updated_at) VALUES(?,1,?,'pending',?,?,?,?,?,?,?) RETURNING revision")
        .bind(x.memory_id,account,b64u(x.payload_ciphertext),b64u(x.payload_nonce),x.key_version,device.device_id,sourceKind,t,t).first<{revision:number}>();
      if (!first) return fail(409,"revision_conflict","Memory revision could not be allocated; retry the request");
      return json({memory_id:x.memory_id,revision:first.revision,trust_state:"pending",created_at:t,updated_at:t},201);
    }
    const approve = path.match(/^\/memory\/([A-Za-z0-9_-]{1,128})\/approve$/);
    if (approve && req.method === "POST") {
      const expected=Number((req.headers.get("if-match")||"").replaceAll('"',""));
      if (!Number.isInteger(expected) || expected < 1) return fail(428,"precondition_required","If-Match revision is required");
      const t=now();
      const r=await env.DB.prepare("INSERT INTO memory_records(memory_id,revision,account_id,trust_state,payload_ciphertext,payload_nonce,key_version,source_device_id,source_kind,created_at,updated_at) SELECT memory_id, revision+1, account_id, 'approved', payload_ciphertext, payload_nonce, key_version, source_device_id, source_kind, created_at, ? FROM memory_records WHERE account_id=? AND memory_id=? AND revision=? AND trust_state='pending' AND NOT EXISTS (SELECT 1 FROM memory_records newer WHERE newer.account_id=? AND newer.memory_id=? AND newer.revision=?)").bind(t,account,approve[1],expected,account,approve[1],expected+1).run();
      if (!r.meta.changes) return fail(409,"revision_conflict","Memory is not pending at the expected revision");
      await env.DB.prepare("INSERT INTO audit_events(event_id,account_id,device_id,event_type,event_metadata_json,created_at) VALUES(?,?,?,?,?,?)").bind(id(),account,device.device_id,"memory.approved",JSON.stringify({memory_id:approve[1],revision:expected+1}),t).run();
      return json({memory_id:approve[1],revision:expected+1,trust_state:"approved",updated_at:t});
    }
    const remove = path.match(/^\/memory\/([A-Za-z0-9_-]{1,128})$/);
    if (remove && req.method === "DELETE") {
      const expected=Number((req.headers.get("if-match")||"").replaceAll('"',""));
      if (!Number.isInteger(expected) || expected < 1) return fail(428,"precondition_required","If-Match revision is required");
      const latest=await env.DB.prepare("SELECT MAX(revision) AS revision FROM memory_records WHERE account_id=? AND memory_id=?").bind(account,remove[1]).first<{revision:number}>();
      if (latest?.revision !== expected) return fail(409,"revision_conflict","Stale memory revision");
      const row=await env.DB.prepare("SELECT payload_nonce,key_version FROM memory_records WHERE account_id=? AND memory_id=? AND revision=?").bind(account,remove[1],expected).first<any>();
      if (!row) return fail(404,"not_found","Memory not found");
      const t=now();
      await env.DB.prepare("INSERT INTO memory_records(memory_id,revision,account_id,trust_state,payload_ciphertext,payload_nonce,key_version,source_device_id,source_kind,created_at,updated_at,tombstoned_at) VALUES(?,?,?,'deleted',?,?,?,?,?,?,?,?)").bind(remove[1],expected+1,account,new Uint8Array([0]),row.payload_nonce,row.key_version,device.device_id,"tombstone",t,t,t).run();
      return new Response(null,{status:204});
    }
    if (path === "/tasks" && req.method === "POST") {
      const x=await bodyJson<any>(req,env);
      if (!validCipher(x) || typeof x.task_kind!=="string" || !/^[a-z][a-z0-9_.-]{1,63}$/.test(x.task_kind)) return fail(400,"invalid_task","Task must contain encrypted payload and a valid task kind");
      const requiredCapabilities = x.required_capabilities === undefined ? [] : x.required_capabilities;
      if (!Array.isArray(requiredCapabilities) || requiredCapabilities.length > 32 ||
          requiredCapabilities.some((v: unknown) => typeof v !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(v)) ||
          new Set(requiredCapabilities).size !== requiredCapabilities.length) return fail(400,"invalid_capabilities","required_capabilities must be up to 32 unique capability identifiers");
      const key=req.headers.get("idempotency-key")||"";
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) return fail(400,"idempotency_required","A valid Idempotency-Key is required");
      const requestHash=await sha256Hex(JSON.stringify({task_kind:x.task_kind,payload_ciphertext:x.payload_ciphertext,payload_nonce:x.payload_nonce,key_version:x.key_version,required_capabilities:requiredCapabilities}));
      const task=id();
      try {
        await env.DB.prepare("INSERT INTO task_leases(task_id,account_id,task_kind,state,idempotency_key,payload_ciphertext,payload_nonce,key_version,created_at,updated_at,required_capabilities_json,request_hash) VALUES(?,?,?,'queued',?,?,?,?,?,?,?,?)").bind(task,account,x.task_kind,key,b64u(x.payload_ciphertext),b64u(x.payload_nonce),x.key_version,now(),now(),JSON.stringify(requiredCapabilities),requestHash).run();
      } catch {
        const existing=await env.DB.prepare("SELECT task_id,state,request_hash FROM task_leases WHERE account_id=? AND idempotency_key=?").bind(account,key).first<any>();
        if (existing && existing.request_hash===requestHash) return json({task_id:existing.task_id,state:existing.state},200);
        if (existing) return fail(409,"idempotency_conflict","Idempotency-Key was already used for a different task payload");
        throw new Error("Task could not be queued");
      }
      return json({task_id:task,state:"queued"},202);
    }
    if (path === "/tasks/claim" && req.method === "POST") {
      const x=await bodyJson<any>(req,env);
      const leaseSeconds=Math.min(300,Math.max(30,Number(x.lease_seconds)||90));
      const t=now();
      await env.DB.prepare("UPDATE task_leases SET state='queued', assigned_device_id=NULL, lease_expires_at=NULL, updated_at=? WHERE account_id=? AND state IN ('leased','running') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?").bind(t,account,t).run();
      const task=await env.DB.prepare("SELECT t.task_id,t.task_kind,t.payload_ciphertext,t.payload_nonce,t.key_version FROM task_leases t JOIN devices d ON d.device_id=? AND d.account_id=t.account_id WHERE t.account_id=? AND t.state='queued' AND NOT EXISTS (SELECT 1 FROM json_each(t.required_capabilities_json) required WHERE NOT EXISTS (SELECT 1 FROM json_each(d.capabilities_json) available WHERE available.value=required.value)) ORDER BY t.created_at LIMIT 1").bind(device.device_id,account).first<any>();
      if (!task) return json({task:null});
      const updated=await env.DB.prepare("UPDATE task_leases SET state='leased',assigned_device_id=?,lease_expires_at=?,updated_at=? WHERE task_id=? AND state='queued'").bind(device.device_id,t+leaseSeconds,t,task.task_id).run();
      return updated.meta.changes ? json({task:{
        ...task,
        payload_ciphertext: encodeBytesBase64Url(new Uint8Array(task.payload_ciphertext)),
        payload_nonce: encodeBytesBase64Url(new Uint8Array(task.payload_nonce)),
        state:"leased",
        lease_expires_at:t+leaseSeconds,
      }}) : json({task:null});
    }
    const taskPath=path.match(/^\/tasks\/([0-9a-f-]{36})$/);
    if (taskPath && req.method==="GET") {
      const task=await env.DB.prepare("SELECT task_id,task_kind,state,assigned_device_id,lease_expires_at,created_at,updated_at FROM task_leases WHERE task_id=? AND account_id=?").bind(taskPath[1],account).first();
      return task ? json(task) : fail(404,"not_found","Task not found");
    }
    if (taskPath && req.method==="PATCH") {
      const x=await bodyJson<any>(req,env);
      if (!["running","succeeded","failed","queued"].includes(x.state)) return fail(400,"invalid_state","Unsupported task transition");
      const result=await env.DB.prepare("UPDATE task_leases SET state=?,updated_at=?,lease_expires_at=CASE WHEN ?='queued' THEN NULL ELSE lease_expires_at END WHERE task_id=? AND account_id=? AND assigned_device_id=? AND state IN ('leased','running')").bind(x.state,now(),x.state,taskPath[1],account,device.device_id).run();
      return result.meta.changes ? json({task_id:taskPath[1],state:x.state}) : fail(409,"lease_conflict","Task lease is not owned by this device");
    }
    if (path === "/chat/completions" && req.method === "POST") return modelRoute(req,env,account);
    if (path === "/voice/transcribe" && req.method === "POST") return voiceRoute(req,env,"transcribe",account);
    if (path === "/voice/synthesize" && req.method === "POST") return voiceRoute(req,env,"synthesize",account);
    return fail(404,"not_found","Route not found");
  } catch(e) {
    const message=e instanceof Error?e.message:"Request failed";
    if (message==="Request body too large") return fail(413,"body_too_large",message);
    return fail(400,"bad_request",message);
  }
}
export function resolveModelRouting(model: unknown, allowFallback: unknown) {
  const requested = typeof model === "string" ? model.trim() : "";
  const explicit = requested.length > 0 && requested.toLowerCase() !== "auto";
  return {
    explicit,
    requestedModel: explicit ? requested : null,
    automaticFallback: !explicit && allowFallback !== false,
  };
}
export function modelRouteMetadata(
  providerName: string,
  primaryName: string,
  automaticRouting: boolean,
  primaryAvailable: boolean,
  fallbackReason: string,
  latencyMs: number,
) {
  const isPrimary = providerName === primaryName;
  const fallbackUsed = automaticRouting && primaryAvailable && !isPrimary;
  return {
    tier: isPrimary ? "primary" : "backup",
    fallback_used: fallbackUsed,
    fallback_reason: fallbackUsed ? fallbackReason : null,
    latency_ms: latencyMs,
    account_scope: "private",
  };
}

type Provider = {
  url?: string;
  name: string;
  key?: string;
  inputRate?: number | null;
  outputRate?: number | null;
};
async function modelRoute(req:Request,env:Env,account:string):Promise<Response>{
  const x=await bodyJson<any>(req,env);
  if (!Array.isArray(x.messages) || x.messages.length<1 || x.messages.length>100) return fail(400,"invalid_messages","messages must contain 1–100 entries");
  if (x.model !== undefined && typeof x.model !== "string") return fail(400,"invalid_model","model must be a string");
  if (x.allow_fallback !== undefined && typeof x.allow_fallback !== "boolean") return fail(400,"invalid_fallback_policy","allow_fallback must be a boolean");
  const routing=resolveModelRouting(x.model,x.allow_fallback);
  const primary:Provider={url:env.MODEL_PRIMARY_URL,name:env.MODEL_PRIMARY_NAME||"primary",key:env.MODEL_PRIMARY_API_KEY,inputRate:positiveConfig(env.MODEL_PRIMARY_INPUT_USD_MICROS_PER_1M),outputRate:positiveConfig(env.MODEL_PRIMARY_OUTPUT_USD_MICROS_PER_1M)};
  const backup:Provider={url:env.MODEL_BACKUP_URL,name:env.MODEL_BACKUP_NAME||"backup",key:env.MODEL_BACKUP_API_KEY,inputRate:positiveConfig(env.MODEL_BACKUP_INPUT_USD_MICROS_PER_1M),outputRate:positiveConfig(env.MODEL_BACKUP_OUTPUT_USD_MICROS_PER_1M)};
  const choices=[primary,backup].filter(p=>p.url&&p.key);
  if (!choices.length) return fail(503,"model_unconfigured","No model provider is configured");
  if (new Set(choices.map(provider=>provider.name)).size !== choices.length) return fail(503,"model_configuration_invalid","Configured provider names must be unique");
  if (routing.explicit && !choices.some(p=>p.name===routing.requestedModel)) return fail(400,"model_unavailable","Explicitly requested model is not configured; no fallback was attempted");
  const candidates=routing.explicit
    ? choices.filter(p=>p.name===routing.requestedModel)
    : routing.automaticFallback ? choices : choices.filter(p=>p.name===primary.name);
  if (!candidates.length) return fail(503,"model_unconfigured","No primary model is configured and automatic fallback is disabled");
  const configuredOutput=positiveConfig(env.MAX_OUTPUT_TOKENS)||1024;
  const requestedOutput=x.max_completion_tokens ?? x.max_tokens ?? configuredOutput;
  if (!Number.isSafeInteger(requestedOutput) || requestedOutput<1 || requestedOutput>configuredOutput) return fail(400,"invalid_token_limit","Requested output tokens exceed the configured per-request maximum");
  const promptBytes=enc.encode(JSON.stringify(x)).byteLength;
  const maxPromptBytes=positiveConfig(env.MAX_PROMPT_BYTES)||128_000;
  if(promptBytes>maxPromptBytes)return fail(413,"prompt_too_large","Prompt exceeds the configured byte limit");
  if(candidates.some(p=>!p.inputRate||!p.outputRate))return fail(503,"spend_pricing_unconfigured","Every eligible provider must have positive, reviewed input and output pricing before use");
  const reservations=candidates.map(p=>({
    provider:p,
    maximum:costMicros(promptBytes,requestedOutput,p.inputRate!,p.outputRate!),
  }));
  const totalReserve=reservations.reduce((sum,item)=>sum+item.maximum,0);
  const reservedInputTokens=promptBytes*reservations.length;
  const reservedOutputTokens=requestedOutput*reservations.length;
  if(!Number.isSafeInteger(totalReserve)||totalReserve<=0||!Number.isSafeInteger(reservedInputTokens)||!Number.isSafeInteger(reservedOutputTokens))return fail(503,"spend_pricing_invalid","Provider spend/token reservation could not be calculated safely");
  const reservationId=await reserveProviderSpend(account,env,totalReserve,candidates.map(p=>p.name).join(","),reservedInputTokens,reservedOutputTokens);
  if(!reservationId)return fail(429,"spend_budget_exceeded","Monthly spend or token budget is unset or exhausted; no provider request was sent");
  let attemptedSpend=0,attemptedInputTokens=0,attemptedOutputTokens=0;
  let lastError="provider_unavailable";
  for(let i=0;i<reservations.length;i++){
    const {provider:p,maximum}=reservations[i];
    try{
      const started=Date.now();
      const forwarded:Record<string,unknown>={...x,model:p.name,stream:false};
      delete forwarded.allow_fallback;
      if(Object.prototype.hasOwnProperty.call(x,"max_completion_tokens")){
        forwarded.max_completion_tokens=requestedOutput;
        delete forwarded.max_tokens;
      }else{
        forwarded.max_tokens=requestedOutput;
      }
      const response=await fetch(p.url!.replace(/\/$/,"")+"/chat/completions",{method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+p.key!},body:JSON.stringify(forwarded),signal:AbortSignal.timeout(60_000)});
      if(!response.ok){
        attemptedSpend+=maximum;
        attemptedInputTokens+=promptBytes;
        attemptedOutputTokens+=requestedOutput;
        lastError="provider_http_"+response.status;
        if((response.status<500&&response.status!==429)||i===reservations.length-1){
          try{await settleProviderSpend(env,reservationId,attemptedSpend,attemptedInputTokens,attemptedOutputTokens);}catch{return fail(503,"spend_settlement_failed","Provider spend could not be reconciled; further inference is blocked");}
          return fail(502,"provider_error",lastError);
        }
        continue;
      }
      const payload=await response.json() as Record<string,unknown>;
      const usage=payload.usage as {prompt_tokens?:unknown;completion_tokens?:unknown}|undefined;
      const promptTokens=Number(usage?.prompt_tokens);
      const completionTokens=Number(usage?.completion_tokens);
      const usageValid=Number.isSafeInteger(promptTokens)&&promptTokens>=0&&Number.isSafeInteger(completionTokens)&&completionTokens>=0;
      const actualInputTokens=usageValid?promptTokens:promptBytes;
      const actualOutputTokens=usageValid?completionTokens:requestedOutput;
      const actualSpend=usageValid
        ? costMicros(actualInputTokens,actualOutputTokens,p.inputRate!,p.outputRate!)
        : maximum;
      try{await settleProviderSpend(env,reservationId,attemptedSpend+actualSpend,attemptedInputTokens+actualInputTokens,attemptedOutputTokens+actualOutputTokens);}catch{return fail(503,"spend_settlement_failed","Provider spend/token usage could not be reconciled; further inference is blocked");}
      return json({ ...payload, neo:{provider:p.name,model:p.name,...modelRouteMetadata(p.name,primary.name,routing.automaticFallback,Boolean(primary.url&&primary.key),lastError,Date.now()-started)}});
    }catch(e){
      attemptedSpend+=maximum;
      attemptedInputTokens+=promptBytes;
      attemptedOutputTokens+=requestedOutput;
      lastError=e instanceof Error?e.name:"provider_network_error";
      if(routing.explicit||i===reservations.length-1){
        try{await settleProviderSpend(env,reservationId,attemptedSpend,attemptedInputTokens,attemptedOutputTokens);}catch{return fail(503,"spend_settlement_failed","Provider spend could not be reconciled; further inference is blocked");}
        return fail(502,"provider_error",lastError);
      }
    }
  }
  try{await settleProviderSpend(env,reservationId,attemptedSpend,attemptedInputTokens,attemptedOutputTokens);}catch{return fail(503,"spend_settlement_failed","Provider spend could not be reconciled; further inference is blocked");}
  return fail(502,"provider_error",lastError);
}
async function voiceRoute(req:Request,env:Env,mode:"transcribe"|"synthesize",account:string):Promise<Response>{
  const url=env.MODEL_PRIMARY_URL;
  const key=env.MODEL_PRIMARY_API_KEY;
  if(!url||!key)return fail(503,"voice_unconfigured","Voice provider is not configured");
  const maxCost=positiveConfig(mode==="transcribe"?env.VOICE_TRANSCRIBE_MAX_COST_USD_MICROS:env.VOICE_SYNTHESIS_MAX_COST_USD_MICROS);
  if(!maxCost)return fail(503,"voice_pricing_unconfigured","A reviewed maximum per-request voice cost is required before voice use");
  const reservationId=await reserveProviderSpend(account,env,maxCost,"voice:"+mode);
  if(!reservationId)return fail(429,"spend_budget_exceeded","Monthly provider spend budget is unset or exhausted; no voice request was sent");
  let data: Uint8Array;
  try { data=await readRequestBodyBounded(req,15_000_000); }
  catch { await settleProviderSpend(env,reservationId,0); return fail(413,"body_too_large","Voice payload exceeds 15 MB"); }
  const endpoint=mode==="transcribe"?"/audio/transcriptions":"/audio/speech";
  const bodyBytes = new Uint8Array(data.byteLength);
  bodyBytes.set(data);
  let body:BodyInit=bodyBytes.buffer;
  const headers:Record<string,string>={"authorization":"Bearer "+key};
  if(mode==="transcribe"){
    const form=new FormData();
    const contentType=req.headers.get("content-type")||"audio/webm";
    const extension=contentType.includes("wav")?"wav":contentType.includes("mpeg")?"mp3":"webm";
    form.append("file",new Blob([bodyBytes],{type:contentType}),"neo-audio."+extension);
    form.append("model","whisper-1");
    body=form;
  } else {
    headers["content-type"]="application/json";
  }
  let upstream:Response;
  try{
    upstream=await fetch(url.replace(/\/$/,"")+endpoint,{method:"POST",headers,body,signal:AbortSignal.timeout(90_000)});
  }catch{
    try{await settleProviderSpend(env,reservationId,maxCost);}catch{return fail(503,"spend_settlement_failed","Voice spend could not be reconciled; further inference is blocked");}
    return fail(502,"voice_provider_error","Voice provider request failed");
  }
  try{await settleProviderSpend(env,reservationId,maxCost);}catch{return fail(503,"spend_settlement_failed","Voice spend could not be reconciled; further inference is blocked");}
  return new Response(upstream.body,{status:upstream.status,headers:{"content-type":upstream.headers.get("content-type")||"application/octet-stream","cache-control":"no-store"}});
}
export async function cleanupExpiredDeviceNonces(env: Env): Promise<number> {
  const result = await env.DB.prepare("DELETE FROM device_nonces WHERE expires_at < ?").bind(now()).run();
  return Number(result.meta.changes || 0);
}

/**
 * Reconcile reservations left open by a Worker termination or lost upstream
 * response. Since provider billing may have happened even when our response
 * was lost, never release these holds: conservatively settle the full reserved
 * USD and token ceilings. A 30-minute age threshold avoids racing ordinary
 * provider requests; the conditional state predicate makes repeated cron runs
 * idempotent.
 */
export async function reconcileStaleProviderSpendReservations(
  env: Env,
  staleBefore = now() - 30 * 60,
  settledAt = now(),
): Promise<number> {
  const result = await env.DB.prepare(
    "UPDATE provider_spend_reservations SET state='settled', settled_microusd=reserved_microusd, settled_input_tokens=reserved_input_tokens, settled_output_tokens=reserved_output_tokens, settled_at=? WHERE state='reserved' AND created_at <= ?",
  ).bind(settledAt, staleBefore).run();
  return Number(result.meta.changes || 0);
}
export default {
  fetch: (req:Request,env:Env) => route(req,env),
  scheduled: async (_controller: ScheduledController, env: Env) => {
    await cleanupExpiredDeviceNonces(env);
    await reconcileStaleProviderSpendReservations(env);
  },
};
