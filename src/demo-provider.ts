import type { Platform } from './domain.js';
import { PLATFORMS } from './domain.js';
import { FakeMetricsProvider, type FakeStep } from './provider/fake-metrics-provider.js';
import { ProviderRegistry } from './provider/metrics-provider.js';
import type { ProviderPostMetric } from './provider/metrics-provider.js';

const SCENARIOS = ['ok', 'duplicate', 'rate_limit', 'timeout', 'timeout_exhausted'] as const;

export type DemoScenario = (typeof SCENARIOS)[number];

export function isDemoScenario(value: string): value is DemoScenario {
  return (SCENARIOS as readonly string[]).includes(value);
}

/** Roteiro do processo HTTP. Os testes montam o fake direto e ignoram isto. */
export function createDemoRegistry(scenario: DemoScenario): ProviderRegistry {
  const steps = stepsFor(scenario);
  return new ProviderRegistry(
    PLATFORMS.map(
      (platform) =>
        new FakeMetricsProvider({
          platform,
          posts: postsFor(platform),
          steps,
          repeatLast: scenario === 'timeout_exhausted',
        }),
    ),
  );
}

function stepsFor(scenario: DemoScenario): FakeStep[] {
  switch (scenario) {
    case 'ok':
      return [{ type: 'success' }];
    case 'duplicate':
      return [{ type: 'duplicate' }];
    case 'rate_limit':
      return [{ type: 'rate_limit', retryAfterMs: 200 }, { type: 'success' }];
    case 'timeout':
      return [{ type: 'timeout' }, { type: 'success' }];
    case 'timeout_exhausted':
      return [{ type: 'timeout' }];
    default: {
      const unreachable: never = scenario;
      return unreachable;
    }
  }
}

function postsFor(platform: Platform): ProviderPostMetric[] {
  return [
    { providerPostId: `${platform}-post-1`, views: 1200, likes: 80, comments: 12, shares: 4 },
    { providerPostId: `${platform}-post-2`, views: 340, likes: 21, comments: 3, shares: 1 },
  ];
}
