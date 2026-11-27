import type { RemoteRepository, RepositoryOwner } from '../../contract/api';
import type { Clock } from '../../core/clock';

export const CACHE_MS = 60_000;

export interface HostSnapshot {
  at: number;
  repositories: RemoteRepository[];
  owners: RepositoryOwner[];
}

interface Slot {
  snapshot?: HostSnapshot;
  failure?: string;
  pending: boolean;
}

/** What each person's token reaches on each host: the snapshot, the kept failure and the pending refresh, by `<login>:<host>`. */
export class RemoteCache {
  private readonly slots = new Map<string, Slot>();

  constructor(private readonly clock: Clock) {}

  /** The snapshot when it is younger than CACHE_MS. */
  fresh(actor: string | null, host: string): HostSnapshot | undefined {
    const snapshot = this.slots.get(this.key(actor, host))?.snapshot;
    return snapshot && this.clock.now() - snapshot.at < CACHE_MS ? snapshot : undefined;
  }

  /** The snapshot, fresh or not. */
  snapshot(actor: string | null, host: string): HostSnapshot | undefined {
    return this.slots.get(this.key(actor, host))?.snapshot;
  }

  /** Keeps a snapshot and forgets the failure of its host. */
  store(actor: string | null, host: string, snapshot: HostSnapshot): void {
    const slot = this.slot(actor, host);
    slot.snapshot = snapshot;
    slot.failure = undefined;
  }

  failure(actor: string | null, host: string): string | undefined {
    return this.slots.get(this.key(actor, host))?.failure;
  }

  fail(actor: string | null, host: string, message: string): void {
    this.slot(actor, host).failure = message;
  }

  /** Forgets every failure kept for a person. */
  dropFailures(actor: string | null): void {
    const prefix = this.key(actor, '');
    for (const [key, slot] of this.slots) {
      if (key.startsWith(prefix)) {
        slot.failure = undefined;
      }
    }
  }

  isPending(actor: string | null, host: string): boolean {
    return this.slots.get(this.key(actor, host))?.pending === true;
  }

  markPending(actor: string | null, host: string): void {
    this.slot(actor, host).pending = true;
  }

  clearPending(actor: string | null, host: string): void {
    const slot = this.slots.get(this.key(actor, host));
    if (slot) {
      slot.pending = false;
    }
  }

  /** Adds a repository to the kept snapshot, when there is one. */
  add(actor: string | null, host: string, repository: RemoteRepository): void {
    const snapshot = this.snapshot(actor, host);
    if (snapshot) {
      snapshot.repositories = [...snapshot.repositories, repository];
    }
  }

  private slot(actor: string | null, host: string): Slot {
    const key = this.key(actor, host);
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { pending: false };
      this.slots.set(key, slot);
    }
    return slot;
  }

  private key(actor: string | null, host: string): string {
    return `${actor ?? ''}:${host}`;
  }
}
