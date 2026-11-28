'use client';

import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import Paper from '@mui/material/Paper';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import type { SettingsBody } from '@contract/api';
import { paidUseUnseenNote, paysPastLimit } from '@contract/paid-use';
import type { SettingsView } from '@contract/settings';

/** Whether the person's agents may use paid usage past their plan's limit, one switch per runtime. A runtime whose paid use cannot be seen is on and locked. */
export function PaidUseSetting({
  view,
  draft,
  onChange,
}: {
  view: SettingsView;
  draft: SettingsBody;
  onChange: (draft: SettingsBody) => void;
}): ReactElement {
  return (
    <Paper variant="outlined" sx={{ p: 2, mt: 3 }}>
      <Typography variant="h6" component="h3" sx={{ mb: 1 }}>
        Paid usage
      </Typography>
      {view.paidUse.map((row) => (
        <Box key={row.runtime} sx={{ mb: 1 }}>
          <FormControlLabel
            control={
              <Switch
                checked={paysPastLimit(row.readsPaidUse, draft.paysPastLimit)}
                disabled={!row.readsPaidUse}
                onChange={
                  row.readsPaidUse ? (_event, allowed) => onChange({ ...draft, paysPastLimit: allowed }) : undefined
                }
                slotProps={{
                  input: { 'aria-label': `Let my agents use paid usage past my plan's limit on ${row.label}` },
                }}
              />
            }
            label={`Let my agents use paid usage past my plan's limit on ${row.label}`}
          />
          {row.readsPaidUse ? null : (
            <Typography variant="body2" color="text.secondary">
              {paidUseUnseenNote(row.label)}
            </Typography>
          )}
        </Box>
      ))}
    </Paper>
  );
}
