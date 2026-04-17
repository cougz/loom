/**
 * Structured logging for the Worker observability tab.
 *
 * Cloudflare observability tab ingests whatever you write to console.*
 * as log lines, and parses JSON-shaped messages into filterable fields.
 * Every helper here emits a single-line JSON object with a consistent
 * shape so you can filter on `component`, `userId`, `event`, etc.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = {
  component?: string;
  userId?: string;
  sandboxId?: string;
  event?: string;
  [key: string]: unknown;
};

function emit(level: LogLevel, message: string, context: LogContext = {}): void {
  const entry = {
    level,
    message,
    ...context,
    timestamp: new Date().toISOString(),
  };

  const line = JSON.stringify(entry);
  switch (level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "debug":
      console.debug(line);
      break;
    default:
      console.log(line);
  }
}

export const log = {
  debug(message: string, context?: LogContext): void {
    emit("debug", message, context);
  },
  info(message: string, context?: LogContext): void {
    emit("info", message, context);
  },
  warn(message: string, context?: LogContext): void {
    emit("warn", message, context);
  },
  error(message: string, context?: LogContext): void {
    emit("error", message, context);
  },
};

/**
 * Flatten an unknown error into log-friendly fields. Never throws.
 */
export function errorFields(err: unknown): Record<string, string> {
  if (err instanceof Error) {
    return {
      errName: err.name,
      errMessage: err.message,
      errStack: err.stack ?? "",
    };
  }
  return {
    errName: "UnknownError",
    errMessage: String(err),
    errStack: "",
  };
}
