'use client';

import type { ReactElement } from 'react';
import Typography from '@mui/material/Typography';
import type { FlowDialogProps } from './flow-types';
import { SignInDialog } from './sign-in-dialog';
import { useSignIn } from './use-sign-in';

/** A device sign-in: it shows a code to type on the provider's page and polls until the person has done it. */
export function DeviceCodeFlow(props: FlowDialogProps): ReactElement {
  const { view, error } = useSignIn(props.card.id);
  return (
    <SignInDialog {...props} view={view} error={error}>
      {view?.code ? (
        <Typography
          variant="h5"
          component="p"
          aria-label="Sign-in code"
          sx={{ fontFamily: 'monospace', letterSpacing: 2 }}
        >
          {view.code}
        </Typography>
      ) : null}
    </SignInDialog>
  );
}
