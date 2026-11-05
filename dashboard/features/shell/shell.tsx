'use client';

import type { ReactElement, ReactNode } from 'react';
import { createContext, useContext } from 'react';
import { LiveBridgeProvider } from './use-live-bridge';

const DialogContext = createContext<() => void>(() => undefined);

export function useNewRun(): () => void {
  return useContext(DialogContext);
}

export function Shell({ children, onNewRun }: { children: ReactNode; onNewRun: () => void }): ReactElement {
  return (
    <LiveBridgeProvider>
      <DialogContext.Provider value={onNewRun}>{children}</DialogContext.Provider>
    </LiveBridgeProvider>
  );
}
