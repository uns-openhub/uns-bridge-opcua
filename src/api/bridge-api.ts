import { getLogger } from "@uns-kit/core";
import type {
  IGetEndpointOptions,
  IPostEndpointOptions,
  UnsEvents,
} from "@uns-kit/core/uns/uns-interfaces.js";
import { buildUnsRoutePath } from "@uns-kit/core/uns/uns-path.js";
import type { UnsApiProxy } from "@uns-kit/api";
import { z } from "zod";
import {
  createBridgeManagementApiRoutes,
  type BridgeEngine,
  type BridgeManagementApiRoutes,
  type BridgeManagementGetHandler,
  type BridgeManagementGetRouteDefinition,
  type BridgeManagementPostHandler,
  type BridgeManagementPostRouteDefinition,
} from "@uns-kit/bridge-core";
import {
  opcuaSecurityPolicyValues,
  runtimeConfigSnapshotSchema,
  runtimeConnectionConfigSchema,
  runtimeConnectionEntrySchema,
  runtimeMappingConfigSchema,
  type RuntimeConfigSnapshot,
} from "../config/runtime-config.js";
import { OpcuaAdapter } from "../opcua/opcua-adapter.js";
import type { OpcuaConnectionConfig } from "../opcua/opcuaClientWrapper.js";
import type { OpcuaMappingConfig, OpcuaValueEvent } from "../opcua/subscriptionManager.js";
import { RuntimeConfigManager } from "../runtime/runtime-config-manager.js";

const logger = getLogger(import.meta.url);

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

const connectionEntryExample = runtimeConfigApplyExample.connections[0]!;
const mappingEntryExample = connectionEntryExample.mappings[0]!;

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

type ExploreGetRouteDefinition = BridgeManagementGetRouteDefinition;
type ExplorePostRouteDefinition = BridgeManagementPostRouteDefinition;

export const healthPath = buildUnsRoutePath(
  SYSTEM_TOPIC,
  SERVICE_ASSET,
  SERVICE_OBJECT_TYPE,
  "bridge",
  "health",
).slice(1);

function createRoutePath(route: {
  topic: string;
  asset: string;
  objectType: string;
  objectId: string;
  attribute: string;
}): string {
  return buildUnsRoutePath(route.topic, route.asset, route.objectType, route.objectId, route.attribute).slice(1);
}

function normalizeReqPath(path?: string): string | undefined {
  return path?.replace(/^\/+|\/+$/g, "");
}

function cloneConfig(snapshot: RuntimeConfigSnapshot): RuntimeConfigSnapshot {
  return structuredClone(snapshot);
}

function parseRequestBody<TSchema extends z.ZodTypeAny>(
  event: UnsEvents["apiPostEvent"],
  schema: TSchema,
): z.output<TSchema> {
  return schema.parse(event.req.body ?? {});
}

function parseQuery<TSchema extends z.ZodTypeAny>(
  event: UnsEvents["apiGetEvent"],
  schema: TSchema,
): z.output<TSchema> {
  return schema.parse(event.req.query ?? {});
}

