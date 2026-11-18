'use client';

import { useCallback, useEffect, useState } from 'react';
import { getSession } from '../../../lib/endpoints';

const storageKey = (login: string): string => `swarmloop.conversation.${login}`;

/** The signed-in login, or null while it loads and '' when it cannot be read. */
function useLogin(): string | null {
  const [login, setLogin] = useState<string | null>(null);
  useEffect(() => {
    getSession().then(
      (me) => setLogin(me.user),
      () => setLogin(''),
    );
  }, []);
  return login;
}

/**
 * Whether the column is open, remembered per signed-in login in localStorage. The bottom sheet below 900 px is not
 * remembered: it starts closed and `reveal` opens it. `unseen` is true while the column is closed and `newest` changed
 * since it was last open.
 */
export function useColumnState(
  newest: string,
  narrow: boolean,
  needsPerson: boolean,
): { open: boolean; setOpen: (open: boolean) => void; reveal: () => void; unseen: boolean } {
  const login = useLogin();
  // Undefined until the remembered state is read; null when nothing is remembered.
  const [stored, setStored] = useState<boolean | null | undefined>(undefined);
  const [sheet, setSheet] = useState(false);
  // A run that needs the person when the page loads counts as unseen, so a collapsed rail shows the mark.
  const [seen, setSeen] = useState(needsPerson ? '' : newest);
  useEffect(() => {
    if (login !== null) {
      setStored(login && localStorage.getItem(storageKey(login)) === 'closed' ? false : null);
    }
  }, [login]);
  const open = narrow ? sheet : (stored ?? true);
  useEffect(() => {
    // Until the remembered state is read, `open` is only the default and shows nothing to the person.
    if (open && stored !== undefined) {
      setSeen(newest);
    }
  }, [open, newest, stored]);

  const setOpen = (value: boolean): void => {
    if (narrow) {
      setSheet(value);
      return;
    }
    setStored(value);
    if (login) {
      localStorage.setItem(storageKey(login), value ? 'open' : 'closed');
    }
  };
  const reveal = useCallback(() => setSheet(true), []);
  return { open, setOpen, reveal, unseen: !open && seen !== newest };
}
