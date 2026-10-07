import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ClientSession, ClientSubscription } from 'node-opcua';
import type { IMqttAttributeEntry, IMqttPublishRequest } from '@uns-kit/core';
import { normalizeEngineeringUnit, readEngineeringUnits } from './engineering-units.js';
import { opcuaNormalizer } from './opcua-normalizer.js';
import { SubscriptionManager, type OpcuaMappingConfig, type OpcuaValueEvent } from './subscriptionManager.js';
import { runtimeMappingConfigSchema } from '../config/runtime-config.js';
import { toMappingConfig } from '../config/opcua-config-mappers.js';
const unit = { displayName: { text: '°C' }, description: { text: 'degree Celsius' }, unitId: 4408652 };
const good = { isGood: () => true };
const config: OpcuaMappingConfig = {
  nodeId: 'ns=2;s=Temperature',
  topic: 'enterprise/site/',
  asset: 'sensor',
  objectType: 'equipment',
  objectId: 'main',
  attribute: 'temperature',
};
const fakeSession = (units = true) =>
  ({
    translateBrowsePath: async () => [
      {
        statusCode: good,
        targets: units ? [{ remainingPathIndex: 0xffffffff, targetId: { serverIndex: 0, toString: () => 'ns=2;s=Unit' } }] : [],
      },
    ],
    read: async (args: unknown) =>
      Array.isArray(args)
        ? [{ statusCode: good, value: { value: unit } }]
        : { statusCode: { name: 'Good' }, value: { value: 705 }, sourceTimestamp: new Date('2026-10-04T12:00:00Z') },
  }) as unknown as ClientSession;

test('source EngineeringUnits are bounded and require an actual display label', () => {
  assert.equal(normalizeEngineeringUnit(unit)?.displayName, '°C');
  assert.equal(normalizeEngineeringUnit({ unitId: 4408652 }), undefined);
  assert.equal(normalizeEngineeringUnit({ displayName: { text: 'x'.repeat(129) } }), undefined);
  assert.equal(normalizeEngineeringUnit({ displayName: { text: 'a\u0000b' } }), undefined);
});
test('reads units on the supplied session; missing/bad metadata is optional', async () => {
  assert.equal((await readEngineeringUnits(fakeSession(), [config.nodeId])).get(config.nodeId)?.displayName, '°C');
  assert.equal((await readEngineeringUnits(fakeSession(false), [config.nodeId])).size, 0);
  assert.equal(
    (
      await readEngineeringUnits(
        {
          translateBrowsePath: async () => {
            throw new Error('unsupported');
          },
        } as unknown as ClientSession,
        [config.nodeId],
      )
    ).size,
    0,
  );
});
test('a stuck optional read is bounded and does not supply a guessed unit', async () => {
  const session = { translateBrowsePath: () => new Promise(() => undefined) } as unknown as ClientSession;
  assert.equal((await readEngineeringUnits(session, [config.nodeId])).size, 0);
});
for (const mode of ['polling', 'subscription'] as const) {
  test(`${mode} publishes source units without reading metadata for every value`, async () => {
    const manager = new SubscriptionManager('plc', { intervalMs: 1000, queueSize: 10, discardOldest: true });
    const session = fakeSession();
    let reads = 0;
    const translate = session.translateBrowsePath.bind(session);
    session.translateBrowsePath = ((...args: Parameters<ClientSession['translateBrowsePath']>) => {
      reads++;
      return translate(...args);
    }) as ClientSession['translateBrowsePath'];
    const item = new EventEmitter() as EventEmitter & { terminate: () => Promise<void> };
    item.terminate = async () => undefined;
    manager.setSession(session);
    await manager.replaceSubscription({ monitor: async () => item } as unknown as ClientSubscription);
    const events: OpcuaValueEvent[] = [];
    try {
      await manager.addMapping('temperature', { ...config, mode, publishInitialValue: true }, async (event) => {
        events.push(event);
      });
      if (mode === 'subscription') item.emit('changed', { value: { value: 706 }, statusCode: { name: 'Good' } });
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(events.length);
      assert.ok(events.every((event) => event.uom === '°C'));
      assert.equal(reads, 1);
    } finally {
      await manager.dispose();
    }
  });
}
test('normalizer preserves numeric/string values; explicit unit label wins without conversion', async () => {
  const event = { value: 705, timestamp: '2026-10-04T12:00:00Z', quality: 'Good', connectionId: 'plc', nodeId: config.nodeId, uom: '°C' };
  const source = await opcuaNormalizer({ connectionId: 'plc', mappingId: 'temperature', mapping: config, event })!;
  const overridden = await opcuaNormalizer({
    connectionId: 'plc',
    mappingId: 'temperature',
    mapping: { ...config, uom: 'custom-unit' },
    event,
  })!;
  assert.equal(((source as IMqttPublishRequest).attributes as IMqttAttributeEntry).data?.uom, '°C');
  assert.equal(((overridden as IMqttPublishRequest).attributes as IMqttAttributeEntry).data?.uom, 'custom-unit');
  assert.equal(((overridden as IMqttPublishRequest).attributes as IMqttAttributeEntry).data?.value, 705);
  const string = await opcuaNormalizer({
    connectionId: 'plc',
    mappingId: 'temperature',
    mapping: config,
    event: { value: 'IDLE', timestamp: event.timestamp, quality: 'Good', connectionId: 'plc', nodeId: config.nodeId },
  })!;
  assert.equal(((string as IMqttPublishRequest).attributes as IMqttAttributeEntry).data?.value, 'IDLE');
  assert.equal(((string as IMqttPublishRequest).attributes as IMqttAttributeEntry).data?.uom, undefined);
});
test('version-1 mapping shapes stay valid and retain a reviewed override', () => {
  assert.ok(runtimeMappingConfigSchema.safeParse(config).success);
  const parsed = runtimeMappingConfigSchema.parse({ ...config, uom: ' °C ' });
  assert.equal(toMappingConfig(parsed).uom, '°C');
  assert.equal(runtimeMappingConfigSchema.safeParse({ ...config, uom: 'a\u0000b' }).success, false);
});
