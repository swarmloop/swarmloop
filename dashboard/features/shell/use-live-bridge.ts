'use client';

import type { ReactElement, ReactNode } from 'react';
import { createContext, createElement, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { liveSocket } from '../../lib/live';
import type { FlowView, RunSummary } from '@contract/api';
import type { LiveEvents, LiveLog } from '@contract/live';
import type { Part, PartCounts, RunChange, RunsPage } from '@contract/run-list';
import type { ServerState } from '@contract/server-pause';
import { applyRunChange } from './apply-run-change';

interface ListView {
  part: Part;
  q: string;
}

interface LiveSnapshot {
  runs: RunSummary[];
  /** True once the runs list has come from the API or the socket. */
  loaded: boolean;
  connected: boolean;
  /** The counts of the three parts, from the server. */
  counts: PartCounts;
  /** The part and the filter text the list shows. */
  view: ListView;
  /** The cursor of the next page of the view, or null on the last page. */
  next: string | null;
  /** The runs of the other part that match the filter text. */
  otherMatches: number;
  /** True while the list of a newly chosen part has not arrived. */
  listing: boolean;
  /** Moves when a run's status changes or a run goes, whether or not the list holds the run. */
  statusStamp: number;
  /** The flow of the watched run. */
  flow: FlowView | null;
  /** The latest log per step, and per command for the checks step, of the watched run; the newest entry is last. */
  logs: LiveLog[];
  /** The last events message of the watched run. */
  events: LiveEvents | null;
  /** True while the server holds new containers for a restart. */
  paused: boolean;
}

interface LiveStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => LiveSnapshot;
  setRuns: (next: RunSummary[] | ((current: RunSummary[]) => RunSummary[])) => void;
  /** Sets the part and the filter text the list shows; a new part clears the rows until its page arrives. */
  showList: (part: Part, q: string) => void;
  /** Stores a page of the view it was asked for; an answer for an older view is dropped. */
  setPage: (page: RunsPage, view: ListView, append: boolean) => void;
  watchRun: (key: string | null) => void;
  /** Connects the socket events to the store and returns the cleanup. */
  attach: () => () => void;
}

function createStore(): LiveStore {
  let snapshot: LiveSnapshot = {
    runs: [],
    loaded: false,
    connected: false,
    counts: { active: 0, done: 0, all: 0 },
    view: { part: 'active', q: '' },
    next: null,
    otherMatches: 0,
    listing: false,
    statusStamp: 0,
    flow: null,
    logs: [],
    events: null,
    paused: false,
  };
  let watched: string | null = null;
  const statuses = new Map<string, string>();
  const remember = (rows: RunSummary[]): void => rows.forEach((run) => statuses.set(run.key, run.status));
  const listeners = new Set<() => void>();
  const update = (patch: Partial<LiveSnapshot>): void => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    setRuns: (next) => update({ runs: typeof next === 'function' ? next(snapshot.runs) : next, loaded: true }),
    showList(part, q) {
      const { view } = snapshot;
      if (part === view.part) {
        if (q !== view.q) {
          update({ view: { part, q } });
        }
        return;
      }
      update({ view: { part, q }, runs: [], next: null, listing: true });
    },
    setPage(page, view, append) {
      if (view.part !== snapshot.view.part || view.q !== snapshot.view.q) {
        return;
      }
      remember(page.runs);
      update({
        runs: append ? [...snapshot.runs, ...page.runs] : page.runs,
        counts: page.counts,
        next: page.next,
        otherMatches: page.otherMatches,
        loaded: true,
        listing: false,
      });
    },
    watchRun(key) {
      if (key === watched) {
        return;
      }
      watched = key;
      if (key !== null) {
        liveSocket().emit('watch', key);
      }
      update({ flow: null, logs: [], events: null });
    },
    attach() {
      const socket = liveSocket();
      const onConnect = (): void => {
        update({ connected: true });
        if (watched !== null) {
          socket.emit('watch', watched);
        }
      };
      const onDisconnect = (): void => update({ connected: false });
      const onRuns = (page: RunsPage): void => {
        remember(page.runs);
        if (snapshot.view.part === 'active' && snapshot.view.q === '') {
          update({ counts: page.counts, runs: page.runs, loaded: true });
        } else {
          update({ counts: page.counts });
        }
      };
      const onRun = (change: RunChange): void => {
        const moved =
          change.removed.some((key) => statuses.delete(key)) ||
          change.rows.some((run) => statuses.get(run.key) !== run.status);
        remember(change.rows);
        update({
          statusStamp: snapshot.statusStamp + (moved ? 1 : 0),
          counts: change.counts,
          runs: applyRunChange({ runs: snapshot.runs, ...snapshot.view, next: snapshot.next }, change),
        });
      };
      const onFlow = (body: FlowView): void => {
        if (body.key === watched) {
          update({ flow: body });
        }
      };
      const onLog = (entry: LiveLog): void => {
        if (entry.key === watched) {
          update({
            logs: [
              ...snapshot.logs.filter((item) => item.step !== entry.step || item.command !== entry.command),
              entry,
            ],
          });
        }
      };
      const onEvents = (entry: LiveEvents): void => {
        if (entry.key === watched) {
          update({ events: entry });
        }
      };
      const onServer = (state: ServerState): void => update({ paused: state.paused });
      socket.on('connect', onConnect);
      socket.on('disconnect', onDisconnect);
      socket.on('runs', onRuns);
      socket.on('run', onRun);
      socket.on('flow', onFlow);
      socket.on('log', onLog);
      socket.on('events', onEvents);
      socket.on('server', onServer);
      if (socket.connected) {
        update({ connected: true });
      }
      return () => {
        socket.off('connect', onConnect);
        socket.off('disconnect', onDisconnect);
        socket.off('runs', onRuns);
        socket.off('run', onRun);
        socket.off('flow', onFlow);
        socket.off('log', onLog);
        socket.off('events', onEvents);
        socket.off('server', onServer);
      };
    },
  };
}

const LiveContext = createContext<LiveStore | null>(null);

export function LiveBridgeProvider({ children }: { children: ReactNode }): ReactElement {
  const [store] = useState(createStore);
  useEffect(() => store.attach(), [store]);
  return createElement(LiveContext.Provider, { value: store }, children);
}

function useStore(): LiveStore {
  const store = useContext(LiveContext);
  if (!store) {
    throw new Error('useLiveBridge needs a LiveBridgeProvider');
  }
  return store;
}

/** Reads one part of the snapshot; the component re-renders only when that part changes. */
export function useLiveBridge<T>(select: (snapshot: LiveSnapshot) => T): T {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.getSnapshot()),
    () => select(store.getSnapshot()),
  );
}

export function useLiveActions(): Pick<LiveStore, 'setRuns' | 'showList' | 'setPage' | 'watchRun'> {
  const { setRuns, showList, setPage, watchRun } = useStore();
  return { setRuns, showList, setPage, watchRun };
}
