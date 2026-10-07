import { resolveRuntimeIdentity } from "./local-secret-references.js";
import { getLogger } from "@uns-kit/core";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { runtimeConfigSnapshotSchema, type RuntimeConfigSnapshot } from "../config/runtime-config.js";
import { toConnectionConfig, toMappingConfig } from "../config/opcua-config-mappers.js";
import type { BridgeEngine } from "@uns-kit/bridge-core";
import type { OpcuaConnectionConfig } from "../opcua/opcuaClientWrapper.js";
import type { OpcuaMappingConfig, OpcuaValueEvent } from "../opcua/subscriptionManager.js";
import { RuntimeConfigStore } from "./runtime-config-store.js";
import { BridgeConfigConflictError, BridgeValidationError } from "../api/validation-error.js";

import { reviewedConnectionSchema, type ReviewedConnection } from "./reviewed-connection.js";

import { devicePreviewBodySchema, type ReviewedDevice } from "./reviewed-device.js";

const logger = getLogger(import.meta.url);

type ConfigSource = "startup-default" | "snapshot" | "api-apply" | "api-validate" | "api-reload";

export class RuntimeConfigManager {
  private mutationTail: Promise<void> = Promise.resolve();

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private configRevision(): string {
    return createHash("sha256").update(JSON.stringify(this.currentConfig)).digest("hex");
  }

  private mergeNewMappings(connectionId: string, mappings: RuntimeConfigSnapshot["connections"][number]["mappings"], snapshot = this.getCurrentConfig()): RuntimeConfigSnapshot {
    const connection = snapshot.connections.find((entry) => entry.id === connectionId);
    if (!connection) throw new BridgeValidationError([{ path: ["connectionId"], message: "Connection does not exist." }]);
    const ids = new Set(connection.mappings.map((entry) => entry.id));
    const target = (config: typeof mappings[number]["config"]) =>
      [config.topic.replace(/\/+$/, ""), config.asset, config.objectType, config.objectId, config.attribute].join("/").toLowerCase();
    const targets = new Set(snapshot.connections.flatMap((entry) => entry.mappings.map((mapping) => target(mapping.config))));
    for (const [index, mapping] of mappings.entries()) {
      if (ids.has(mapping.id)) throw new BridgeValidationError([{ path: ["mappings", index, "id"], message: "Mapping ID already exists in this connection." }]);
      const path = target(mapping.config);
      if (targets.has(path)) throw new BridgeValidationError([{ path: ["mappings", index, "config", "attribute"], message: "This UNS attribute already has a bridge mapping." }]);
      ids.add(mapping.id); targets.add(path);
      connection.mappings.push(mapping);
    }
    return snapshot;
  }

  async previewMappingsBatch(connectionId: string, mappings: RuntimeConfigSnapshot["connections"][number]["mappings"]): Promise<{ revision: string; count: number }> {
    const revision = this.configRevision();
    await this.validateConfig(this.mergeNewMappings(connectionId, mappings));
    return { revision, count: mappings.length };
  }

  appendMappingsBatch(connectionId: string, mappings: RuntimeConfigSnapshot["connections"][number]["mappings"], expectedRevision: string): Promise<{ count: number }> {
    return this.exclusive(async () => {
      if (expectedRevision !== this.configRevision()) throw new BridgeConfigConflictError();
      await this.applyValidatedConfig(this.mergeNewMappings(connectionId, mappings), "api-apply");
      return { count: mappings.length };
    });
  }

  private mergeNewConnection(connection: ReviewedConnection): RuntimeConfigSnapshot {
    const parsed = reviewedConnectionSchema.parse(connection);
    const snapshot = this.getCurrentConfig();
    if (snapshot.connections.some(entry => entry.id.toLowerCase() === parsed.id.toLowerCase())) {
      throw new BridgeValidationError([{ path: ["connection", "id"], message: "A connection with this name already exists. Choose another name." }]);
    }
    snapshot.connections.push({ ...parsed, start: false, mappings: [] });
    return snapshot;
  }

  async previewNewConnection(connection: ReviewedConnection): Promise<{ revision: string; id: string }> {
    const revision = this.configRevision();
    // Pure validation: no source status, protocol connection or persisted configuration changes.
    const parsed = runtimeConfigSnapshotSchema.parse(this.mergeNewConnection(connection));
    this.ensureUniqueIds(parsed);
    return { revision, id: connection.id };
  }

