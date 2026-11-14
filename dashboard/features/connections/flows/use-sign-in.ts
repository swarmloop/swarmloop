import { useEffect, useState } from 'react';
import type { SignInView } from '@contract/connections';
import { getSignIn, startSignIn } from '../../../lib/endpoints';
import { messageOf } from './flow-types';

export const SIGN_IN_POLL_MS = 2000;

/** Starts the sign-in once and polls it until it is done or failed. */
export function useSignIn(id: string): {
  view: SignInView | null;
  error: string | null;
  setView: (view: SignInView) => void;
} {
  const [view, setView] = useState<SignInView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    startSignIn(id).then(
      (started) => live && setView(started),
      (cause: unknown) => live && setError(messageOf(cause, 'the sign-in could not start')),
    );
    return () => {
      live = false;
    };
  }, [id]);

  const session = view?.id;
  const running = view !== null && (view.state === 'waiting' || view.state === 'code');
  useEffect(() => {
    if (!session || !running) {
      return;
    }
    let live = true;
    const timer = setInterval(() => {
      getSignIn(id, session).then(
        (next) => live && setView(next),
        (cause: unknown) => live && setError(messageOf(cause, 'the sign-in could not be read')),
      );
    }, SIGN_IN_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [id, session, running]);

  return { view, error, setView };
}
