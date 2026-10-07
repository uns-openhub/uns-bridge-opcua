import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createServiceApis } from "./routes.js";
import { withValidationErrors } from "./validation-error.js";
import { RuntimeConfigManager } from "../runtime/runtime-config-manager.js";
import type { RuntimeConfigStore } from "../runtime/runtime-config-store.js";

type Engine = ConstructorParameters<typeof RuntimeConfigManager>[0];
function response() {
  let status = 200;
  let body: any;
  const res = { status(value: number) { status = value; return res; }, json(value: unknown) { body = value; } };
  return { res, result: () => ({ status, body }) };
}

function fixture() {
  let writes = 0;
  const engine = new Proxy({}, { get: () => () => { throw new Error("Unexpected runtime mutation"); } }) as Engine;
  const manager = new RuntimeConfigManager(engine, { write: async () => { writes++; } } as unknown as RuntimeConfigStore);
  const apis = createServiceApis(engine, {} as Parameters<typeof createServiceApis>[1], manager);
  return { manager, apis, writes: () => writes };
}
const validConnection = { id: "plc-a", config: { endpointUrl: "opc.tcp://localhost:4840" }, mappings: [] };
const mapping = { id: "temperature", config: { nodeId: "ns=2;s=Temperature", topic: "enterprise/site/", asset: "device-a", objectType: "equipment", objectId: "main", attribute: "temperature" } };

for (const attribute of ["validate", "apply"]) {
  for (const [name, snapshot, path] of [
    ["invalid shape", { connections: "invalid" }, ["connections"]],
    ["empty ID", { connections: [{ ...validConnection, id: "" }] }, ["connections", 0, "id"]],
    ["duplicate connections", { connections: [validConnection, validConnection] }, ["connections", 1, "id"]],
    ["duplicate mappings", { connections: [{ ...validConnection, mappings: [mapping, mapping] }] }, ["connections", 0, "mappings", 1, "id"]],
  ] as const) {
    test(`${attribute}: ${name} returns 400 without runtime or store mutations`, async () => {
      const f = fixture();
      const before = f.manager.getCurrentConfig();
      const api = Object.values(f.apis).find((api) => api.objectId === "config" && api.attribute === attribute);
      assert.ok(api);
      const r = response();
      await api.handler({ req: { body: snapshot }, res: r.res });
      assert.equal(r.result().status, 400);
      assert.equal(r.result().body.code, "VALIDATION_ERROR");
      assert.deepEqual(r.result().body.issues[0].path, path);
      assert.deepEqual(f.manager.getCurrentConfig(), before);
      assert.equal(f.writes(), 0);
    });
  }
}

test("browse rejects invalid credential types without echoing supplied values", async () => {
  const f = fixture(); const r = response();
  await f.apis["browseNodes"]!.handler({ req: { body: { config: { endpointUrl: "opc.tcp://localhost:4840", userIdentity: { password: { secret: "never-echo-this" } } } } }, res: r.res });
  assert.equal(r.result().status, 400);
  assert.match(r.result().body.error, /config.userIdentity.password/);
  assert.ok(!JSON.stringify(r.result().body).includes("never-echo-this"));
});

test("discovery rejects invalid endpoint type", async () => {
  const f = fixture(); const r = response();
  await f.apis["discoveryServers"]!.handler({ req: { query: { endpointUrl: 123 } }, res: r.res });
  assert.equal(r.result().status, 400);
});

test("successful handlers and unexpected storage/runtime errors retain their contract", async () => {
  const r = response();
  await withValidationErrors(async (event) => { event.res.json({ ok: true }); })({ req: {}, res: r.res });
  assert.deepEqual(r.result(), { status: 200, body: { ok: true } });
  const failure = new Error("storage unavailable");
  await assert.rejects(withValidationErrors(async () => { throw failure; })({ req: {}, res: r.res }), (error) => error === failure);
});

test("large validation responses are bounded", async () => {
  const r = response();
  await withValidationErrors(async () => { z.array(z.number()).parse(Array(30).fill("invalid")); })({ req: {}, res: r.res });
  assert.equal(r.result().body.issues.length, 20);
});


test("missing runtime references block started apply before any mutation", async () => {
  const f = fixture(); const r = response();
  const api = Object.values(f.apis).find((api) => api.objectId === "config" && api.attribute === "apply")!;
  const before = f.manager.getCurrentConfig();
  await api.handler({ req: { body: { connections: [{ ...validConnection, start: true, config: { endpointUrl: "opc.tcp://plc.example:4840", userIdentity: { type: "username", userName: {provider:"env",key:"UNS_RUNTIME_SECRET_F09_MISSING_USER"},password:{provider:"env",key:"UNS_RUNTIME_SECRET_F09_MISSING_PASSWORD"} } } }] } }, res: r.res });
  assert.equal(r.result().status, 400);
  assert.match(r.result().body.error, /Provision local runtime secret UNS_RUNTIME_SECRET_F09_MISSING_USER/);
  assert.equal(f.writes(), 0); assert.deepEqual(f.manager.getCurrentConfig(), before);
});
