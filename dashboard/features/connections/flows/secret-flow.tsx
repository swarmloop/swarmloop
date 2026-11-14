'use client';

import type { ReactElement } from 'react';
import { FieldsDialog } from './fields-dialog';
import type { FlowDialogProps } from './flow-types';

/** Paste a secret: it is checked before it is stored and never shown again. */
export function SecretFlow(props: FlowDialogProps): ReactElement {
  return <FieldsDialog {...props} hint="It is checked first, stored encrypted and never shown again." />;
}
