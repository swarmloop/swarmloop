'use client';

import { createTheme } from '@mui/material/styles';

export const theme = createTheme({
  cssVariables: {
    colorSchemeSelector: 'data',
  },
  colorSchemes: {
    light: {
      palette: {
        primary: { main: '#1f6b4a', contrastText: '#f7f4ee' },
        secondary: { main: '#8a5a2a' },
        background: { default: '#f3f0e8', paper: '#faf8f4' },
        text: { primary: '#1c1915', secondary: '#5e584e' },
        divider: '#e3dcd0',
        error: { main: '#9c3b2e' },
        warning: { main: '#a15c12' },
        success: { main: '#1f6b4a' },
        info: { main: '#2f5d73' },
      },
    },
    dark: {
      palette: {
        primary: { main: '#6fbf96', contrastText: '#1c1915' },
        secondary: { main: '#d7a36a' },
        background: { default: '#1c1915', paper: '#26221c' },
        text: { primary: '#f7f4ee', secondary: '#c4bbae' },
        divider: '#3d362c',
        error: { main: '#e39a90' },
        warning: { main: '#e8a15a' },
        success: { main: '#6fbf96' },
        info: { main: '#86b7c9' },
      },
    },
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: 'var(--font-sans), "Segoe UI", sans-serif',
    h5: { fontWeight: 560, letterSpacing: '-0.03em' },
    button: { textTransform: 'none', fontWeight: 560 },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        '@keyframes swarmloop-pulse': {
          '0%, 100%': { opacity: 1 },
          '50%': { opacity: 0.35 },
        },
        '[data-light]': { '--swarmloop-skipped': '#8a847a' },
        '[data-dark]': { '--swarmloop-skipped': '#c4bbae' },
      },
    },
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiPaper: { defaultProps: { elevation: 0 } },
    MuiAppBar: { defaultProps: { elevation: 0, color: 'inherit' } },
  },
});

export function statusColor(status: string): string {
  switch (status) {
    case 'running':
      return 'info.main';
    case 'waiting':
      return 'warning.main';
    case 'failed':
    case 'blocked':
      return 'error.main';
    case 'done':
      return 'primary.main';
    default:
      return 'var(--swarmloop-skipped, #8a847a)';
  }
}
