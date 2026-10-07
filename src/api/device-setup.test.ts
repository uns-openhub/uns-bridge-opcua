import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeConfigManager } from '../runtime/runtime-config-manager.js';
import type { RuntimeConfigStore } from '../runtime/runtime-config-store.js';
import { createServiceApis } from './routes.js';

const mapping = (id: string, asset = id) => ({ id, config: { nodeId: `ns=2;s=${id}.Temperature`, topic: 'enterprise/site/', asset, objectType: 'equipment', objectId: 'main', attribute: 'temperature' } });
async function fixture() {
  let writes = 0; const mutations: string[] = [];
  const engine = new Proxy({}, { get: (_, name) => async () => { mutations.push(String(name)); } }) as ConstructorParameters<typeof RuntimeConfigManager>[0];
  const manager = new RuntimeConfigManager(engine, { write: async () => { writes++; } } as unknown as RuntimeConfigStore);
  await manager.applyConfig({ connections: [{ id: 'plc', config: { endpointUrl: 'opc.tcp://localhost:4840' }, mappings: [mapping('old')] }] }, 'api-apply');
  writes = 0; mutations.length = 0;
  const apis = createServiceApis(engine, {} as Parameters<typeof createServiceApis>[1], manager);
  const call = async (name: string, body: unknown) => {
    let status = 200; let output: any;
    const res = { status(value: number) { status = value; return res; }, json(value: unknown) { output = value; } };
    await apis[name]!.handler({ req: { body }, res });
    return { status, body: output };
  };
  return { manager, call, writes: () => writes, mutations };
}

const device = (id = 'new') => ({ connection: { id, config: { endpointUrl: 'opc.tcp://local:4840', monitoring: { discardOldest: false } } },
 mappings: ['temperature','status'].map((attribute,index) => ({ id:`m-${index}`, config:{nodeId:`ns=2;s=DeviceB.${attribute}`,topic:'enterprise/site/',asset:'new-device',objectType:'equipment',objectId:'main',attribute,publishInitialValue:false} })) });
test('device review is pure; additive create persists stopped device with every mapping and preserves existing sessions', async()=>{
 const f=await fixture();const before=f.manager.getCurrentConfig();const body=device();
 const review=await f.call('devicesPreviewAdd',body);assert.equal(review.status,200);assert.deepEqual(f.manager.getCurrentConfig(),before);assert.deepEqual(f.mutations,[]);assert.equal(f.writes(),0);
 const result=await f.call('devicesAppendReviewed',{...body,expectedRevision:review.body.revision});assert.equal(result.status,200);assert.deepEqual(result.body,{id:'new',count:2,start:false});assert.deepEqual(f.mutations,['addConnection','addMapping','addMapping']);assert.equal(f.writes(),1);
 const after=f.manager.getCurrentConfig();assert.deepEqual(after.connections[0],before.connections[0]);assert.deepEqual(after.connections[1],{...body.connection,start:false,mappings:body.mappings});
});
test('device concurrency allows one revision and the rejected queue recovers',async()=>{
 const f=await fixture();const r=await f.call('devicesPreviewAdd',device());const outcomes=await Promise.all(['a','b'].map(id=>f.call('devicesAppendReviewed',{...device(id),expectedRevision:r.body.revision})));assert.deepEqual(outcomes.map(o=>o.status).sort(),[200,409]);assert.equal(f.writes(),1);
 const next=device('c');next.mappings.forEach(m=>m.config.asset='another');const fresh=await f.call('devicesPreviewAdd',next);assert.equal((await f.call('devicesAppendReviewed',{...next,expectedRevision:fresh.body.revision})).status,200);
});
for(const [label,alter] of [
 ['automatic start',(d:any)=>{d.connection.start=true;}],['inline identity',(d:any)=>{d.connection.config.userIdentity={type:'username',userName:'SECRET',password:'SECRET'};}],
 ['empty mappings',(d:any)=>{d.mappings=[];}],['unknown mapping field',(d:any)=>{d.mappings[0].config.future=true;}],['duplicate attribute',(d:any)=>{d.mappings[1].config.attribute='temperature';}],
 ['duplicate id',(d:any)=>{d.mappings[1].id=d.mappings[0].id;}],['multiple targets',(d:any)=>{d.mappings[1].config.objectId='other';}],
 ['invalid NodeId',(d:any)=>{d.mappings[0].config.nodeId='Temperature';}],['wildcard target',(d:any)=>{d.mappings[0].config.asset='#';}],
 ['existing name',(d:any)=>{d.connection.id='plc';}],['existing mapped attribute',(d:any)=>{d.mappings.forEach((m:any)=>m.config.asset='old');}],
] as const) test(`${label}: reject reviewed device without mutation or secret echo`,async()=>{
 const f=await fixture();const before=f.manager.getCurrentConfig();const d=device();alter(d);const r=await f.call('devicesPreviewAdd',d);assert.equal(r.status,400);assert.deepEqual(f.manager.getCurrentConfig(),before);assert.equal(f.writes(),0);assert.deepEqual(f.mutations,[]);assert.ok(!JSON.stringify(r.body).includes('SECRET'));
});
for(const failure of ['mapping','write']) test(`${failure} failure removes only new device and leaves snapshot untouched`,async()=>{
 let fail=false;let count=0;const calls:Array<{name:string,args:any[]}>=[];
 const engine=new Proxy({},{get:(_,name)=>async(...args:any[])=>{calls.push({name:String(name),args});if(fail&&failure==='mapping'&&name==='addMapping'&&++count===2)throw new Error('mapping failed');}}) as ConstructorParameters<typeof RuntimeConfigManager>[0];
 const manager=new RuntimeConfigManager(engine,{write:async()=>{if(fail&&failure==='write')throw new Error('write failed');}} as unknown as RuntimeConfigStore);
 const before=manager.getCurrentConfig();const d=device();const review=await manager.previewNewDevice(d);fail=true;await assert.rejects(()=>manager.appendReviewedDevice(d,review.revision),/failed/);assert.deepEqual(manager.getCurrentConfig(),before);assert.equal(calls.at(-1)!.name,'removeConnection');assert.equal(calls.at(-1)!.args[0],'new');
});
test('unresolved local references can be stored in a stopped device',async()=>{
 const f=await fixture();const d=device();Object.assign(d.connection.config,{userIdentity:{type:'username',userName:{provider:'env',key:'UNS_RUNTIME_SECRET_U2_UNKNOWN_USER'},password:{provider:'env',key:'UNS_RUNTIME_SECRET_U2_UNKNOWN_PASSWORD'}}});const r=await f.call('devicesPreviewAdd',d);assert.equal(r.status,200);assert.equal((await f.call('devicesAppendReviewed',{...d,expectedRevision:r.body.revision})).status,200);assert.deepEqual(f.mutations,['addConnection','addMapping','addMapping']);
});
