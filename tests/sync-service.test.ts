import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/clock.js';
import type { Connection, MetricSnapshot } from '../src/domain.js';
import { FakeMetricsProvider, type FakeStep } from '../src/provider/fake-metrics-provider.js';
import { ProviderRegistry, type ProviderPostMetric } from '../src/provider/metrics-provider.js';
import { MemoryMetricsRepository } from '../src/repository/memory-metrics-repository.js';
import type { RetryPolicy } from '../src/sync/retry.js';
import { snapshotKey, SyncService } from '../src/sync/sync-service.js';

const WINDOW = {
  windowStart: '2026-10-01T00:00:00.000Z',
  windowEnd: '2026-10-08T00:00:00.000Z',
};

const POST_A: ProviderPostMetric = {
  providerPostId: 'post-1',
  views: 100,
  likes: 10,
  comments: 2,
  shares: 1,
};

const POST_B: ProviderPostMetric = {
  providerPostId: 'post-2',
  views: 40,
  likes: 4,
  comments: 1,
  shares: 0,
};

function setup(options: {
  steps?: FakeStep[];
  posts?: readonly ProviderPostMetric[];
  repeatLast?: boolean;
  retry?: Partial<RetryPolicy>;
}) {
  const clock = new ManualClock();
  const provider = new FakeMetricsProvider({
    platform: 'instagram',
    posts: options.posts ?? [POST_A],
    steps: options.steps,
    repeatLast: options.repeatLast,
  });
  const repository = new MemoryMetricsRepository();
  const service = new SyncService({
    registry: new ProviderRegistry([provider]),
    repository,
    clock,
    sleeper: clock,
    retry: {
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      ...options.retry,
    },
  });

  return { clock, provider, repository, service };
}

async function connect(repository: MemoryMetricsRepository, id = 'conn-1'): Promise<Connection> {
  return repository.saveConnection({
    id,
    platform: 'instagram',
    creatorId: 'criador-1',
    accessToken: 'token-ficticio',
    connectedAt: '2026-10-07T12:00:00.000Z',
  });
}

function viewsOf(snapshots: readonly MetricSnapshot[]): number {
  return snapshots.reduce((total, snapshot) => total + snapshot.views, 0);
}

describe('idempotência do snapshot', () => {
  it('não soma quando o mesmo post chega de novo na mesma janela', async () => {
    const { service, repository, provider } = setup({
      steps: [
        { type: 'success' },
        { type: 'payload', posts: [{ ...POST_A, views: 999, likes: 50, comments: 9, shares: 8 }] },
      ],
    });
    await connect(repository);

    const first = await service.sync({ connectionId: 'conn-1', ...WINDOW });
    const second = await service.sync({ connectionId: 'conn-1', ...WINDOW });
    const stored = await repository.listSnapshots({ connectionId: 'conn-1' });

    expect(first.snapshots.map((snapshot) => snapshot.outcome)).toEqual(['stored']);
    expect(second.snapshots.map((snapshot) => snapshot.outcome)).toEqual(['replayed']);
    expect(stored).toHaveLength(1);
    expect(viewsOf(stored)).toBe(100);
    expect(stored[0]).toMatchObject({ likes: 10, comments: 2, shares: 1 });
    expect(second.snapshots[0]?.fetchedAt).toBe(first.snapshots[0]?.fetchedAt);
    expect(provider.calls).toBe(2);
  });

  it('trata o mesmo instante com e sem milissegundos como a mesma chave', async () => {
    const { service, repository } = setup({ steps: [{ type: 'success' }, { type: 'success' }] });
    await connect(repository);

    await service.sync({
      connectionId: 'conn-1',
      windowStart: '2026-10-01T00:00:00Z',
      windowEnd: '2026-10-08T00:00:00Z',
    });
    const again = await service.sync({
      connectionId: 'conn-1',
      windowStart: '2026-10-01T00:00:00.000Z',
      windowEnd: '2026-10-08T00:00:00.000Z',
    });

    expect(again.snapshots[0]?.outcome).toBe('replayed');
    expect(again.snapshots[0]?.idempotencyKey).toBe(
      snapshotKey({
        platform: 'instagram',
        providerPostId: 'post-1',
        windowStart: '2026-10-01T00:00:00.000Z',
        windowEnd: '2026-10-08T00:00:00.000Z',
      }),
    );
    expect(await repository.listSnapshots()).toHaveLength(1);
  });

  it('grava outra linha quando a janela é outra', async () => {
    const { service, repository } = setup({ steps: [{ type: 'success' }, { type: 'success' }] });
    await connect(repository);

    await service.sync({ connectionId: 'conn-1', ...WINDOW });
    await service.sync({
      connectionId: 'conn-1',
      windowStart: '2026-10-08T00:00:00.000Z',
      windowEnd: '2026-10-15T00:00:00.000Z',
    });

    const stored = await repository.listSnapshots();
    expect(stored).toHaveLength(2);
    expect(viewsOf(stored)).toBe(200);
  });

  it('mantém o post já gravado e acrescenta só o post novo', async () => {
    const { service, repository } = setup({
      steps: [
        { type: 'payload', posts: [POST_A] },
        { type: 'payload', posts: [{ ...POST_A, views: 500 }, POST_B] },
      ],
    });
    await connect(repository);

    await service.sync({ connectionId: 'conn-1', ...WINDOW });
    const second = await service.sync({ connectionId: 'conn-1', ...WINDOW });
    const stored = await repository.listSnapshots();

    expect(second.snapshots.map((snapshot) => [snapshot.providerPostId, snapshot.outcome])).toEqual([
      ['post-1', 'replayed'],
      ['post-2', 'stored'],
    ]);
    expect(viewsOf(stored)).toBe(140);
  });
});