  appendReviewedConnection(connection: ReviewedConnection, expectedRevision: string): Promise<{ id: string; start: false }> {
    return this.exclusive(async () => {
      if (expectedRevision !== this.configRevision()) throw new BridgeConfigConflictError();
      const snapshot = this.mergeNewConnection(connection);
      const added = snapshot.connections[snapshot.connections.length - 1]!;
      // Do not reapply/start/stop existing sessions when adding a stopped connection.
      await this.engine.addConnection({ id: added.id, config: toConnectionConfig(added.config), start: false });
      snapshot.updatedAt = new Date().toISOString();
      try {
        await this.store.write(snapshot);
      } catch (error) {
        await this.engine.removeConnection(added.id);
        throw error;
      }
      this.currentConfig = snapshot;
      await this.reconcilePublisher(snapshot);
      this.sourceStatus = { source: "api-apply", lastAppliedAt: snapshot.updatedAt };
      return { id: added.id, start: false };
    });
  }

  private mergeNewDevice(device: ReviewedDevice): RuntimeConfigSnapshot {
    const input = devicePreviewBodySchema.parse(device);
    const snapshot = this.mergeNewMappings(input.connection.id, input.mappings, this.mergeNewConnection(input.connection));
    this.ensureUniqueIds(runtimeConfigSnapshotSchema.parse(snapshot));
    return snapshot;
  }

  async previewNewDevice(device: ReviewedDevice): Promise<{ revision: string; id: string; count: number }> {
    const revision = this.configRevision();
    this.mergeNewDevice(device);
    return { revision, id: device.connection.id, count: device.mappings.length };
  }

  appendReviewedDevice(device: ReviewedDevice, expectedRevision: string): Promise<{ id: string; count: number; start: false }> {
    return this.exclusive(async () => {
      if (expectedRevision !== this.configRevision()) throw new BridgeConfigConflictError();
      const snapshot = this.mergeNewDevice(device);
      const added = snapshot.connections[snapshot.connections.length - 1]!;
      await this.engine.addConnection({ id: added.id, config: toConnectionConfig(added.config), start: false });
      try {
        for (const mapping of added.mappings) {
          await this.engine.addMapping(added.id, { id: mapping.id, config: toMappingConfig(mapping.config) });
        }
        snapshot.updatedAt = new Date().toISOString();
        await this.store.write(snapshot);
      } catch (error) {
        await this.engine.removeConnection(added.id);
        throw error;
      }
      this.currentConfig = snapshot;
      await this.reconcilePublisher(snapshot);
      this.sourceStatus = { source: "api-apply", lastAppliedAt: snapshot.updatedAt };
      return { id: added.id, count: added.mappings.length, start: false };
    });
  }

  private currentConfig: RuntimeConfigSnapshot = {
    version: 1,
    updatedAt: new Date().toISOString(),
    connections: [],
  };

  private sourceStatus: {
    source: ConfigSource;
    lastAppliedAt: string | undefined;
  } = {
    source: "startup-default",
    lastAppliedAt: undefined,
  };

  constructor(
    private readonly engine: BridgeEngine<OpcuaConnectionConfig, OpcuaMappingConfig, OpcuaValueEvent>,
    private readonly store: RuntimeConfigStore,
    private readonly reconcilePublisher: (snapshot: RuntimeConfigSnapshot) => Promise<void> = async () => undefined,
    private readonly preparePublisher: (snapshot: RuntimeConfigSnapshot) => Promise<void> = async () => undefined,
  ) {}

  async initializeFromSnapshot(): Promise<RuntimeConfigSnapshot> {
    const snapshot = await this.store.read();
    if (!snapshot) {
      logger.info(`No runtime snapshot found at '${this.store.resolvedPath}', starting with empty config`);
      return this.getCurrentConfig();
    }

    return this.applyConfig(snapshot, "snapshot");
  }

  getCurrentConfig(): RuntimeConfigSnapshot {
    return structuredClone(this.currentConfig);
  }

  async validateConfig(snapshot: unknown): Promise<RuntimeConfigSnapshot> {
    const parsed = runtimeConfigSnapshotSchema.parse(snapshot);
    this.ensureUniqueIds(parsed);
    this.sourceStatus = {
      ...this.sourceStatus,
      source: "api-validate",
    };
    return parsed;
  }

  applyConfig(snapshot: unknown, source: ConfigSource): Promise<RuntimeConfigSnapshot> {
    return this.exclusive(() => this.applyValidatedConfig(snapshot, source));
  }

