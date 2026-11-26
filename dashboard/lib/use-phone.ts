import useMediaQuery from '@mui/material/useMediaQuery';

/** The width below which the dashboard uses its phone layout. */
export const PHONE_BELOW_PX = 900;

/** True below `PHONE_BELOW_PX`; false when the window cannot be measured. */
export function usePhone(): boolean {
  return useMediaQuery(`(max-width:${PHONE_BELOW_PX - 1}px)`, { noSsr: true });
}

/** True below 600 px, where a dialog fills the screen. Used only for a Dialog's `fullScreen`. */
export function useFullScreenDialog(): boolean {
  return useMediaQuery('(max-width:599px)', { noSsr: true });
}
