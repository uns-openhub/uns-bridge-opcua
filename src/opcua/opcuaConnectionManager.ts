import { getLogger } from "@uns-kit/core";
import {
  AttributeIds,
  BrowseDirection,
  MessageSecurityMode,
  NodeClass,
  OPCUAClient,
  SecurityPolicy,
  type ClientSession,
  type ReferenceDescription,
} from "node-opcua";
import type { OpcuaSecurityPolicyName } from "../config/runtime-config.js";
import { OpcuaClientWrapper, type OpcuaConnectionConfig } from "./opcuaClientWrapper.js";

const logger = getLogger(import.meta.url);

const toSecurityMode = (value?: "None" | "Sign" | "SignAndEncrypt"): MessageSecurityMode => {
  switch (value) {
    case "Sign":
      return MessageSecurityMode.Sign;
    case "SignAndEncrypt":
      return MessageSecurityMode.SignAndEncrypt;
    case "None":
    default:
      return MessageSecurityMode.None;
  }
};

const toSecurityPolicy = (value?: OpcuaSecurityPolicyName): SecurityPolicy => {
  if (!value || value === "None") {
    return SecurityPolicy.None;
  }

  return SecurityPolicy[value];
};

export class OpcuaConnectionManager {
  constructor(
    private readonly retry: {
      minDelayMs: number;
      maxDelayMs: number;
      maxAttempts: number;
    },
  ) {}

  async createConnection(id: string, config: OpcuaConnectionConfig): Promise<OpcuaClientWrapper> {
    return new OpcuaClientWrapper(id, config, this.retry);
  }

  async checkConnection(config: OpcuaConnectionConfig): Promise<void> {
    const client = OPCUAClient.create({
      clientName: `uns-bridge-opcua-health-check`,
      endpointMustExist: false,
      securityMode: toSecurityMode(config.securityMode),
      securityPolicy: toSecurityPolicy(config.securityPolicy),
      requestedSessionTimeout: config.requestedSessionTimeoutMs ?? 60_000,
      connectionStrategy: {
        initialDelay: this.retry.minDelayMs,
        maxDelay: this.retry.maxDelayMs,
        maxRetry: Math.max(1, this.retry.maxAttempts),
      },
    });

    let session: ClientSession | undefined;
    try {
      await client.connect(config.endpointUrl);
      session = await client.createSession(
        config.userIdentity?.type === "username" && config.userIdentity.userName && config.userIdentity.password
          ? {
              type: 1,
              userName: config.userIdentity.userName,
              password: config.userIdentity.password,
            }
          : undefined,
      );
    } finally {
      if (session) {
        await session.close().catch(() => undefined);
      }
      await client.disconnect().catch(() => undefined);
    }
  }

  async discover(endpointUrl: string): Promise<unknown[]> {
    const client = OPCUAClient.create({ endpointMustExist: false });
    try {
      await client.connect(endpointUrl);
      const servers = await client.findServers();
      return servers.map((server) => ({
        applicationName: server.applicationName?.text,
        applicationUri: server.applicationUri,
        productUri: server.productUri,
        discoveryUrls: server.discoveryUrls,
      }));
    } finally {
      await client.disconnect().catch(() => undefined);
    }
  }

  async browse(config: OpcuaConnectionConfig, nodeId = "ObjectsFolder"): Promise<unknown> {
    const client = OPCUAClient.create({
      clientName: `uns-bridge-opcua-browser`,
      endpointMustExist: false,
      securityMode: toSecurityMode(config.securityMode),
      securityPolicy: toSecurityPolicy(config.securityPolicy),
      requestedSessionTimeout: config.requestedSessionTimeoutMs ?? 60_000,
      connectionStrategy: {
        initialDelay: this.retry.minDelayMs,
        maxDelay: this.retry.maxDelayMs,
        maxRetry: Math.max(1, this.retry.maxAttempts),
      },
    });

    let session: ClientSession | undefined;
    try {
      await client.connect(config.endpointUrl);
      session = await client.createSession(
        config.userIdentity?.type === "username" && config.userIdentity.userName && config.userIdentity.password
          ? {
              type: 1,
              userName: config.userIdentity.userName,
              password: config.userIdentity.password,
            }
          : undefined,
      );
      if (!session) {
        throw new Error("Failed to create OPC UA session for browse");
      }
      const activeSession = session;
      const browseResult = await activeSession.browse({
        nodeId,
        browseDirection: BrowseDirection.Forward,
        includeSubtypes: true,
        nodeClassMask: 0,
        resultMask: 0x3f,
      });

      const references: ReferenceDescription[] = browseResult.references ?? [];
      const metadataReads = references.flatMap((reference: ReferenceDescription) => {
        const shouldReadVariableMetadata =
          reference.nodeClass === NodeClass.Variable || reference.nodeClass === NodeClass.VariableType;

        if (!shouldReadVariableMetadata) {
          return [];
        }

        return [
          { nodeId: reference.nodeId, attributeId: AttributeIds.DataType },
          { nodeId: reference.nodeId, attributeId: AttributeIds.ValueRank },
          { nodeId: reference.nodeId, attributeId: AttributeIds.AccessLevel },
          { nodeId: reference.nodeId, attributeId: AttributeIds.UserAccessLevel },
        ];
      });

      const metadataValues = metadataReads.length > 0 ? await activeSession.read(metadataReads) : [];
      let metadataIndex = 0;

      const children = references.map((reference: ReferenceDescription) => {
        const item: {
          nodeId: string;
          browseName: string | null;
          displayName: string | null;
          nodeClass: string;
          typeDefinition: string | null;
          referenceTypeId: string | null;
          isForward: boolean;
          hasChildren: boolean;
          dataTypeNodeId?: string | null;
          valueRank?: unknown;
          accessLevel?: unknown;
          userAccessLevel?: unknown;
        } = {
          nodeId: reference.nodeId.toString(),
          browseName: reference.browseName?.name ?? null,
          displayName: reference.displayName?.text ?? null,
          nodeClass: NodeClass[reference.nodeClass] ?? String(reference.nodeClass),
          typeDefinition: reference.typeDefinition?.toString() ?? null,
          referenceTypeId: reference.referenceTypeId?.toString() ?? null,
          isForward: reference.isForward ?? true,
          hasChildren:
            reference.nodeClass === NodeClass.Object ||
            reference.nodeClass === NodeClass.ObjectType ||
            reference.nodeClass === NodeClass.View,
        };

        const shouldReadVariableMetadata =
          reference.nodeClass === NodeClass.Variable || reference.nodeClass === NodeClass.VariableType;

        if (shouldReadVariableMetadata) {
          item.dataTypeNodeId = metadataValues[metadataIndex++]?.value.value?.toString() ?? null;
          item.valueRank = metadataValues[metadataIndex++]?.value.value ?? null;
          item.accessLevel = metadataValues[metadataIndex++]?.value.value ?? null;
          item.userAccessLevel = metadataValues[metadataIndex++]?.value.value ?? null;
        }

        return item;
      });

      return {
        endpointUrl: config.endpointUrl,
        nodeId,
        continuationPoint: browseResult.continuationPoint?.toString("base64") ?? null,
        children,
      };
    } finally {
      if (session) {
        await session.close().catch(() => undefined);
      }
      await client.disconnect().catch(() => undefined);
    }
  }
}
