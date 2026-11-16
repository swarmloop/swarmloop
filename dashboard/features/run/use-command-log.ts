'use client';

import { useEffect, useState } from 'react';
import type { CheckCommandView } from '@contract/api';
import { getRunLog } from '../../lib/endpoints';

/** The full output of a command, read from its stored file when the row is open. Undefined while it loads, null when there is none. */
export function useCommandLog(runKey: string, command: CheckCommandView, open: boolean): string | null | undefined {
  const [text, setText] = useState<string | null | undefined>(undefined);
  const settled = command.status === 'passed' || command.status === 'failed' || command.status === 'interrupted';

  useEffect(() => {
    setText(undefined);
    if (!open || !settled) {
      return;
    }
    let stopped = false;
    getRunLog(runKey, 'checks', command.attempt, { command: command.index })
      .then((body) => !stopped && setText(body))
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [runKey, command.attempt, command.index, open, settled]);

  return text;
}
