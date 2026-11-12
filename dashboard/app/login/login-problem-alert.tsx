'use client';

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { hostOf } from './hosts';
import { PROBLEM_TEXTS, problemFrom, type LoginProblem } from './login-problems';

/** The alert for the problem a login came back with, from the query of the page. */
export function LoginProblemAlert(): ReactElement | null {
  const [problem, setProblem] = useState<LoginProblem | null>(null);

  useEffect(() => {
    setProblem(problemFrom(window.location.search));
  }, []);

  if (problem === null) {
    return null;
  }
  const host = hostOf(problem.host);
  return (
    <Alert severity="error" sx={{ width: '100%' }}>
      {PROBLEM_TEXTS[problem.code](problem).map((line) => (
        <Typography key={line} variant="body2">
          {line}
        </Typography>
      ))}
      {problem.code === 'refused' ? (
        <Typography variant="body2">
          Signed in to {host.label} with another account?{' '}
          {host.signOutUrl ? <Link href={host.signOutUrl}>Sign out there</Link> : 'Sign out there'}, then try again.
        </Typography>
      ) : null}
    </Alert>
  );
}
