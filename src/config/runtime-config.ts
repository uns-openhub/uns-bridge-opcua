import { z } from "zod";

export const opcuaSecurityPolicyValues = [
  "None",
  "Basic128",
  "Basic128Rsa15",
  "Basic192",
  "Basic192Rsa15",
  "Basic256",
  "Basic256Rsa15",
  "Basic256Sha256",
  "Aes128_Sha256_RsaOaep",
  "Aes256_Sha256_RsaPss",
  "PubSub_Aes128_CTR",
  "PubSub_Aes256_CTR",
] as const;

export const opcuaSecurityPolicySchema = z.enum(opcuaSecurityPolicyValues);

export const runtimeConnectionConfigSchema = z.object({
  endpointUrl: z.string().min(1),
  name: z.string().min(1).optional(),
  securityMode: z.enum(["None", "Sign", "SignAndEncrypt"]).optional(),
  securityPolicy: opcuaSecurityPolicySchema.optional(),
  requestedSessionTimeoutMs: z.number().int().positive().optional(),
  userIdentity: z
    .object({
      type: z.enum(["anonymous", "username"]).optional(),
      userName: z.string().min(1).optional(),
      password: z.string().min(1).optional(),
    })
    .optional(),
  subscription: z
    .object({
      requestedPublishingInterval: z.number().positive().optional(),
      requestedLifetimeCount: z.number().int().positive().optional(),
      requestedMaxKeepAliveCount: z.number().int().positive().optional(),
      maxNotificationsPerPublish: z.number().int().nonnegative().optional(),
      publishingEnabled: z.boolean().optional(),
      priority: z.number().int().min(0).max(255).optional(),
    })
    .optional(),
  monitoring: z
    .object({
      intervalMs: z.number().positive().optional(),
      queueSize: z.number().int().positive().optional(),
      discardOldest: z.boolean().optional(),
      timestampsToReturn: z.enum(["source", "server", "both", "neither"]).optional(),
    })
    .optional(),
});

export const runtimeMappingConfigSchema = z.object({
  nodeId: z.string().min(1),
  topic: z.string().min(1),
  asset: z.string().min(1),
  assetDescription: z.string().min(1).optional(),
  objectType: z.string().min(1),
  objectTypeDescription: z.string().min(1).optional(),
  objectId: z.string().min(1),
  attribute: z.string().min(1),
  attributeDescription: z.string().min(1).optional(),
  dataGroup: z.string().min(1).optional(),
  validityMode: z.enum(["interval", "lifecycle"]).optional(),
  lifecycleEndValue: z.string().min(1).optional(),
  publishInitialValue: z.boolean().optional(),
  mode: z.enum(["subscription", "polling"]).optional(),
  expectedIntervalMs: z.number().int().positive().optional(),
  intervalMs: z.number().positive().optional(),
  queueSize: z.number().int().positive().optional(),
  discardOldest: z.boolean().optional(),
});

export const runtimeConnectionEntrySchema = z.object({
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
    .default([]),
});

export const runtimeConfigSnapshotSchema = z.object({
  version: z.literal(1).default(1),
  updatedAt: z.string().datetime().optional(),
  connections: z.array(runtimeConnectionEntrySchema).default([]),
});

export type RuntimeConfigSnapshot = z.infer<typeof runtimeConfigSnapshotSchema>;
export type OpcuaSecurityPolicyName = z.infer<typeof opcuaSecurityPolicySchema>;
