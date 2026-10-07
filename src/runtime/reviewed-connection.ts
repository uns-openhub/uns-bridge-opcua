import { z } from "zod";
import { runtimeConnectionConfigSchema } from "../config/runtime-config.js";
import { runtimeSecretReferenceSchema } from "./local-secret-references.js";

function validEndpoint(endpoint: string): boolean {
  if (endpoint.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(endpoint)) return false;
  try {
    const url = new URL(endpoint);
    return url.protocol === "opc.tcp:" && !!url.hostname && !url.username && !url.password && !url.search && !url.hash &&
      (!url.port || (/^\d+$/.test(url.port) && Number(url.port) > 0 && Number(url.port) <= 65535));
  } catch { return false; }
}
// The reviewed-add API has a narrower contract than the existing editable runtime snapshot.
// Credentials must stay node-local references; no endpoint credentials or future fields are discarded.
const identitySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("anonymous") }).strict(),
  z.object({ type: z.literal("username"), userName: runtimeSecretReferenceSchema, password: runtimeSecretReferenceSchema }).strict(),
]);
export const reviewedConnectionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,95}$/),
  config: runtimeConnectionConfigSchema.omit({ name: true }).extend({
    endpointUrl: z.string().refine(validEndpoint, "Use an OPC UA endpoint without embedded credentials, query or fragment."),
    userIdentity: identitySchema.optional(),
    monitoring: runtimeConnectionConfigSchema.shape.monitoring.unwrap().strict().optional(),
    subscription: runtimeConnectionConfigSchema.shape.subscription.unwrap().strict().optional(),
  }).strict(),
}).strict();
export type ReviewedConnection = z.infer<typeof reviewedConnectionSchema>;
export const connectionPreviewBodySchema = z.object({ connection: reviewedConnectionSchema }).strict();
export const connectionAppendBodySchema = connectionPreviewBodySchema.extend({ expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
