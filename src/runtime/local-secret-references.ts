import { z } from "zod";
import { BridgeValidationError } from "../api/validation-error.js";

export const runtimeSecretReferenceSchema = z.object({
  provider: z.literal("env"),
  key: z.string().regex(/^UNS_RUNTIME_SECRET_[A-Z][A-Z0-9_]{0,95}$/),
}).strict();
export type RuntimeSecretReference = z.infer<typeof runtimeSecretReferenceSchema>;
export type RuntimeCredential = string | RuntimeSecretReference;
export type RuntimeIdentity = { type?: "anonymous" | "username" | undefined; userName?: RuntimeCredential | undefined; password?: RuntimeCredential | undefined };

function credential(value: RuntimeCredential | undefined, field: string, environment: NodeJS.ProcessEnv): string {
  if (typeof value === "string" && value.length) return value;
  const reference = runtimeSecretReferenceSchema.safeParse(value);
  if (!reference.success) throw new BridgeValidationError([{ path: ["userIdentity", field], message: "A credential or strict local environment reference is required." }]);
  const resolved = environment[reference.data.key];
  if (!resolved) throw new BridgeValidationError([{ path: ["userIdentity", field], message: `Provision local runtime secret ${reference.data.key} on this controller before starting.` }]);
  return resolved;
}

/** Resolve only at the protocol boundary. Never return this object as configuration. */
export function resolveRuntimeIdentity(identity: RuntimeIdentity | undefined, environment: NodeJS.ProcessEnv = process.env): { type: 1; userName: string; password: string } | undefined {
  if (!identity || identity.type === "anonymous") return undefined;
  return { type: 1, userName: credential(identity.userName, "userName", environment), password: credential(identity.password, "password", environment) };
}

export function redactRuntimeIdentityError(error: unknown, identity: RuntimeIdentity | undefined, environment: NodeJS.ProcessEnv = process.env): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of [identity?.userName, identity?.password]) {
    const resolved = typeof value === "string" ? value : value?.provider === "env" ? environment[value.key] : undefined;
    if (resolved) message = message.split(resolved).join("[redacted]");
  }
  return message.replace(/opc\.tcp:\/\/[^/\s@]+@/g, "opc.tcp://[redacted]@").slice(0, 300);
}
