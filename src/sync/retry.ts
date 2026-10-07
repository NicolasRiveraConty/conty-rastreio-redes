import { ProviderRequestError, type ProviderErrorCode } from '../provider/metrics-provider.js';

export type RetryPolicy = {
  /** Inclui a primeira chamada. 4 significa 1 tentativa + no máximo 3 retries. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
};

export type RetryResult<T> =
  | { ok: true; value: T; attempts: number; waitedMs: number }
  | { ok: false; error: ProviderRequestError; attempts: number; waitedMs: number };

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set(['timeout', 'rate_limited', 'unavailable']);

export function isRetryable(code: ProviderErrorCode): boolean {
  return RETRYABLE.has(code);
}

/**
 * 429 com Retry-After espera exatamente esse prazo (não o backoff).
 * Timeout e indisponibilidade usam backoff exponencial, com teto.
 * A tentativa que acabou de falhar é `attempt`, começando em 1.
 */
export function nextDelayMs(error: ProviderRequestError, attempt: number, policy: RetryPolicy): number {
  if (error.code === 'rate_limited' && error.retryAfterMs !== undefined && error.retryAfterMs >= 0) {
    return error.retryAfterMs;
  }

  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  return Math.min(exponential, policy.maxDelayMs);
}

export async function withRetry<T>(options: {
  policy: RetryPolicy;
  sleep: (ms: number) => Promise<void>;
  run: () => Promise<T>;
}): Promise<RetryResult<T>> {
  const { policy } = options;
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new Error('maxAttempts precisa ser um inteiro >= 1');
  }
  if (policy.baseDelayMs < 0 || policy.maxDelayMs < 0) {
    throw new Error('atrasos do retry não podem ser negativos');
  }

  let waitedMs = 0;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      const value = await options.run();
      return { ok: true, value, attempts: attempt, waitedMs };
    } catch (error) {
      if (!(error instanceof ProviderRequestError)) {
        throw error;
      }

      const canRetry = isRetryable(error.code) && attempt < policy.maxAttempts;
      if (!canRetry) {
        return { ok: false, error, attempts: attempt, waitedMs };
      }

      const delay = nextDelayMs(error, attempt, policy);
      waitedMs += delay;
      await options.sleep(delay);
    }
  }

  throw new Error('retry encerrado sem resultado');
}
