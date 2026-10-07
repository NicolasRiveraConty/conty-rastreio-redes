import type { Clock, Sleeper } from '../clock.js';
import type { MetricSnapshot, SyncCommand, SyncReport, SyncSnapshot } from '../domain.js';
import type { ProviderPostMetric } from '../provider/metrics-provider.js';
import { ProviderRegistry } from '../provider/metrics-provider.js';
import type { MetricsRepository } from '../repository/memory-metrics-repository.js';
import { withRetry, type RetryPolicy } from './retry.js';

export class SyncError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'SyncError';
    this.statusCode = statusCode;
  }
}

export type SyncServiceDeps = {
  registry: ProviderRegistry;
  repository: MetricsRepository;
  clock: Clock;
  sleeper: Sleeper;
  retry: RetryPolicy;
};

/**
 * Regra de negócio do sync. Deduplica o corpo, grava um snapshot por
 * (provedor, post, janela) e carimba fetchedAt. Não soma em cima de
 * uma chave que já existe: a primeira leitura da janela fica valendo.
 */
export class SyncService {
  constructor(private readonly deps: SyncServiceDeps) {}

  async sync(command: SyncCommand): Promise<SyncReport> {
    const connection = await this.deps.repository.findConnection(command.connectionId);
    if (!connection) {
      throw new SyncError(404, 'conexão não encontrada');
    }

    const windowStart = parseInstant(command.windowStart, 'windowStart');
    const windowEnd = parseInstant(command.windowEnd, 'windowEnd');
    if (Date.parse(windowEnd) <= Date.parse(windowStart)) {
      throw new SyncError(400, 'windowEnd precisa ser depois de windowStart');
    }

    const provider = this.deps.registry.find(connection.platform);
    if (!provider) {
      throw new SyncError(500, `provedor não configurado para ${connection.platform}`);
    }

    const fetched = await withRetry({
      policy: this.deps.retry,
      sleep: (ms) => this.deps.sleeper.sleep(ms),
      run: () =>
        provider.fetchPostMetrics({
          accessToken: connection.accessToken,
          creatorId: connection.creatorId,
          platform: connection.platform,
          windowStart,
          windowEnd,
        }),
    });

    const base = {
      connectionId: connection.id,
      platform: connection.platform,
      windowStart,
      windowEnd,
    };

    if (!fetched.ok) {
      return {
        status: 'failed',
        ...base,
        attempts: fetched.attempts,
        waitedMs: fetched.waitedMs,
        snapshots: [],
        droppedAsDuplicateInResponse: 0,
        error: {
          code: fetched.error.code,
          message: fetched.error.message,
          ...(fetched.error.retryAfterMs !== undefined ? { retryAfterMs: fetched.error.retryAfterMs } : {}),
        },
      };
    }

    const fetchedAt = this.deps.clock.now().toISOString();
    const { unique, dropped } = dedupePosts(fetched.value);
    const snapshots: SyncSnapshot[] = [];

    for (const post of unique) {
      const snapshot: MetricSnapshot = {
        idempotencyKey: snapshotKey({
          platform: connection.platform,
          providerPostId: post.providerPostId,
          windowStart,
          windowEnd,
        }),
        connectionId: connection.id,
        platform: connection.platform,
        providerPostId: post.providerPostId,
        windowStart,
        windowEnd,
        views: post.views,
        likes: post.likes,
        comments: post.comments,
        shares: post.shares,
        fetchedAt,
      };

      const saved = await this.deps.repository.insertSnapshotIfAbsent(snapshot);
      snapshots.push({ ...saved.snapshot, outcome: saved.outcome });
    }

    return {
      status: 'completed',
      ...base,
      attempts: fetched.attempts,
      waitedMs: fetched.waitedMs,
      snapshots,
      droppedAsDuplicateInResponse: dropped,
    };
  }
}

export function snapshotKey(parts: {
  platform: string;
  providerPostId: string;
  windowStart: string;
  windowEnd: string;
}): string {
  return [parts.platform, parts.providerPostId, parts.windowStart, parts.windowEnd].join('|');
}

export function parseInstant(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.includes('T')) {
    throw new SyncError(400, `${field} precisa ser um instante ISO-8601`);
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new SyncError(400, `${field} precisa ser um instante ISO-8601`);
  }

  return new Date(parsed).toISOString();
}

function dedupePosts(posts: readonly ProviderPostMetric[]): {
  unique: ProviderPostMetric[];
  dropped: number;
} {
  const seen = new Set<string>();
  const unique: ProviderPostMetric[] = [];
  let dropped = 0;

  for (const post of posts) {
    if (seen.has(post.providerPostId)) {
      dropped += 1;
      continue;
    }
    seen.add(post.providerPostId);
    unique.push(post);
  }

  return { unique, dropped };
}
