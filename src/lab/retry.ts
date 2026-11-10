export const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface RetryOptions {
  attempts: number;
  delayMs: number;
  shouldRetry: (error: unknown) => boolean;
  wait?: (milliseconds: number) => Promise<void>;
}

/**
 * Retries eventually-consistent control-plane calls (for example a Lambda created right after the
 * IAM role it assumes). Errors that do not match shouldRetry fail immediately.
 */
export async function retry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const wait = options.wait ?? sleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!options.shouldRetry(error) || attempt === options.attempts) break;
      await wait(options.delayMs);
    }
  }
  throw lastError;
}
