'use client';

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'swarmloop.conversation.wide';

/** Whether the conversation takes the main content's width, kept per browser in localStorage and read after mount. */
export function useWideConversation(): [boolean, (wide: boolean) => void] {
  const [wide, setWideState] = useState(false);
  useEffect(() => {
    setWideState(localStorage.getItem(STORAGE_KEY) === 'true');
  }, []);
  const setWide = useCallback((value: boolean) => {
    setWideState(value);
    if (value) {
      localStorage.setItem(STORAGE_KEY, 'true');
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);
  return [wide, setWide];
}
