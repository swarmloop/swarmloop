'use client';

import type { ReactElement } from 'react';
import { CliCodeFlow } from './cli-code-flow';
import { DeviceCodeFlow } from './device-code-flow';
import type { FlowDialogProps } from './flow-types';
import { FormFlow } from './form-flow';
import { SecretFlow } from './secret-flow';

/** The one dialog of a flow's kind. A `redirect` flow opens a page, so it has no dialog. */
export function FlowDialog(props: FlowDialogProps): ReactElement | null {
  switch (props.flow.kind) {
    case 'secret':
      return <SecretFlow {...props} />;
    case 'form':
      return <FormFlow {...props} />;
    case 'cli-code':
      return <CliCodeFlow {...props} />;
    case 'device-code':
      return <DeviceCodeFlow {...props} />;
    case 'redirect':
      return null;
  }
}