describe('resposta duplicada do provedor', () => {
  it('conta o post uma vez quando o corpo repete os mesmos ids', async () => {
    const { service, repository } = setup({
      posts: [POST_A, POST_B],
      steps: [{ type: 'duplicate' }],
    });
    await connect(repository);

    const report = await service.sync({ connectionId: 'conn-1', ...WINDOW });
    const stored = await repository.listSnapshots();

    expect(report.droppedAsDuplicateInResponse).toBe(2);
    expect(report.snapshots).toHaveLength(2);
    expect(viewsOf(stored)).toBe(140);
  });

  it('fica com a primeira ocorrência se o duplicado traz outro número', async () => {
    const { service, repository } = setup({
      steps: [
        {
          type: 'payload',
          posts: [POST_A, { ...POST_A, views: 70, likes: 1, comments: 0, shares: 0 }],
        },
      ],
    });
    await connect(repository);

    const report = await service.sync({ connectionId: 'conn-1', ...WINDOW });

    expect(report.droppedAsDuplicateInResponse).toBe(1);
    expect(report.snapshots).toHaveLength(1);
    expect(report.snapshots[0]).toMatchObject({ views: 100, likes: 10, outcome: 'stored' });
  });
});

describe('429', () => {
  it('espera o Retry-After e grava o snapshot na tentativa seguinte', async () => {
    const started = Date.now();
    const { service, repository, clock, provider } = setup({
      steps: [{ type: 'rate_limit', retryAfterMs: 1_500 }, { type: 'success' }],
      retry: { baseDelayMs: 100, maxDelayMs: 400 },
    });
    await connect(repository);

    const report = await service.sync({ connectionId: 'conn-1', ...WINDOW });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(clock.sleeps).toEqual([1_500]);
    expect(provider.calls).toBe(2);
    expect(report).toMatchObject({ status: 'completed', attempts: 2, waitedMs: 1_500 });
    expect(report.snapshots[0]?.fetchedAt).toBe('2026-10-07T12:00:01.500Z');
    expect(viewsOf(await repository.listSnapshots())).toBe(100);
  });

  it('usa o backoff quando o 429 não traz Retry-After', async () => {
    const { service, repository, clock } = setup({
      steps: [{ type: 'rate_limit' }, { type: 'success' }],
    });
    await connect(repository);

    const report = await service.sync({ connectionId: 'conn-1', ...WINDOW });

    expect(clock.sleeps).toEqual([100]);
    expect(report.status).toBe('completed');
  });

  it('para no teto de tentativas e não grava nada', async () => {
    const { service, repository, clock, provider } = setup({
      steps: [{ type: 'rate_limit', retryAfterMs: 250 }],
      repeatLast: true,
      retry: { maxAttempts: 3 },
    });
    await connect(repository);

    const report = await service.sync({ connectionId: 'conn-1', ...WINDOW });

    expect(provider.calls).toBe(3);
    expect(clock.sleeps).toEqual([250, 250]);
    expect(report).toMatchObject({
      status: 'failed',
      attempts: 3,
      waitedMs: 500,
      snapshots: [],
      error: { code: 'rate_limited', retryAfterMs: 250 },
    });
    expect(await repository.listSnapshots()).toHaveLength(0);
  });
});

