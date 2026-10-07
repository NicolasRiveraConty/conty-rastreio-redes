import type { Connection, MetricSnapshot } from '../domain.js';

export type SnapshotInsert =
  | { outcome: 'stored'; snapshot: MetricSnapshot }
  | { outcome: 'replayed'; snapshot: MetricSnapshot };

export type SnapshotFilter = {
  connectionId?: string;
  providerPostId?: string;
};

/**
 * Persistência atrás de uma interface pequena. A implementação de memória
 * guarda a primeira versão de cada chave e não soma em cima dela.
 */
export interface MetricsRepository {
  saveConnection(connection: Connection): Promise<Connection>;
  findConnection(id: string): Promise<Connection | null>;
  insertSnapshotIfAbsent(snapshot: MetricSnapshot): Promise<SnapshotInsert>;
  listSnapshots(filter?: SnapshotFilter): Promise<MetricSnapshot[]>;
}

export class MemoryMetricsRepository implements MetricsRepository {
  private readonly connections = new Map<string, Connection>();
  private readonly snapshots = new Map<string, MetricSnapshot>();

  async saveConnection(connection: Connection): Promise<Connection> {
    const stored = { ...connection };
    this.connections.set(stored.id, stored);
    return stored;
  }

  async findConnection(id: string): Promise<Connection | null> {
    const connection = this.connections.get(id);
    return connection ? { ...connection } : null;
  }

  async insertSnapshotIfAbsent(snapshot: MetricSnapshot): Promise<SnapshotInsert> {
    const existing = this.snapshots.get(snapshot.idempotencyKey);
    if (existing) {
      return { outcome: 'replayed', snapshot: existing };
    }

    const stored = { ...snapshot };
    this.snapshots.set(stored.idempotencyKey, stored);
    return { outcome: 'stored', snapshot: stored };
  }

  async listSnapshots(filter: SnapshotFilter = {}): Promise<MetricSnapshot[]> {
    return [...this.snapshots.values()].filter((snapshot) => {
      if (filter.connectionId !== undefined && snapshot.connectionId !== filter.connectionId) {
        return false;
      }
      if (filter.providerPostId !== undefined && snapshot.providerPostId !== filter.providerPostId) {
        return false;
      }
      return true;
    });
  }
}
