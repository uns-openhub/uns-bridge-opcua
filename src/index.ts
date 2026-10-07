import { ConfigFile, UnsProxyProcess, getLogger, type IApiProxyOptions } from "@uns-kit/core";
import "@uns-kit/api";
import { buildUnsRoutePath } from "@uns-kit/core/uns/uns-path.js";
import { registerApiCatalog, type UnsApiProxy, type UnsProxyProcessWithApi } from "@uns-kit/api";
import { bridgeSettingsSchema, BridgeEngine, ManagedBridgePublisher } from "@uns-kit/bridge-core";
import { createServiceApis } from "./api/routes.js";
import { OpcuaAdapter } from "./opcua/opcua-adapter.js";
import { opcuaNormalizer } from "./opcua/opcua-normalizer.js";
import type { OpcuaConnectionConfig } from "./opcua/opcuaClientWrapper.js";
import type { OpcuaMappingConfig, OpcuaValueEvent } from "./opcua/subscriptionManager.js";
import { RuntimeConfigManager } from "./runtime/runtime-config-manager.js";
import { RuntimeConfigStore } from "./runtime/runtime-config-store.js";

const runtimeConfigPath = process.env["UNS_BRIDGE_RUNTIME_CONFIG_PATH"] ?? "runtime-config.json";
import { createSourceHealthRefresh, SOURCE_HEALTH_INTERVAL_MS, type SourceDependencyHealth } from "./runtime/source-health.js";
const healthPath = buildUnsRoutePath("system/bridge/opcua/", "runtime", "service", "bridge", "health").slice(1);

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

const managedPublisher = new ManagedBridgePublisher(
  request => publisherProxy.publishMqttMessage(request),
  paths => publisherProxy.retainProducedTopics(paths),
);
const adapter = new OpcuaAdapter(bridgeSettings.retry);
const engine = new BridgeEngine<OpcuaConnectionConfig, OpcuaMappingConfig, OpcuaValueEvent>(
  adapter,
  managedPublisher,
  opcuaNormalizer,
);

const runtimeConfigStore = new RuntimeConfigStore(runtimeConfigPath);
const configuredTargets = (snapshot: import("./config/runtime-config.js").RuntimeConfigSnapshot) =>
  snapshot.connections.flatMap(connection => connection.mappings.map(mapping => ({ ...mapping.config })));
const runtimeConfigManager = new RuntimeConfigManager(engine, runtimeConfigStore,
  snapshot => managedPublisher.reconcile(configuredTargets(snapshot)),
  async snapshot => { managedPublisher.allowTargets(configuredTargets(snapshot)); },
);

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
    ...(dependencies ? { extra: { dependencies, sourceHealth: { observationMode: "runtime-status", startedConnectionCount: runtimeConfigManager.getCurrentConfig().connections.filter(connection => connection.start === true).length } } } : {}),
  });
}

const refreshSourceHealth = createSourceHealthRefresh(
  () => runtimeConfigManager.getCurrentConfig(),
  id => engine.getStatus(id),
  publishBridgeServiceMetadata,
  () => logger.warn("Unable to publish OPC UA runtime source health; the previous observation will expire"),
);

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
await refreshSourceHealth();
const sourceHealthCheckTimer = setInterval(() => { void refreshSourceHealth(); }, SOURCE_HEALTH_INTERVAL_MS);

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