  private async applyValidatedConfig(snapshot: unknown, source: ConfigSource): Promise<RuntimeConfigSnapshot> {
    const parsed = runtimeConfigSnapshotSchema.parse(snapshot);
    this.ensureUniqueIds(parsed);

    // Validate started identities before mutating any engine or persisted state.
    for (const connection of parsed.connections) {
      if (connection.start) resolveRuntimeIdentity(connection.config.userIdentity);
    }

    await this.preparePublisher(parsed);
    try {
      const currentById = new Map(this.currentConfig.connections.map((connection) => [connection.id, connection]));
      const desiredById = new Map(parsed.connections.map((connection) => [connection.id, connection]));

      for (const currentConnection of this.currentConfig.connections) {
        if (!desiredById.has(currentConnection.id)) {
          logger.info(`Removing connection '${currentConnection.id}' from runtime config`);
          await this.engine.removeConnection(currentConnection.id);
        }
      }

      for (const desiredConnection of parsed.connections) {
        const existingConnection = currentById.get(desiredConnection.id);
        const shouldStart = desiredConnection.start ?? false;

        if (!existingConnection) {
          logger.info(`Adding connection '${desiredConnection.id}' to runtime config`);
          await this.engine.addConnection({
            id: desiredConnection.id,
            config: toConnectionConfig(desiredConnection.config),
            start: false,
          });
        } else if (!shouldStart && existingConnection.start) {
          logger.info(`Stopping connection '${desiredConnection.id}' before applying stopped config`);
          await this.engine.stopConnection(desiredConnection.id);
        }

        if (existingConnection && !isDeepStrictEqual(existingConnection.config, desiredConnection.config)) {
          logger.info(`Updating connection '${desiredConnection.id}' in runtime config`);
          await this.engine.updateConnection(desiredConnection.id, toConnectionConfig(desiredConnection.config));
        }

        const currentMappings = new Map((existingConnection?.mappings ?? []).map((mapping) => [mapping.id, mapping]));
        const desiredMappings = new Map(desiredConnection.mappings.map((mapping) => [mapping.id, mapping]));

        for (const currentMapping of existingConnection?.mappings ?? []) {
          if (!desiredMappings.has(currentMapping.id)) {
            logger.info(`Removing mapping '${currentMapping.id}' from connection '${desiredConnection.id}'`);
            await this.engine.removeMapping(desiredConnection.id, currentMapping.id);
          }
        }

        for (const desiredMapping of desiredConnection.mappings) {
          if (!currentMappings.has(desiredMapping.id)) {
            logger.info(`Adding mapping '${desiredMapping.id}' to connection '${desiredConnection.id}'`);
            await this.engine.addMapping(desiredConnection.id, {
              id: desiredMapping.id,
              config: toMappingConfig(desiredMapping.config),
            });
          } else if (!isDeepStrictEqual(currentMappings.get(desiredMapping.id)?.config, desiredMapping.config)) {
            logger.info(`Updating mapping '${desiredMapping.id}' on connection '${desiredConnection.id}'`);
            await this.engine.updateMapping(
              desiredConnection.id,
              desiredMapping.id,
              toMappingConfig(desiredMapping.config),
            );
          }
        }

        if (shouldStart) {
          await this.engine.startConnection(desiredConnection.id);
        } else {
          await this.engine.stopConnection(desiredConnection.id);
        }
      }

      const appliedSnapshot: RuntimeConfigSnapshot = {
        ...parsed,
        updatedAt: new Date().toISOString(),
      };

      await this.store.write(appliedSnapshot);
      this.currentConfig = appliedSnapshot;
      this.sourceStatus = {
        source,
        lastAppliedAt: appliedSnapshot.updatedAt,
      };

      await this.reconcilePublisher(appliedSnapshot);
      return this.getCurrentConfig();
    } catch (error) {
      await this.reconcilePublisher(this.getCurrentConfig());
      throw error;
    }
  }

  async reloadSnapshot(): Promise<RuntimeConfigSnapshot> {
    const snapshot = await this.store.read();
    if (!snapshot) {
      throw new Error(`Runtime snapshot '${this.store.resolvedPath}' does not exist`);
    }

    return this.applyConfig(snapshot, "api-reload");
  }

  async getSourceStatus(): Promise<{
    source: ConfigSource;
    lastAppliedAt: string | undefined;
    snapshotPath: string;
    snapshotExists: boolean;
  }> {
    return {
      ...this.sourceStatus,
      snapshotPath: this.store.resolvedPath,
      snapshotExists: await this.store.exists(),
    };
  }

  private ensureUniqueIds(snapshot: RuntimeConfigSnapshot): void {
    const connectionIds = new Set<string>();
    for (const [connectionIndex, connection] of snapshot.connections.entries()) {
      if (connectionIds.has(connection.id)) {
        throw new BridgeValidationError([{ path: ["connections", connectionIndex, "id"], message: "Duplicate connection ID." }]);
      }
      connectionIds.add(connection.id);

      const mappingIds = new Set<string>();
      for (const [mappingIndex, mapping] of connection.mappings.entries()) {
        if (mappingIds.has(mapping.id)) {
          throw new BridgeValidationError([{ path: ["connections", connectionIndex, "mappings", mappingIndex, "id"], message: "Duplicate mapping ID in this connection." }]);
        }
        mappingIds.add(mapping.id);
      }
    }
  }
}
