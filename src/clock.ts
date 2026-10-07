/** Relógio e espera injetáveis. O teste avança o tempo sem dormir de verdade. */
export interface Clock {
  now(): Date;
}

export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

export function systemClock(): Clock {
  return { now: () => new Date() };
}

export function systemSleeper(): Sleeper {
  return {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export class ManualClock implements Clock, Sleeper {
  private epochMs: number;
  readonly sleeps: number[] = [];

  constructor(iso = '2026-10-07T12:00:00.000Z') {
    const parsed = Date.parse(iso);
    if (Number.isNaN(parsed)) {
      throw new Error(`instante inválido: ${iso}`);
    }
    this.epochMs = parsed;
  }

  now(): Date {
    return new Date(this.epochMs);
  }

  async sleep(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`espera inválida: ${ms}`);
    }
    this.sleeps.push(ms);
    this.epochMs += ms;
  }
}
