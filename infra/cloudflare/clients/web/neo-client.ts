export type DevicePlatform = "android" | "ios" | "windows" | "macos" | "linux" | "browser" | "other";
type StoredIdentity = { deviceId:string; privateKey:CryptoKey; publicJwk:JsonWebKey };
type OutboxItem = {
  id:string;
  scopeKey:string;
  kind:"memory.create"|"task.enqueue";
  path:string;
  method:"POST";
  headers:Record<string,string>;
  body:string;
  createdAt:number;
  attempts:number;
};
type CachedMemory = { key:string; record:Record<string,unknown> };
const enc = new TextEncoder();
const toB64u = (bytes:Uint8Array) => {
  let binary=""; for(const b of bytes) binary+=String.fromCharCode(b);
  return btoa(binary).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
};
const randomId = () => toB64u(crypto.getRandomValues(new Uint8Array(24)));
async function sha256(data:BufferSource){return new Uint8Array(await crypto.subtle.digest("SHA-256",data));}
function openDb():Promise<IDBDatabase>{
  return new Promise((resolve,reject)=>{
    const r=indexedDB.open("neo-device-identity",2);
    r.onupgradeneeded=()=>{
      const db=r.result;
      if(!db.objectStoreNames.contains("identity"))db.createObjectStore("identity");
      if(!db.objectStoreNames.contains("memory_cache"))db.createObjectStore("memory_cache",{keyPath:"key"});
      if(!db.objectStoreNames.contains("outbox"))db.createObjectStore("outbox",{keyPath:"id"});
      if(!db.objectStoreNames.contains("meta"))db.createObjectStore("meta");
    };
    r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
  });
}
function transactionDone(tx:IDBTransaction):Promise<void>{
  return new Promise((resolve,reject)=>{
    tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error||new Error("IndexedDB transaction aborted"));
  });
}
async function loadIdentity(scopeKey:string):Promise<StoredIdentity|null>{
  const db=await openDb();
  try{return await new Promise((resolve,reject)=>{
    const r=db.transaction("identity","readonly").objectStore("identity").get("current:"+scopeKey);
    r.onsuccess=()=>resolve(r.result||null); r.onerror=()=>reject(r.error);
  });}finally{db.close();}
}
async function saveIdentity(value:StoredIdentity,scopeKey:string):Promise<void>{
  const db=await openDb();
  try{const tx=db.transaction("identity","readwrite");tx.objectStore("identity").put(value,"current:"+scopeKey);await transactionDone(tx);}finally{db.close();}
}
async function enqueueOutbox(item:OutboxItem):Promise<void>{
  const db=await openDb();
  try{const tx=db.transaction("outbox","readwrite");tx.objectStore("outbox").put(item);await transactionDone(tx);}finally{db.close();}
}
async function readOutbox(scopeKey:string):Promise<OutboxItem[]>{
  const db=await openDb();
  try{return await new Promise((resolve,reject)=>{
    const r=db.transaction("outbox","readonly").objectStore("outbox").getAll();
    r.onsuccess=()=>resolve((r.result as OutboxItem[]).filter(item=>item.scopeKey===scopeKey).sort((a,b)=>a.createdAt-b.createdAt));
    r.onerror=()=>reject(r.error);
  });}finally{db.close();}
}
async function removeOutbox(id:string):Promise<void>{
  const db=await openDb();
  try{const tx=db.transaction("outbox","readwrite");tx.objectStore("outbox").delete(id);await transactionDone(tx);}finally{db.close();}
}
async function cacheMemory(records:Record<string,unknown>[],scopeKey:string):Promise<void>{
  if(!records.length)return;
  const db=await openDb();
  try{
    const tx=db.transaction("memory_cache","readwrite"),store=tx.objectStore("memory_cache");
    for(const record of records){
      if(typeof record.memory_id!=="string"||typeof record.revision!=="number")continue;
      // Cache only the encrypted wire record; never decrypt or persist plaintext here.
      store.put({key:scopeKey+":"+record.memory_id+":"+record.revision,record} satisfies CachedMemory);
    }
    await transactionDone(tx);
  }finally{db.close();}
}
export function selectRecallableMemory(records:Record<string,unknown>[],includePending=false):Record<string,unknown>[] {
  const groups=new Map<string,Record<string,unknown>[]>();
  for(const record of records){
    if(typeof record.memory_id!=="string"||typeof record.revision!=="number")continue;
    const group=groups.get(record.memory_id)||[];
    group.push(record);
    groups.set(record.memory_id,group);
  }
  const selected:Record<string,unknown>[]=[];
  for(const group of groups.values()){
    const durable=group.filter(record=>record.trust_state==="approved"||record.trust_state==="deleted")
      .sort((a,b)=>Number(b.revision)-Number(a.revision));
    const latestDurable=durable[0];
    if(latestDurable?.trust_state==="approved")selected.push(latestDurable);
    if(includePending)selected.push(...group.filter(record=>record.trust_state==="pending"&&
      (!latestDurable||Number(record.revision)>Number(latestDurable.revision))));
  }
  return selected.sort((a,b)=>Number(a.updated_at||0)-Number(b.updated_at||0));
}

