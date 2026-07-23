import { ConfigFile, UnsProxyProcess, getLogger, type IApiProxyOptions, type IMqttPublishRequest } from "@uns-kit/core";
import "@uns-kit/api";
import { buildUnsRoutePath } from "@uns-kit/core/uns/uns-path.js";
import { registerApiCatalog, type UnsApiProxy, type UnsProxyProcessWithApi } from "@uns-kit/api";
import { bridgeSettingsSchema, BridgeEngine } from "@uns-kit/bridge-core";
import { createServiceApis } from "./api/routes.js";
import { toConnectionConfig } from "./config/opcua-config-mappers.js";
import { OpcuaAdapter } from "./opcua/opcua-adapter.js";
import { opcuaNormalizer } from "./opcua/opcua-normalizer.js";
import type { OpcuaConnectionConfig } from "./opcua/opcuaClientWrapper.js";
import type { OpcuaMappingConfig, OpcuaValueEvent } from "./opcua/subscriptionManager.js";
import type { RuntimeConfigSnapshot } from "./config/runtime-config.js";
import { RuntimeConfigManager } from "./runtime/runtime-config-manager.js";
import { RuntimeConfigStore } from "./runtime/runtime-config-store.js";

const runtimeConfigPath = process.env["UNS_BRIDGE_RUNTIME_CONFIG_PATH"] ?? "runtime-config.json";
const sourceHealthCheckIntervalMs = 30_000;
const healthPath = buildUnsRoutePath("system/bridge/opcua/", "runtime", "service", "bridge", "health").slice(1);

type SourceDependencyHealth = {
  id: string;
  label: string;
  state: "healthy" | "degraded" | "unknown";
  healthy: boolean | null;
  checkedAt: string;
  message: string;
};

type SourceHealthResult = {
  id: string;
  ok: boolean;
  message?: string;
};

const logger = getLogger(import.meta.url);
const config = await ConfigFile.loadConfig();
const bridgeSettings = bridgeSettingsSchema.parse(config.bridge);
const instanceMode = config.uns.instanceMode ?? "wait";
const handover = config.uns.handover ?? true;

const processHost = config.infra.host ?? config.output?.host;
if (!processHost) {
  throw new Error("infra.host or output.host must be configured");
}

const unsProxyProcess = new UnsProxyProcess(processHost, {
  processName: config.uns.processName,
}) as UnsProxyProcessWithApi;

const publisherProxy = await unsProxyProcess.createUnsMqttProxy(
  config.output?.host ?? processHost,
  bridgeSettings.publisher.instanceName,
  instanceMode,
  handover,
);

const adapter = new OpcuaAdapter(bridgeSettings.retry);
const engine = new BridgeEngine<OpcuaConnectionConfig, OpcuaMappingConfig, OpcuaValueEvent>(
  adapter,
  {
    publish: async (request: IMqttPublishRequest): Promise<void> => {
      await publisherProxy.publishMqttMessage(request);
    },
  },
  opcuaNormalizer,
);

const runtimeConfigStore = new RuntimeConfigStore(runtimeConfigPath);
const runtimeConfigManager = new RuntimeConfigManager(engine, runtimeConfigStore);

if (!config.uns.jwksWellKnownUrl) {
  throw new Error("config.uns.jwksWellKnownUrl is required");
}

const apiOptions: IApiProxyOptions = {
  jwks: {
    wellKnownJwksUrl: config.uns.jwksWellKnownUrl,
    ...(config.uns.kidWellKnownUrl ? { activeKidUrl: config.uns.kidWellKnownUrl } : {}),
  },
};

const apiProxy = (await unsProxyProcess.createApiProxy(
  bridgeSettings.api.instanceName,
  apiOptions,
)) as UnsApiProxy;

