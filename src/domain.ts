export const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'x'] as const;

export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value);
}

/** Conexão já autorizada. O token é fictício neste exercício: não há OAuth. */
export type Connection = {
  id: string;
  platform: Platform;
  creatorId: string;
  accessToken: string;
  connectedAt: string;
};

/**
 * Uma leitura de um post numa janela. A chave impede que o mesmo snapshot
 * entre duas vezes na conta da campanha.
 */
export type MetricSnapshot = {
  idempotencyKey: string;
  connectionId: string;
  platform: Platform;
  providerPostId: string;
  windowStart: string;
  windowEnd: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  /** Quando o serviço aceitou a resposta do provedor. Não muda num replay. */
  fetchedAt: string;
};

export type SnapshotOutcome = 'stored' | 'replayed';

export type SyncSnapshot = MetricSnapshot & {
  outcome: SnapshotOutcome;
};

export type SyncCommand = {
  connectionId: string;
  windowStart: string;
  windowEnd: string;
};

export type SyncFailureCode = 'timeout' | 'rate_limited' | 'unavailable' | 'unauthorized';

export type SyncReport = {
  status: 'completed' | 'failed';
  connectionId: string;
  platform: Platform;
  windowStart: string;
  windowEnd: string;
  attempts: number;
  waitedMs: number;
  snapshots: SyncSnapshot[];
  droppedAsDuplicateInResponse: number;
  error?: {
    code: SyncFailureCode;
    message: string;
    retryAfterMs?: number;
  };
};
