import {
  defineDataCatalogField,
  defineDataCatalogQueryParam,
  defineDataCatalogSchema,
  defineServiceApi,
  type ServiceApiRegistration,
} from "@uns-kit/api";
import {
  createBridgeManagementServiceApis,
  type BridgeEngine,
} from "@uns-kit/bridge-core";
import type { IPostEndpointOptions } from "@uns-kit/core/uns/uns-interfaces.js";
import { z } from "zod";
import {
  opcuaSecurityPolicyValues,
  runtimeConfigSnapshotSchema,
  runtimeConnectionConfigSchema,
  runtimeMappingConfigSchema,
  type RuntimeConfigSnapshot,
} from "../config/runtime-config.js";
import { OpcuaAdapter } from "../opcua/opcua-adapter.js";
import type { OpcuaConnectionConfig } from "../opcua/opcuaClientWrapper.js";
import type { OpcuaMappingConfig, OpcuaValueEvent } from "../opcua/subscriptionManager.js";
import { RuntimeConfigManager } from "../runtime/runtime-config-manager.js";

const SYSTEM_TOPIC = "system/bridge/opcua/";
const SERVICE_ASSET = "runtime";
const SERVICE_OBJECT_TYPE = "service";
const EXPLORE_TAGS = ["Explore"];
const OPCUA_SECURITY_POLICY_ENUM = [...opcuaSecurityPolicyValues];

const runtimeConfigApplyExample = {
  version: 1,
  connections: [
    {
      id: "plc-a",
      start: true,
      config: {
        endpointUrl: "opc.tcp://localhost:4840",
        securityMode: "None",
        monitoring: {
          intervalMs: 1000,
          queueSize: 10,
          discardOldest: true,
          timestampsToReturn: "both",
        },
      },
      mappings: [
        {
          id: "temperature",
          config: {
            nodeId: "ns=3;s=Machine.Temperature",
            topic: "enterprise/site/area/line/",
            asset: "line-3-furnace",
            assetDescription: "Line 3 furnace",
            objectType: "energy-resource",
            objectId: "main-bus",
            attribute: "current",
            attributeDescription: "Current measurement",
            dataGroup: "opcua-plc-a",
            validityMode: "interval",
            publishInitialValue: false,
            mode: "polling",
            expectedIntervalMs: 1000,
            intervalMs: 500,
          },
        },
      ],
    },
  ],
} satisfies RuntimeConfigSnapshot;

const browseRequestExample = {
  config: {
    endpointUrl: "opc.tcp://localhost:4840",
    securityMode: "None",
    monitoring: {
      intervalMs: 1000,
      queueSize: 10,
      discardOldest: true,
      timestampsToReturn: "both",
    },
  },
  nodeId: "ObjectsFolder",
};

const connectionIdQuerySchema = z.object({
  id: z.string().min(1),
});

const discoveryQuerySchema = z.object({
  endpointUrl: z.string().min(1).optional(),
});

const connectionCreateBodySchema = z.object({
  id: z.string().min(1),
  start: z.boolean().optional(),
  config: runtimeConnectionConfigSchema,
  mappings: z
    .array(
      z.object({
        id: z.string().min(1),
        config: runtimeMappingConfigSchema,
      }),
    )
    .optional(),
});

const connectionUpdateBodySchema = z.object({
  id: z.string().min(1),
  start: z.boolean().optional(),
  config: runtimeConnectionConfigSchema,
});

const connectionControlBodySchema = z.object({
  id: z.string().min(1),
});

const mappingCreateBodySchema = z.object({
  connectionId: z.string().min(1),
  mapping: z.object({
    id: z.string().min(1),
    config: runtimeMappingConfigSchema,
  }),
});

const mappingDeleteBodySchema = z.object({
  connectionId: z.string().min(1),
  mappingId: z.string().min(1),
});

const browseBodySchema = z.object({
  config: runtimeConnectionConfigSchema,
  nodeId: z.string().min(1).optional(),
});

type ConnectionCreateBody = z.output<typeof connectionCreateBodySchema>;
type ConnectionUpdateBody = z.output<typeof connectionUpdateBodySchema>;
type ConnectionControlBody = z.output<typeof connectionControlBodySchema>;
type MappingCreateBody = z.output<typeof mappingCreateBodySchema>;
type MappingDeleteBody = z.output<typeof mappingDeleteBodySchema>;