async function readCachedMemory(includePending:boolean,scopeKey:string):Promise<Record<string,unknown>[]>{
  const db=await openDb();
  try{
    const rows=await new Promise<CachedMemory[]>((resolve,reject)=>{
      const r=db.transaction("memory_cache","readonly").objectStore("memory_cache").getAll();
      r.onsuccess=()=>resolve(r.result as CachedMemory[]);r.onerror=()=>reject(r.error);
    });
    return selectRecallableMemory(
      rows.filter(row=>row.key.startsWith(scopeKey+":")).map(row=>row.record),
      includePending,
    );
  }finally{db.close();}
}
async function saveCursor(cursor:string|null,scopeKey:string):Promise<void>{
  const db=await openDb();
  try{const tx=db.transaction("meta","readwrite");tx.objectStore("meta").put(cursor,"memory_cursor:"+scopeKey);await transactionDone(tx);}finally{db.close();}
}
async function loadCursor(scopeKey:string):Promise<string|undefined>{
  const db=await openDb();
  try{return await new Promise((resolve,reject)=>{
    const r=db.transaction("meta","readonly").objectStore("meta").get("memory_cursor:"+scopeKey);
    r.onsuccess=()=>resolve(typeof r.result==="string"?r.result:undefined);r.onerror=()=>reject(r.error);
  });}finally{db.close();}
}
const retryableStatus=(status:number)=>status===408||status===425||status===429||status>=500;
export async function createDeviceIdentity():Promise<StoredIdentity>{
  // WebCrypto applies extractability to both halves of a generated pair. Generate
  // temporarily exportable keys, then immediately re-import the private JWK as
  // non-exportable; only that non-exportable CryptoKey is persisted in IndexedDB.
  const pair=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);
  const publicJwk=await crypto.subtle.exportKey("jwk",pair.publicKey);
  const privateJwk=await crypto.subtle.exportKey("jwk",pair.privateKey);
  const privateKey=await crypto.subtle.importKey("jwk",privateJwk,{name:"ECDSA",namedCurve:"P-256"},false,["sign"]);
  for(const key of Object.keys(privateJwk)) delete (privateJwk as Record<string,unknown>)[key];
  if(privateKey.extractable)throw new Error("Browser device private key must be non-exportable");
  return {deviceId:randomId(),privateKey,publicJwk};
}

