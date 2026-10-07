import { readEngineeringUnits } from "./engineering-units.js";
import { getLogger } from "@uns-kit/core";
import {
  AttributeIds,
  TimestampsToReturn,
  type ClientMonitoredItem,
  type ClientSession,
  type ClientSubscription,
  type MonitoringParametersOptions,
  type ReadValueIdOptions,
} from "node-opcua";

const logger = getLogger(import.meta.url);

export type OpcuaMappingConfig = {
  nodeId: string;
  topic: string;
  asset: string;
  assetDescription?: string;
  objectType: string;
  objectTypeDescription?: string;
  objectId: string;
  attribute: string;
  attributeDescription?: string;
  uom?: string;
  dataGroup?: string;
  validityMode?: "interval" | "lifecycle";
  lifecycleEndValue?: string;
  publishInitialValue?: boolean;
  mode?: "subscription" | "polling";
  expectedIntervalMs?: number;
  intervalMs?: number;
  queueSize?: number;
  discardOldest?: boolean;
};

export type OpcuaValueEvent = {
  value: unknown;
  timestamp: string;
  quality: string;
  uom?: string;
  connectionId: string;
  nodeId: string;
};

type MappingEntry = {
  config: OpcuaMappingConfig;
  sourceUnit?: string | undefined;
  onValue: (event: OpcuaValueEvent) => Promise<void>;
  monitoredItem: ClientMonitoredItem | undefined;
  pollingTimer: NodeJS.Timeout | undefined;
};

const resolveTimestampsToReturn = (value?: "source" | "server" | "both" | "neither"): TimestampsToReturn => {
  switch (value) {
    case "source":
      return TimestampsToReturn.Source;
    case "server":
      return TimestampsToReturn.Server;
    case "neither":
      return TimestampsToReturn.Neither;
    case "both":
    default:
      return TimestampsToReturn.Both;
  }
};

export class SubscriptionManager {
  private readonly mappings = new Map<string, MappingEntry>();
  private session: ClientSession | undefined;
  private subscription: ClientSubscription | undefined;

  constructor(
    private readonly connectionId: string,
    private readonly defaults: {
      intervalMs: number;
      queueSize: number;
      discardOldest: boolean;
      timestampsToReturn?: "source" | "server" | "both" | "neither";
    },
  ) {}

  setSession(session: ClientSession | undefined): void {
    this.session = session;
  }

  async restoreMappings(): Promise<void> {
    await this.disposeMappingWorkers();
    for (const [mappingId, entry] of this.mappings.entries()) {
      if (!this.session) {
        break;
      }
      await this.activateMapping(mappingId, entry);
    }
  }

  async replaceSubscription(subscription: ClientSubscription): Promise<void> {
    this.subscription = subscription;
    await this.restoreMappings();
  }

  async addMapping(mappingId: string, config: OpcuaMappingConfig, onValue: (event: OpcuaValueEvent) => Promise<void>): Promise<void> {
    if (this.mappings.has(mappingId)) {
      throw new Error(`Mapping '${mappingId}' already exists`);
    }

    const entry: MappingEntry = { config, onValue, monitoredItem: undefined, pollingTimer: undefined };
    this.mappings.set(mappingId, entry);

    if (this.session) {
      await this.activateMapping(mappingId, entry);
    }
  }

  async updateMapping(mappingId: string, config: OpcuaMappingConfig): Promise<void> {
    const entry = this.mappings.get(mappingId);
    if (!entry) {
      throw new Error(`Mapping '${mappingId}' was not found`);
    }

    await this.disposeMappingWorker(entry);

    entry.config = config;
    if (this.session) {
      await this.activateMapping(mappingId, entry);
    }
  }

  async removeMapping(mappingId: string): Promise<void> {
    const entry = this.mappings.get(mappingId);
    if (!entry) {
      return;
    }

    await this.disposeMappingWorker(entry);
    this.mappings.delete(mappingId);
  }

  async dispose(): Promise<void> {
    await this.disposeMappingWorkers();
    this.session = undefined;
    this.subscription = undefined;
    this.mappings.clear();
  }

  private async disposeMappingWorkers(): Promise<void> {
    for (const entry of this.mappings.values()) {
      await this.disposeMappingWorker(entry);
    }
  }

  private async disposeMappingWorker(entry: MappingEntry): Promise<void> {
    if (entry.monitoredItem) {
      await entry.monitoredItem.terminate().catch(() => undefined);
      entry.monitoredItem = undefined;
    }

    if (entry.pollingTimer) {
      clearTimeout(entry.pollingTimer);
      entry.pollingTimer = undefined;
    }
  }

