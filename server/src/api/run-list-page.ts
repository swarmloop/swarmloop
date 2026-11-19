import { BadRequestException } from '@nestjs/common';
import type { RunSummary } from '../contract/api';
import { filterRuns, nested, type Part, type RunsPage } from '../contract/run-list';

/** Top-level runs a `done` or `all` page holds. */
const PAGE_SIZE = 20;

interface Cursor {
  createdAt: string;
  key: string;
}

function encode(top: RunSummary): string {
  const cursor: Cursor = { createdAt: top.createdAt, key: top.key };
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decode(value: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const { createdAt, key } = (parsed ?? {}) as Partial<Cursor>;
    if (typeof createdAt === 'string' && typeof key === 'string') {
      return { createdAt, key };
    }
  } catch {
    // falls through to the same answer as any other foreign cursor
  }
  throw new BadRequestException('the cursor is not one this list gave');
}

/** The index of the first top after the cursor; a run that left the part is replaced by the first older one. */
function startAfter(tops: RunSummary[], cursor: Cursor): number {
  const at = tops.findIndex((top) => top.key === cursor.key);
  if (at >= 0) {
    return at + 1;
  }
  const older = tops.findIndex((top) => top.createdAt < cursor.createdAt);
  return older >= 0 ? older : tops.length;
}

/** One page of the run list: `active` whole, `done` and `all` 20 top-level runs from the cursor, each with its subtasks. */
export function pageOf(rows: RunSummary[], query: { part: Part; q: string; cursor?: string }): RunsPage {
  const { visible, otherMatches } = filterRuns(rows, query.q, query.part);
  const { counts } = filterRuns(rows, '', 'all');
  const { tops, children } = nested(visible);
  const groupOf = (top: RunSummary): RunSummary[] => [top, ...(children.get(top.key) ?? [])];
  if (query.part === 'active') {
    return { runs: visible, counts, otherMatches, next: null };
  }
  const from = query.cursor === undefined ? 0 : startAfter(tops, decode(query.cursor));
  const page = tops.slice(from, from + PAGE_SIZE);
  const more = from + PAGE_SIZE < tops.length;
  return {
    runs: page.flatMap(groupOf),
    counts,
    otherMatches,
    next: more ? encode(page[page.length - 1]) : null,
  };
}
