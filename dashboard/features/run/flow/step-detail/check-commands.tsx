'use client';

import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { CheckCommandView, StepView } from '@contract/api';
import { CheckCommandLine } from './check-command-line';

/** The commands of one checks visit, a line each. The repositories are group headings only when the run has more than one. */
export function CheckCommands({
  runKey,
  commands,
  visit,
  now,
}: {
  runKey: string;
  commands: CheckCommandView[];
  visit: StepView['visits'][number] | undefined;
  now: number;
}): ReactElement | null {
  const repos = [...new Set(commands.map((command) => command.repo))];
  if (commands.length === 0) {
    return visit?.status === 'running' ? null : (
      <Typography color="text.secondary" sx={{ mt: 2 }}>
        This visit has no check commands.
      </Typography>
    );
  }
  return (
    <Box sx={{ mt: 2 }}>
      {repos.map((repo) => (
        <Box key={repo} component="ul" aria-label={repos.length > 1 ? repo : 'Check commands'} sx={{ m: 0, p: 0 }}>
          {repos.length > 1 ? (
            <Typography
              component="li"
              sx={{ listStyle: 'none', fontFamily: 'var(--font-mono)', fontSize: 12 }}
              color="text.secondary"
            >
              {repo}
            </Typography>
          ) : null}
          {commands
            .filter((command) => command.repo === repo)
            .map((command) => (
              <CheckCommandLine key={command.index} runKey={runKey} command={command} visit={visit} now={now} />
            ))}
        </Box>
      ))}
    </Box>
  );
}
