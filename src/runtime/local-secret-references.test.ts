import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BridgeValidationError } from '../api/validation-error.js';
import { runtimeConfigSnapshotSchema } from '../config/runtime-config.js';
import { resolveRuntimeIdentity, redactRuntimeIdentityError, runtimeSecretReferenceSchema } from './local-secret-references.js';
const userName = { provider: 'env' as const, key: 'UNS_RUNTIME_SECRET_PLC_USER' };
const password = { provider: 'env' as const, key: 'UNS_RUNTIME_SECRET_PLC_PASSWORD' };
const identity = { type: 'username' as const, userName, password };
test('resolves references only at the session boundary without modifying identity', () => {
  const before = JSON.stringify(identity);
  assert.deepEqual(resolveRuntimeIdentity(identity, { [userName.key]: 'test-user', [password.key]: 'test-password' }), { type: 1, userName: 'test-user', password: 'test-password' });
  assert.equal(JSON.stringify(identity), before);
});
test('missing or empty bindings fail; never fall back to anonymous', () => {
  for (const environment of [{}, { [userName.key]: 'test-user', [password.key]: '' }]) assert.throws(() => resolveRuntimeIdentity(identity, environment), (error: unknown) => error instanceof BridgeValidationError && error.issues.some(issue => issue.message.includes('Provision local runtime secret')));
  assert.equal(resolveRuntimeIdentity({ type: 'anonymous' }, {}), undefined);
});
test('strict names and no secret fallback', () => {
  for (const bad of [{provider:'env',key:'HOME'}, {...password,value:'fallback'}, {...password,default:'fallback'}, {...password,provider:'file'}]) assert.equal(runtimeSecretReferenceSchema.safeParse(bad).success, false);
});
test('runtime configuration retains unresolved references for stopped connections', () => {
  const parsed = runtimeConfigSnapshotSchema.parse({ version: 1, connections: [{id:'plc',start:false,config:{endpointUrl:'opc.tcp://plc.example:4840',userIdentity:identity},mappings:[]}] });
  assert.deepEqual(parsed.connections[0]?.config.userIdentity, identity);
});
test('redacts local credential values in operator error messages', () => {
  const message = redactRuntimeIdentityError(new Error('test-user/test-password refused'), identity, {[userName.key]:'test-user',[password.key]:'test-password'});
  assert.equal(message.includes('test-user'), false); assert.equal(message.includes('test-password'), false);
});
test('legacy inline credentials remain local and explicit', () => {
  assert.deepEqual(resolveRuntimeIdentity({type:'username',userName:'legacy',password:'local'}, {}), {type:1,userName:'legacy',password:'local'});
  assert.throws(() => resolveRuntimeIdentity({type:'username',userName:'legacy'}, {}), (error: unknown) => error instanceof BridgeValidationError && error.issues.some(issue => issue.message.includes('credential')));
});
