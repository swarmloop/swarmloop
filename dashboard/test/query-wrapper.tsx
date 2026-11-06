import { type ReactElement, type ReactNode, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/** A fresh query cache for each render. A failed query is not tried again, so a test sees its error at once. */
export function QueryWrapper({ children }: { children: ReactNode }): ReactElement {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