async function executeHandler<TEvent extends UnsEvents["apiGetEvent"] | UnsEvents["apiPostEvent"]>(
  event: TEvent,
  handler: ((event: TEvent) => Promise<void> | void) | undefined,
  method: "GET" | "POST",
  reqPath: string | undefined,
): Promise<void> {
  if (!handler) {
    event.res.status(404).send("API handler not found");
    return;
  }

  try {
    await handler(event);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Bridge ${method} handler error [${reqPath}]: ${message}`);
    event.res.status(500).json({ error: message });
  }
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
      example: connectionEntryExample,
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
          ...connectionEntryExample.config,
          monitoring: {
            ...connectionEntryExample.config.monitoring,
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
        mapping: mappingEntryExample,
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

export function createBridgeApiRoutes(
  engine: BridgeEngine<OpcuaConnectionConfig, OpcuaMappingConfig, OpcuaValueEvent>,
  adapter: OpcuaAdapter,
  runtimeConfigManager: RuntimeConfigManager,
): BridgeManagementApiRoutes {
  const managementRoutes = createBridgeManagementApiRoutes({
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
      upsertConnection: (snapshot, body: ConnectionCreateBody) => {
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
      },
      updateConnection: (snapshot, body: ConnectionUpdateBody) => {
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
      },
      deleteConnection: (snapshot, body: ConnectionControlBody) => {
        const nextConfig = cloneConfig(snapshot);
        nextConfig.connections = nextConfig.connections.filter((connection) => connection.id !== body.id);
        return nextConfig;
      },
      startConnection: (snapshot, body: ConnectionControlBody) => {
        const nextConfig = cloneConfig(snapshot);
        const connection = nextConfig.connections.find((entry) => entry.id === body.id);
        if (!connection) {
          throw new Error(`Connection '${body.id}' does not exist`);
        }
        connection.start = true;
        return nextConfig;
      },
      stopConnection: (snapshot, body: ConnectionControlBody) => {
        const nextConfig = cloneConfig(snapshot);
        const connection = nextConfig.connections.find((entry) => entry.id === body.id);
        if (!connection) {
          throw new Error(`Connection '${body.id}' does not exist`);
        }
        connection.start = false;
        return nextConfig;
      },
      upsertMapping: (snapshot, body: MappingCreateBody) => {
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
      },
      updateMapping: (snapshot, body: MappingCreateBody) => {
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
      },
      deleteMapping: (snapshot, body: MappingDeleteBody) => {
        const nextConfig = cloneConfig(snapshot);
        const connection = nextConfig.connections.find((entry) => entry.id === body.connectionId);
        if (!connection) {
          throw new Error(`Connection '${body.connectionId}' does not exist`);
        }
        connection.mappings = connection.mappings.filter((mapping) => mapping.id !== body.mappingId);
        return nextConfig;
      },
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

  const apiGetRoutes = {
    ...managementRoutes.apiGetRoutes,
    discoveryServers: {
      topic: SYSTEM_TOPIC,
      asset: SERVICE_ASSET,
      objectType: SERVICE_OBJECT_TYPE,
      objectId: "discovery",
      attribute: "servers",
      options: {
        apiDescription: "Discover OPC UA servers for a selected endpoint URL",
        tags: EXPLORE_TAGS,
        queryParams: [
          {
            name: "endpointUrl",
            type: "string",
            required: false,
            description: "OPC UA discovery endpoint, e.g. opc.tcp://localhost:4840",
            chatCanonical: "endpointUrl",
          },
        ],
      } satisfies IGetEndpointOptions,
      handler: async (event) => {
        const query = parseQuery(event, discoveryQuerySchema);
        const servers = await adapter.discover(query);
        event.res.json({
          endpointUrl: query.endpointUrl,
          servers,
        });
      },
    },
  } satisfies Record<string, ExploreGetRouteDefinition>;

  const apiPostRoutes = {
    ...managementRoutes.apiPostRoutes,
    browseNodes: {
      topic: SYSTEM_TOPIC,
      asset: SERVICE_ASSET,
      objectType: SERVICE_OBJECT_TYPE,
      objectId: "browse",
      attribute: "nodes",
      options: {
        apiDescription: "Browse a selected OPC UA server and return child nodes for frontend mapping",
        tags: EXPLORE_TAGS,
        requestBody: {
          description: "Temporary OPC UA connection settings and browse root",
          required: true,
          schema: {
            type: "object",
            required: ["config"],
            properties: {
              config: {
                type: "object",
                required: ["endpointUrl"],
                properties: {
                  endpointUrl: { type: "string", example: "opc.tcp://localhost:4840" },
                  name: { type: "string", example: "plc-a" },
                  securityMode: { type: "string", enum: ["None", "Sign", "SignAndEncrypt"], example: "None" },
                  securityPolicy: { type: "string", enum: OPCUA_SECURITY_POLICY_ENUM, example: "Basic256Sha256" },
                  requestedSessionTimeoutMs: { type: "number", example: 60000 },
                  userIdentity: {
                    type: "object",
                    properties: {
                      type: { type: "string", enum: ["anonymous", "username"], example: "anonymous" },
                      userName: { type: "string", example: "operator" },
                      password: { type: "string", example: "secret" },
                    },
                  },
                  subscription: {
                    type: "object",
                    properties: {
                      requestedPublishingInterval: { type: "number", example: 1000 },
                      requestedLifetimeCount: { type: "number", example: 60 },
                      requestedMaxKeepAliveCount: { type: "number", example: 20 },
                      maxNotificationsPerPublish: { type: "number", example: 1000 },
                      publishingEnabled: { type: "boolean", example: true },
                      priority: { type: "number", example: 1 },
                    },
                  },
                  monitoring: {
                    type: "object",
                    properties: {
                      intervalMs: { type: "number", example: 1000 },
                      queueSize: { type: "number", example: 10 },
                      discardOldest: { type: "boolean", example: true },
                      timestampsToReturn: {
                        type: "string",
                        enum: ["source", "server", "both", "neither"],
                        example: "both",
                      },
                    },
                  },
                },
              },
              nodeId: { type: "string", example: "ObjectsFolder" },
            },
            example: browseRequestExample,
          },
        },
      } satisfies IPostEndpointOptions,
      handler: async (event) => {
        const input = parseRequestBody(event, browseBodySchema);
        event.res.json(await adapter.browse(input));
      },
    },
  } satisfies Record<string, ExplorePostRouteDefinition>;

  return {
    apiGetRoutes,
    apiPostRoutes,
    apiGetRouteHandlers: Object.fromEntries(
      Object.values(apiGetRoutes).map((route) => [createRoutePath(route), route.handler as BridgeManagementGetHandler]),
    ) as Record<string, BridgeManagementGetHandler>,
    apiPostRouteHandlers: Object.fromEntries(
      Object.values(apiPostRoutes).map((route) => [createRoutePath(route), route.handler as BridgeManagementPostHandler]),
    ) as Record<string, BridgeManagementPostHandler>,
  };
}

export function registerBridgeApiEvents(
  apiInput: UnsApiProxy,
  apiGetRouteHandlers: Record<string, BridgeManagementGetHandler>,
  apiPostRouteHandlers: Record<string, BridgeManagementPostHandler>,
): void {
  apiInput.event.on("apiGetEvent", async (event: UnsEvents["apiGetEvent"]) => {
    const reqPath = normalizeReqPath(event.req.path);
    const handler = reqPath ? apiGetRouteHandlers[reqPath] : undefined;
    await executeHandler(event, handler, "GET", reqPath);
  });

  apiInput.event.on("apiPostEvent", async (event: UnsEvents["apiPostEvent"]) => {
    const reqPath = normalizeReqPath(event.req.path);
    const handler = reqPath ? apiPostRouteHandlers[reqPath] : undefined;
    await executeHandler(event, handler, "POST", reqPath);
  });
}
