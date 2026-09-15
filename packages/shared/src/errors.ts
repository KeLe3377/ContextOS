export type ContextOsErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL";

export class ContextOsError extends Error {
  readonly code: ContextOsErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ContextOsErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ContextOsError";
    this.code = code;
    this.details = details;
  }
}
