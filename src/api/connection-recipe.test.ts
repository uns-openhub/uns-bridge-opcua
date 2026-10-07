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

const connection = (id = 'new') => ({ id, config: { endpointUrl: 'opc.tcp://local:4840', monitoring: { discardOldest: false }, subscription: { priority: 0, publishingEnabled: false } } });
test('review is read-only and create adds only a stopped connection; existing sessions untouched', async () => {
  const f = await fixture(); const before = f.manager.getCurrentConfig(); const body = { connection: connection() };
  const review = await f.call('connectionsPreviewAdd', body);
  assert.equal(review.status, 200); assert.deepEqual(f.manager.getCurrentConfig(), before); assert.deepEqual(f.mutations, []); assert.equal(f.writes(), 0);
  const saved = await f.call('connectionsAppendReviewed', { ...body, expectedRevision: review.body.revision });
  assert.equal(saved.status, 200); assert.deepEqual(saved.body, { id: 'new', start: false });
  assert.deepEqual(f.mutations, ['addConnection']); assert.equal(f.writes(), 1);
  const after = f.manager.getCurrentConfig(); assert.deepEqual(after.connections[0], before.connections[0]);
  assert.deepEqual(after.connections[1], { ...body.connection, start: false, mappings: [] });
});
test('unprovisioned references persist without resolution or source network activity', async () => {
  const f = await fixture(); const c = connection();
  Object.assign(c.config, { userIdentity: { type:'username', userName:{provider:'env',key:'UNS_RUNTIME_SECRET_U2_UNKNOWN_USER'}, password:{provider:'env',key:'UNS_RUNTIME_SECRET_U2_UNKNOWN_PASSWORD'} } });
  const review = await f.call('connectionsPreviewAdd', { connection:c }); assert.equal(review.status,200);
  const result = await f.call('connectionsAppendReviewed',{connection:c, expectedRevision:review.body.revision}); assert.equal(result.status,200);
  assert.deepEqual(f.mutations,['addConnection']); assert.deepEqual(f.manager.getCurrentConfig().connections[1]!.config,c.config);
});
test('simultaneous reviewed creates allow exactly one write; stale rejection does not poison queue', async () => {
  const f = await fixture(); const review = await f.call('connectionsPreviewAdd',{connection:connection()});
  const results=await Promise.all(['a','b'].map(id=>f.call('connectionsAppendReviewed',{connection:connection(id),expectedRevision:review.body.revision})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]); assert.equal(f.writes(),1); assert.deepEqual(f.mutations,['addConnection']);
  const fresh=await f.call('connectionsPreviewAdd',{connection:connection('retry')});
  assert.equal((await f.call('connectionsAppendReviewed',{connection:connection('retry'),expectedRevision:fresh.body.revision})).status,200);
});
for (const [label, input] of [
  ['existing name', {connection:connection('plc')}], ['case folded existing name', {connection:connection('PLC')}],
  ['automatic start', {connection:{...connection(),start:true}}], ['mapping authority', {connection:{...connection(),mappings:[]}}],
  ['inline credentials', {connection:{id:'new',config:{endpointUrl:'opc.tcp://local:4840',userIdentity:{type:'username',userName:'SECRET',password:'SECRET'}}}}],
  ['embedded credentials', {connection:{id:'new',config:{endpointUrl:'opc.tcp://SECRET:SECRET@local:4840'}}}],
  ['query credentials', {connection:{id:'new',config:{endpointUrl:'opc.tcp://local:4840?token=SECRET'}}}],
  ['bad port', {connection:{id:'new',config:{endpointUrl:'opc.tcp://local:99999'}}}],
  ['unknown setting', {connection:{id:'new',config:{endpointUrl:'opc.tcp://local:4840',future:true}}}],
  ['unknown monitoring', {connection:{id:'new',config:{endpointUrl:'opc.tcp://local:4840',monitoring:{future:true}}}}],
  ['anonymous credentials', {connection:{id:'new',config:{endpointUrl:'opc.tcp://local:4840',userIdentity:{type:'anonymous',password:{provider:'env',key:'UNS_RUNTIME_SECRET_PASSWORD'}}}}}],
] as const) test(`${label}: reject without mutation or secret echo`, async()=>{
  const f=await fixture(); const before=f.manager.getCurrentConfig(); const result=await f.call('connectionsPreviewAdd',input);
  assert.equal(result.status,400); assert.deepEqual(f.manager.getCurrentConfig(),before); assert.deepEqual(f.mutations,[]); assert.equal(f.writes(),0); assert.ok(!JSON.stringify(result.body).includes('SECRET'));
});
test('full config mutation invalidates the reviewed connection; duplicate can never overwrite', async()=>{
  const f=await fixture(); const body={connection:connection()};const review=await f.call('connectionsPreviewAdd',body);
  const changed=f.manager.getCurrentConfig(); changed.connections[0]!.config.name='Changed'; await f.manager.applyConfig(changed,'api-apply');const before=f.manager.getCurrentConfig();f.mutations.length=0;
  assert.equal((await f.call('connectionsAppendReviewed',{...body,expectedRevision:review.body.revision})).status,409);
  assert.deepEqual(f.manager.getCurrentConfig(),before);assert.deepEqual(f.mutations,[]);
});

test('snapshot write failure removes only the newly added stopped engine connection', async () => {
  let fail = false; const mutations: Array<{name:string,args:any[]}> = [];
  const engine = new Proxy({}, { get: (_,name) => async (...args:any[]) => {mutations.push({name:String(name),args});} }) as ConstructorParameters<typeof RuntimeConfigManager>[0];
  const manager = new RuntimeConfigManager(engine, {write: async()=>{if(fail) throw new Error('disk full');}} as unknown as RuntimeConfigStore);
  const before=manager.getCurrentConfig();const review=await manager.previewNewConnection(connection());fail=true;
  await assert.rejects(()=>manager.appendReviewedConnection(connection(),review.revision),/disk full/);
  assert.deepEqual(manager.getCurrentConfig(),before);assert.deepEqual(mutations.map(m=>m.name),['addConnection','removeConnection']);assert.equal(mutations[1]!.args[0],'new');
});

test('a legacy mixed-case name also blocks a lowercase reviewed addition', async()=>{
  const f=await fixture();const changed=f.manager.getCurrentConfig();changed.connections[0]!.id='PLC';await f.manager.applyConfig(changed,'api-apply');
  const before=f.manager.getCurrentConfig();const writes=f.writes();f.mutations.length=0;
  const result=await f.call('connectionsPreviewAdd',{connection:connection('plc')});assert.equal(result.status,400);
  assert.deepEqual(f.manager.getCurrentConfig(),before);assert.equal(f.writes(),writes);assert.deepEqual(f.mutations,[]);
});