type BridgeServiceHandler = (event: { req: any; res: any }) => Promise<void>;

const discoveryQueryParams = [
  defineDataCatalogQueryParam("endpointUrl", "OPC UA discovery endpoint, e.g. opc.tcp://localhost:4840", {
    required: false,
    type: "string",
    example: "opc.tcp://localhost:4840",
  }),
];

const browseRequestSchema = defineDataCatalogSchema({
  id: "opcua-browse-request",
  title: "OPC UA Browse Request",
  contentType: "application/json",
  fields: [
    defineDataCatalogField("endpointUrl", "string", "OPC UA endpoint URL", {
      required: true,
      path: "config.endpointUrl",
      example: "opc.tcp://localhost:4840",
    }),
    defineDataCatalogField("securityMode", "string", "Security mode", {
      path: "config.securityMode",
      example: "None",
      enumValues: ["None", "Sign", "SignAndEncrypt"],
    }),
    defineDataCatalogField("securityPolicy", "string", "Security policy", {
      path: "config.securityPolicy",
      example: "Basic256Sha256",
      enumValues: OPCUA_SECURITY_POLICY_ENUM,
    }),
    defineDataCatalogField("nodeId", "string", "Browse root node id", {
      example: "ObjectsFolder",
    }),
  ],
  examplePayloads: [browseRequestExample],
});

function parseBody<TSchema extends z.ZodTypeAny>(event: { req: any }, schema: TSchema): z.output<TSchema> {
  return schema.parse(event.req.body ?? {});
}

function parseQuery<TSchema extends z.ZodTypeAny>(event: { req: any }, schema: TSchema): z.output<TSchema> {
  return schema.parse(event.req.query ?? {});
}

function cloneConfig(snapshot: RuntimeConfigSnapshot): RuntimeConfigSnapshot {
  return structuredClone(snapshot);
}

function createConnectionCreateRequestBody(): NonNullable<IPostEndpointOptions["requestBody"]> {
  return {
    description: "Connection entry to create or update. Existing mappings are preserved when mappings is omitted.",
    required: true,
    schema: {
      type: "object",
      required: ["id", "config"],
      properties: {
        id: { type: "string", example: "plc-a" },
        start: { type: "boolean", example: true },
        config: {
          type: "object",
          required: ["endpointUrl"],
          properties: {
            endpointUrl: { type: "string", example: "opc.tcp://localhost:4840" },
            securityMode: { type: "string", enum: ["None", "Sign", "SignAndEncrypt"], example: "None" },
            securityPolicy: { type: "string", enum: OPCUA_SECURITY_POLICY_ENUM, example: "Basic256Sha256" },
            monitoring: {
              type: "object",
              properties: {
                intervalMs: { type: "number", example: 1000 },
                queueSize: { type: "number", example: 10 },
                discardOldest: { type: "boolean", example: true },
              },
            },
          },
        },
        mappings: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "config"],
            properties: {
              id: { type: "string", example: "temperature" },
              config: {
                type: "object",
                required: ["nodeId", "topic", "asset", "objectType", "objectId", "attribute"],
                properties: {
                  nodeId: { type: "string", example: "ns=3;s=Machine.Temperature" },
                  topic: { type: "string", example: "enterprise/site/area/line/" },
                  asset: { type: "string", example: "line-3-furnace" },
                  assetDescription: { type: "string", example: "Line 3 furnace" },
                  objectType: { type: "string", example: "energy-resource" },
                  objectTypeDescription: { type: "string", example: "Energy resource" },
                  objectId: { type: "string", example: "main-bus" },
                  attribute: { type: "string", example: "current" },
                  attributeDescription: { type: "string", example: "Current measurement" },
                  dataGroup: { type: "string", example: "opcua-plc-a" },
                  validityMode: { type: "string", enum: ["interval", "lifecycle"], example: "interval" },
                  lifecycleEndValue: { type: "string", example: "STOPPED" },
                  publishInitialValue: { type: "boolean", example: false },
                  mode: { type: "string", enum: ["subscription", "polling"], example: "polling" },
                  expectedIntervalMs: { type: "number", example: 1000 },
                  intervalMs: { type: "number", example: 500 },
                  queueSize: { type: "number", example: 10 },
                  discardOldest: { type: "boolean", example: true },
                },
              },
            },
          },
        },
      },
      example: runtimeConfigApplyExample.connections[0],
    },
  };
}

