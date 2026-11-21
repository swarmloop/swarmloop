import useMediaQuery from '@mui/material/useMediaQuery';

/** True below the width where the desktop layout fits. */
export function usePhone(): boolean {
  return !useMediaQuery('(min-width:600px)', { noSsr: true });
}
