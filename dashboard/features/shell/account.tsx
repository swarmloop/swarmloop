'use client';

import type { ReactElement } from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { MeView } from '@contract/api';
import { getSession } from '../../lib/endpoints';
import { AccountPanel } from './account-panel';
import type { AccountHost } from './account-trigger';
import { AccountTrigger } from './account-trigger';
import { useLiveBridge } from './use-live-bridge';
import { useOnReconnect } from './use-on-reconnect';

interface AccountProps {
  hostOf: (provider: string) => AccountHost;
  needsAttention: boolean;
}

/**
 * The signed-in person as a button; it opens the account panel. The last person known stays while a read fails; the
 * session is read again on a reconnect and, after a failed read, on the next live connect.
 */
export function Account({ hostOf, needsAttention }: AccountProps): ReactElement {
  const [me, setMe] = useState<MeView | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const panelId = useId();
  const connects = useLiveBridge((snapshot) => snapshot.connects);
  const reading = useRef(false);
  const failed = useRef(false);

  const read = useCallback(() => {
    if (reading.current) {
      return;
    }
    reading.current = true;
    getSession()
      .then(
        (next) => {
          failed.current = false;
          setMe(next);
        },
        () => {
          failed.current = true;
        },
      )
      .finally(() => {
        reading.current = false;
      });
  }, []);

  useEffect(read, [read]);
  useOnReconnect(read);
  // A reconnect reads through useOnReconnect; the page's first connect reads only when the first read failed.
  useEffect(() => {
    if (connects > 0 && failed.current) {
      read();
    }
  }, [connects, read]);

  const login = me?.user ?? '';
  const host = me?.provider ? hostOf(me.provider) : null;
  return (
    <>
      <AccountTrigger
        login={login}
        avatarUrl={me?.avatarUrl}
        host={host}
        open={anchor !== null}
        panelId={panelId}
        onOpen={setAnchor}
      />
      <AccountPanel
        id={panelId}
        anchor={anchor}
        onClose={() => setAnchor(null)}
        login={login}
        avatarUrl={me?.avatarUrl}
        host={host}
        version={me?.version ?? 'dev'}
        revision={me?.revision}
        sourceUrl={me?.sourceUrl ?? null}
        needsAttention={needsAttention}
      />
    </>
  );
}
