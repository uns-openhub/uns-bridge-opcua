import { getLogger } from "@uns-kit/core";
import {
  MessageSecurityMode,
  OPCUAClient,
  SecurityPolicy,
  type ClientSession,
  type ClientSubscription,
  type OPCUAClientOptions,
} from "node-opcua";
import type { BridgeConnectionStatus, MappingDefinition, ProtocolConnection } from "@uns-kit/bridge-core";
import type { OpcuaSecurityPolicyName } from "../config/runtime-config.js";
import { SubscriptionManager, type OpcuaMappingConfig, type OpcuaValueEvent } from "./subscriptionManager.js";

const logger = getLogger(import.meta.url);

export type OpcuaConnectionConfig = {
  endpointUrl: string;
  name?: string;
  securityMode?: "None" | "Sign" | "SignAndEncrypt";
  securityPolicy?: OpcuaSecurityPolicyName;
  requestedSessionTimeoutMs?: number;
  userIdentity?: {
    type?: "anonymous" | "username";
    userName?: string;
    password?: string;
  };
  subscription?: {
    requestedPublishingInterval?: number;
    requestedLifetimeCount?: number;
    requestedMaxKeepAliveCount?: number;
    maxNotificationsPerPublish?: number;
    publishingEnabled?: boolean;
    priority?: number;
  };
  monitoring?: {
    intervalMs?: number;
    queueSize?: number;
    discardOldest?: boolean;
    timestampsToReturn?: "source" | "server" | "both" | "neither";
  };
};

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

