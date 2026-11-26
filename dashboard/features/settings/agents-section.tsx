'use client';

import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import Paper from '@mui/material/Paper';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import type { SettingsBody, StoredAgents } from '@contract/api';
import type { SettingsView } from '@contract/settings';
import { agentOf, entryOf } from './agent-entry';
import { AgentList } from './agent-list';

const ROLES_OF = {
  main: ['plan', 'implement', 'review'],
  subtask: ['plan', 'implement', 'review'],
  backlog: ['plan'],
} as const;
const TIERS = Object.keys(ROLES_OF) as (keyof typeof ROLES_OF)[];
type Tier = keyof typeof ROLES_OF;
type Role = 'plan' | 'implement' | 'review';

/** The role lists of the person; a key left out is the server default. */
export function AgentsSection({
  view,
  draft,
  onChange,
}: {
  view: SettingsView;
  draft: SettingsBody;
  onChange: (draft: SettingsBody) => void;
}): ReactElement {
  function setList(tier: Tier, role: Role, list: string[] | undefined): void {
    const roles = { ...draft.agents?.[tier] };
    if (list === undefined || list.length === 0) {
      delete roles[role];
    } else {
      roles[role] = list.map(agentOf);
    }
    const agents: StoredAgents = { ...draft.agents, [tier]: roles };
    onChange({ ...draft, agents });
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Typography variant="body2" color="text.secondary">
        By default, subtask agents work at medium effort, and plan, implement and review work at high. When a run splits
        into subtasks, the epic effort setting lifts only the parent&apos;s planning.
      </Typography>
      {view.modelsLimited ? (
        <Typography variant="body2" color="text.secondary">
          The model list is limited to the server&apos;s models for now.
        </Typography>
      ) : null}
      {TIERS.map((tier) => (
        <Paper key={tier} variant="outlined" sx={{ p: 2 }}>
          <Typography variant="h6" component="h3" sx={{ textTransform: 'capitalize', mb: 1 }}>
            {tier}
          </Typography>
          {ROLES_OF[tier].map((role) => {
            const fallback: string[] = view.defaults.agents[tier][role as 'plan'];
            const own = draft.agents?.[tier]?.[role]?.map(entryOf);
            const label = `${tier} ${role}`;
            return (
              <Box key={role} sx={{ mb: 2 }}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={own === undefined}
                      onChange={(_event, useDefault) => setList(tier, role, useDefault ? undefined : [...fallback])}
                      slotProps={{ input: { 'aria-label': `Use server default for ${label}` } }}
                    />
                  }
                  label={`${role}: use server default`}
                />
                {own === undefined ? (
                  <Typography variant="body2" color="text.secondary" aria-label={`Server default for ${label}`}>
                    {fallback.join(', ') || 'none'}
                  </Typography>
                ) : (
                  <AgentList
                    label={label}
                    role={role}
                    base={view.defaults.levels[tier][role as 'plan']}
                    value={own}
                    runtimes={view.runtimes}
                    onChange={(list) => setList(tier, role, list)}
                  />
                )}
              </Box>
            );
          })}
        </Paper>
      ))}
    </Box>
  );
}
