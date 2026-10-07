import { z } from "zod";

export type ValidationIssue = { path: Array<string | number>; message: string };

/** Expected request validation failure; never include supplied credentials. */
export class BridgeValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super("Invalid bridge configuration.");
    this.name = "BridgeValidationError";
  }
}

export class BridgeConfigConflictError extends Error {
  constructor() {
    super("Configuration changed after review. Review the configuration again.");
    this.name = "BridgeConfigConflictError";
  }
}

type Handler = (event: { req: any; res: any }) => Promise<void>;

export function withValidationErrors(handler: Handler): Handler {
  return async (event) => {
    try {
      await handler(event);
    } catch (error) {
      if (error instanceof BridgeConfigConflictError) {
        event.res.status(409).json({ code: "CONFIG_CHANGED", error: error.message, message: error.message });
        return;
      }
      const issues = error instanceof BridgeValidationError ? error.issues
        : error instanceof z.ZodError ? error.issues.map((issue) => ({
          path: issue.path.map((part) => typeof part === "number" ? part : String(part)),
          message: issue.message,
        })) : null;
      if (!issues) throw error;
      const boundedIssues = issues.slice(0, 20);
      const message = boundedIssues.map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`).join("; ");
      event.res.status(400).json({
        code: "VALIDATION_ERROR",
        error: message,
        message,
        issues: boundedIssues,
      });
    }
  };
}
