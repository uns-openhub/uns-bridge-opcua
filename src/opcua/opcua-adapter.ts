import type { ProtocolAdapter } from "@uns-kit/bridge-core";
import { OpcuaConnectionManager } from "./opcuaConnectionManager.js";
import type { OpcuaConnectionConfig } from "./opcuaClientWrapper.js";
import type { OpcuaMappingConfig, OpcuaValueEvent } from "./subscriptionManager.js";

export class OpcuaAdapter
  implements ProtocolAdapter<OpcuaConnectionConfig, OpcuaMappingConfig, OpcuaValueEvent>
{
  private readonly manager: OpcuaConnectionManager;

  constructor(
    retry: {
      minDelayMs: number;
      maxDelayMs: number;
      maxAttempts: number;
    },
  ) {
    this.manager = new OpcuaConnectionManager(retry);
  }

  async createConnection(args: { id: string; config: OpcuaConnectionConfig }) {
    return this.manager.createConnection(args.id, args.config);
  }

  async checkConnection(config: OpcuaConnectionConfig): Promise<void> {
    return this.manager.checkConnection(config);
  }

  async discover(input?: unknown): Promise<unknown[]> {
    const endpointUrl =
      typeof input === "object" &&
      input !== null &&
      "endpointUrl" in input &&
      typeof input.endpointUrl === "string"
        ? input.endpointUrl
        : undefined;

    if (!endpointUrl) {
      return [
        {
          applicationName: "mock-local-discovery",
          discoveryUrls: ["opc.tcp://localhost:4840"],
          status: "endpointUrl query parameter not provided",
        },
      ];
    }

    try {
      return await this.manager.discover(endpointUrl);
    } catch (error) {
      return [
        {
          applicationName: "mock-unreachable-discovery",
          discoveryUrls: [endpointUrl],
          status: error instanceof Error ? error.message : String(error),
        },
      ];
    }
  }

  async browse(input?: unknown): Promise<unknown> {
    if (typeof input !== "object" || input === null) {
      throw new Error("Browse input is required");
    }

    const config =
      "config" in input && typeof input.config === "object" && input.config !== null
        ? (input.config as OpcuaConnectionConfig)
        : undefined;
    const nodeId = "nodeId" in input && typeof input.nodeId === "string" ? input.nodeId : undefined;

    if (!config?.endpointUrl) {
      throw new Error("Browse requires config.endpointUrl");
    }

    return this.manager.browse(config, nodeId);
  }

  async validateConnection(config: OpcuaConnectionConfig): Promise<void> {
    if (!config.endpointUrl) {
      throw new Error("endpointUrl is required");
    }
  }
}
