import pino from "pino";

export function createLogger(name: string) {
  const level = process.env["LOG_LEVEL"] ?? "info";
  return pino({ name, level });
}

type CrashLogger = Pick<ReturnType<typeof createLogger>, "fatal">;

/**
 * Install last-resort handlers for unhandled promise rejections and uncaught exceptions.
 * The 72h soak (PLAN §10) treats either as a hard failure: we log full context — so the crash
 * is diagnosable rather than a bare stack trace — then exit non-zero. A supervisor (or the human)
 * decides whether to restart; the process must not keep running in an unknown state.
 *
 * Returns a teardown that removes the listeners (handy for tests; not needed at process scope).
 */
export function installCrashHandlers(logger: CrashLogger): () => void {
  const onRejection = (reason: unknown) => {
    logger.fatal({ err: reason }, "unhandled promise rejection — exiting");
    process.exit(1);
  };
  const onException = (err: Error) => {
    logger.fatal({ err }, "uncaught exception — exiting");
    process.exit(1);
  };
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  return () => {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  };
}
