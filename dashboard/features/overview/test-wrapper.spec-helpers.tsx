import type { ReactElement, ReactNode } from 'react';
import { LiveBridgeProvider } from '../shell';
import { QueryWrapper } from '../../test/query-wrapper';

/** A fresh query cache and the live bridge, for the parts of the Overview. */
export function PartsWrapper({ children }: { children: ReactNode }): ReactElement {
  return (
    <QueryWrapper>
      <LiveBridgeProvider>{children}</LiveBridgeProvider>
    </QueryWrapper>
  );
}
