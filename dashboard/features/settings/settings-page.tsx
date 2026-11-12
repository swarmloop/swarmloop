'use client';

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import type { SettingsBody } from '@contract/api';
import type { SettingsView } from '@contract/settings';
import { ConnectionsPage } from '../connections';
import { ThemeModeSwitch } from '../shell';
import { getSettings, saveSettings } from '../../lib/endpoints';
import { AgentsSection } from './agents-section';

const SECTIONS = ['Agents', 'Connections', 'Appearance', 'Server'] as const;
type Section = (typeof SECTIONS)[number];

const reason = (cause: unknown, fallback: string): string => (cause instanceof Error ? cause.message : fallback);

/** Sections in a left list: the person's agents, Connections, Appearance and the env-only Server settings. */
export function SettingsPage(): ReactElement {
  const [section, setSection] = useState<Section>('Agents');
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<SettingsBody>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getSettings().then(
      (loaded) => {
        setView(loaded);
        setDraft(loaded.settings);
      },
      (cause: unknown) => setError(reason(cause, 'settings could not be read')),
    );
  }, []);

  function edit(next: SettingsBody): void {
    setDraft(next);
    setSaved(false);
  }

  async function save(): Promise<void> {
    setError(null);
    setSaved(false);
    try {
      const next = await saveSettings(draft);
      setView(next);
      setDraft(next.settings);
      setSaved(true);
    } catch (cause: unknown) {
      setError(reason(cause, 'settings could not be saved'));
    }
  }

  return (
    <Box>
      <Typography variant="h4" component="h1" sx={{ mb: 2 }}>
        Settings
      </Typography>
      <Box sx={{ display: 'flex', gap: 4, alignItems: 'flex-start' }}>
        <List component="nav" aria-label="settings sections" sx={{ width: 200, flexShrink: 0 }}>
          {SECTIONS.map((name) => (
            <ListItemButton key={name} selected={name === section} onClick={() => setSection(name)}>
              <ListItemText primary={name} />
            </ListItemButton>
          ))}
        </List>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {section === 'Connections' ? <ConnectionsPage /> : null}
          {section === 'Appearance' ? <ThemeModeSwitch /> : null}
          {section === 'Server' && view ? (
            <Box
              component="dl"
              sx={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: 1, columnGap: 3, m: 0 }}
            >
              {view.server.map(({ name, value }) => (
                <Box key={name} sx={{ display: 'contents' }}>
                  <Typography component="dt" variant="body2" sx={{ fontFamily: 'monospace' }}>
                    {name}
                  </Typography>
                  <Typography component="dd" variant="body2" color="text.secondary" sx={{ m: 0 }}>
                    {value || '—'}
                  </Typography>
                </Box>
              ))}
            </Box>
          ) : null}
          {section === 'Agents' && view ? (
            <>
              <AgentsSection view={view} draft={draft} onChange={edit} />
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 3 }}>
                <Button variant="contained" onClick={() => void save()}>
                  Save
                </Button>
                {saved ? (
                  <Typography role="status" variant="body2" color="text.secondary">
                    Saved
                  </Typography>
                ) : null}
              </Box>
            </>
          ) : null}
          {error ? (
            <Alert severity="error" sx={{ mt: 2 }}>
              {error}
            </Alert>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}
