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
  const response = await fetch(issuer + "/cdn-cgi/access/certs", { cf: { cacheTtl: 300 } } as RequestInit);
  if (!response.ok) throw new Error("Unable to validate access issuer");
  const jwks = await response.json() as { keys: JsonWebKey[] };
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
  const deviceId = req.headers.get("x-neo-device-id") || "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(deviceId)) throw new Error("Invalid or missing device id");
  const row = await env.DB.prepare("SELECT device_id, account_id, public_key_jwk, revoked_at FROM devices WHERE device_id = ? AND account_id = ?").bind(deviceId, account).first<Device>();
  if (!row || row.revoked_at !== null) throw new Error("Device is not enrolled or has been revoked");
  if (req.method !== "GET" && req.method !== "HEAD") {
    const ts = Number(req.headers.get("x-neo-timestamp"));
    const nonce = req.headers.get("x-neo-nonce") || "";
    const signature = req.headers.get("x-neo-signature") || "";
    if (!Number.isInteger(ts) || Math.abs(now() - ts) > 300 || !/^[A-Za-z0-9_-]{16,96}$/.test(nonce) || !signature) throw new Error("Missing or expired device proof");
    const body = await req.clone().arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
    const bodyHash = Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
    const canonical = [req.method.toUpperCase(), new URL(req.url).pathname + new URL(req.url).search, ts, nonce, bodyHash].join("\n");
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
  const max = Number(env.MAX_BODY_BYTES || 1_000_000);
  const raw = await req.arrayBuffer();
  if (raw.byteLength > max) throw new Error("Request body too large");
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
      const cursor = Number(url.searchParams.get("cursor") || 0);
      const includePending = url.searchParams.get("include_pending") === "true";
      const states = includePending ? ["approved","pending"] : ["approved"];
      const rows = await env.DB.prepare("SELECT memory_id, revision, trust_state, payload_ciphertext, payload_nonce, key_version, source_device_id, source_kind, created_at, updated_at, tombstoned_at FROM memory_records WHERE account_id = ? AND updated_at > ? AND trust_state IN ('approved','deleted',?,?) ORDER BY updated_at, memory_id LIMIT 200").bind(account,cursor,states[0],states[1] || states[0]).all();
      const next = rows.results.length ? Math.max(...rows.results.map((r:any)=>Number(r.updated_at))) : null;
      return json({ records: rows.results, next_cursor: next });
    }
    if (path === "/memory" && req.method === "POST") {
      const x = await bodyJson<any>(req,env);
      if (!validCipher(x) || typeof x.memory_id !== "string" || x.memory_id.length > 128) return fail(400,"invalid_memory","Invalid encrypted memory payload");
      const rev = await env.DB.prepare("SELECT COALESCE(MAX(revision),0)+1 AS revision FROM memory_records WHERE account_id=? AND memory_id=?").bind(account,x.memory_id).first<{revision:number}>();
      const t=now();
      await env.DB.prepare("INSERT INTO memory_records(memory_id,revision,account_id,trust_state,payload_ciphertext,payload_nonce,key_version,source_device_id,source_kind,created_at,updated_at) VALUES(?,?,?,'pending',?,?,?,?,?,?,?)").bind(x.memory_id,rev?.revision || 1,account,b64u(x.payload_ciphertext),b64u(x.payload_nonce),x.key_version,device.device_id,String(x.source_kind || "user").slice(0,40),t,t).run();
      return json({memory_id:x.memory_id,revision:rev?.revision || 1,trust_state:"pending",created_at:t},201);
    }
    const approve = path.match(/^\/memory\/([A-Za-z0-9_-]{1,128})\/approve$/);
    if (approve && req.method === "POST") {
      const expected=Number((req.headers.get("if-match")||"").replaceAll('"',""));
      if (!Number.isInteger(expected) || expected < 1) return fail(428,"precondition_required","If-Match revision is required");
      const r=await env.DB.prepare("UPDATE memory_records SET trust_state='approved', updated_at=? WHERE account_id=? AND memory_id=? AND revision=? AND trust_state='pending'").bind(now(),account,approve[1],expected).run();
      if (!r.meta.changes) return fail(409,"revision_conflict","Memory is not pending at the expected revision");
      await env.DB.prepare("INSERT INTO audit_events(event_id,account_id,device_id,event_type,event_metadata_json,created_at) VALUES(?,?,?,?,?,?)").bind(id(),account,device.device_id,"memory.approved",JSON.stringify({memory_id:approve[1],revision:expected}),now()).run();
      return json({memory_id:approve[1],revision:expected,trust_state:"approved"});
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
      const key=req.headers.get("idempotency-key")||"";
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) return fail(400,"idempotency_required","A valid Idempotency-Key is required");
      const task=id();
      try {
        await env.DB.prepare("INSERT INTO task_leases(task_id,account_id,task_kind,state,idempotency_key,payload_ciphertext,payload_nonce,key_version,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?,?,?,?)").bind(task,account,x.task_kind,key,b64u(x.payload_ciphertext),b64u(x.payload_nonce),x.key_version,now(),now()).run();
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
      const task=await env.DB.prepare("SELECT task_id,task_kind,payload_ciphertext,payload_nonce,key_version FROM task_leases WHERE account_id=? AND state='queued' ORDER BY created_at LIMIT 1").bind(account).first<any>();
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
      if(!response.ok){lastError="provider_http_"+response.status;if(response.status<500||i===candidates.length-1) return fail(502,"provider_error",lastError);continue;}
      const payload=await response.json();
      return json({ ...payload, neo:{provider:p.name,model:p.name,tier:i===0?"primary":"backup",fallback_used:i>0,fallback_reason:i>0?lastError:null,latency_ms:Date.now()-started,account_scope:"private"}});
    }catch(e){lastError=e instanceof Error?e.name:"provider_network_error";if(explicit||i===candidates.length-1)return fail(502,"provider_error",lastError);}
  }
  return fail(502,"provider_error",lastError);
}
async function voiceRoute(req:Request,env:Env,mode:"transcribe"|"synthesize"):Promise<Response>{
  const url=mode==="transcribe"?env.MODEL_PRIMARY_URL:env.MODEL_PRIMARY_URL;
  const key=env.MODEL_PRIMARY_API_KEY;
  if(!url||!key)return fail(503,"voice_unconfigured","Voice provider is not configured");
  const data=await req.arrayBuffer();
  if(data.byteLength>15_000_000)return fail(413,"body_too_large","Voice payload exceeds 15 MB");
  const endpoint=mode==="transcribe"?"/audio/transcriptions":"/audio/speech";
  const upstream=await fetch(url.replace(/\/$/,"")+endpoint,{method:"POST",headers:{"authorization":"Bearer "+key,"content-type":req.headers.get("content-type")||"application/octet-stream"},body:data,signal:AbortSignal.timeout(90_000)});
  return new Response(upstream.body,{status:upstream.status,headers:{"content-type":upstream.headers.get("content-type")||"application/octet-stream","cache-control":"no-store"}});
}
export default { fetch: (req:Request,env:Env) => route(req,env) };
