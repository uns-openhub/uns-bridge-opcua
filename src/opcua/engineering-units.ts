import { AttributeIds, makeBrowsePath, type ClientSession } from 'node-opcua';
import { within } from '../runtime/source-health.js';

export type EngineeringUnit = { displayName: string; description?: string; unitId?: number; namespaceUri?: string };
const unitText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= 128 && !/[\u0000-\u001f\u007f]/.test(text) ? text : undefined;
};
export function normalizeEngineeringUnit(value: unknown): EngineeringUnit | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const display = raw['displayName'] as { text?: unknown } | undefined;
  const description = raw['description'] as { text?: unknown } | undefined;
  const displayName = unitText(display?.text);
  if (!displayName) return undefined;
  const unitDescription = unitText(description?.text);
  return {
    displayName,
    ...(unitDescription ? { description: unitDescription } : {}),
    ...(typeof raw['unitId'] === 'number' && Number.isInteger(raw['unitId']) ? { unitId: raw['unitId'] } : {}),
    ...(typeof raw['namespaceUri'] === 'string' && raw['namespaceUri'].length <= 512 ? { namespaceUri: raw['namespaceUri'] } : {}),
  };
}

/** Optional metadata read on an existing session; failures never block value monitoring. */
export async function readEngineeringUnits(session: ClientSession, nodeIds: string[]): Promise<Map<string, EngineeringUnit>> {
  try {
    return await within(
      (async () => {
        const nodes = nodeIds.slice(0, 100);
        const paths = await session.translateBrowsePath(nodes.map((id) => makeBrowsePath(id, '.EngineeringUnits')));
        const targets = paths.flatMap((path, index) => {
          if (!path.statusCode.isGood() || path.targets?.length !== 1) return [];
          const target = path.targets[0];
          if (!target || target.remainingPathIndex !== 0xffffffff || target.targetId.serverIndex !== 0) return [];
          return [{ id: nodes[index]!, nodeId: target.targetId.toString() }];
        });
        if (!targets.length) return new Map<string, EngineeringUnit>();
        const values = await session.read(targets.map((target) => ({ nodeId: target.nodeId, attributeId: AttributeIds.Value })));
        const result = new Map<string, EngineeringUnit>();
        values.forEach((value, index) => {
          if (!value.statusCode.isGood()) return;
          const unit = normalizeEngineeringUnit(value.value.value);
          if (unit) result.set(targets[index]!.id, unit);
        });
        return result;
      })(),
      2_000,
    );
  } catch {
    return new Map();
  }
}
