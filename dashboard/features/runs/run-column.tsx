'use client';

import type { ReactElement } from 'react';
import type { Route } from 'next';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { RunSummary } from '@contract/api';
import { parsePart } from '@contract/run-list';
import type { Part, PartCounts } from '@contract/run-list';
import { useLiveActions } from '../shell';
import { showQuery } from './run-filter';
import { RunList } from './run-list';
import { ShowControl } from './show-control';

/** The run list with its search box and its Active / Done / All control; the part lives in `?show=`. */
export function RunColumn({
  runs,
  counts,
  otherMatches,
  next,
  onLoadMore,
  listing,
  now,
  loaded,
  error,
  onRetry,
  selected,
  onOpen,
  onRemove,
}: {
  runs: RunSummary[];
  counts: PartCounts;
  otherMatches: number;
  next: string | null;
  onLoadMore: () => void;
  /** True while the list of a newly chosen part has not arrived. */
  listing: boolean;
  now: number;
  loaded: boolean;
  error: string | null;
  onRetry: () => void;
  selected: string;
  /** `search` is the query that keeps the chosen part: `?show=done`, or empty. */
  onOpen: (key: string, search: string) => void;
  onRemove: (run: RunSummary, search: string) => void;
}): ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState('');
  const part = parsePart(searchParams.get('show'));
  const search = showQuery(searchParams);
  const { showList } = useLiveActions();
  useEffect(() => showList(part, query), [showList, part, query]);

  function onPart(chosen: Part): void {
    const params = new URLSearchParams(searchParams.toString());
    params.set('show', chosen);
    router.replace(`${pathname}?${params.toString()}` as Route);
  }

  return (
    <RunList
      query={query}
      onQuery={setQuery}
      visible={runs}
      part={part}
      otherMatches={otherMatches}
      total={counts.all}
      next={next}
      onLoadMore={onLoadMore}
      onPart={onPart}
      control={<ShowControl part={part} counts={loaded ? counts : null} onPart={onPart} />}
      selected={selected}
      now={now}
      loaded={loaded && !listing}
      error={error}
      onRetry={onRetry}
      onOpen={(key) => onOpen(key, search)}
      onRemove={(run) => onRemove(run, search)}
    />
  );
}
