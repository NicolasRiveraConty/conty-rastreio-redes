import { systemClock, systemSleeper } from './clock.js';
import { createDemoRegistry, isDemoScenario } from './demo-provider.js';
import { buildApp } from './http/app.js';
import { MemoryMetricsRepository } from './repository/memory-metrics-repository.js';
import { defaultRetryPolicy } from './sync/retry.js';

const scenarioName = process.env.PROVIDER_SCENARIO ?? 'ok';
if (!isDemoScenario(scenarioName)) {
  throw new Error(
    `PROVIDER_SCENARIO inválido: ${scenarioName}. Use ok, duplicate, rate_limit, timeout ou timeout_exhausted.`,
  );
}

const app = buildApp({
  registry: createDemoRegistry(scenarioName),
  repository: new MemoryMetricsRepository(),
  clock: systemClock(),
  sleeper: systemSleeper(),
  retry: defaultRetryPolicy,
});

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
console.log(`sync de métricas em http://localhost:${port} (cenário ${scenarioName})`);
