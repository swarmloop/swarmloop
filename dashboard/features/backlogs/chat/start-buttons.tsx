'use client';

import { type ReactElement, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import type { BacklogView } from '@contract/backlog';
import { runBacklog, runBacklogTaskNow, runMilestone } from '../../../lib/backlog-endpoints';
import type { LiveOffer } from './chat-rows';

/**
 * The starts only the owner takes, as buttons: Run milestone for an offered milestone (and Run backlog for the first
 * proposed one), and Run <task> for an offered task. A click is the owner's own start through the same endpoint the
 * backlog panel uses.
 */
export function StartButtons({
  view,
  offers,
  onView,
}: {
  view: BacklogView;
  offers: LiveOffer[];
  onView: (view: BacklogView) => void;
}): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = (run: () => Promise<BacklogView>): void => {
    setBusy(true);
    setError(null);
    run()
      .then(onView)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'The action was refused'))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
        {offers.map((offer) =>
          offer.kind === 'task' ? (
            <Button
              key={`task-${offer.slug}`}
              size="small"
              variant="contained"
              disabled={busy}
              onClick={() => act(() => runBacklogTaskNow(view.name, offer.slug))}
            >
              {`Run ${offer.title}`}
            </Button>
          ) : (
            [
              <Button
                key={`milestone-${offer.number}`}
                size="small"
                variant="contained"
                disabled={busy}
                onClick={() => act(() => runMilestone(view.name, offer.number))}
              >
                Run milestone
              </Button>,
              offer.first ? (
                <Button
                  key="backlog"
                  size="small"
                  variant="outlined"
                  disabled={busy}
                  onClick={() => act(() => runBacklog(view.name))}
                >
                  Run backlog
                </Button>
              ) : null,
            ]
          ),
        )}
      </Box>
      {error ? (
        <Typography color="error" variant="body2" role="alert">
          {error}
        </Typography>
      ) : null}
    </>
  );
}
