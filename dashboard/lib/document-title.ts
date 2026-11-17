'use client';

import { useEffect } from 'react';

const APP_TITLE = 'swarmloop';

/** Sets the browser tab to `<title> · swarmloop` while the component is mounted, and back to `swarmloop` after. */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (title === null) {
      return undefined;
    }
    document.title = `${title} · ${APP_TITLE}`;
    return () => {
      document.title = APP_TITLE;
    };
  }, [title]);
}
