import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeConfigManager } from './runtime-config-manager.js';
import type { RuntimeConfigStore } from './runtime-config-store.js';
const mapping={id:'temp',config:{nodeId:'ns=2;s=Temperature',topic:'enterprise/site/',asset:'device',objectType:'equipment',objectId:'main',attribute:'temperature'}};
test('every apply path reconciles persisted targets; stop retains, retarget/delete removes, invalid config has no hook',async()=>{
 const calls:string[]=[];const targets:unknown[]=[];
 const engine=new Proxy({}, {get:(_,name)=>async()=>{calls.push(String(name));}}) as ConstructorParameters<typeof RuntimeConfigManager>[0];
 const manager=new RuntimeConfigManager(engine,{write:async()=>{calls.push('write');}} as unknown as RuntimeConfigStore,async snapshot=>{calls.push('reconcile');targets.push(snapshot.connections.flatMap(c=>c.mappings.map(m=>m.config.attribute)));});
 const config={connections:[{id:'plc',start:false,config:{endpointUrl:'opc.tcp://localhost:4840'},mappings:[structuredClone(mapping)]}]};
 await manager.applyConfig(config,'api-apply');assert.deepEqual(targets.at(-1),['temperature']);assert.deepEqual(calls.slice(-2),['write','reconcile']);
 config.connections[0]!.start=true;await manager.applyConfig(config,'api-apply');config.connections[0]!.start=false;await manager.applyConfig(config,'api-apply');assert.deepEqual(targets.at(-1),['temperature']);
 config.connections[0]!.mappings[0]!.config.attribute='state';await manager.applyConfig(config,'api-apply');assert.deepEqual(targets.at(-1),['state']);
 config.connections[0]!.mappings=[];await manager.applyConfig(config,'api-apply');assert.deepEqual(targets.at(-1),[]);
 const count=targets.length;await assert.rejects(()=>manager.applyConfig({connections:[{id:'bad'}]},'api-apply'));assert.equal(targets.length,count);
 await manager.applyConfig({connections:[]},'api-apply');assert.deepEqual(targets.at(-1),[]);
});

test('reviewed targets are allowed before initial activation; failed persistence restores previous publisher eligibility',async()=>{
 const { ManagedBridgePublisher }=await import('@uns-kit/bridge-core');let count=0;let fail=false;let retained:string[]=[];
 const pub=new ManagedBridgePublisher(async()=>{count++;},paths=>{retained=[...paths];});
 const targets=(snapshot:any)=>snapshot.connections.flatMap((c:any)=>c.mappings.map((m:any)=>m.config));
 const publish=async(config:any)=>pub.publish({...config,attributes:{attribute:config.attribute,data:{time:new Date().toISOString(),value:1}}});
 const engine=new Proxy({},{get:(_,name)=>async(...args:any[])=>{if(name==='addMapping')await publish(args[1].config);if(name==='updateMapping')await publish(args[2]);}}) as ConstructorParameters<typeof RuntimeConfigManager>[0];
 const manager=new RuntimeConfigManager(engine,{write:async()=>{if(fail)throw new Error('disk failure');}} as unknown as RuntimeConfigStore,s=>pub.reconcile(targets(s)),async s=>{pub.allowTargets(targets(s));});
 const config={connections:[{id:'plc',start:true,config:{endpointUrl:'opc.tcp://localhost:4840'},mappings:[structuredClone(mapping)]}]};
 await manager.applyConfig(config,'api-apply');assert.equal(count,1);config.connections[0]!.mappings[0]!.config.attribute='state';await manager.applyConfig(config,'api-apply');assert.equal(count,2);assert.ok(retained[0]!.endsWith('/state'));
 fail=true;config.connections[0]!.mappings[0]!.config.attribute='draft';await assert.rejects(()=>manager.applyConfig(config,'api-apply'),/disk failure/);assert.equal(manager.getCurrentConfig().connections[0]!.mappings[0]!.config.attribute,'state');assert.ok(retained[0]!.endsWith('/state'));const n=count;await publish(config.connections[0]!.mappings[0]!.config);assert.equal(count,n);
});
