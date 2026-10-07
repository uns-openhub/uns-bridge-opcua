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
test('preview is read-only; append preserves existing entries and saves once', async () => {
  const f = await fixture(); const before = f.manager.getCurrentConfig();
  const body = { connectionId: 'plc', mappings: [mapping('new')] };
  const review = await f.call('mappingsPreview', body);
  assert.equal(review.status, 200); assert.equal(review.body.count, 1);
  assert.deepEqual(f.manager.getCurrentConfig(), before); assert.equal(f.writes(), 0); assert.deepEqual(f.mutations, []);
  const added = await f.call('mappingsAppend', { ...body, expectedRevision: review.body.revision });
  assert.equal(added.status, 200); assert.equal(f.writes(), 1);
  const entries = f.manager.getCurrentConfig().connections[0]!.mappings;
  assert.deepEqual(entries[0], before.connections[0]!.mappings[0]); assert.equal(entries[1]!.id, 'new');
});
test('simultaneous appends from one revision permit one write and return 409 for the other', async () => {
  const f = await fixture(); const body = { connectionId: 'plc', mappings: [mapping('a')] };
  const review = await f.call('mappingsPreview', body);
  const results = await Promise.all(['a','b'].map(id => f.call('mappingsAppend', { connectionId: 'plc', mappings: [mapping(id)], expectedRevision: review.body.revision })));
  assert.deepEqual(results.map(r => r.status).sort(), [200,409]); assert.equal(f.writes(), 1);
  assert.equal(results.find(r => r.status === 409)!.body.code, 'CONFIG_CHANGED');
});
for (const [label, body] of [
  ['missing connection', { connectionId: 'missing', mappings: [mapping('new')] }],
  ['repeated ID', { connectionId: 'plc', mappings: [mapping('old','new')] }],
  ['existing target', { connectionId: 'plc', mappings: [mapping('new','old')] }],
  ['case and trailing-slash collision', { connectionId: 'plc', mappings: [{...mapping('new','OLD'), config: {...mapping('new','OLD').config, topic:'enterprise/site'}}] }],
  ['empty batch', { connectionId: 'plc', mappings: [] }],
  ['oversize batch', { connectionId: 'plc', mappings: Array.from({length:101},(_,i)=>mapping(String(i))) }],
  ['duplicate batch targets', { connectionId: 'plc', mappings: [mapping('new','same'),mapping('other','same')] }],
] as const) test(`${label}: reject before mutation`, async () => {
  const f = await fixture(); const before = f.manager.getCurrentConfig();
  const result = await f.call('mappingsPreview', body);
  assert.equal(result.status,400); assert.deepEqual(f.manager.getCurrentConfig(),before);
  assert.equal(f.writes(),0); assert.deepEqual(f.mutations,[]);
});
test('a full configuration edit invalidates the review; failed append does not poison the queue', async () => {
  const f = await fixture(); const body = { connectionId:'plc',mappings:[mapping('new')] };
  const review = await f.call('mappingsPreview',body);
  const updated=f.manager.getCurrentConfig(); updated.connections[0]!.config.name='Renamed';
  await f.manager.applyConfig(updated,'api-apply');
  const stale=await f.call('mappingsAppend',{...body,expectedRevision:review.body.revision});
  assert.equal(stale.status,409); assert.equal(f.writes(),1);
  const fresh=await f.call('mappingsPreview',body);
  assert.equal((await f.call('mappingsAppend',{...body,expectedRevision:fresh.body.revision})).status,200);
  assert.equal(f.writes(),2);
});
