import type { Platform } from '../domain.js';
import {
  ProviderRequestError,
  type FetchMetricsInput,
  type MetricsProvider,
  type ProviderPostMetric,
} from './metrics-provider.js';

/** Um passo do roteiro. O fake não faz HTTP e não dorme. */
export type FakeStep =
  | { type: 'success' }
  | { type: 'duplicate' }
  | { type: 'timeout' }
  | { type: 'unavailable' }
  | { type: 'unauthorized' }
  | { type: 'defect' }
  | { type: 'rate_limit'; retryAfterMs?: number }
  | { type: 'payload'; posts: readonly ProviderPostMetric[] };

export type FakeMetricsProviderOptions = {
  platform: Platform;
  posts: readonly ProviderPostMetric[];
  /** Roteiro das próximas chamadas. Depois dele, responde sucesso — salvo repeatLast. */
  steps?: readonly FakeStep[];
  /** Repete o último passo (útil para estourar o teto de retry). */
  repeatLast?: boolean;
};

/**
 * Provedor simulado. Cada chamada consome um passo: sucesso, o mesmo post
 * repetido no corpo, timeout, ou 429 com Retry-After. Não contém regra de
 * campanha — só o comportamento instável da rede.
 */
export class FakeMetricsProvider implements MetricsProvider {
  readonly platform: Platform;
  readonly requests: FetchMetricsInput[] = [];
  calls = 0;

  private readonly posts: readonly ProviderPostMetric[];
  private readonly steps: readonly FakeStep[];
  private readonly repeatLast: boolean;
  private cursor = 0;

  constructor(options: FakeMetricsProviderOptions) {
    this.platform = options.platform;
    this.posts = options.posts;
    this.steps = options.steps ?? [];
    this.repeatLast = options.repeatLast ?? false;
  }

  async fetchPostMetrics(input: FetchMetricsInput): Promise<ProviderPostMetric[]> {
    this.calls += 1;
    this.requests.push({ ...input });
    return this.materialize(this.nextStep());
  }

  private nextStep(): FakeStep {
    if (this.steps.length === 0) {
      return { type: 'success' };
    }

    if (this.cursor < this.steps.length) {
      const step = this.steps[this.cursor];
      this.cursor += 1;
      return step ?? { type: 'success' };
    }

    if (this.repeatLast) {
      return this.steps[this.steps.length - 1] ?? { type: 'success' };
    }

    return { type: 'success' };
  }

  private materialize(step: FakeStep): ProviderPostMetric[] {
    switch (step.type) {
      case 'success':
        return clonePosts(this.posts);
      case 'duplicate':
        return [...clonePosts(this.posts), ...clonePosts(this.posts)];
      case 'payload':
        return clonePosts(step.posts);
      case 'timeout':
        throw new ProviderRequestError('timeout', 'provedor não respondeu dentro do prazo');
      case 'unavailable':
        throw new ProviderRequestError('unavailable', 'provedor indisponível');
      case 'unauthorized':
        throw new ProviderRequestError('unauthorized', 'token recusado pelo provedor');
      case 'rate_limit':
        throw new ProviderRequestError('rate_limited', 'provedor respondeu 429', step.retryAfterMs);
      case 'defect':
        throw new Error('falha inesperada no provedor');
      default: {
        const unreachable: never = step;
        return unreachable;
      }
    }
  }
}

function clonePosts(posts: readonly ProviderPostMetric[]): ProviderPostMetric[] {
  return posts.map((post) => ({ ...post }));
}
