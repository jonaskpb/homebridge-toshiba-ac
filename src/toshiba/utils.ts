/** Minimal logger interface — satisfied by Homebridge's Logging. */
export interface Log {
  debug(message: string, ...parameters: unknown[]): void;
  info(message: string, ...parameters: unknown[]): void;
  warn(message: string, ...parameters: unknown[]): void;
  error(message: string, ...parameters: unknown[]): void;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export enum JitterMode {
  /** Pick a delay uniformly from [0, cap]. */
  Full = 'full',
  /** Pick a delay uniformly from [cap/2, cap]. */
  Equal = 'equal',
}

export interface RetryOptions {
  retries: number;
  /** Base backoff in milliseconds. */
  backoff: number;
  maxBackoff?: number;
  growthFactor?: number;
  jitterMode?: JitterMode;
  shouldRetry?: (e: unknown) => boolean;
  onRetry?: (e: unknown, attempt: number, delayMs: number) => void;
}

export function backoffDelay(
  backoff: number,
  attempt: number,
  maxBackoff: number,
  growthFactor: number,
  jitterMode: JitterMode,
): number {
  const capped = Math.min(maxBackoff, backoff * growthFactor ** (attempt - 1));
  if (jitterMode === JitterMode.Equal) {
    return capped / 2 + Math.random() * (capped / 2);
  }
  return Math.random() * capped;
}

/**
 * Retry an async operation with exponential backoff and jitter.
 * Mirrors retry_on_exception from the Python library.
 */
export async function retryOnException<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    retries,
    backoff,
    maxBackoff = 300_000,
    growthFactor = 2,
    jitterMode = JitterMode.Full,
    shouldRetry,
    onRetry,
  } = options;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (shouldRetry && !shouldRetry(e)) {
        throw e;
      }
      attempt += 1;
      if (attempt > retries) {
        throw e;
      }
      const delay = backoffDelay(backoff, attempt, maxBackoff, growthFactor, jitterMode);
      onRetry?.(e, attempt, delay);
      await sleep(delay);
    }
  }
}
