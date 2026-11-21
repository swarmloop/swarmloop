'use client';

import { useEffect, useState } from 'react';

export const OVERVIEW_RANGES = [
  { days: 7, label: 'This week' },
  { days: 30, label: 'This month' },
  { days: 0, label: 'All time' },
];

const STORAGE_KEY = 'swarmloop.overview.range';
const DEFAULT_DAYS = OVERVIEW_RANGES[0].days;

function storedDays(): number | null {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  const days = Number(stored);
  return stored !== null && OVERVIEW_RANGES.some((range) => range.days === days) ? days : null;
}

/** The range of the numbers: This week first, then the choice kept in this browser once the page has mounted. */
export function useOverviewRange(): [number, (days: number) => void] {
  const [days, setDays] = useState(DEFAULT_DAYS);
  useEffect(() => {
    const stored = storedDays();
    if (stored !== null) {
      setDays(stored);
    }
  }, []);
  return [
    days,
    (next) => {
      setDays(next);
      window.localStorage.setItem(STORAGE_KEY, String(next));
    },
  ];
}
