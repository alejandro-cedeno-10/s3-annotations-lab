import { describeError, type ErrorInfo } from "../aws/error-info";

export type Attempt<T> = { ok: true; value: T } | { ok: false; error: ErrorInfo };

/**
 * Runs an operation whose failure is itself the observation (experiments record error names and
 * HTTP status instead of aborting).
 */
export async function attempt<T>(operation: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}