function createConnectionUpdateRequestBody(): NonNullable<IPostEndpointOptions["requestBody"]> {
  return {
    description: "Existing connection id plus replacement connection config",
    required: true,
    schema: {
      type: "object",
      required: ["id", "config"],
      properties: {
        id: { type: "string", example: "plc-a" },
        start: { type: "boolean", example: true },
        config: {
          type: "object",
          required: ["endpointUrl"],
          properties: {
            endpointUrl: { type: "string", example: "opc.tcp://localhost:4840" },
            securityMode: { type: "string", enum: ["None", "Sign", "SignAndEncrypt"], example: "None" },
            securityPolicy: { type: "string", enum: OPCUA_SECURITY_POLICY_ENUM, example: "Basic256Sha256" },
            requestedSessionTimeoutMs: { type: "number", example: 60000 },
            monitoring: {
              type: "object",
              properties: {
                intervalMs: { type: "number", example: 1000 },
              },
            },
          },
        },
      },
      example: {
        id: "plc-a",
        start: true,
        config: {
          ...runtimeConfigApplyExample.connections[0]!.config,
          monitoring: {
            ...runtimeConfigApplyExample.connections[0]!.config.monitoring,
            intervalMs: 1000,
          },
        },
      },
    },
  };
}

function createConnectionControlRequestBody(): NonNullable<IPostEndpointOptions["requestBody"]> {
  return {
    description: "Connection id",
    required: true,
    schema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", example: "plc-a" },
      },
      example: { id: "plc-a" },
    },
  };
}

function createMappingRequestBody(description: string): NonNullable<IPostEndpointOptions["requestBody"]> {
  return {
    description,
    required: true,
    schema: {
      type: "object",
      required: ["connectionId", "mapping"],
      properties: {
        connectionId: { type: "string", example: "plc-a" },
        mapping: {
          type: "object",
          required: ["id", "config"],
          properties: {
            id: { type: "string", example: "temperature" },
            config: {
              type: "object",
              required: ["nodeId", "topic", "asset", "objectType", "objectId", "attribute"],
              properties: {
                nodeId: { type: "string", example: "ns=3;s=Machine.Temperature" },
                topic: { type: "string", example: "enterprise/site/area/line/" },
                asset: { type: "string", example: "line-3-furnace" },
                objectType: { type: "string", example: "energy-resource" },
                objectId: { type: "string", example: "main-bus" },
                attribute: { type: "string", example: "current" },
                dataGroup: { type: "string", example: "opcua-plc-a" },
                validityMode: { type: "string", enum: ["interval", "lifecycle"], example: "interval" },
                lifecycleEndValue: { type: "string", example: "STOPPED" },
                publishInitialValue: { type: "boolean", example: false },
                mode: { type: "string", enum: ["subscription", "polling"], example: "polling" },
                expectedIntervalMs: { type: "number", example: 1000 },
                intervalMs: { type: "number", example: 500 },
              },
            },
          },
        },
      },
      example: {
        connectionId: "plc-a",
        mapping: runtimeConfigApplyExample.connections[0]!.mappings[0],
      },
    },
  };
}

function createMappingDeleteRequestBody(): NonNullable<IPostEndpointOptions["requestBody"]> {
  return {
    description: "Connection id plus mapping id",
    required: true,
    schema: {
      type: "object",
      required: ["connectionId", "mappingId"],
      properties: {
        connectionId: { type: "string", example: "plc-a" },
        mappingId: { type: "string", example: "temperature" },
      },
      example: {
        connectionId: "plc-a",
        mappingId: "temperature",
      },
    },
  };
}

function createConfigSnapshotRequestBody(description: string): NonNullable<IPostEndpointOptions["requestBody"]> {
  return {
    description,
    required: true,
    schema: {
      type: "object",
      required: ["version", "connections"],
      properties: {
        version: { type: "number", enum: [1], example: 1 },
        updatedAt: { type: "string", format: "date-time", example: "2026-04-16T08:00:00.000Z" },
        connections: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "config"],
            properties: {
              id: { type: "string", example: "plc-a" },
              start: { type: "boolean", example: true },
              config: { type: "object" },
              mappings: { type: "array", items: { type: "object" } },
            },
          },
        },
      },
      example: runtimeConfigApplyExample,
    },
  };
}

