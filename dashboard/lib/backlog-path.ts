import type { Route } from 'next';

/** The dashboard page of a backlog. */
export const backlogPath = (name: string): Route => `/backlogs/${encodeURIComponent(name)}` as Route;
