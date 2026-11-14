'use client';

import type { ReactElement } from 'react';
import type { Route } from 'next';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { RunSummary } from '@contract/api';
import { filterRuns, parsePart } from './run-filter';
import type { Part } from './run-filter';
import { RunList } from './run-list';
import { ShowControl } from './show-control';

/** The run list with its search box and its Active / Done / All control; the part lives in `?show=`. */
export function RunColumn({
  runs,
  now,
  error,
  selected,
  onOpen,
  onRemove,
}: {
  runs: RunSummary[];
  now: number;
  error: string | null;
  selected: string;
  onOpen: (key: string) => void;
  onRemove: (run: RunSummary) => void;
}): ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState('');
  const part = parsePart(searchParams.get('show'));
  const { visible, counts, otherMatches } = useMemo(() => filterRuns(runs, query, part), [runs, query, part]);

  function onPart(next: Part): void {
    const params = new URLSearchParams(searchParams.toString());
    params.set('show', next);
    router.replace(`${pathname}?${params.toString()}` as Route);
  }

  return (
    <RunList
      query={query}
      onQuery={setQuery}
      runs={runs}
      visible={visible}
      part={part}
      otherMatches={otherMatches}
      onPart={onPart}
      control={<ShowControl part={part} counts={counts} onPart={onPart} />}
      selected={selected}
      now={now}
      error={error}
      onOpen={onOpen}
      onRemove={onRemove}
    />
  );
}
