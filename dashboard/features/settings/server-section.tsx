'use client';

import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { ServerSetting } from '@contract/settings';
import { usePhone } from '../../lib/use-phone';

/** Consecutive settings of one group, as the server lists them in the order of defaults.env. */
function groupsOf(settings: ServerSetting[]): { name: string; settings: ServerSetting[] }[] {
  const groups: { name: string; settings: ServerSetting[] }[] = [];
  for (const setting of settings) {
    const last = groups.at(-1);
    if (last && last.name === setting.group) last.settings.push(setting);
    else groups.push({ name: setting.group, settings: [setting] });
  }
  return groups;
}

/** The env-only settings of the server, read only, a heading per group of defaults.env. */
export function ServerSection({ settings }: { settings: ServerSetting[] }): ReactElement {
  const phone = usePhone();
  const wrap = phone ? { overflowWrap: 'anywhere' } : {};
  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Read only. Each value comes from .env, the environment or defaults.env. To change one, edit its line in .env and
        run docker compose up -d.
      </Typography>
      {groupsOf(settings).map((group, index) => (
        <Box key={`${index}:${group.name}`} component="section" sx={{ mb: 3 }}>
          {group.name ? (
            <Typography variant="subtitle1" component="h2" sx={{ mb: 1 }}>
              {group.name}
            </Typography>
          ) : null}
          <Box
            component="dl"
            sx={{
              display: 'grid',
              gridTemplateColumns: phone ? 'minmax(0, 1fr)' : 'max-content 1fr',
              gap: 1,
              columnGap: 3,
              m: 0,
            }}
          >
            {group.settings.map(({ name, value, source, description }) => (
              <Box key={name} sx={{ display: 'contents' }}>
                <Typography component="dt" variant="body2" sx={{ fontFamily: 'monospace', ...wrap }}>
                  {name}
                </Typography>
                <Typography component="dd" variant="body2" color="text.secondary" sx={{ m: 0, ...wrap }}>
                  {value || '—'}
                  <Typography component="span" variant="caption" sx={{ display: 'block' }}>
                    {source}
                  </Typography>
                  {description ? (
                    <Typography component="span" variant="caption" sx={{ display: 'block' }}>
                      {description}
                    </Typography>
                  ) : null}
                </Typography>
              </Box>
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