  private async activateMapping(mappingId: string, entry: MappingEntry): Promise<void> {
    entry.sourceUnit = undefined;
    if (this.session && !entry.config.uom) {
      entry.sourceUnit = (await readEngineeringUnits(this.session, [entry.config.nodeId])).get(entry.config.nodeId)?.displayName;
    }
    if (entry.config.mode === "polling") {
      this.startPolling(mappingId, entry);
      return;
    }

    if (entry.config.publishInitialValue) {
      await this.publishInitialValue(mappingId, entry);
    }
    entry.monitoredItem = await this.monitorMapping(mappingId, entry);
  }

  private async monitorMapping(mappingId: string, entry: MappingEntry): Promise<ClientMonitoredItem> {
    if (!this.subscription) {
      throw new Error(`Cannot create monitored item for '${mappingId}' without an active subscription`);
    }

    const itemToMonitor: ReadValueIdOptions = {
      nodeId: entry.config.nodeId,
      attributeId: AttributeIds.Value,
    };
    const monitoringParameters: MonitoringParametersOptions = {
      samplingInterval: entry.config.intervalMs ?? this.defaults.intervalMs,
      queueSize: entry.config.queueSize ?? this.defaults.queueSize,
      discardOldest: entry.config.discardOldest ?? this.defaults.discardOldest,
    };

    const monitoredItem = await this.subscription.monitor(
      itemToMonitor,
      monitoringParameters,
      resolveTimestampsToReturn(this.defaults.timestampsToReturn),
    );

    monitoredItem.on("changed", (dataValue) => {
      const timestamp =
        dataValue.sourceTimestamp?.toISOString() ??
        dataValue.serverTimestamp?.toISOString() ??
        new Date().toISOString();
      const quality = dataValue.statusCode?.name ?? "Unknown";

      void entry.onValue({
        value: dataValue.value.value,
        timestamp,
        quality,
        ...(entry.sourceUnit ? { uom: entry.sourceUnit } : {}),
        connectionId: this.connectionId,
        nodeId: entry.config.nodeId,
      });
    });

    monitoredItem.on("err", (message) => {
      logger.warn(
        `OPC UA monitored item '${mappingId}' on connection '${this.connectionId}' reported an error: ${message}`,
      );
    });

    logger.info(`Subscribed mapping '${mappingId}' to node '${entry.config.nodeId}' on connection '${this.connectionId}'`);
    return monitoredItem;
  }

  private async publishInitialValue(mappingId: string, entry: MappingEntry): Promise<void> {
    if (!this.session) {
      return;
    }

    try {
      const dataValue = await this.session.read({
        nodeId: entry.config.nodeId,
        attributeId: AttributeIds.Value,
      });
      const timestamp =
        dataValue.sourceTimestamp?.toISOString() ??
        dataValue.serverTimestamp?.toISOString() ??
        new Date().toISOString();
      const quality = dataValue.statusCode?.name ?? "Unknown";

      await entry.onValue({
        value: dataValue.value.value,
        timestamp,
        quality,
        ...(entry.sourceUnit ? { uom: entry.sourceUnit } : {}),
        connectionId: this.connectionId,
        nodeId: entry.config.nodeId,
      });

      logger.info(
        `Published initial value for mapping '${mappingId}' on connection '${this.connectionId}' from node '${entry.config.nodeId}'`,
      );
    } catch (error) {
      logger.warn(
        `Initial read for mapping '${mappingId}' on connection '${this.connectionId}' failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private startPolling(mappingId: string, entry: MappingEntry): void {
    const poll = async (): Promise<void> => {
      if (!this.session) {
        return;
      }

      try {
        const dataValue = await this.session.read({
          nodeId: entry.config.nodeId,
          attributeId: AttributeIds.Value,
        });
        const timestamp =
          dataValue.sourceTimestamp?.toISOString() ??
          dataValue.serverTimestamp?.toISOString() ??
          new Date().toISOString();
        const quality = dataValue.statusCode?.name ?? "Unknown";

        await entry.onValue({
          value: dataValue.value.value,
          timestamp,
          quality,
          ...(entry.sourceUnit ? { uom: entry.sourceUnit } : {}),
          connectionId: this.connectionId,
          nodeId: entry.config.nodeId,
        });
      } catch (error) {
        logger.warn(
          `OPC UA polling '${mappingId}' on connection '${this.connectionId}' failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (entry.pollingTimer) {
          entry.pollingTimer = setTimeout(() => {
            void poll();
          }, entry.config.intervalMs ?? this.defaults.intervalMs);
        }
      }
    };

    entry.pollingTimer = setTimeout(() => {
      void poll();
    }, 0);

    logger.info(`Polling mapping '${mappingId}' on node '${entry.config.nodeId}' for connection '${this.connectionId}'`);
  }
}
