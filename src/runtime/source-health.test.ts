import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeSourceHealth, createSourceHealthRefresh, within } from './source-health.js';
import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
const snapshot:RuntimeConfigSnapshot={version:1,connections:[{id:'plc',start:true,config:{endpointUrl:'opc.tcp://localhost:4840'},mappings:[]},{id:'not-started',start:false,config:{endpointUrl:'opc.tcp://offline'},mappings:[]}]};
const now=new Date('2026-10-04T20:00:00Z');
test('observes only started real runtime sessions without a network probe',async()=>{
 const calls:string[]=[];
 const result=await observeSourceHealth(snapshot,async id=>{calls.push(id);return {state:'running',connected:true,updatedAt:now.toISOString()};},now);
 assert.deepEqual(calls,['plc']);assert.equal(result[0]!.healthy,true);assert.equal(result[0]!.checkedAt,now.toISOString());
});
for(const state of ['reconnecting','starting','stopped','error'] as const) test(`${state} on a started connection degrades source health`,async()=>{
 const result=await observeSourceHealth(snapshot,async()=>({state,connected:false,updatedAt:now.toISOString(),message:'Source offline'}),now);
 assert.equal(result[0]!.healthy,false);assert.match(result[0]!.message,/plc: Source offline/);assert.ok(result[0]!.action);
});
test('no started sources are neutral, not degraded',async()=>{
 const result=await observeSourceHealth({...snapshot,connections:snapshot.connections.map(c=>({...c,start:false}))},async()=>{throw new Error('not called');},now);assert.equal(result[0]!.healthy,null);
});
test('unreadable runtime status degrades instead of retaining healthy',async()=>{
 const result=await observeSourceHealth(snapshot,async()=>{throw new Error('internal failure');},now);assert.equal(result[0]!.healthy,false);assert.match(result[0]!.message,/status is unavailable/);
});
test('shared errors redact credentials and limit details',async()=>{
 const secretSnapshot=structuredClone(snapshot);secretSnapshot.connections[0]!.config.userIdentity={type:'username',userName:'operator-identity',password:'secret-test-value'};
 const result=await observeSourceHealth(secretSnapshot,async()=>({state:'error',connected:false,updatedAt:now.toISOString(),message:'operator-identity secret-test-value opc.tcp://user:pass@host '+'x'.repeat(500)}),now);
 assert.ok(!result[0]!.message.includes('secret-test-value'));assert.ok(!result[0]!.message.includes('operator-identity'));assert.ok(!result[0]!.message.includes('user:pass'));assert.ok(result[0]!.message.length<300);
});
test('a stuck source read completes degraded within one second',async()=>{
 const result=await observeSourceHealth(snapshot,()=>new Promise(()=>{}),now);assert.equal(result[0]!.healthy,false);
});
test('deadline clears after a successful operation and rejects a stuck one',async()=>{
 assert.equal(await within(Promise.resolve('done'),10),'done');await assert.rejects(within(new Promise(()=>{}),10),/timed out/);
});
test('refresh calls coalesce while publication is pending and resume after failure',async()=>{
 let resolve!:()=>void;let publications=0;let errors=0;
 const refresh=createSourceHealthRefresh(()=>snapshot,async()=>({state:'running',connected:true,updatedAt:now.toISOString()}),async()=>{publications++;if(publications===1) await new Promise<void>(r=>{resolve=r;});else throw new Error('MQTT unavailable');},()=>{errors++;});
 const first=refresh();const second=refresh();assert.equal(first,second);
 await new Promise(r=>setTimeout(r,0));resolve();await first;await refresh();assert.equal(publications,2);assert.equal(errors,1);
});
test('a stuck publication releases the guard for later observations',async()=>{
 let errors=0;const refresh=createSourceHealthRefresh(()=>snapshot,async()=>({state:'running',connected:true,updatedAt:now.toISOString()}),()=>new Promise(()=>{}),()=>errors++);
 await refresh();assert.equal(errors,1);await refresh();assert.equal(errors,2);
});
