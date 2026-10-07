import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { RuntimeConfigStore } from './runtime-config-store.js';
import { runtimeConfigSnapshotSchema } from '../config/runtime-config.js';
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })));
});
async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcua-store-'));
  directories.push(dir);
  return { dir, store: new RuntimeConfigStore(path.join(dir, 'runtime-config.json')) };
}
describe('atomic runtime configuration persistence', () => {
  it('writes a complete private snapshot and restores it after restart', async () => {
    const { dir, store } = await setup();
    const snapshot = {
      version: 1 as const,
      connections: [{ id: 'one', start: true, config: { endpointUrl: 'opc.tcp://plc.test:4840' }, mappings: [] }],
    };
    await store.write(snapshot);
    assert.deepEqual(await new RuntimeConfigStore(store.resolvedPath).read(), snapshot);
    assert.equal((await fs.stat(store.resolvedPath)).mode & 0o777, 0o600);
    assert.deepEqual(await fs.readdir(dir), ['runtime-config.json']);
  });
  it('concurrent writes leave one complete snapshot with no pending files', async () => {
    const { dir, store } = await setup();
    await Promise.all(
      Array.from({ length: 10 }, (_, n) => store.write({ version: 1, updatedAt: new Date(n * 1000).toISOString(), connections: [] })),
    );
    const snapshot = await store.read();
    assert.equal(snapshot?.version, 1);
    assert.deepEqual(snapshot?.connections, []);
    assert.deepEqual(await fs.readdir(dir), ['runtime-config.json']);
  });
  it('bundles the JSON schema generated from the source configuration types', async () => {
    const schema = JSON.parse(await fs.readFile(new URL('../../runtime-config.schema.json', import.meta.url), 'utf8'));
    assert.deepEqual(schema, z.toJSONSchema(runtimeConfigSnapshotSchema, { target: 'draft-7', io: 'input' }));
    const manifest = JSON.parse(await fs.readFile(new URL('../../runtime-state.manifest.json', import.meta.url), 'utf8'));
    assert.deepEqual(
      { protocol: manifest.protocol, file: manifest.file, schema: manifest.schema },
      { protocol: 1, file: 'runtime-config.json', schema: 'runtime-config.schema.json' },
    );
  });
});
