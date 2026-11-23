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
}
type Claims = { sub: string; iss: string; aud: string | string[]; exp: number; email?: string };
type Device = { device_id: string; account_id: string; public_key_jwk: string; revoked_at: number | null };
const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status);
const b64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
function jsonBodyLimit(env: Env): number {
  const configured = Number(env.MAX_BODY_BYTES || 1_000_000);
  return Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 5_000_000) : 1_000_000;
}
function urlPathBodyLimit(req: Request, env: Env): number {
  const path = new URL(req.url).pathname.replace(/^\\/v1/, "");
  return path.startsWith("/voice/") ? 15_000_000 : jsonBodyLimit(env);
}
export async function readRequestBodyBounded(req: Request, maxBytes: number): Promise<Uint8Array> {
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
  if (claims.iss !== issuer || !aud.includes(env.ACCESS_AUD) || !claims.sub || claims.exp <= now()) throw new Error("Invalid access token claims");
  return claims;
}
async function authenticate(req: Request, env: Env): Promise<{ account: string; device: Device }> {
  const authorization = req.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) throw new Error("Missing Cloudflare Access bearer token");
  const claims = await accessClaims(authorization.slice(7), env);
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
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
    const bodyHash = Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
    const requestUrl = new URL(req.url);
    const canonical = [req.method.toUpperCase(), requestUrl.host, requestUrl.pathname + requestUrl.search, ts, nonce, bodyHash].join("\n");
    const jwk = JSON.parse(row.public_key_jwk) as JsonWebKey;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64u(signature), enc.encode(canonical))) throw new Error("Invalid device signature");
    try {
      await env.DB.prepare("INSERT INTO device_nonces(device_id, nonce, expires_at) VALUES(?, ?, ?)").bind(deviceId, nonce, ts + 600).run();
    } catch { throw new Error("Replayed device request"); }
  }
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
function validCipher(x: any): boolean {
  return typeof x?.payload_ciphertext === "string" && x.payload_ciphertext.length >= 16 &&
    typeof x?.payload_nonce === "string" && x.payload_nonce.length >= 12 &&
    Number.isInteger(x?.key_version) && x.key_version > 0;
}
async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/v1/, "") || "/";
  if (req.method === "GET" && path === "/health") return json({ status: "ok", environment: env.NEO_ENV || "unset" });
  if (!path.startsWith("/")) return fail(404, "not_found", "Route not found");
  // First enrolment uses Access identity and binds a client-generated P-256 key.
  if (path === "/devices" && req.method === "POST") {
    try {
      const bearer = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
      if (!bearer) return fail(401, "unauthorized", "Missing Cloudflare Access bearer token");
      const claims = await accessClaims(bearer, env);
      const x = await bodyJson<any>(req, env);
      const deviceId = req.headers.get("x-neo-device-id") || "";
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(deviceId) || typeof x.label !== "string" ||
          x.label.length < 1 || x.label.length > 80 ||
          !["android","ios","windows","macos","linux","browser","other"].includes(x.platform) ||
          !x.public_key_jwk || x.public_key_jwk.kty !== "EC" || x.public_key_jwk.crv !== "P-256" ||
          typeof x.public_key_jwk.x !== "string" || typeof x.public_key_jwk.y !== "string" ||
          !Array.isArray(x.capabilities)) return fail(400, "invalid_device", "Invalid device registration");
      await env.DB.prepare("INSERT OR IGNORE INTO accounts(account_id, created_at, status) VALUES(?, ?, 'active')").bind(claims.sub, now()).run();
      await env.DB.prepare("INSERT INTO devices(device_id, account_id, label, platform, public_key_jwk, capabilities_json, created_at) VALUES(?,?,?,?,?,?,?)")
        .bind(deviceId, claims.sub, x.label, x.platform, JSON.stringify(x.public_key_jwk), JSON.stringify(x.capabilities.slice(0,32)), now()).run();
      await env.DB.prepare("INSERT INTO audit_events(event_id,account_id,device_id,event_type,created_at) VALUES(?,?,?,?,?)")
        .bind(id(), claims.sub, deviceId, "device.enrolled", now()).run();
      return json({ device_id: deviceId, account_id: claims.sub, status: "enrolled" }, 201);
    } catch (e) { return fail(401, "enrolment_failed", e instanceof Error ? e.message : "Device enrolment failed"); }
  }
  let auth: { account: string; device: Device };
  try { auth = await authenticate(req, env); } catch (e) {
    const message = e instanceof Error ? e.message : "Authentication failed";
    return fail(message.includes("revoked") || message.includes("not enrolled") ? 403 : 401, "unauthorized", message);
  }
  const { account, device } = auth;
  try {
    if (path === "/devices" && req.method === "GET") {
      const result = await env.DB.prepare("SELECT device_id, label, platform, capabilities_json, created_at, last_seen_at, revoked_at FROM devices WHERE account_id = ? ORDER BY created_at").bind(account).all();
      return json({ devices: result.results });
    }
    if (path === "/devices" && req.method === "POST") {
      const x = await bodyJson<any>(req, env);
      if (typeof x.label !== "string" || x.label.length < 1 || x.label.length > 80 || !["android","ios","windows","macos","linux","browser","other"].includes(x.platform) || !x.public_key_jwk || x.public_key_jwk.kty !== "EC" || x.public_key_jwk.crv !== "P-256" || !Array.isArray(x.capabilities)) return fail(400,"invalid_device","Invalid device registration");
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
      return json({ records: rows.results, next_cursor: next });
    }
    if (path === "/memory" && req.method === "POST") {
      const x = await bodyJson<any>(req,env);
      if (!validCipher(x) || typeof x.memory_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(x.memory_id)) return fail(400,"invalid_memory","Invalid encrypted memory payload");
      const t=now();
      const inserted=await env.DB.prepare("INSERT INTO memory_records(memory_id,revision,account_id,trust_state,payload_ciphertext,payload_nonce,key_version,source_device_id,source_kind,created_at,updated_at) SELECT ?, COALESCE(MAX(revision),0)+1, ?, 'pending', ?, ?, ?, ?, ?, ?, ? FROM memory_records WHERE account_id=? AND memory_id=? RETURNING revision")
        .bind(x.memory_id,account,b64u(x.payload_ciphertext),b64u(x.payload_nonce),x.key_version,device.device_id,String(x.source_kind || "user").slice(0,40),t,t,account,x.memory_id).first<{revision:number}>();
      const first=inserted || await env.DB.prepare("INSERT INTO memory_records(memory_id,revision,account_id,trust_state,payload_ciphertext,payload_nonce,key_version,source_device_id,source_kind,created_at,updated_at) VALUES(?,1,?,'pending',?,?,?,?,?,?,?) RETURNING revision")
        .bind(x.memory_id,account,b64u(x.payload_ciphertext),b64u(x.payload_nonce),x.key_version,device.device_id,String(x.source_kind || "user").slice(0,40),t,t).first<{revision:number}>();
      if (!first) return fail(409,"revision_conflict","Memory revision could not be allocated; retry the request");
      return json({memory_id:x.memory_id,revision:first.revision,trust_state:"pending",created_at:t},201);
    }
    const approve = path.match(/^\/memory\/([A-Za-z0-9_-]{1,128})\/approve$/);
    if (approve && req.method === "POST") {
      const expected=Number((req.headers.get("if-match")||"").replaceAll('"',""));
      if (!Number.isInteger(expected) || expected < 1) return fail(428,"precondition_required","If-Match revision is required");
      const t=now();
      const r=await env.DB.prepare("INSERT INTO memory_records(memory_id,revision,account_id,trust_state,payload_ciphertext,payload_nonce,key_version,source_device_id,source_kind,created_at,updated_at) SELECT memory_id, revision+1, account_id, 'approved', payload_ciphertext, payload_nonce, key_version, source_device_id, source_kind, created_at, ? FROM memory_records WHERE account_id=? AND memory_id=? AND revision=? AND trust_state='pending' AND NOT EXISTS (SELECT 1 FROM memory_records newer WHERE newer.account_id=? AND newer.memory_id=? AND newer.revision=?)").bind(t,account,approve[1],expected,account,approve[1],expected+1).run();
      if (!r.meta.changes) return fail(409,"revision_conflict","Memory is not pending at the expected revision");
      await env.DB.prepare("INSERT INTO audit_events(event_id,account_id,device_id,event_type,event_metadata_json,created_at) VALUES(?,?,?,?,?,?)").bind(id(),account,device.device_id,"memory.approved",JSON.stringify({memory_id:approve[1],revision:expected+1}),t).run();
      return json({memory_id:approve[1],revision:expected+1,trust_state:"approved"});
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
      const task=id();
      try {
        await env.DB.prepare("INSERT INTO task_leases(task_id,account_id,task_kind,state,idempotency_key,payload_ciphertext,payload_nonce,key_version,created_at,updated_at,required_capabilities_json) VALUES(?,?,?,'queued',?,?,?,?,?,?,?)").bind(task,account,x.task_kind,key,b64u(x.payload_ciphertext),b64u(x.payload_nonce),x.key_version,now(),now(),JSON.stringify(requiredCapabilities)).run();
      } catch {
        const existing=await env.DB.prepare("SELECT task_id,state FROM task_leases WHERE account_id=? AND idempotency_key=?").bind(account,key).first();
        if (existing) return json(existing,200);
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
      return updated.meta.changes ? json({task:{...task,state:"leased",lease_expires_at:t+leaseSeconds}}) : json({task:null});
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
    if (path === "/voice/transcribe" && req.method === "POST") return voiceRoute(req,env,"transcribe");
    if (path === "/voice/synthesize" && req.method === "POST") return voiceRoute(req,env,"synthesize");
    return fail(404,"not_found","Route not found");
  } catch(e) {
    const message=e instanceof Error?e.message:"Request failed";
    if (message==="Request body too large") return fail(413,"body_too_large",message);
    return fail(400,"bad_request",message);
  }
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

async function modelRoute(req:Request,env:Env,account:string):Promise<Response>{
  const x=await bodyJson<any>(req,env);
  if (!Array.isArray(x.messages) || x.messages.length<1 || x.messages.length>100) return fail(400,"invalid_messages","messages must contain 1–100 entries");
  const explicit=typeof x.model==="string" && x.model.length>0;
  const primary={url:env.MODEL_PRIMARY_URL,name:env.MODEL_PRIMARY_NAME||"primary",key:env.MODEL_PRIMARY_API_KEY};
  const backup={url:env.MODEL_BACKUP_URL,name:env.MODEL_BACKUP_NAME||"backup",key:env.MODEL_BACKUP_API_KEY};
  const choices=[primary,backup].filter(p=>p.url&&p.key);
  if (!choices.length) return fail(503,"model_unconfigured","No model provider is configured");
  if (explicit && !choices.some(p=>p.name===x.model)) return fail(400,"model_unavailable","Explicitly requested model is not configured; no fallback was attempted");
  const candidates=explicit?choices.filter(p=>p.name===x.model):choices;
  let lastError="provider_unavailable";
  for(let i=0;i<candidates.length;i++){
    const p=candidates[i];
    try{
      const started=Date.now();
      const response=await fetch(p.url!.replace(/\/$/,"")+"/chat/completions",{method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+p.key!},body:JSON.stringify({...x,model:p.name,stream:false}),signal:AbortSignal.timeout(60_000)});
      if(!response.ok){lastError="provider_http_"+response.status;if((response.status<500&&response.status!==429)||i===candidates.length-1) return fail(502,"provider_error",lastError);continue;}
      const payload=await response.json() as Record<string, unknown>;
      return json({ ...payload, neo:{provider:p.name,model:p.name,...modelRouteMetadata(p.name,primary.name,!explicit,Boolean(primary.url&&primary.key),lastError,Date.now()-started)}});
    }catch(e){lastError=e instanceof Error?e.name:"provider_network_error";if(explicit||i===candidates.length-1)return fail(502,"provider_error",lastError);}
  }
  return fail(502,"provider_error",lastError);
}
async function voiceRoute(req:Request,env:Env,mode:"transcribe"|"synthesize"):Promise<Response>{
  const url=mode==="transcribe"?env.MODEL_PRIMARY_URL:env.MODEL_PRIMARY_URL;
  const key=env.MODEL_PRIMARY_API_KEY;
  if(!url||!key)return fail(503,"voice_unconfigured","Voice provider is not configured");
  let data: Uint8Array;
  try { data=await readRequestBodyBounded(req,15_000_000); }
  catch { return fail(413,"body_too_large","Voice payload exceeds 15 MB"); }
  const endpoint=mode==="transcribe"?"/audio/transcriptions":"/audio/speech";
  let body:BodyInit=data;
  const headers:Record<string,string>={"authorization":"Bearer "+key};
  if(mode==="transcribe"){
    const form=new FormData();
    const contentType=req.headers.get("content-type")||"audio/webm";
    const extension=contentType.includes("wav")?"wav":contentType.includes("mpeg")?"mp3":"webm";
    form.append("file",new Blob([data as BlobPart],{type:contentType}),"neo-audio."+extension);
    form.append("model","whisper-1");
    body=form;
  } else {
    headers["content-type"]="application/json";
  }
  const upstream=await fetch(url.replace(/\/$/,"")+endpoint,{method:"POST",headers,body,signal:AbortSignal.timeout(90_000)});
  return new Response(upstream.body,{status:upstream.status,headers:{"content-type":upstream.headers.get("content-type")||"application/octet-stream","cache-control":"no-store"}});
}
export default { fetch: (req:Request,env:Env) => route(req,env) };
