import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/clock.js';
import { FakeMetricsProvider } from '../src/provider/fake-metrics-provider.js';
import { ProviderRegistry } from '../src/provider/metrics-provider.js';
import { MemoryMetricsRepository } from '../src/repository/memory-metrics-repository.js';
import { buildApp } from '../src/http/app.js';

const WINDOW = {
  windowStart: '2026-10-01T00:00:00.000Z',
  windowEnd: '2026-10-08T00:00:00.000Z',
};

function createApp() {
  const clock = new ManualClock();
  const provider = new FakeMetricsProvider({
    platform: 'tiktok',
    posts: [{ providerPostId: 'tt-1', views: 80, likes: 8, comments: 1, shares: 0 }],
    steps: [{ type: 'duplicate' }, { type: 'rate_limit', retryAfterMs: 1_500 }, { type: 'success' }],
  });
  const repository = new MemoryMetricsRepository();
  const app = buildApp({
    registry: new ProviderRegistry([provider]),
    repository,
    clock,
    sleeper: clock,
    retry: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 100 },
  });

  return { app, clock, provider, repository };
}

describe('API', () => {
  it('sincroniza, ignora a repetição e não devolve o token', async () => {
    const { app, provider } = createApp();
    const created = await app.inject({
      method: 'POST',
      url: '/connections',
      payload: { platform: 'tiktok', creatorId: 'criador-9', accessToken: 'token-ficticio' },
    });

    expect(created.statusCode).toBe(201);
    const connection = created.json() as { id: string; accessToken?: string };
    expect(connection.accessToken).toBeUndefined();

    const started = Date.now();
    const first = await app.inject({
      method: 'POST',
      url: '/sync',
      payload: { connectionId: connection.id, ...WINDOW },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/sync',
      payload: { connectionId: connection.id, ...WINDOW },
    });
    const listed = await app.inject({
      method: 'GET',
      url: `/metrics?connectionId=${connection.id}`,
    });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      status: 'completed',
      droppedAsDuplicateInResponse: 1,
      attempts: 1,
      snapshots: [{ providerPostId: 'tt-1', views: 80, outcome: 'stored', fetchedAt: '2026-10-07T12:00:00.000Z' }],
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      status: 'completed',
      attempts: 2,
      waitedMs: 1_500,
      snapshots: [{ views: 80, outcome: 'replayed', fetchedAt: '2026-10-07T12:00:00.000Z' }],
    });
    expect(provider.calls).toBe(3);

    const metrics = listed.json() as { snapshots: Array<{ views: number; accessToken?: string }> };
    expect(metrics.snapshots).toHaveLength(1);
    expect(metrics.snapshots[0]?.views).toBe(80);
    expect(JSON.stringify(listed.json())).not.toContain('token-ficticio');
    expect(JSON.stringify(second.json())).not.toContain('token-ficticio');

    await app.close();
  });

  it('responde 503 quando o provedor segue em 429 até o limite', async () => {
    const clock = new ManualClock();
    const provider = new FakeMetricsProvider({
      platform: 'x',
      posts: [{ providerPostId: 'x-1', views: 5, likes: 1, comments: 0, shares: 0 }],
      steps: [{ type: 'rate_limit', retryAfterMs: 25 }],
      repeatLast: true,
    });
    const app = buildApp({
      registry: new ProviderRegistry([provider]),
      repository: new MemoryMetricsRepository(),
      clock,
      sleeper: clock,
      retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10 },
    });

    const created = await app.inject({
      method: 'POST',
      url: '/connections',
      payload: { platform: 'x', creatorId: 'criador-x', accessToken: 'token-ficticio' },
    });
    const connectionId = (created.json() as { id: string }).id;
    const sync = await app.inject({
      method: 'POST',
      url: '/sync',
      payload: { connectionId, ...WINDOW },
    });

    expect(sync.statusCode).toBe(503);
    expect(sync.json()).toMatchObject({
      status: 'failed',
      attempts: 2,
      waitedMs: 25,
      snapshots: [],
      error: { code: 'rate_limited', retryAfterMs: 25 },
    });
    expect(provider.calls).toBe(2);

    await app.close();
  });

  it('recusa plataforma e conexão desconhecida', async () => {
    const { app } = createApp();

    const invalid = await app.inject({
      method: 'POST',
      url: '/connections',
      payload: { platform: 'facebook', creatorId: 'a', accessToken: 'b' },
    });
    const missing = await app.inject({
      method: 'POST',
      url: '/sync',
      payload: { connectionId: 'nao-existe', ...WINDOW },
    });

    expect(invalid.statusCode).toBe(400);
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
