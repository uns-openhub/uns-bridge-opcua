# UNS Bridge OPC UA

UNS OpenHub add-on for browsing OPC UA servers, managing source connections,
and mapping OPC UA nodes into canonical UNS attributes.

Requires Node.js 22+, pnpm 10, UNS OpenHub, and an accessible OPC UA endpoint.

## Scripts

```bash
pnpm install
cp config-development-host.json config.json
pnpm run dev
pnpm run verify
```

## Configuration

Choose one tracked startup profile, then copy it to the ignored `config.json`:

| Profile                          | Use it when                                                 | MQTT                    | Controller authentication                                                   |
| -------------------------------- | ----------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------- |
| `config-development-host.json`   | Running the bridge directly with `pnpm run dev` on the host | `localhost`             | None; the bridge validates caller JWTs through the controller JWKS endpoint |
| `config-development-podman.json` | Deploying through a local Podman OpenHub controller         | Compose DNS `mosquitto` | None; the controller supplies the reachable JWKS endpoint                   |
| `config-production.json`         | Creating a production controller instance                   | Runtime DNS `mosquitto` | None; use the controller's reachable JWKS endpoint                          |

The Podman and production profiles use the internal network name because the
RTT process runs alongside the controller. The production profile is a safe
starting point only; supply real external endpoints through the controller's
deployment configuration. The bridge does not log in with an email/password or
service token: its management API verifies the operator's JWT using the
configured controller JWKS endpoints.

Runtime bridge state is loaded from `runtime-config.json` when present. A sample snapshot is provided in `runtime-config.json.example`.
This runtime snapshot is separate from the original `uns-kit` `config.json` structure (`uns`, `infra`, `input`, `output`, ...).
If needed, override the snapshot path with `UNS_BRIDGE_RUNTIME_CONFIG_PATH`.

Recommended flow:

- keep `config.json` for infrastructure and service settings
- keep `runtime-config.json` as a persisted local snapshot only
- apply desired connection/mapping state through the API `config/apply` endpoint

Key runtime config endpoints:

- `GET /api/system/bridge/opcua/runtime/service/config/state`
- `GET /api/system/bridge/opcua/runtime/service/config/source-status`
- `POST /api/system/bridge/opcua/runtime/service/config/apply`
- `POST /api/system/bridge/opcua/runtime/service/config/validate`
- `POST /api/system/bridge/opcua/runtime/service/config/reload-snapshot`

Other management endpoints:

- `GET /api/system/bridge/opcua/runtime/service/bridge/health`
- `GET /api/system/bridge/opcua/runtime/service/bridge/status`
- `GET /api/system/bridge/opcua/runtime/service/discovery/servers?endpointUrl=opc.tcp://localhost:4840`
- `GET /api/system/bridge/opcua/runtime/service/connections/list`
- `GET /api/system/bridge/opcua/runtime/service/connections/status?id=plc-a`
- `GET /api/system/bridge/opcua/runtime/service/connections/mappings?id=plc-a`
- `POST /api/system/bridge/opcua/runtime/service/browse/nodes`
- `POST /api/system/bridge/opcua/runtime/service/connections/create`
- `POST /api/system/bridge/opcua/runtime/service/connections/update`
- `POST /api/system/bridge/opcua/runtime/service/connections/delete`
- `POST /api/system/bridge/opcua/runtime/service/connections/start`
- `POST /api/system/bridge/opcua/runtime/service/connections/stop`
- `POST /api/system/bridge/opcua/runtime/service/mappings/create`
- `POST /api/system/bridge/opcua/runtime/service/mappings/update`
- `POST /api/system/bridge/opcua/runtime/service/mappings/delete`

Swagger is served by `@uns-kit/api` for the registered endpoints. After startup, use the generated swagger JSON/UI exposed by the API proxy instance.

## Shared Bridge-Core API

The protocol-agnostic management API is provided by the separately published
`@uns-kit/bridge-core` package. This bridge requires `@uns-kit/bridge-core`
3.0.1 or newer and `@uns-kit/core` / `@uns-kit/api` 3.0.21 or newer.

