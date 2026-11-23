export type DevicePlatform = "android" | "ios" | "windows" | "macos" | "linux" | "browser" | "other";
type StoredIdentity = { deviceId:string; privateKey:CryptoKey; publicJwk:JsonWebKey };
const enc = new TextEncoder();
const toB64u = (bytes:Uint8Array) => {
  let binary=""; for(const b of bytes) binary+=String.fromCharCode(b);
  return btoa(binary).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
};
const fromB64u = (s:string) => Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));
const randomId = () => toB64u(crypto.getRandomValues(new Uint8Array(24)));
async function sha256(data:BufferSource){return new Uint8Array(await crypto.subtle.digest("SHA-256",data));}
function openDb():Promise<IDBDatabase>{
  return new Promise((resolve,reject)=>{
    const r=indexedDB.open("neo-device-identity",1);
    r.onupgradeneeded=()=>r.result.createObjectStore("identity");
    r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
  });
}
async function loadIdentity():Promise<StoredIdentity|null>{
  const db=await openDb(); return new Promise((resolve,reject)=>{
    const r=db.transaction("identity","readonly").objectStore("identity").get("current");
    r.onsuccess=()=>resolve(r.result||null); r.onerror=()=>reject(r.error);
  });
}
async function saveIdentity(value:StoredIdentity):Promise<void>{
  const db=await openDb(); return new Promise((resolve,reject)=>{
    const tx=db.transaction("identity","readwrite"); tx.objectStore("identity").put(value,"current");
    tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error);
  });
}
export class NeoDeviceClient {
  private constructor(private baseUrl:string,private accessToken:()=>Promise<string>,private identity:StoredIdentity){}
  static async create(baseUrl:string,accessToken:()=>Promise<string>){
    let identity=await loadIdentity();
    if(!identity){
      const pair=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},false,["sign","verify"]);
      const publicJwk=await crypto.subtle.exportKey("jwk",pair.publicKey);
      // Persist the non-exportable CryptoKey directly in IndexedDB; never export private key material.
      identity={deviceId:randomId(),privateKey:pair.privateKey,publicJwk};
      await saveIdentity(identity);
    }
    return new NeoDeviceClient(baseUrl.endsWith("/") ? baseUrl.slice(0,-1) : baseUrl,accessToken,identity);
  }
  get deviceId(){return this.identity.deviceId;}
  async enrol(label:string,platform:DevicePlatform,capabilities:string[]=[]){
    const response=await fetch(this.baseUrl+"/v1/devices",{method:"POST",headers:{"authorization":"Bearer "+await this.accessToken(),"content-type":"application/json","x-neo-device-id":this.deviceId},body:JSON.stringify({label,platform,public_key_jwk:this.identity.publicJwk,capabilities})});
    if(!response.ok) throw new Error("NEO device enrolment failed: "+response.status);
    return response.json();
  }
  async request(path:string,init:RequestInit={}):Promise<Response>{
    const method=(init.method||"GET").toUpperCase(), url=new URL(this.baseUrl+"/v1"+path);
    const body=init.body===undefined?new Uint8Array():typeof init.body==="string"?enc.encode(init.body):init.body instanceof ArrayBuffer?new Uint8Array(init.body):new Uint8Array(await new Response(init.body).arrayBuffer());
    const ts=Math.floor(Date.now()/1000), nonce=randomId();
    const hash=Array.from(await sha256(body),b=>b.toString(16).padStart(2,"0")).join("");
    const canonical=[method,url.host,url.pathname+url.search,ts,nonce,hash].join("\n");
    const signature=new Uint8Array(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},this.identity.privateKey,enc.encode(canonical)));
    const headers=new Headers(init.headers);
    headers.set("authorization","Bearer "+await this.accessToken());
    headers.set("x-neo-device-id",this.deviceId); headers.set("x-neo-timestamp",String(ts));
    headers.set("x-neo-nonce",nonce); headers.set("x-neo-signature",toB64u(signature));
    if(body.byteLength && !headers.has("content-type")) headers.set("content-type","application/json");
    return fetch(url,{...init,method,headers,body:body.byteLength?body:undefined});
  }
  async syncMemory(cursor?:string,includePending=false){
    const q=new URLSearchParams(); if(cursor)q.set("cursor",cursor); if(includePending)q.set("include_pending","true");
    const r=await this.request("/memory?"+q.toString()); if(!r.ok)throw new Error("Memory sync failed: "+r.status); return r.json();
  }
  async createMemory(input:{memory_id:string;payload_ciphertext:string;payload_nonce:string;key_version:number;source_kind?:string}){
    const r=await this.request("/memory",{method:"POST",body:JSON.stringify(input)}); if(!r.ok)throw new Error("Memory write failed: "+r.status); return r.json();
  }
  async approveMemory(memoryId:string,revision:number){
    const r=await this.request("/memory/"+encodeURIComponent(memoryId)+"/approve",{method:"POST",headers:{"if-match":String(revision)}});
    if(!r.ok)throw new Error("Memory approval failed: "+r.status); return r.json();
  }
  async queueTask(input:{task_kind:string;payload_ciphertext:string;payload_nonce:string;key_version:number},idempotencyKey=randomId()){
    const r=await this.request("/tasks",{method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(input)});
    if(!r.ok)throw new Error("Task enqueue failed: "+r.status); return r.json();
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
