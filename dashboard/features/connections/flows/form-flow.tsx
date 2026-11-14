'use client';

import type { ReactElement } from 'react';
import { FieldsDialog } from './fields-dialog';
import type { FlowDialogProps } from './flow-types';

/** A form of named fields, such as the site, the email and the token. */
export function FormFlow(props: FlowDialogProps): ReactElement {
  return <FieldsDialog {...props} hint="Fill in every field. The connection is tested before it is stored." />;
}