Its managed publisher reconciles observed UNS topic metadata against the saved
connection and mapping targets. Stopping a connection keeps its configured
targets; retargeting or deleting a mapping removes obsolete publisher metadata,
while targets shared by other mappings remain. Accepted publishes drain before
retirement with a bounded wait, and late publishes to removed targets are
rejected. A drain timeout fails the operation rather than reporting a completed
retirement. Reconciliation does not create unseen target observations or delete
UNS nodes, retained values, or archived history.

These endpoints should stay aligned across bridges such as `uns-bridge-opcua`, `uns-bridge-modbus`, and `uns-bridge-mqtt`:

- `GET .../bridge/health`
- `GET .../bridge/status`
- `GET .../connections/list`
- `GET .../connections/status`
- `GET .../connections/mappings`
- `POST .../connections/create`
- `POST .../connections/update`
- `POST .../connections/delete`
- `POST .../connections/start`
- `POST .../connections/stop`
- `POST .../mappings/create`
- `POST .../mappings/update`
- `POST .../mappings/delete`
- `GET .../config/state`
- `GET .../config/source-status`
- `POST .../config/apply`
- `POST .../config/validate`
- `POST .../config/reload-snapshot`

Protocol-specific bridges should only add their own endpoints on top, for example:

- OPC UA: discovery, browse
- Modbus: device scan, register test
- MQTT bridge: topic discovery, subscription test

`bridge/health` is intentionally lightweight and intended for uptime checks. Use `bridge/status`,
`connections/list`, or `connections/status` when the frontend needs runtime state such as
`stopped`, `running`, `reconnecting`, or `error`.

## Browse API

`POST /api/system/bridge/opcua/runtime/service/browse/nodes`

Browse is intentionally one level at a time. The frontend should:

1. browse a parent node
2. render returned children
3. when the user expands a child with `hasChildren: true`, browse again with that child `nodeId`

This keeps payloads smaller and avoids full-tree scans on large OPC UA servers.

Example request:

```json
{
  "config": {
    "endpointUrl": "opc.tcp://localhost:65000",
    "securityMode": "None",
    "monitoring": {
      "discardOldest": true,
      "queueSize": 10,
      "intervalMs": 1000,
      "timestampsToReturn": "both"
    }
  },
  "nodeId": "ObjectsFolder"
}
```

Example response:

```json
{
  "endpointUrl": "opc.tcp://localhost:65000",
  "nodeId": "ObjectsFolder",
  "continuationPoint": null,
  "children": [
    {
      "nodeId": "ns=3;s=Machine",
      "browseName": "Machine",
      "displayName": "Machine",
      "nodeClass": "Object",
      "typeDefinition": "i=58",
      "referenceTypeId": "i=35",
      "isForward": true,
      "hasChildren": true
    },
    {
      "nodeId": "ns=3;s=Machine.Temperature",
      "browseName": "Temperature",
      "displayName": "Temperature",
      "nodeClass": "Variable",
      "typeDefinition": "i=63",
      "referenceTypeId": "i=47",
      "isForward": true,
      "hasChildren": false,
      "dataTypeNodeId": "i=11",
      "valueRank": -1,
      "accessLevel": 3,
      "userAccessLevel": 3
    }
  ]
}
```

Example follow-up request when the user expands `Machine`:

```json
{
  "config": {
    "endpointUrl": "opc.tcp://localhost:65000",
    "securityMode": "None"
  },
  "nodeId": "ns=3;s=Machine"
}
```

## Runtime Config Apply

`POST /api/system/bridge/opcua/runtime/service/config/apply`

Apply a full desired-state snapshot. The bridge reconciles connections and mappings live, without restart, and persists the snapshot locally to `runtime-config.json`.

Sampling behavior:

- connection `config.monitoring.intervalMs` is the default interval for all mappings on that connection
- mapping `config.intervalMs` overrides the connection default interval only for that mapping
- mapping `config.mode` can optionally be set to `polling` for specific mappings that should be read periodically even when unchanged

Mapping publish behavior:

- `dataGroup` can be set per mapping
- if `dataGroup` is omitted, the bridge uses `connectionId` as before
- for sub-assets, set `topic` to the full parent asset path and `asset` to the
  leaf sub-asset; for example `topic: "enterprise/site/area/line/line-3-furnace/"`
  and `asset: "zone-1"` publishes under
  `enterprise/site/area/line/line-3-furnace/zone-1/...`
