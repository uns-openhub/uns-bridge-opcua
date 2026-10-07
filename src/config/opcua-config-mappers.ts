import type { RuntimeCredential } from "../runtime/local-secret-references.js";
import type { OpcuaConnectionConfig } from "../opcua/opcuaClientWrapper.js";
import type { OpcuaMappingConfig } from "../opcua/subscriptionManager.js";
import type { OpcuaSecurityPolicyName } from "./runtime-config.js";

export type RawOpcuaConnectionConfig = {
  endpointUrl: string;
  name?: string | undefined;
  securityMode?: "None" | "Sign" | "SignAndEncrypt" | undefined;
  securityPolicy?: OpcuaSecurityPolicyName | undefined;
  requestedSessionTimeoutMs?: number | undefined;
  userIdentity?:
    | {
        type?: "anonymous" | "username" | undefined;
        userName?: RuntimeCredential | undefined;
        password?: RuntimeCredential | undefined;
      }
    | undefined;
  subscription?:
    | {
        requestedPublishingInterval?: number | undefined;
        requestedLifetimeCount?: number | undefined;
        requestedMaxKeepAliveCount?: number | undefined;
        maxNotificationsPerPublish?: number | undefined;
        publishingEnabled?: boolean | undefined;
        priority?: number | undefined;
      }
    | undefined;
  monitoring?:
    | {
        intervalMs?: number | undefined;
        queueSize?: number | undefined;
        discardOldest?: boolean | undefined;
        timestampsToReturn?: "source" | "server" | "both" | "neither" | undefined;
      }
    | undefined;
};

export type RawOpcuaMappingConfig = {
  nodeId: string;
  topic: string;
  asset: string;
  assetDescription?: string | undefined;
  objectType: string;
  objectTypeDescription?: string | undefined;
  objectId: string;
  attribute: string;
  attributeDescription?: string | undefined;
  uom?: string | undefined;
  dataGroup?: string | undefined;
  validityMode?: "interval" | "lifecycle" | undefined;
  lifecycleEndValue?: string | undefined;
  publishInitialValue?: boolean | undefined;
  mode?: "subscription" | "polling" | undefined;
  expectedIntervalMs?: number | undefined;
  intervalMs?: number | undefined;
  queueSize?: number | undefined;
  discardOldest?: boolean | undefined;
};

export const toConnectionConfig = (input: RawOpcuaConnectionConfig): OpcuaConnectionConfig => ({
  endpointUrl: input.endpointUrl,
  ...(input.name ? { name: input.name } : {}),
  ...(input.securityMode ? { securityMode: input.securityMode } : {}),
  ...(input.securityPolicy ? { securityPolicy: input.securityPolicy } : {}),
  ...(input.requestedSessionTimeoutMs ? { requestedSessionTimeoutMs: input.requestedSessionTimeoutMs } : {}),
  ...(input.userIdentity
    ? {
        userIdentity: {
          ...(input.userIdentity.type ? { type: input.userIdentity.type } : {}),
          ...(input.userIdentity.userName ? { userName: input.userIdentity.userName } : {}),
          ...(input.userIdentity.password ? { password: input.userIdentity.password } : {}),
        },
      }
    : {}),
  ...(input.subscription
    ? {
        subscription: {
          ...(input.subscription.requestedPublishingInterval
            ? { requestedPublishingInterval: input.subscription.requestedPublishingInterval }
            : {}),
          ...(input.subscription.requestedLifetimeCount
            ? { requestedLifetimeCount: input.subscription.requestedLifetimeCount }
            : {}),
          ...(input.subscription.requestedMaxKeepAliveCount
            ? { requestedMaxKeepAliveCount: input.subscription.requestedMaxKeepAliveCount }
            : {}),
          ...(input.subscription.maxNotificationsPerPublish !== undefined
            ? { maxNotificationsPerPublish: input.subscription.maxNotificationsPerPublish }
            : {}),
          ...(input.subscription.publishingEnabled !== undefined
            ? { publishingEnabled: input.subscription.publishingEnabled }
            : {}),
          ...(input.subscription.priority !== undefined ? { priority: input.subscription.priority } : {}),
        },
      }
    : {}),
  ...(input.monitoring
    ? {
        monitoring: {
          ...(input.monitoring.intervalMs ? { intervalMs: input.monitoring.intervalMs } : {}),
          ...(input.monitoring.queueSize ? { queueSize: input.monitoring.queueSize } : {}),
          ...(input.monitoring.discardOldest !== undefined ? { discardOldest: input.monitoring.discardOldest } : {}),
          ...(input.monitoring.timestampsToReturn ? { timestampsToReturn: input.monitoring.timestampsToReturn } : {}),
        },
      }
    : {}),
});

export const toMappingConfig = (input: RawOpcuaMappingConfig): OpcuaMappingConfig => ({
  nodeId: input.nodeId,
  topic: input.topic,
  asset: input.asset,
  ...(input.assetDescription ? { assetDescription: input.assetDescription } : {}),
  objectType: input.objectType,
  ...(input.objectTypeDescription ? { objectTypeDescription: input.objectTypeDescription } : {}),
  objectId: input.objectId,
  attribute: input.attribute,
  ...(input.attributeDescription ? { attributeDescription: input.attributeDescription } : {}),
  ...(input.uom ? { uom: input.uom } : {}),
  ...(input.dataGroup ? { dataGroup: input.dataGroup } : {}),
  ...(input.validityMode ? { validityMode: input.validityMode } : {}),
  ...(input.lifecycleEndValue ? { lifecycleEndValue: input.lifecycleEndValue } : {}),
  ...(input.publishInitialValue !== undefined ? { publishInitialValue: input.publishInitialValue } : {}),
  ...(input.mode ? { mode: input.mode } : {}),
  ...(input.expectedIntervalMs ? { expectedIntervalMs: input.expectedIntervalMs } : {}),
  ...(input.intervalMs ? { intervalMs: input.intervalMs } : {}),
  ...(input.queueSize ? { queueSize: input.queueSize } : {}),
  ...(input.discardOldest !== undefined ? { discardOldest: input.discardOldest } : {}),
});
