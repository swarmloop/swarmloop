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

const TIERS = ['main', 'subtask'] as const;
const ROLES = ['plan', 'implement', 'review'] as const;
type Tier = (typeof TIERS)[number];
type Role = (typeof ROLES)[number];

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
          {ROLES.map((role) => {
            const own = draft.agents?.[tier]?.[role]?.map(entryOf);
            const label = `${tier} ${role}`;
            return (
              <Box key={role} sx={{ mb: 2 }}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={own === undefined}
                      onChange={(_event, useDefault) =>
                        setList(tier, role, useDefault ? undefined : [...view.defaults.agents[tier][role]])
                      }
                      slotProps={{ input: { 'aria-label': `Use server default for ${label}` } }}
                    />
                  }
                  label={`${role}: use server default`}
                />
                {own === undefined ? (
                  <Typography variant="body2" color="text.secondary" aria-label={`Server default for ${label}`}>
                    {view.defaults.agents[tier][role].join(', ') || 'none'}
                  </Typography>
                ) : (
                  <AgentList
                    label={label}
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