- `validityMode` can be `interval` or `lifecycle`
- `expectedIntervalMs` is used for interval-based liveliness
- `lifecycleEndValue` is used for lifecycle-based liveliness
- `publishInitialValue` is optional and defaults to `false`
- use `publishInitialValue: true` only for passive state/config values where an initial snapshot is desirable
- keep it `false` for trigger-like values to avoid restart-triggered side effects

Example payload:

```json
{
  "version": 1,
  "connections": [
    {
      "id": "plc-a",
      "start": true,
      "config": {
        "endpointUrl": "opc.tcp://localhost:4840",
        "securityMode": "None",
        "monitoring": {
          "intervalMs": 1000,
          "queueSize": 10,
          "discardOldest": true,
          "timestampsToReturn": "both"
        }
      },
      "mappings": [
        {
          "id": "temperature",
          "config": {
            "nodeId": "ns=3;s=Machine.Temperature",
            "topic": "enterprise/site/area/line/",
            "asset": "line-3-furnace",
            "assetDescription": "Line 3 furnace",
            "objectType": "energy-resource",
            "objectId": "main-bus",
            "attribute": "current",
            "attributeDescription": "Current measurement",
            "dataGroup": "opcua-plc-a",
            "validityMode": "interval",
            "publishInitialValue": false,
            "mode": "polling",
            "expectedIntervalMs": 1000,
            "intervalMs": 500
          }
        },
        {
          "id": "furnace-zone-temperature",
          "config": {
            "nodeId": "ns=3;s=Machine.Zone1.Temperature",
            "topic": "enterprise/site/area/line/line-3-furnace/",
            "asset": "zone-1",
            "objectType": "equipment",
            "objectId": "main",
            "attribute": "temperature",
            "dataGroup": "opcua-plc-a",
            "validityMode": "interval",
            "mode": "polling",
            "expectedIntervalMs": 1000,
            "intervalMs": 500
          }
        }
      ]
    }
  ]
}
```

## Connection and Mapping Payloads

Create or replace a connection:

`POST /api/system/bridge/opcua/runtime/service/connections/create`

```json
{
  "id": "plc-a",
  "start": true,
  "config": {
    "endpointUrl": "opc.tcp://localhost:4840",
    "securityMode": "None",
    "monitoring": {
      "intervalMs": 1000,
      "queueSize": 10,
      "discardOldest": true,
      "timestampsToReturn": "both"
    }
  },
  "mappings": []
}
```

Add or replace one mapping on an existing connection:

`POST /api/system/bridge/opcua/runtime/service/mappings/create`

```json
{
  "connectionId": "plc-a",
  "mapping": {
    "id": "temperature",
    "config": {
      "nodeId": "ns=3;s=Machine.Temperature",
      "topic": "enterprise/site/area/line/",
      "asset": "line-3-furnace",
      "assetDescription": "Line 3 furnace",
      "objectType": "energy-resource",
      "objectId": "main-bus",
      "attribute": "current",
      "attributeDescription": "Current measurement",
      "dataGroup": "opcua-plc-a",
      "validityMode": "interval",
      "publishInitialValue": false,
      "mode": "polling",
      "expectedIntervalMs": 1000,
      "intervalMs": 500
    }
  }
}
```

For a lifecycle-style attribute instead of interval-style liveliness:

```json
{
  "connectionId": "plc-a",
  "mapping": {
    "id": "material-presence",
    "config": {
      "nodeId": "ns=3;s=Machine.MaterialPresence",
      "topic": "enterprise/site/area/line/",
      "asset": "line-3-furnace",
      "objectType": "material-state",
      "objectId": "transfer-zone",
      "attribute": "presence",
      "dataGroup": "opcua-plc-a",
      "validityMode": "lifecycle",
      "lifecycleEndValue": "EXITED"
    }
  }
}
```

Published attribute shape:

```json
{
  "attribute": "current",
  "description": "Current measurement",
  "validityMode": "interval",
  "expectedIntervalMs": 1000,
  "data": {
    "time": "2026-04-16T08:00:00.000Z",
    "value": 12.4,
    "dataGroup": "opcua-plc-a"
  }
}
```

If `dataGroup` is not configured on the mapping, the bridge publishes `connectionId` as `dataGroup`.