function createConfigReloadRequestBody(): NonNullable<IPostEndpointOptions["requestBody"]> {
  return {
    description: "No body required",
    required: false,
    schema: {
      type: "object",
      example: {},
    },
  };
}

function upsertConnection(snapshot: RuntimeConfigSnapshot, body: ConnectionCreateBody): RuntimeConfigSnapshot {
  const nextConfig = cloneConfig(snapshot);
  const index = nextConfig.connections.findIndex((connection) => connection.id === body.id);

  if (index >= 0) {
    const existingConnection = nextConfig.connections[index];
    if (!existingConnection) {
      throw new Error(`Connection '${body.id}' does not exist`);
    }

    nextConfig.connections[index] = {
      ...existingConnection,
      config: body.config,
      ...(body.start !== undefined ? { start: body.start } : {}),
      ...(body.mappings !== undefined ? { mappings: body.mappings } : {}),
    };
  } else {
    nextConfig.connections.push({
      ...body,
      mappings: body.mappings ?? [],
    });
  }

  return nextConfig;
}

function updateConnection(snapshot: RuntimeConfigSnapshot, body: ConnectionUpdateBody): RuntimeConfigSnapshot {
  const nextConfig = cloneConfig(snapshot);
  const index = nextConfig.connections.findIndex((connection) => connection.id === body.id);

  if (index < 0) {
    throw new Error(`Connection '${body.id}' does not exist`);
  }

  const existingConnection = nextConfig.connections[index];
  if (!existingConnection) {
    throw new Error(`Connection '${body.id}' does not exist`);
  }

  nextConfig.connections[index] = {
    ...existingConnection,
    config: body.config,
    ...(body.start !== undefined ? { start: body.start } : {}),
  };

  return nextConfig;
}

function deleteConnection(snapshot: RuntimeConfigSnapshot, body: ConnectionControlBody): RuntimeConfigSnapshot {
  const nextConfig = cloneConfig(snapshot);
  nextConfig.connections = nextConfig.connections.filter((connection) => connection.id !== body.id);
  return nextConfig;
}

function startConnection(snapshot: RuntimeConfigSnapshot, body: ConnectionControlBody): RuntimeConfigSnapshot {
  const nextConfig = cloneConfig(snapshot);
  const connection = nextConfig.connections.find((entry) => entry.id === body.id);
  if (!connection) {
    throw new Error(`Connection '${body.id}' does not exist`);
  }
  connection.start = true;
  return nextConfig;
}

function stopConnection(snapshot: RuntimeConfigSnapshot, body: ConnectionControlBody): RuntimeConfigSnapshot {
  const nextConfig = cloneConfig(snapshot);
  const connection = nextConfig.connections.find((entry) => entry.id === body.id);
  if (!connection) {
    throw new Error(`Connection '${body.id}' does not exist`);
  }
  connection.start = false;
  return nextConfig;
}

function upsertMapping(snapshot: RuntimeConfigSnapshot, body: MappingCreateBody): RuntimeConfigSnapshot {
  const nextConfig = cloneConfig(snapshot);
  const connection = nextConfig.connections.find((entry) => entry.id === body.connectionId);
  if (!connection) {
    throw new Error(`Connection '${body.connectionId}' does not exist`);
  }
  const mappingIndex = connection.mappings.findIndex((mapping) => mapping.id === body.mapping.id);
  if (mappingIndex >= 0) {
    connection.mappings[mappingIndex] = body.mapping;
  } else {
    connection.mappings.push(body.mapping);
  }
  return nextConfig;
}

function updateMapping(snapshot: RuntimeConfigSnapshot, body: MappingCreateBody): RuntimeConfigSnapshot {
  const nextConfig = cloneConfig(snapshot);
  const connection = nextConfig.connections.find((entry) => entry.id === body.connectionId);
  if (!connection) {
    throw new Error(`Connection '${body.connectionId}' does not exist`);
  }
  const mappingIndex = connection.mappings.findIndex((mapping) => mapping.id === body.mapping.id);
  if (mappingIndex < 0) {
    throw new Error(`Mapping '${body.mapping.id}' does not exist on connection '${body.connectionId}'`);
  }
  connection.mappings[mappingIndex] = body.mapping;
  return nextConfig;
}

