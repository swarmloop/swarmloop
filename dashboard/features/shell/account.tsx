'use client';

import type { ReactElement } from 'react';
import { useEffect, useId, useState } from 'react';
import type { MeView } from '@contract/api';
import { getSession } from '../../lib/endpoints';
import { AccountPanel } from './account-panel';
import type { AccountHost } from './account-trigger';
import { AccountTrigger } from './account-trigger';

interface AccountProps {
  hostOf: (provider: string) => AccountHost;
  needsAttention: boolean;
}

/** The signed-in person as a button; it opens the account panel. */
export function Account({ hostOf, needsAttention }: AccountProps): ReactElement {
  const [me, setMe] = useState<MeView | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const panelId = useId();

  useEffect(() => {
    getSession().then(setMe, () => setMe(null));
  }, []);

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
        sourceUrl={me?.sourceUrl ?? null}
        needsAttention={needsAttention}
      />
    </>
  );
}
