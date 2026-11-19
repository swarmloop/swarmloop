import type { RunsView, RunSummary } from '../contract/api';

/** The run rows last sent to the sockets, by key, so a change sends only what differs. */
export class RunListChanges {
  private sent = new Map<string, string>();

  hasBaseline(): boolean {
    return this.sent.size > 0;
  }

  reset(view: RunsView): void {
    this.sent = new Map(view.runs.map((row) => [row.key, JSON.stringify(row)]));
  }

  /** The rows of `keys`, their parents and every new or changed row in view order, and the keys that left the list. */
  since(view: RunsView, keys: string[]): { rows: RunSummary[]; removed: string[] } {
    const wanted = new Set(keys);
    for (const row of view.runs) {
      if (wanted.has(row.key) && row.parentKey) {
        wanted.add(row.parentKey);
      }
    }
    const rows = view.runs.filter((row) => wanted.has(row.key) || this.sent.get(row.key) !== JSON.stringify(row));
    const present = new Set(view.runs.map((row) => row.key));
    const removed = [...this.sent.keys()].filter((key) => !present.has(key));
    this.reset(view);
    return { rows, removed };
  }
}