function deleteMapping(snapshot: RuntimeConfigSnapshot, body: MappingDeleteBody): RuntimeConfigSnapshot {
  const nextConfig = cloneConfig(snapshot);
  const connection = nextConfig.connections.find((entry) => entry.id === body.connectionId);
  if (!connection) {
    throw new Error(`Connection '${body.connectionId}' does not exist`);
  }
  connection.mappings = connection.mappings.filter((mapping) => mapping.id !== body.mappingId);
  return nextConfig;
}

export function createServiceApis(
  engine: BridgeEngine<OpcuaConnectionConfig, OpcuaMappingConfig, OpcuaValueEvent>,
  adapter: OpcuaAdapter,
  runtimeConfigManager: RuntimeConfigManager,
): Record<string, ServiceApiRegistration<BridgeServiceHandler>> {
  const managementServiceApis = createBridgeManagementServiceApis<
    OpcuaConnectionConfig,
    OpcuaMappingConfig,
    OpcuaValueEvent,
    RuntimeConfigSnapshot,
    ConnectionCreateBody,
    ConnectionUpdateBody,
    ConnectionControlBody,
    MappingCreateBody,
    MappingDeleteBody
  >({
    namespace: {
      topic: SYSTEM_TOPIC,
      asset: SERVICE_ASSET,
      objectType: SERVICE_OBJECT_TYPE,
    },
    engine,
    runtimeConfigManager,
    schemas: {
      connectionIdQuerySchema,
      connectionCreateBodySchema,
      connectionUpdateBodySchema,
      connectionControlBodySchema,
      mappingCreateBodySchema,
      mappingDeleteBodySchema,
      runtimeConfigSnapshotSchema,
    },
    mutations: {
      upsertConnection,
      updateConnection,
      deleteConnection,
      startConnection,
      stopConnection,
      upsertMapping,
      updateMapping,
      deleteMapping,
    },
    swagger: {
      connectionCreateRequestBody: createConnectionCreateRequestBody(),
      connectionUpdateRequestBody: createConnectionUpdateRequestBody(),
      connectionControlRequestBody: createConnectionControlRequestBody(),
      mappingCreateRequestBody: createMappingRequestBody("Connection id plus mapping entry"),
      mappingUpdateRequestBody: createMappingRequestBody("Connection id plus replacement mapping entry"),
      mappingDeleteRequestBody: createMappingDeleteRequestBody(),
      configApplyRequestBody: createConfigSnapshotRequestBody("Full runtime config snapshot"),
      configValidateRequestBody: createConfigSnapshotRequestBody("Full runtime config snapshot"),
      configReloadRequestBody: createConfigReloadRequestBody(),
    },
    tags: {
      health: ["Health"],
      status: ["Status"],
      connections: ["Connections"],
      mappings: ["Mappings"],
      configuration: ["Configuration"],
    },
  });

  return {
    ...managementServiceApis,
    discoveryServers: defineServiceApi<BridgeServiceHandler>({
      topic: SYSTEM_TOPIC,
      asset: SERVICE_ASSET,
      objectType: SERVICE_OBJECT_TYPE,
      objectId: "discovery",
      attribute: "servers",
      method: "GET",
      description: "Discover OPC UA servers for a selected endpoint URL",
      tags: EXPLORE_TAGS,
      queryParams: discoveryQueryParams,
      handler: async (event) => {
        const query = parseQuery(event, discoveryQuerySchema);
        const servers = await adapter.discover(query);
        event.res.json({
          endpointUrl: query.endpointUrl,
          servers,
        });
      },
    }),
    browseNodes: defineServiceApi<BridgeServiceHandler>({
      topic: SYSTEM_TOPIC,
      asset: SERVICE_ASSET,
      objectType: SERVICE_OBJECT_TYPE,
      objectId: "browse",
      attribute: "nodes",
      method: "POST",
      description: "Browse a selected OPC UA server and return child nodes for frontend mapping",
      tags: EXPLORE_TAGS,
      requestBody: {
        required: true,
        description: "Temporary OPC UA connection settings and browse root",
        contentType: "application/json",
        schemas: [browseRequestSchema],
      },
      handler: async (event) => {
        const input = parseBody(event, browseBodySchema);
        event.res.json(await adapter.browse(input));
      },
    }),
  };
}
