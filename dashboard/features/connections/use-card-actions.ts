'use client';

import { useState } from 'react';
import type { ConnectionCard } from '@contract/connections';
import { disconnectIntegration, testIntegration } from '../../lib/endpoints';
import { messageOf } from './flows/flow-types';

interface ActionResult {
  severity: 'success' | 'error';
  text: string;
}

/** Test and Disconnect of one card, with the answer of Test to show beside them. */
export function useCardActions(
  card: ConnectionCard,
  onChanged: () => void,
): { result: ActionResult | null; test: () => Promise<void>; remove: () => Promise<void> } {
  const [result, setResult] = useState<ActionResult | null>(null);

  async function run(action: () => Promise<unknown>, fallback: string): Promise<void> {
    setResult(null);
    try {
      await action();
    } catch (cause: unknown) {
      setResult({ severity: 'error', text: messageOf(cause, fallback) });
    }
  }

  const test = (): Promise<void> =>
    run(async () => {
      const tested = await testIntegration(card.id);
      setResult(
        tested.status === 'attention'
          ? { severity: 'error', text: tested.reason ?? 'the test failed' }
          : { severity: 'success', text: 'Test passed' },
      );
      onChanged();
    }, 'the test could not run');

  /** Rejects on failure: the confirm that asked for it shows the error. */
  const remove = async (): Promise<void> => {
    setResult(null);
    await disconnectIntegration(card.id);
    onChanged();
  };

  return { result, test, remove };
}
