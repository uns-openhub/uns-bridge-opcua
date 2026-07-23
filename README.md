# UNS Bridge OPC UA

UNS DataHub add-on for browsing OPC UA servers, managing source connections,
and mapping OPC UA nodes into canonical UNS attributes.

Requires Node.js 22+, pnpm 10, UNS DataHub, and an accessible OPC UA endpoint.

## Scripts

```bash
pnpm install
cp config-example.json config.json
export UNS_PASSWORD='your-controller-password'
pnpm run dev
pnpm run verify
```

## Configuration

Update `config.json` with UNS endpoints and credentials. The management API
requires the configured controller JWKS endpoints.

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

The protocol-agnostic management API now lives in local `bridge-core` and is intended to become a reusable package later, for example `@uns-kit/bridge-core`.

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

`UnsClient` provides a minimal REST client for the UNS Datahub API, including the batch last-value endpoint. Prefer a long-lived service token if available; you can pass it directly and skip username/password auth.

```ts
import { UnsClient } from '@uns-kit/core';

const client = new UnsClient('https://datahub.example.com', {
  token: process.env.UNS_SERVICE_TOKEN,
});

const values = await client.lastValue(['raw/data/line-1/motor/main/temperature', 'raw/data/line-1/motor/main/status']);
console.log(values);
```

## Releases

The package version is the source of truth. Release tags must match it exactly.
For example, package version `1.1.1` uses tag `1.1.1`. No package is published
automatically.

## License

[MIT](./LICENSE) © Aljoša Vister.