Mapping acquisition behavior:

- default: subscription with OPC UA monitored items
- optional per mapping: `mode: "polling"`
- use polling only for selected tags such as setpoints, recipes, or configuration values that may not change often
- `publishInitialValue` is independent of acquisition mode and defaults to `false`
- enable it only when consumers should see the current value immediately after mapping activation or restart

Start or stop a configured connection:

`POST /api/system/bridge/opcua/runtime/service/connections/start`
`POST /api/system/bridge/opcua/runtime/service/connections/stop`

```json
{
  "id": "plc-a"
}
```

## Validity / Liveliness

UNS attributes can declare how the controller decides whether they are live or stale; in most apps this is primarily used to drive UI liveliness/activity indicators. In app-level modeling we use two modes only:

- `interval`: continuously refreshed values (stale after ~2× `expectedIntervalMs`)
- `lifecycle`: event-driven activity that stays active until a defined end value (`lifecycleEndValue`)

Example:

```ts
await proxy.publishMqttMessage({
  topic: 'raw/data/',
  asset: 'line-1',
  objectType: 'motor',
  objectId: 'main',
  attributes: {
    attribute: 'status',
    data: { time: new Date().toISOString(), value: 'RUNNING' },
    validityMode: 'lifecycle',
    lifecycleEndValue: 'STOPPED',
  },
});
```

## Datahub client (last value)

`UnsClient` provides a minimal REST client for the UNS OpenHub API, including the batch last-value endpoint. Prefer a long-lived service token if available; you can pass it directly and skip username/password auth.

```ts
import { UnsClient } from '@uns-kit/core';

const client = new UnsClient('https://datahub.example.com', {
  token: process.env.UNS_SERVICE_TOKEN,
});

const values = await client.lastValue(['raw/data/line-1/motor/main/temperature', 'raw/data/line-1/motor/main/status']);
console.log(values);
```

## Releases

The package version is the source of truth. A change to `package.json` on
`main` creates the immutable `v<version>` tag and matching GitHub Release after
release metadata validation. The release tag then runs the full verification
suite.

## License

[MIT](./LICENSE) © Aljoša Vister.

## Source health observations

The bridge reports the state of its actual started OPC UA sessions every five
seconds through retained service metadata. It does not open separate periodic
probe sessions. Stopped connections do not degrade source health. Runtime status
reads and metadata publication have bounded waits; newer controllers expire these
observations after 20 seconds rather than confirming an old healthy result.
Connection status details include the last received value time, last good value
time and last observed quality. These are observations across that connection's
mappings, not a promise that every mapped signal is fresh.

## Engineering units

Browse returns a readable built-in data type and optional `engineeringUnits` from
the source's OPC UA EngineeringUnits property. The runtime reads this optional
property on the existing session when activating/restoring a mapping and includes
its display name as `data.uom` on published UNS values. Missing, bad or slow unit
metadata does not prevent monitoring. Metadata is not read on every data sample.

An optional mapping `uom` overrides the unit label. Blank/omitted uses source
metadata; numeric values are never converted. Unknown units stay absent rather
than being guessed from the signal name. Schema-version-1 snapshots remain valid.
Unit/type metadata is source observation and does not overwrite tenant schema.

### Portable runtime configuration

`runtime-state.manifest.json` declares the runtime-owned JSON configuration file
and its source-generated JSON schema. Controller cold updates copy this file
only after the source stops; differing target configuration blocks the move.
The file stays on disk, separately from controller-local startup credentials.
`pnpm build` regenerates the runtime schema from `runtimeConfigSnapshotSchema`.
Default `runtime-config.json` is supported; an external path selected through
`UNS_BRIDGE_RUNTIME_CONFIG_PATH` requires separate operator-managed transfer.
Cross-controller automatic transfer supports anonymous remote endpoints and
username/password sources whose two credentials use local environment references.
Inline credentials, loopback addresses and local certificate files are blocked
before stopping the source. Runtime changes are written atomically.

### Local runtime credential references

Username-authenticated sources can use node-local environment references in
`runtime-config.json` instead of inline credentials:

