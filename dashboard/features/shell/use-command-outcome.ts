import { useCallback, useEffect, useState } from 'react';
import type { CommandView } from '@contract/command';
import { getCommand } from '../../lib/endpoints';
import { useOnReconnect } from './use-on-reconnect';
import { useCommandEnds } from './use-live-bridge';

/**
 * The command once it has ended, read from its own stored state; null while it runs or when no command is watched.
 * It reads when the id is set, when a command ends and after a reconnect; a failed read waits for the next of these.
 */
export function useCommandOutcome(commandId: string | null): CommandView | null {
  const ends = useCommandEnds();
  const [outcome, setOutcome] = useState<{ id: string; view: CommandView } | null>(null);
  const [reconnects, setReconnects] = useState(0);
  useOnReconnect(useCallback(() => setReconnects((count) => count + 1), []));

  useEffect(() => {
    if (commandId === null) {
      return;
    }
    let current = true;
    getCommand(commandId)
      .then((view) => {
        if (current && (view.state === 'succeeded' || view.state === 'failed')) {
          setOutcome({ id: commandId, view });
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [commandId, ends, reconnects]);

  return outcome !== null && outcome.id === commandId ? outcome.view : null;
}