export class NeoDeviceClient {
  private constructor(private baseUrl:string,private accessToken:(()=>Promise<string>)|undefined,private identity:StoredIdentity,private scopeKey:string){}
  static async resolveAccountScope(baseUrl:string,accessToken?:(()=>Promise<string>)):Promise<string>{
    const normalizedBase=baseUrl.endsWith("/")?baseUrl.slice(0,-1):baseUrl;
    const headers=new Headers();
    if(accessToken){
      const token=await accessToken();
      if(!token.trim())throw new Error("NEO access token callback returned an empty token");
      headers.set("authorization","Bearer "+token);
    }
    const response=await fetch(normalizedBase+"/v1/session",{
      method:"GET",headers,credentials:"same-origin",cache:"no-store",
    });
    if(!response.ok)throw new Error("NEO session bootstrap failed: "+response.status);
    const payload=await response.json() as {account_id?:unknown};
    if(typeof payload.account_id!=="string"||!payload.account_id.trim())
      throw new Error("NEO session bootstrap returned no account scope");
    return payload.account_id;
  }
  static async create(baseUrl:string,accessToken:(()=>Promise<string>)|undefined,accountScope:string){
    if(!accountScope.trim())throw new Error("A stable account scope is required for local device storage");
    const scopeKey=toB64u(await sha256(enc.encode(accountScope)));
    let identity=await loadIdentity(scopeKey);
    if(identity?.privateKey.extractable)identity=null;
    if(!identity){
      identity=await createDeviceIdentity();
      await saveIdentity(identity,scopeKey);
    }
    return new NeoDeviceClient(baseUrl.endsWith("/") ? baseUrl.slice(0,-1) : baseUrl,accessToken,identity,scopeKey);
  }
  get deviceId(){return this.identity.deviceId;}
  async enrol(label:string,platform:DevicePlatform,capabilities:string[]=[]){
    const headers=new Headers({"content-type":"application/json","x-neo-device-id":this.deviceId});
    if(this.accessToken)headers.set("authorization","Bearer "+await this.accessToken());
    const response=await fetch(this.baseUrl+"/v1/devices",{method:"POST",headers,body:JSON.stringify({label,platform,public_key_jwk:this.identity.publicJwk,capabilities}),credentials:"same-origin"});
    if(!response.ok) throw new Error("NEO device enrolment failed: "+response.status);
    return response.json();
  }
  async request(path:string,init:RequestInit={}):Promise<Response>{
    const method=(init.method||"GET").toUpperCase(), url=new URL(this.baseUrl+"/v1"+path);
    const body=init.body===undefined?new Uint8Array():typeof init.body==="string"?enc.encode(init.body):init.body instanceof ArrayBuffer?new Uint8Array(init.body):new Uint8Array(await new Response(init.body).arrayBuffer());
    const bodyCopy=new Uint8Array(body.byteLength);bodyCopy.set(body);
    const ts=Math.floor(Date.now()/1000), nonce=randomId();
    const hash=Array.from(await sha256(bodyCopy.buffer),b=>b.toString(16).padStart(2,"0")).join("");
    const canonical=[method,url.host,url.pathname+url.search,ts,nonce,hash].join("\n");
    const signature=new Uint8Array(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},this.identity.privateKey,enc.encode(canonical)));
    const headers=new Headers(init.headers);
    if(this.accessToken)headers.set("authorization","Bearer "+await this.accessToken());
    headers.set("x-neo-device-id",this.deviceId); headers.set("x-neo-timestamp",String(ts));
    headers.set("x-neo-nonce",nonce); headers.set("x-neo-signature",toB64u(signature));
    if(body.byteLength && !headers.has("content-type")) headers.set("content-type","application/json");
    return fetch(url,{...init,method,headers,body:body.byteLength?body:undefined,credentials:init.credentials??"same-origin"});
  }
  private async enqueue(kind:OutboxItem["kind"],path:string,body:string,idempotencyKey:string){
    const item:OutboxItem={
      id:randomId(),scopeKey:this.scopeKey,kind,path,method:"POST",
      headers:{"content-type":"application/json","idempotency-key":idempotencyKey},
      body,createdAt:Date.now(),attempts:0,
    };
    await enqueueOutbox(item);
    return {status:"queued_offline",kind,idempotency_key:idempotencyKey,queued_at:item.createdAt};
  }
  async syncMemory(cursor?:string,includePending=false){
    const activeCursor=cursor??await loadCursor(this.scopeKey);
    const q=new URLSearchParams(); if(activeCursor)q.set("cursor",activeCursor); if(includePending)q.set("include_pending","true");
    let response:Response;
    try{response=await this.request("/memory?"+q.toString());}
    catch{return {records:await readCachedMemory(includePending,this.scopeKey),next_cursor:activeCursor??null,offline:true};}
    if(!response.ok)throw new Error("Memory sync failed: "+response.status);
    const payload=await response.json() as {records?:Record<string,unknown>[];next_cursor?:string|null};
    const records=payload.records||[];
    await cacheMemory(records,this.scopeKey);
    if(payload.next_cursor)await saveCursor(payload.next_cursor,this.scopeKey);
    return {...payload,offline:false};
  }
  async getCachedMemory(includePending=false){return readCachedMemory(includePending,this.scopeKey);}
  async createMemory(input:{memory_id:string;payload_ciphertext:string;payload_nonce:string;key_version:number;source_kind?:string}){
    const key=randomId(),body=JSON.stringify({memory_id:input.memory_id,payload_ciphertext:input.payload_ciphertext,payload_nonce:input.payload_nonce,key_version:input.key_version,...(input.source_kind===undefined?{}:{source_kind:input.source_kind})});
    let response:Response;
    try{response=await this.request("/memory",{method:"POST",headers:{"idempotency-key":key},body});}
    catch{return this.enqueue("memory.create","/memory",body,key);}
    if(!response.ok){
      if(retryableStatus(response.status))return this.enqueue("memory.create","/memory",body,key);
      throw new Error("Memory write failed: "+response.status);
    }
    return response.json();
  }
  async approveMemory(memoryId:string,revision:number){
    const r=await this.request("/memory/"+encodeURIComponent(memoryId)+"/approve",{method:"POST",headers:{"if-match":String(revision)}});
    if(!r.ok)throw new Error("Memory approval failed: "+r.status); return r.json();
  }
  async queueTask(
    input:{task_kind:string;payload_ciphertext:string;payload_nonce:string;key_version:number;required_capabilities?:string[]},
    idempotencyKey=randomId(),
  ){
    const body=JSON.stringify({task_kind:input.task_kind,payload_ciphertext:input.payload_ciphertext,payload_nonce:input.payload_nonce,key_version:input.key_version,...(input.required_capabilities===undefined?{}:{required_capabilities:input.required_capabilities})});
    let response:Response;
    try{response=await this.request("/tasks",{method:"POST",headers:{"idempotency-key":idempotencyKey},body});}
    catch{return this.enqueue("task.enqueue","/tasks",body,idempotencyKey);}
    if(!response.ok){
      if(retryableStatus(response.status))return this.enqueue("task.enqueue","/tasks",body,idempotencyKey);
      throw new Error("Task enqueue failed: "+response.status);
    }
    return response.json();
  }
  async flushOutbox(){
    const items=await readOutbox(this.scopeKey);
    let sent=0,blockedOn:string|null=null;
    for(const item of items){
      let response:Response;
      try{response=await this.request(item.path,{method:item.method,headers:item.headers,body:item.body});}
      catch{blockedOn=item.id;break;}
      if(response.ok){await removeOutbox(item.id);sent++;continue;}
      if(retryableStatus(response.status)||response.status===401||response.status===403||response.status===409){
        blockedOn=item.id;break;
      }
      blockedOn=item.id;break;
    }
    return {sent,remaining:(await readOutbox(this.scopeKey)).length,blocked_on:blockedOn};
  }
  async heartbeat(){
    const r=await this.request("/devices/heartbeat",{method:"POST",body:"{}"});
    if(!r.ok)throw new Error("Device heartbeat failed: "+r.status); return r.json();
  }
  async claimTask(leaseSeconds=90){
    const r=await this.request("/tasks/claim",{method:"POST",body:JSON.stringify({lease_seconds:leaseSeconds})});
    if(!r.ok)throw new Error("Task claim failed: "+r.status); return r.json();
  }
  async transcribe(audio:Blob){
    const r=await this.request("/voice/transcribe",{method:"POST",headers:{"content-type":audio.type||"application/octet-stream"},body:await audio.arrayBuffer()});
    if(!r.ok)throw new Error("Transcription failed: "+r.status); return r;
  }
  async synthesize(request:unknown){
    return this.request("/voice/synthesize",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(request)});
  }
}
