import type { DeliveryEntry, DeliveryState } from '../../contract/delivery';
import { SwarmloopError } from '../../core/swarmloop-error';

const STATES: readonly DeliveryState[] = ['publishing', 'published', 'read'];

/** One line per repository: `<repo> <state>`, and ` <project>` for a published one. */
export function formatDelivery(entries: DeliveryEntry[]): string {
  return `${entries.map(({ repo, state, project }) => [repo, state, project].filter(Boolean).join(' ')).join('\n')}\n`;
}

export function parseDelivery(body: string): DeliveryEntry[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [repo, state, project] = line.split(/\s+/);
      const known = STATES.find((item) => item === state);
      if (!known) {
        throw new SwarmloopError(`delivery has an unknown state for ${repo}: ${state ?? 'none'}`);
      }
      return project ? { repo, state: known, project } : { repo, state: known };
    });
}

/**
 * What the run delivers of each repository. A run made before the list existed has none: every repository of it
 * reads as published, which is what its merge requests and CI wait did then.
 */
export function deliveryOf(entries: DeliveryEntry[] | null, repos: string[]): DeliveryEntry[] {
  return entries ?? repos.map((repo) => ({ repo, state: 'published' }));
}

/** The repositories the run publishes: the ones with work of their own. */
export function toPublish(entries: DeliveryEntry[]): DeliveryEntry[] {
  return entries.filter((entry) => entry.state !== 'read');
}

export function stillPublishing(entries: DeliveryEntry[]): DeliveryEntry[] {
  return entries.filter((entry) => entry.state === 'publishing');
}

export function withPublished(entries: DeliveryEntry[], opened: { repo: string; project: string }[]): DeliveryEntry[] {
  return entries.map((entry) => {
    const found = opened.find((item) => item.repo === entry.repo);
    return found ? { repo: entry.repo, state: 'published', project: found.project } : entry;
  });
}

export function withRead(entries: DeliveryEntry[], repos: string[]): DeliveryEntry[] {
  return entries.map((entry) => (repos.includes(entry.repo) ? { repo: entry.repo, state: 'read' } : entry));
}

/** `1 published, 2 read` */
export function deliverySummary(entries: DeliveryEntry[]): string {
  return STATES.flatMap((state) => {
    const count = entries.filter((entry) => entry.state === state).length;
    return count > 0 ? [`${count} ${state}`] : [];
  }).join(', ');
}