describe('timeout', () => {
  it('tenta de novo com backoff e registra fetchedAt depois da espera', async () => {
    const { service, repository, clock, provider } = setup({
      steps: [{ type: 'timeout' }, { type: 'timeout' }, { type: 'success' }],
    });
    await connect(repository);

    const report = await service.sync({ connectionId: 'conn-1', ...WINDOW });

    expect(clock.sleeps).toEqual([100, 200]);
    expect(provider.calls).toBe(3);
    expect(report.attempts).toBe(3);
    expect(report.snapshots[0]?.fetchedAt).toBe('2026-10-07T12:00:00.300Z');
  });

  it('respeita o teto do backoff e não passa de maxAttempts', async () => {
    const { service, repository, clock, provider } = setup({
      steps: [{ type: 'timeout' }],
      repeatLast: true,
      retry: { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 250 },
    });
    await connect(repository);

    const report = await service.sync({ connectionId: 'conn-1', ...WINDOW });

    expect(provider.calls).toBe(4);
    expect(clock.sleeps).toEqual([100, 200, 250]);
    expect(report).toMatchObject({
      status: 'failed',
      attempts: 4,
      waitedMs: 550,
      error: { code: 'timeout' },
    });
    expect(await repository.listSnapshots()).toHaveLength(0);
  });

  it('não tenta de novo quando o token é recusado', async () => {
    const { service, repository, clock, provider } = setup({
      steps: [{ type: 'unauthorized' }],
      repeatLast: true,
    });
    await connect(repository);

    const report = await service.sync({ connectionId: 'conn-1', ...WINDOW });

    expect(provider.calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
    expect(report.error?.code).toBe('unauthorized');
  });

  it('não engole erro que não é falha do provedor', async () => {
    const { service, repository, provider } = setup({
      steps: [{ type: 'defect' }],
      repeatLast: true,
    });
    await connect(repository);

    await expect(service.sync({ connectionId: 'conn-1', ...WINDOW })).rejects.toThrow(
      'falha inesperada no provedor',
    );
    expect(provider.calls).toBe(1);
  });
});

describe('fronteira com o provedor', () => {
  it('entrega token e janela normalizada ao provedor, sem fetchedAt vindo de lá', async () => {
    const { service, repository, provider } = setup({ steps: [{ type: 'success' }] });
    await connect(repository);

    const report = await service.sync({
      connectionId: 'conn-1',
      windowStart: '2026-10-01T00:00:00Z',
      windowEnd: '2026-10-08T00:00:00Z',
    });

    expect(provider.requests).toEqual([
      {
        accessToken: 'token-ficticio',
        creatorId: 'criador-1',
        platform: 'instagram',
        windowStart: '2026-10-01T00:00:00.000Z',
        windowEnd: '2026-10-08T00:00:00.000Z',
      },
    ]);
    expect(report.snapshots[0]?.fetchedAt).toBe('2026-10-07T12:00:00.000Z');
  });

  it('recusa conexão desconhecida e janela invertida antes de chamar o provedor', async () => {
    const { service, provider } = setup({});

    await expect(service.sync({ connectionId: 'nao-existe', ...WINDOW })).rejects.toThrow(
      'conexão não encontrada',
    );
    expect(provider.calls).toBe(0);

    const { service: other, repository, provider: otherProvider } = setup({});
    await connect(repository, 'conn-2');
    await expect(
      other.sync({
        connectionId: 'conn-2',
        windowStart: '2026-10-08T00:00:00.000Z',
        windowEnd: '2026-10-01T00:00:00.000Z',
      }),
    ).rejects.toThrow('windowEnd precisa ser depois de windowStart');
    expect(otherProvider.calls).toBe(0);
  });
});
