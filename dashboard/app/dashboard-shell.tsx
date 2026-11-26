'use client';

import type { ReactElement } from 'react';
import type { Route } from 'next';
import { usePathname, useRouter } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Drawer from '@mui/material/Drawer';
import Toolbar from '@mui/material/Toolbar';
import type { RunSummary } from '@contract/api';
import { BacklogList } from '../features/backlogs';
import { usePhone } from '../lib/use-phone';
import { NewRunDialog } from '../features/new-run';
import { ReadinessStatus, useReadiness } from '../features/readiness';
import { RemoveRunDialog, RunColumn, useRuns } from '../features/runs';
import { Account, MainNav, PauseBanner, Shell, useNewRun } from '../features/shell';
import { DashboardHeader } from './dashboard-header';
import { hostOf } from './login/hosts';

const DrawerWidth = 280;

export function DashboardShell({ children }: { children: React.ReactNode }): ReactElement {
  const [open, setOpen] = useState(false);
  // The login page has no runs to list and no socket to open: nobody is logged in yet.
  if (usePathname() === '/login') {
    return <>{children}</>;
  }
  return (
    <Shell onNewRun={() => setOpen(true)}>
      <DashboardFrame open={open} setOpen={setOpen}>
        {children}
      </DashboardFrame>
    </Shell>
  );
}

function decodePart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function DashboardFrame({
  children,
  open,
  setOpen,
}: {
  children: React.ReactNode;
  open: boolean;
  setOpen: (open: boolean) => void;
}): ReactElement {
  const pathname = usePathname();
  const router = useRouter();
  const { runs, counts, otherMatches, next, listing, loadMore, loaded, now, error, retry, connected, removeRun } =
    useRuns();
  const openNewRun = useNewRun();
  const { blocker } = useReadiness();
  const [pendingRemove, setPendingRemove] = useState<{ run: RunSummary; search: string } | null>(null);
  const matched = pathname.match(/^\/runs\/([^/]+)/)?.[1] ?? '';
  const selected = decodePart(matched);

  const onBacklogs = /^\/backlogs(\/|$)/.test(pathname);
  const phone = usePhone();
  const [listOpen, setListOpen] = useState(false);
  // A link in the drawer (the main nav, the account menu) opens another page: the list must not cover it.
  useEffect(() => setListOpen(false), [pathname]);
  const backlogSelected = decodePart(pathname.match(/^\/backlogs\/([^/]+)/)?.[1] ?? '');

  async function confirmRemove(): Promise<void> {
    if (!pendingRemove) {
      return;
    }
    const { run, search } = pendingRemove;
    await removeRun(run.key);
    if (selected === run.key) {
      router.push(`/${search}` as Route);
    }
  }

  return (
    <>
      <DashboardHeader
        connected={connected}
        blocker={blocker}
        onNewRun={openNewRun}
        onMenu={() => setListOpen(true)}
        phone={phone}
        menuLabel={onBacklogs ? 'Open the list of backlogs' : 'Open the list of runs'}
      />
      <Drawer
        variant={phone ? 'temporary' : 'permanent'}
        open={phone ? listOpen : undefined}
        onClose={() => setListOpen(false)}
        sx={{
          width: DrawerWidth,
          flexShrink: 0,
          '& .MuiDrawer-paper': {
            width: DrawerWidth,
            boxSizing: 'border-box',
            bgcolor: 'background.paper',
            borderRight: 1,
            borderColor: 'divider',
            display: 'flex',
            flexDirection: 'column',
          },
        }}
      >
        <Toolbar />
        {phone ? (
          <Box sx={{ px: 2, py: 1, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
            <MainNav />
            <ReadinessStatus />
          </Box>
        ) : null}
        <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {onBacklogs ? (
            <BacklogList selected={backlogSelected} onPick={() => setListOpen(false)} />
          ) : (
            <Suspense fallback={null}>
              <RunColumn
                runs={runs}
                counts={counts}
                otherMatches={otherMatches}
                next={next}
                onLoadMore={loadMore}
                listing={listing}
                selected={selected}
                now={now}
                loaded={loaded}
                error={error}
                onRetry={retry}
                onOpen={(key, search) => {
                  setListOpen(false);
                  router.push(`/runs/${key}${search}` as Route);
                }}
                onRemove={(run, search) => setPendingRemove({ run, search })}
              />
            </Suspense>
          )}
        </Box>
        <Box sx={{ borderTop: 1, borderColor: 'divider' }}>
          <Account hostOf={hostOf} needsAttention={blocker !== null} />
        </Box>
      </Drawer>
      <Box component="main" sx={{ ml: phone ? 0 : `${DrawerWidth}px`, minHeight: '100vh', minWidth: 0 }}>
        <Toolbar />
        <PauseBanner />
        <Box sx={{ px: { xs: 2, md: 4 }, py: 3, maxWidth: 1180, minWidth: 0 }}>{children}</Box>
      </Box>
      <RemoveRunDialog
        run={pendingRemove?.run ?? null}
        onClose={() => setPendingRemove(null)}
        onConfirm={confirmRemove}
      />
      <NewRunDialog
        open={open}
        onClose={() => setOpen(false)}
        onCreated={(key) => {
          setOpen(false);
          router.push(`/runs/${key}` as Route);
        }}
      />
    </>
  );
}
