import { createTheme, type Theme } from '@mui/material/styles';

const TOUCH_MIN = { minHeight: 40 };

/** Below md a touch target is at least 40 px tall. */
function touchRoot({ theme: t }: { theme: Theme }) {
  return { [t.breakpoints.down('md')]: TOUCH_MIN };
}

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
        '@keyframes swarmloop-fade': {
          from: { opacity: 0 },
          to: { opacity: 1 },
        },
        // The one link style. :where() has zero specificity, so a component that styles its own anchor keeps its look.
        ':where(a)': {
          color: 'var(--mui-palette-primary-main)',
          textDecoration: 'none',
          textUnderlineOffset: '0.2em',
          textDecorationThickness: '1px',
        },
        ':where(a):visited': { color: 'var(--mui-palette-primary-main)' },
        ':where(a):hover': { textDecoration: 'underline' },
        ':where(a):focus-visible': {
          outline: '2px solid var(--mui-palette-primary-main)',
          outlineOffset: '2px',
          borderRadius: '2px',
        },
        // Chart colors, checked for colour-blind separation and contrast against each mode's paper.
        '[data-light]': {
          '--swarmloop-skipped': '#8a847a',
          '--chart-done': '#2f8a57',
          '--chart-active': '#3a74b8',
          '--chart-failed': '#c2453a',
          '--chart-money': '#b5651d',
          '--chart-returns': '#6250d6',
          '--chart-grid': '#ebe5da',
          '--chart-axis': '#8a847a',
        },
        '[data-dark]': {
          '--swarmloop-skipped': '#c4bbae',
          '--chart-done': '#3a9e66',
          '--chart-active': '#5b95e0',
          '--chart-failed': '#e3685b',
          '--chart-money': '#bd7f37',
          '--chart-returns': '#9085e9',
          '--chart-grid': '#353028',
          '--chart-axis': '#8f877a',
        },
      },
    },
    MuiLink: { defaultProps: { underline: 'hover' } },
    MuiAccordionSummary: {
      styleOverrides: {
        expandIconWrapper: ({ theme: t }) => ({
          transition: t.transitions.create('transform', { duration: t.transitions.duration.shortest }),
          '&.Mui-expanded': { transform: 'rotate(90deg)' },
          '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
        }),
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: { root: ({ theme: t }) => ({ whiteSpace: 'nowrap', [t.breakpoints.down('md')]: TOUCH_MIN }) },
    },
    MuiIconButton: {
      styleOverrides: { root: ({ theme: t }) => ({ [t.breakpoints.down('md')]: { ...TOUCH_MIN, minWidth: 40 } }) },
    },
    MuiToggleButton: { styleOverrides: { root: touchRoot } },
    MuiTab: { styleOverrides: { root: touchRoot } },
    MuiListItemButton: { styleOverrides: { root: touchRoot } },
    MuiMenuItem: { styleOverrides: { root: touchRoot } },
    MuiPaper: { defaultProps: { elevation: 0 } },
    MuiAppBar: { defaultProps: { elevation: 0, color: 'inherit' } },
  },
});

export function statusColor(status: string): string {
  switch (status) {
    case 'running':
    case 'preparing':
      return 'info.main';
    case 'waiting':
      return 'warning.main';
    case 'failed':
    case 'blocked':
      return 'error.main';
    case 'returned':
      return 'var(--chart-returns)';
    case 'done':
      return 'primary.main';
    default:
      return 'var(--swarmloop-skipped, #8a847a)';
  }
}
