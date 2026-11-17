'use client';

import type { ReactElement } from 'react';
import ButtonBase from '@mui/material/ButtonBase';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useColorScheme } from '@mui/material/styles';
import ContrastIcon from '@mui/icons-material/Contrast';
import DarkModeOutlined from '@mui/icons-material/DarkModeOutlined';
import LightModeOutlined from '@mui/icons-material/LightModeOutlined';

type Mode = 'light' | 'system' | 'dark';

const PARTS: { value: Mode; word: string; Icon: typeof ContrastIcon }[] = [
  { value: 'light', word: 'Light', Icon: LightModeOutlined },
  { value: 'system', word: 'System', Icon: ContrastIcon },
  { value: 'dark', word: 'Dark', Icon: DarkModeOutlined },
];

/** The Theme row of the account menu: a label and a three-part control that stores the choice like the settings switch. */
export function AccountTheme(): ReactElement | null {
  const { mode, setMode } = useColorScheme();
  if (!mode) {
    return null;
  }
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 36, px: 2 }}>
      <Typography variant="body2">Theme</Typography>
      <Box
        role="group"
        aria-label="Theme"
        sx={{ display: 'flex', gap: 0.25, p: 0.25, borderRadius: 1.5, bgcolor: 'action.hover' }}
      >
        {PARTS.map(({ value, word, Icon }) => {
          const chosen = mode === value;
          return (
            <Tooltip key={value} title={word}>
              <ButtonBase
                role="menuitemradio"
                aria-checked={chosen}
                aria-label={word}
                tabIndex={-1}
                onClick={() => setMode(value)}
                sx={{
                  width: 28,
                  height: 24,
                  borderRadius: 1,
                  bgcolor: chosen ? 'primary.main' : 'transparent',
                  color: chosen ? 'primary.contrastText' : 'text.secondary',
                }}
              >
                <Icon sx={{ fontSize: 16 }} />
              </ButtonBase>
            </Tooltip>
          );
        })}
      </Box>
    </Box>
  );
}
