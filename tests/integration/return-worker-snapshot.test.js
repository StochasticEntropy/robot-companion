"use strict";
const test = require("node:test"),assert = require("node:assert/strict"),fs = require("node:fs"),path = require("node:path"),vm = require("node:vm");
const source = fs.readFileSync(path.resolve(__dirname,"../../src/core/extension.js"),"utf8");
const deferred = () => {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(disk = false) {
  let generation=1,serializations=0;
  const context={Map,Set,console,vscode:{workspace:{getWorkspaceFolder:()=>({uri:{toString:()=>"file:///workspace"}})}},
    serializeReturnWorkerIndexSnapshot: index => {serializations++;return index;},computeReturnWorkerSnapshotFingerprint:index=>index.fingerprint,
    getReturnTypeCacheMaxEntries:()=>50,isReturnTypeDiskCacheEnabled:()=>disk,
    sanitizePersistedTypeCacheEntries:entries=>entries};
  const a=source.indexOf("class RobotReturnComputeWorker {"),b=source.indexOf("class RobotRuntimeCacheService {",a);
  vm.runInNewContext(`${source.slice(a,b)};globalThis.WorkerClass=RobotReturnComputeWorker`,context);
  const value=Object.create(context.WorkerClass.prototype);const calls=[];
  Object.assign(value,{_isAvailable:true,_worker:{},_enumHintService:{getGenerationForDocument:()=>generation},
    _snapshotLoadsByWorkspace:new Map(),_snapshotIndexesByWorkspace:new Map(),_snapshotGenerationByWorkspace:new Map(),
    _snapshotFingerprintByWorkspace:new Map(),_persistedTypeCacheByWorkspace:new Map(),_clearPersistTimers(){},_clearPersistTimerForWorkspace(){},
    _postRequest(type,payload){const gate=deferred();calls.push({type,payload,gate});if(type.startsWith("clear"))gate.resolve(true);return gate.promise;}});
  return {value,calls,document:{uri:{}},context,generation:n=>{generation=n;},serializations:()=>serializations,index:{fingerprint:"first"}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test("cold selection, member completion and prewarm share one exact snapshot upload",async()=>{
 const f=fixture(),a=f.value._ensureWorkspaceSnapshot(f.document,f.index),b=f.value._ensureWorkspaceSnapshot(f.document,f.index);
 assert.equal(f.serializations(),1);assert.equal(f.calls.length,1);f.calls[0].gate.resolve(true);
 assert.equal((await a).cacheFingerprint,"first");assert.equal((await b).generation,1);
 await f.value._ensureWorkspaceSnapshot(f.document,f.index);assert.equal(f.calls.length,1);
});

test("clearAll and clearWorkspace forbid a late old ACK from resurrecting loaded state",async()=>{
 for(const action of ["invalidateAll","invalidateForUri"]){
  const f=fixture(),old=f.value._ensureWorkspaceSnapshot(f.document,f.index);f.value[action](f.document.uri);f.calls[0].gate.resolve(true);
  assert.equal(await old,undefined);assert.equal(f.value._snapshotGenerationByWorkspace.size,0);
  const next=f.value._ensureWorkspaceSnapshot(f.document,f.index);assert.equal(f.serializations(),2);
  f.calls.at(-1).gate.resolve(true);assert.ok(await next);
 }
});

test("superseded index or generation cannot overwrite or delete the replacement load",async()=>{
 for(const nextGeneration of [1,2]){
  const f=fixture(),old=f.value._ensureWorkspaceSnapshot(f.document,f.index);f.generation(nextGeneration);
  const newer=f.value._ensureWorkspaceSnapshot(f.document,{fingerprint:"second"});
  f.calls[0].gate.resolve(true);assert.equal(await old,undefined);assert.equal(f.value._snapshotLoadsByWorkspace.size,1);
  f.calls[1].gate.resolve(true);assert.equal((await newer).cacheFingerprint,"second");assert.equal(f.value._snapshotFingerprintByWorkspace.get("file:///workspace"),"second");
 }
});

test("refusal or rejection retries; disposed or replaced worker cannot publish a completed old load",async()=>{
 for(const failure of [false,new Error("upload failed")]){
  const f=fixture(),request=f.value._ensureWorkspaceSnapshot(f.document,f.index);
  if(failure)f.calls[0].gate.reject(failure);else f.calls[0].gate.resolve(false);
  if(failure)await assert.rejects(request,/upload failed/);else assert.equal(await request,undefined);
  const retry=f.value._ensureWorkspaceSnapshot(f.document,f.index);assert.equal(f.calls.length,2);f.calls[1].gate.resolve(true);assert.ok(await retry);
 }
 for(const replace of [false,true]){
  const f=fixture(),old=f.value._ensureWorkspaceSnapshot(f.document,f.index);
  if(replace)f.value._worker={};else f.value._isAvailable=false;
  f.calls[0].gate.resolve(true);assert.equal(await old,undefined);assert.equal(f.value._snapshotGenerationByWorkspace.size,0);
 }
});

test("late disk reads and hydrate ACKs cannot overwrite a newer persisted snapshot",async()=>{
 for(const phase of ["read","hydrate"]){
  const f=fixture(true),read=deferred();f.value._storageRootUri={};f.value._loadPersistedTypeCache=()=>read.promise;
  const request=f.value._ensureWorkspaceSnapshot(f.document,f.index);f.calls[0].gate.resolve(true);await tick();
  const entry={key:"valid",entry:{}};
  if(phase==="hydrate"){read.resolve({cacheFingerprint:"first",entries:[entry]});await tick();assert.equal(f.calls.at(-1).type,"hydrateTypePreviewCache");}
  f.value.invalidateAll();const fresh={cacheFingerprint:"new",entries:new Map([["new",{}]])};f.value._persistedTypeCacheByWorkspace.set("file:///workspace",fresh);
  if(phase==="read")read.resolve({cacheFingerprint:"first",entries:[entry]});else f.calls.find(c=>c.type==="hydrateTypePreviewCache").gate.resolve(true);
  assert.equal(await request,undefined);assert.equal(f.value._persistedTypeCacheByWorkspace.get("file:///workspace"),fresh);
 }
});
