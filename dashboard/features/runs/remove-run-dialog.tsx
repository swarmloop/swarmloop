'use client';

import type { ReactElement } from 'react';
import type { RunSummary } from '@contract/api';
import { ConfirmDialog } from '../shell';

export function RemoveRunDialog({
  run,
  onClose,
  onConfirm,
}: {
  run: RunSummary | null;
  onClose: () => void;
  onConfirm: () => Promise<unknown>;
}): ReactElement {
  return (
    <ConfirmDialog
      open={run !== null}
      title={`Remove run ${run?.title ?? ''}?`}
      body="Its saved rows and files are deleted. This cannot be undone."
      verb="Remove run"
      tone="danger"
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
