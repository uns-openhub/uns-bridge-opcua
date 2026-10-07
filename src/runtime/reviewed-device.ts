import { z } from "zod";
import { runtimeMappingConfigSchema } from "../config/runtime-config.js";
import { reviewedConnectionSchema } from "./reviewed-connection.js";

const segment = z.string().min(1).max(128).regex(/^[^/+#\u0000-\u001f\u007f]+$/).refine(value => value === value.trim());
const mappingSchema = z.object({
  id: z.string().min(1).max(128),
  config: runtimeMappingConfigSchema.extend({
    nodeId: z.string().max(2048).regex(/^ns=\d+;[isgb]=.+$/).regex(/^[^\u0000-\u001f\u007f]+$/),
    topic: z.string().min(1).max(2048).regex(/^[^+#\u0000-\u001f\u007f]+$/).refine(value => value.replace(/\/$/, "").split("/").every(part => !!part && part === part.trim())),
    asset: segment, objectType: segment, objectId: segment, attribute: segment,
  }).strict(),
}).strict();
export const devicePreviewBodySchema = z.object({
  connection: reviewedConnectionSchema,
  mappings: z.array(mappingSchema).min(1).max(100),
}).strict().refine(input => new Set(input.mappings.map(({config}) =>
  [config.topic.replace(/\/+$/, ""), config.asset, config.objectType, config.objectId].join("/"))).size === 1,
  { message: "All mappings must belong to one UNS device.", path: ["mappings"] });
export const deviceAppendBodySchema = devicePreviewBodySchema.safeExtend({ expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) });
export type ReviewedDevice = z.infer<typeof devicePreviewBodySchema>;
