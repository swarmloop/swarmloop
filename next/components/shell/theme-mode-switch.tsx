'use client';

import DarkMode from '@mui/icons-material/DarkMode';
import LightMode from '@mui/icons-material/LightMode';
import SettingsBrightness from '@mui/icons-material/SettingsBrightness';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { useColorScheme } from '@mui/material/styles';

export function ThemeModeSwitch() {
  const { mode, setMode } = useColorScheme();
  if (!mode) {
    return null;
  }
  return (
    <ToggleButtonGroup
      exclusive
      size="small"
      value={mode}
      aria-label="theme"
      onChange={(_event, value: 'light' | 'dark' | 'system' | null) => {
        if (value) {
          setMode(value);
        }
      }}
      sx={{ mr: 2 }}
    >
      <ToggleButton value="light" aria-label="light">
        <LightMode fontSize="small" />
      </ToggleButton>
      <ToggleButton value="system" aria-label="system">
        <SettingsBrightness fontSize="small" />
      </ToggleButton>
      <ToggleButton value="dark" aria-label="dark">
        <DarkMode fontSize="small" />
      </ToggleButton>
    </ToggleButtonGroup>
  );
}
