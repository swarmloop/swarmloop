'use client';

import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import Paper from '@mui/material/Paper';
import Switch from '@mui/material/Switch';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import type { SettingsBody, StoredAgents } from '@contract/api';
import type { SettingsView } from '@contract/settings';
import { AgentList } from './agent-list';

const TIERS = ['main', 'subtask'] as const;
const ROLES = ['plan', 'implement', 'review'] as const;
type Tier = (typeof TIERS)[number];
type Role = (typeof ROLES)[number];

/** The list is `runtime:model`; a model may hold a colon, a runtime does not. */
const entryOf = (agent: { runtime: string; model: string }): string => `${agent.runtime}:${agent.model}`;
function agentOf(entry: string): { runtime: string; model: string } {
  const at = entry.indexOf(':');
  return { runtime: entry.slice(0, at), model: entry.slice(at + 1) };
}

/** The role lists and the `SPLIT` choice of the person; a key left out is the server default. */
export function AgentsSection({
  view,
  draft,
  onChange,
}: {
  view: SettingsView;
  draft: SettingsBody;
  onChange: (draft: SettingsBody) => void;
}): ReactElement {
  const choices = view.runtimes.flatMap(({ runtime, models }) => models.map((model) => `${runtime}:${model}`));

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

  function setSplit(split: boolean | undefined): void {
    const { split: _old, ...rest } = draft;
    onChange(split === undefined ? rest : { ...rest, split });
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
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
                    choices={choices}
                    onChange={(list) => setList(tier, role, list)}
                  />
                )}
              </Box>
            );
          })}
        </Paper>
      ))}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="h6" component="h3" sx={{ mb: 1 }}>
          Runs
        </Typography>
        <FormControlLabel
          control={
            <Switch
              checked={draft.split === undefined}
              onChange={(_event, useDefault) => setSplit(useDefault ? undefined : view.defaults.split)}
              slotProps={{ input: { 'aria-label': 'Use server default for SPLIT' } }}
            />
          }
          label={`SPLIT: server default (${view.defaults.split ? 'auto' : 'off'})`}
        />
        {draft.split !== undefined ? (
          <ToggleButtonGroup
            exclusive
            size="small"
            aria-label="SPLIT"
            value={draft.split ? 'auto' : 'off'}
            onChange={(_event, value: 'auto' | 'off' | null) => value && setSplit(value === 'auto')}
          >
            <ToggleButton value="auto">auto</ToggleButton>
            <ToggleButton value="off">off</ToggleButton>
          </ToggleButtonGroup>
        ) : null}
      </Paper>
    </Box>
  );
}