export class OpcuaClientWrapper
  implements ProtocolConnection<OpcuaConnectionConfig, OpcuaMappingConfig, OpcuaValueEvent>
{
  private client: OPCUAClient | undefined;
  private session: ClientSession | undefined;
  private subscription: ClientSubscription | undefined;
  private status: BridgeConnectionStatus = {
    state: "stopped",
    connected: false,
    updatedAt: new Date().toISOString(),
  };
  private reconnectPromise: Promise<void> | undefined;
  private stopRequested = false;

  private readonly subscriptions: SubscriptionManager;

  constructor(
    private readonly id: string,
    private config: OpcuaConnectionConfig,
    private readonly retry: {
      minDelayMs: number;
      maxDelayMs: number;
      maxAttempts: number;
    },
  ) {
    this.subscriptions = new SubscriptionManager(this.id, {
      intervalMs: config.monitoring?.intervalMs ?? 1_000,
      queueSize: config.monitoring?.queueSize ?? 10,
      discardOldest: config.monitoring?.discardOldest ?? true,
      timestampsToReturn: config.monitoring?.timestampsToReturn ?? "both",
    });
  }

  async start(): Promise<void> {
    if (this.status.state === "running" || this.status.state === "starting" || this.status.state === "reconnecting") {
      return;
    }

    this.stopRequested = false;
    this.setStatus("starting", false);
    this.client = OPCUAClient.create(this.createClientOptions());
    this.bindClientEvents(this.client);

    try {
      await this.client.connect(this.config.endpointUrl);
      if (this.stopRequested) {
        await this.stop();
        return;
      }
      await this.createSessionAndSubscription();
      if (this.stopRequested) {
        await this.stop();
        return;
      }
      this.setStatus("running", true);
    } catch (error) {
      if (this.stopRequested) {
        this.setStatus("stopped", false);
        return;
      }
      this.setStatus("error", false, this.toMessage(error));
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (!this.client && this.status.state === "stopped") {
      return;
    }

    this.setStatus("stopping", false);
    await this.closeSessionAndSubscription();

    const client = this.client;
    this.client = undefined;

    if (client) {
      client.removeAllListeners();
      await this.disconnectClient(client);
    }

    this.setStatus("stopped", false);
  }

  async updateConfig(config: OpcuaConnectionConfig): Promise<void> {
    const wasRunning = this.status.state === "running" || this.status.state === "reconnecting";
    this.config = config;

    if (wasRunning) {
      await this.stop();
      await this.start();
    }
  }

  async getStatus(): Promise<BridgeConnectionStatus> {
    return this.status;
  }

  async addMapping(mapping: MappingDefinition<OpcuaMappingConfig>, onValue: (event: OpcuaValueEvent) => Promise<void>): Promise<void> {
    await this.subscriptions.addMapping(mapping.id, mapping.config, onValue);
  }

  async updateMapping(mappingId: string, mapping: OpcuaMappingConfig): Promise<void> {
    await this.subscriptions.updateMapping(mappingId, mapping);
  }

  async removeMapping(mappingId: string): Promise<void> {
    await this.subscriptions.removeMapping(mappingId);
  }

  async dispose(): Promise<void> {
    await this.stop();
    await this.subscriptions.dispose();
  }

  private bindClientEvents(client: OPCUAClient): void {
    client.on("connected", () => {
      if (this.stopRequested) {
        void this.stop();
        return;
      }
      this.setStatus("running", true);
    });

    client.on("backoff", (attempt, delay) => {
      if (this.stopRequested) {
        void this.stop();
        return;
      }
      logger.warn(`OPC UA connection '${this.id}' backing off after attempt ${attempt}; retry in ${delay}ms`);
    });

    client.on("start_reconnection", () => {
      if (this.stopRequested) {
        void this.stop();
        return;
      }
      this.setStatus("reconnecting", false, "Reconnecting to OPC UA server");
    });

    client.on("after_reconnection", (error) => {
      if (error) {
        this.setStatus("error", false, this.toMessage(error));
        return;
      }

      void this.restoreAfterReconnect();
    });

    client.on("connection_failed", (error) => {
      if (this.stopRequested) {
        this.setStatus("stopped", false);
        return;
      }
      this.setStatus("error", false, this.toMessage(error));
    });

    client.on("close", (error) => {
      if (this.stopRequested) {
        this.setStatus("stopped", false);
        return;
      }
      if (this.status.state !== "stopping" && this.status.state !== "stopped") {
        this.setStatus("reconnecting", false, error ? this.toMessage(error) : "Connection closed");
      }
    });
  }

  private async restoreAfterReconnect(): Promise<void> {
    if (!this.client) {
      return;
    }

    if (!this.reconnectPromise) {
      this.reconnectPromise = (async () => {
        logger.info(`Restoring OPC UA session and subscriptions for connection '${this.id}'`);
        await this.closeSessionAndSubscription();
        await this.createSessionAndSubscription();
        this.setStatus("running", true);
      })().finally(() => {
        this.reconnectPromise = undefined;
      });
    }

    await this.reconnectPromise;
  }

  private async createSessionAndSubscription(): Promise<void> {
    if (!this.client) {
      throw new Error("OPC UA client is not initialized");
    }

    this.session = await this.client.createSession(this.resolveUserIdentity());
    this.subscriptions.setSession(this.session);
    await this.ensureSubscription();
  }

  private async closeSessionAndSubscription(): Promise<void> {
    if (this.subscription) {
      await this.subscription.terminate().catch(() => undefined);
      this.subscription.removeAllListeners();
      this.subscription = undefined;
    }
    this.subscriptions.setSession(undefined);

    if (this.session) {
      await this.session.close().catch(() => undefined);
      this.session.removeAllListeners();
      this.session = undefined;
    }
  }

  private async ensureSubscription(): Promise<void> {
    if (!this.session || this.subscription) {
      return;
    }

    this.subscription = await this.session.createSubscription2({
      requestedPublishingInterval: this.config.subscription?.requestedPublishingInterval ?? 1_000,
      requestedLifetimeCount: this.config.subscription?.requestedLifetimeCount ?? 120,
      requestedMaxKeepAliveCount: this.config.subscription?.requestedMaxKeepAliveCount ?? 20,
      maxNotificationsPerPublish: this.config.subscription?.maxNotificationsPerPublish ?? 100,
      publishingEnabled: this.config.subscription?.publishingEnabled ?? true,
      priority: this.config.subscription?.priority ?? 1,
    });

    this.subscription.on("status_changed", (statusCode) => {
      logger.warn(
        `Subscription status changed for connection '${this.id}' to '${statusCode.name}'`,
      );
    });
    this.subscription.on("terminated", () => {
      if (this.status.state !== "stopping" && this.status.state !== "stopped") {
        this.setStatus("reconnecting", false, "Subscription terminated");
      }
    });
    this.subscription.on("internal_error", (error) => {
      logger.error(`Subscription error for connection '${this.id}': ${this.toMessage(error)}`);
    });

    await this.subscriptions.replaceSubscription(this.subscription);
  }

  private createClientOptions(): OPCUAClientOptions {
    return {
      clientName: this.config.name ?? `uns-bridge-opcua-${this.id}`,
      endpointMustExist: false,
      securityMode: toSecurityMode(this.config.securityMode),
      securityPolicy: toSecurityPolicy(this.config.securityPolicy),
      keepSessionAlive: true,
      requestedSessionTimeout: this.config.requestedSessionTimeoutMs ?? 60_000,
      connectionStrategy: {
        initialDelay: this.retry.minDelayMs,
        maxDelay: this.retry.maxDelayMs,
        maxRetry: Number.isFinite(this.retry.maxAttempts) ? this.retry.maxAttempts : 1_000_000,
      },
    };
  }

  private resolveUserIdentity():
    | undefined
    | {
        type: 1;
        userName: string;
        password: string;
      } {
    if (!this.config.userIdentity || this.config.userIdentity.type === "anonymous") {
      return undefined;
    }

    if (!this.config.userIdentity.userName || !this.config.userIdentity.password) {
      throw new Error(`Connection '${this.id}' requires both userName and password for username authentication`);
    }

    return {
      type: 1,
      userName: this.config.userIdentity.userName,
      password: this.config.userIdentity.password,
    };
  }

  private setStatus(
    state: BridgeConnectionStatus["state"],
    connected: boolean,
    message?: string,
  ): void {
    this.status = {
      state,
      connected,
      updatedAt: new Date().toISOString(),
      ...(message ? { message } : {}),
      details: {
        endpointUrl: this.config.endpointUrl,
      },
    };
  }

  private toMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async disconnectClient(client: OPCUAClient): Promise<void> {
    await Promise.race([
      client.disconnect().catch(() => undefined),
      new Promise<void>((resolve) => {
        setTimeout(resolve, 2_000);
      }),
    ]);
  }
}
