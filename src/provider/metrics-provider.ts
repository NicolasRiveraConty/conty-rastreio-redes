import type { Platform } from '../domain.js';

/**
 * Fronteira com a rede. Implementações (o fake, ou um cliente real)
 * só buscam métricas ou falham. Retry, idempotência e fetchedAt ficam
 * no SyncService — o provedor não grava e não decide quantas vezes tentar.
 */
export type FetchMetricsInput = {
  accessToken: string;
  creatorId: string;
  platform: Platform;
  windowStart: string;
  windowEnd: string;
};

export type ProviderPostMetric = {
  providerPostId: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
};

export type ProviderErrorCode = 'timeout' | 'rate_limited' | 'unavailable' | 'unauthorized';

export class ProviderRequestError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryAfterMs?: number;

  constructor(code: ProviderErrorCode, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'ProviderRequestError';
    this.code = code;
    if (retryAfterMs !== undefined) {
      this.retryAfterMs = retryAfterMs;
    }
  }
}

export interface MetricsProvider {
  readonly platform: Platform;
  fetchPostMetrics(input: FetchMetricsInput): Promise<ProviderPostMetric[]>;
}

export class ProviderRegistry {
  private readonly byPlatform = new Map<Platform, MetricsProvider>();

  constructor(providers: readonly MetricsProvider[]) {
    for (const provider of providers) {
      if (this.byPlatform.has(provider.platform)) {
        throw new Error(`provedor duplicado para ${provider.platform}`);
      }
      this.byPlatform.set(provider.platform, provider);
    }
  }

  find(platform: Platform): MetricsProvider | undefined {
    return this.byPlatform.get(platform);
  }
}
