import type { ReactElement } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import type { RemoteListView } from '@contract/api';

/** What the remote list is doing: still loading, or why it could not be loaded, with a Retry. */
export function RemoteStatus({
  remote,
  error,
  onRetry,
}: {
  remote: RemoteListView | null;
  /** The message of a failed read; the list's own error is shown when there is none. */
  error: string | null;
  onRetry?: () => void;
}): ReactElement | null {
  const shown = error ?? remote?.error ?? null;
  if (shown !== null) {
    return (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={onRetry}>
            Retry
          </Button>
        }
      >
        Repositories could not be loaded: {shown}
      </Alert>
    );
  }
  return remote?.loading ? (
    <Typography variant="body2" color="text.secondary">
      Loading repositories…
    </Typography>
  ) : null;
}