async function checkActiveSourceConnections(snapshot: RuntimeConfigSnapshot): Promise<SourceDependencyHealth[]> {
  const activeConnections = snapshot.connections.filter((connection) => connection.start === true);
  const checkedAt = new Date().toISOString();

  if (activeConnections.length === 0) {
    return [
      {
        id: "opcua-source",
        label: "OPC UA source server",
        state: "unknown",
        healthy: null,
        checkedAt,
        message: "No started OPC UA source connections are configured.",
      },
    ];
  }

  const results: SourceHealthResult[] = await Promise.all(
    activeConnections.map(async (connection) => {
      try {
        await adapter.checkConnection(toConnectionConfig(connection.config));
        return { id: connection.id, ok: true };
      } catch (error) {
        return {
          id: connection.id,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) {
    return [
      {
        id: "opcua-source",
        label: "OPC UA source server",
        state: "healthy",
        healthy: true,
        checkedAt,
        message: `${activeConnections.length} started OPC UA source connection${activeConnections.length === 1 ? "" : "s"} reachable.`,
      },
    ];
  }

  const failedSummary = failed.map((result) => `${result.id}${result.message ? ` (${result.message})` : ""}`).join(", ");

  return [
    {
      id: "opcua-source",
      label: "OPC UA source server",
      state: "degraded",
      healthy: false,
      checkedAt,
      message: `${failed.length}/${activeConnections.length} started OPC UA source connection${activeConnections.length === 1 ? "" : "s"} unavailable: ${failedSummary}`,
    },
  ];
}

async function publishBridgeServiceMetadata(dependencies?: SourceDependencyHealth[]): Promise<void> {
  await unsProxyProcess.publishServiceMetadata({
    serviceId: "uns-bridge-opcua",
    kind: "addon",
    addonId: "uns-bridge-opcua",
    label: "UNS Bridge OPC UA",
    description: "Addon runtime for browsing OPC UA servers and mapping nodes into UNS.",
    capabilities: ["addon", "opcua-source-browser", "opcua-node-browse", "runtime-mappings"],
    apiRoutes: [
      {
        path: `/api/${healthPath}`,
        kind: "health",
      },
    ],
    healthPath: `/api/${healthPath}`,
    ...(dependencies ? { extra: { dependencies } } : {}),
  });
}

let sourceHealthCheckInFlight: Promise<void> | undefined;
function scheduleSourceHealthCheck(): void {
  if (sourceHealthCheckInFlight) {
    return;
  }

  sourceHealthCheckInFlight = (async () => {
    try {
      const dependencies = await checkActiveSourceConnections(runtimeConfigManager.getCurrentConfig());
      await publishBridgeServiceMetadata(dependencies);
    } catch (error) {
      logger.warn(`Unable to refresh OPC UA source dependency health: ${error instanceof Error ? error.message : String(error)}`);
    }
  })().finally(() => {
    sourceHealthCheckInFlight = undefined;
  });
}

await registerApiCatalog(apiProxy, {
  serviceApis: createServiceApis(engine, adapter, runtimeConfigManager),
  context: undefined,
  options: {
    onError: ({ method, reqPath, error }) => {
      logger.error(`Bridge ${method} handler error [${reqPath ?? ""}]: ${error instanceof Error ? error.message : String(error)}`);
    },
  },
});
const runtimeConfig = await runtimeConfigManager.initializeFromSnapshot();
await publishBridgeServiceMetadata(await checkActiveSourceConnections(runtimeConfig));
const sourceHealthCheckTimer = setInterval(scheduleSourceHealthCheck, sourceHealthCheckIntervalMs);

const shutdown = async (signal: string): Promise<void> => {
  logger.info(`Received ${signal}, shutting down bridge runtime`);
  clearInterval(sourceHealthCheckTimer);
  await engine.stopAll();
  unsProxyProcess.shutdown();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

logger.info(
  `uns-bridge-opcua started with process '${config.uns.processName}' and runtime snapshot '${runtimeConfigStore.resolvedPath}' (${runtimeConfig.connections.length} connections)`,
);
