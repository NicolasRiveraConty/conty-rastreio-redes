import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Clock, Sleeper } from '../clock.js';
import { isPlatform, type Connection } from '../domain.js';
import { ProviderRegistry } from '../provider/metrics-provider.js';
import type { MetricsRepository } from '../repository/memory-metrics-repository.js';
import { SyncError, SyncService } from '../sync/sync-service.js';
import type { RetryPolicy } from '../sync/retry.js';

export type AppDeps = {
  registry: ProviderRegistry;
  repository: MetricsRepository;
  clock: Clock;
  sleeper: Sleeper;
  retry: RetryPolicy;
};

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const syncService = new SyncService(deps);

  app.get('/health', async () => ({ ok: true }));

  app.post('/connections', async (request, reply) => {
    const body = asBody(request.body);
    const platform = body.platform;
    const creatorId = body.creatorId;
    const accessToken = body.accessToken;

    if (!isPlatform(platform)) {
      return reply.status(400).send({ error: 'platform inválida' });
    }
    if (!nonEmpty(creatorId) || !nonEmpty(accessToken)) {
      return reply.status(400).send({ error: 'creatorId e accessToken são obrigatórios' });
    }

    const connection: Connection = {
      id: randomUUID(),
      platform,
      creatorId,
      accessToken,
      connectedAt: deps.clock.now().toISOString(),
    };
    await deps.repository.saveConnection(connection);

    return reply.status(201).send({
      id: connection.id,
      platform: connection.platform,
      creatorId: connection.creatorId,
      connectedAt: connection.connectedAt,
    });
  });

  app.post('/sync', async (request, reply) => {
    const body = asBody(request.body);

    try {
      const report = await syncService.sync({
        connectionId: requiredString(body.connectionId, 'connectionId'),
        windowStart: requiredString(body.windowStart, 'windowStart'),
        windowEnd: requiredString(body.windowEnd, 'windowEnd'),
      });
      const status = report.status === 'completed' ? 200 : 503;
      return reply.status(status).send(report);
    } catch (error) {
      if (error instanceof SyncError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get('/metrics', async (request) => {
    const query = (request.query ?? {}) as { connectionId?: string; providerPostId?: string };
    const snapshots = await deps.repository.listSnapshots({
      ...(query.connectionId ? { connectionId: query.connectionId } : {}),
      ...(query.providerPostId ? { providerPostId: query.providerPostId } : {}),
    });
    return { snapshots };
  });

  return app;
}

function asBody(body: unknown): Record<string, unknown> {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function requiredString(value: unknown, field: string): string {
  if (!nonEmpty(value)) {
    throw new SyncError(400, `${field} é obrigatório`);
  }
  return value;
}
