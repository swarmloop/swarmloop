'use client';

import type { ReactElement, ReactNode } from 'react';
import { createContext, createElement, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { liveSocket } from '../../lib/live';
import type { FlowView, RunsView, RunSummary } from '@contract/api';
import type { LiveEvents, LiveLog } from '@contract/live';

interface LiveSnapshot {
  runs: RunSummary[];
  connected: boolean;
  /** The flow of the watched run. */
  flow: FlowView | null;
  /** The latest log per step of the watched run; the newest entry is last. */
  logs: LiveLog[];
  /** The last events message of the watched run. */
  events: LiveEvents | null;
}

interface LiveStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => LiveSnapshot;
  setRuns: (next: RunSummary[] | ((current: RunSummary[]) => RunSummary[])) => void;
  watchRun: (key: string | null) => void;
  /** Connects the socket events to the store and returns the cleanup. */
  attach: () => () => void;
}

function createStore(): LiveStore {
  let snapshot: LiveSnapshot = { runs: [], connected: false, flow: null, logs: [], events: null };
  let watched: string | null = null;
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
    setRuns: (next) => update({ runs: typeof next === 'function' ? next(snapshot.runs) : next }),
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
      const onRuns = (body: RunsView): void => update({ runs: body.runs });
      const onFlow = (body: FlowView): void => {
        if (body.key === watched) {
          update({ flow: body });
        }
      };
      const onLog = (entry: LiveLog): void => {
        if (entry.key === watched) {
          update({ logs: [...snapshot.logs.filter((item) => item.step !== entry.step), entry] });
        }
      };
      const onEvents = (entry: LiveEvents): void => {
        if (entry.key === watched) {
          update({ events: entry });
        }
      };
      socket.on('connect', onConnect);
      socket.on('disconnect', onDisconnect);
      socket.on('runs', onRuns);
      socket.on('flow', onFlow);
      socket.on('log', onLog);
      socket.on('events', onEvents);
      if (socket.connected) {
        update({ connected: true });
      }
      return () => {
        socket.off('connect', onConnect);
        socket.off('disconnect', onDisconnect);
        socket.off('runs', onRuns);
        socket.off('flow', onFlow);
        socket.off('log', onLog);
        socket.off('events', onEvents);
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

export function useLiveActions(): Pick<LiveStore, 'setRuns' | 'watchRun'> {
  const { setRuns, watchRun } = useStore();
  return { setRuns, watchRun };
}