```json
{
  "userIdentity": {
    "type": "username",
    "userName": { "provider": "env", "key": "UNS_RUNTIME_SECRET_PLC_USER" },
    "password": { "provider": "env", "key": "UNS_RUNTIME_SECRET_PLC_PASSWORD" }
  }
}
```

Provision those variables separately on every controller that will run the
connection. References must have exactly `provider` and `key`, with an
`UNS_RUNTIME_SECRET_*` key; values and defaults are not part of the reference.
The runtime resolves them only when opening an OPC UA session. Saved snapshots,
configuration API responses and shared configuration retain the reference objects.
Missing variables block a started configuration before runtime mutation; check
and browse also fail without falling back to anonymous authentication. Stopped
connections can be authored before provisioning in a running bridge. Controller-managed
process starts require every declared reference, including stopped connections.
Existing inline credentials still
work locally but are not eligible for cross-controller configuration transfer.

Rotation changes the local variable, then requires a process restart with the new
environment. It does not change the shared runtime configuration revision. A
nonempty binding proves availability only; check the OPC UA connection to prove
that the server accepts it. Use a trusted network and the appropriate OPC UA
security policy for the server. This reference feature does not change transport
security or provision/distribute secrets. The initial provider is `env` only.


### Development candidate: reviewed connection recipes

The controller's OPC UA workspace can export/import portable connection recipes
(`uns-openhub/opcua-connection`, version `1`). Device mapping recipes are a
separate artifact; connection recipes contain no UNS destinations or mappings.
The source endpoint, connection ID/name, start flag and inline credentials are
excluded. Supported security, session, subscription and monitoring options are
preserved, including absent defaults and explicit zero/false values. Import
asks for a new local name, an `opc.tcp://` endpoint and, for username auth, strict
`UNS_RUNTIME_SECRET_*` environment reference keys. Values may come from the
existing node-local environment/Infisical bootstrap; recipes never contain them.

Two additive management endpoints support this flow under the existing protected
`/api/system/bridge/opcua/runtime/service/` namespace:

- `POST connections/preview-add`: `{ "connection": { "id": "plc-b", "config": { "endpointUrl": "opc.tcp://plc-b.local:4840" } } }`.
  Returns `{ "id", "revision" }`. No source connection, secret resolution or
  snapshot write occurs during review.
- `POST connections/append-reviewed`: the same `connection` plus
  `expectedRevision` from review. Returns `{ "id", "start": false }`.
  Requires an unchanged configuration revision, rejects existing names (also
  case-insensitively), and creates only a stopped connection with no mappings.
  Existing sessions are not started, stopped or reapplied by this operation.

These APIs reject unknown fields, inline credentials, embedded endpoint
credentials and supplied start/mapping flags. A stale revision returns
`409 CONFIG_CHANGED`; validation failure returns `400 VALIDATION_ERROR`.
Both routes inherit the existing controller JWKS authorization boundary.
Starting remains a separate action and requires credential values to have been
provisioned. An older bridge without these endpoints must be updated; the UI
must not fall back to the legacy `connections/create` upsert operation.

This is a locally verified development candidate, not publication evidence.
Full runtime snapshots and the existing editable create/update APIs retain their
previous contracts. A network/write failure with an uncertain outcome requires
refreshing saved connections before retrying.

### Guided device setup (development candidate)

The controller can export a portable version 1 `uns-openhub/opcua-device` recipe
containing connection settings and signal definitions. Local endpoint, saved
connection/mapping IDs, UNS destination and inline credentials are excluded.
Supported local credential references remain unresolved in the artifact.

`devices/preview-add` reviews `{ connection: { id, config }, mappings }` without
opening a source connection or changing configuration. `devices/append-reviewed`
requires the reviewed `expectedRevision` and adds only one **new stopped**
connection plus 1–100 mappings for one UNS device. Duplicate names, IDs and
UNS mapped attributes are rejected. The mutation is serialized, writes one atomic
snapshot and removes the new stopped engine connection on mapping/write failure;
existing sessions are not replayed. All routes retain controller JWKS protection.

The guided UI chooses an existing active UNS Object ID and checks fresh attributes
before review/create. Cancel leaves no partial connection. Create does not resolve
credentials or start the device; provision local values and use explicit Start.
This is a scoped additive setup contract, not a schema/package migration or a
transaction guarantee across a process crash. Older bridges need an update.
