import type { IMqttAttributeEntry, IMqttPublishRequest } from "@uns-kit/core";
import type { ISO8601 } from "@uns-kit/core/uns/uns-interfaces.js";
import type { ValueEventNormalizer } from "@uns-kit/bridge-core";
import type { OpcuaMappingConfig, OpcuaValueEvent } from "./subscriptionManager.js";

export const opcuaNormalizer: ValueEventNormalizer<OpcuaMappingConfig, OpcuaValueEvent> = ({
  connectionId,
  mapping,
  event,
}) => {
  const attributeEntry: IMqttAttributeEntry = {
    attribute: mapping.attribute,
    ...(mapping.attributeDescription ? { description: mapping.attributeDescription } : {}),
    ...(
      mapping.validityMode
        ? { validityMode: mapping.validityMode }
        : mapping.expectedIntervalMs
          ? { validityMode: "interval" as const }
          : {}
    ),
    ...(mapping.expectedIntervalMs ? { expectedIntervalMs: mapping.expectedIntervalMs } : {}),
    ...(mapping.lifecycleEndValue ? { lifecycleEndValue: mapping.lifecycleEndValue } : {}),
    data: {
      time: event.timestamp as ISO8601,
      value:
        typeof event.value === "number" || typeof event.value === "string"
          ? event.value
          : JSON.stringify(event.value),
      dataGroup: mapping.dataGroup ?? connectionId,
      ...(mapping.uom || event.uom ? { uom: mapping.uom || event.uom } : {}),
    },
  };

  const request: IMqttPublishRequest = {
    topic: mapping.topic,
    asset: mapping.asset,
    ...(mapping.assetDescription ? { assetDescription: mapping.assetDescription } : {}),
    objectType: mapping.objectType,
    ...(mapping.objectTypeDescription ? { objectTypeDescription: mapping.objectTypeDescription } : {}),
    objectId: mapping.objectId,
    attributes: attributeEntry,
  };

  return request;
};
