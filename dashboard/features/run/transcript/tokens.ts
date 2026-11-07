import useMediaQuery from '@mui/material/useMediaQuery';

/** The one home of the numbers of the transcript: the cards and the feed read them from here. */

/** The widths of the window where the bubble width changes. */
const WIDE = 1200;
const MEDIUM = 900;
const NARROW = 600;

const px = (value: number): string => `${value}px`;

/** The bubble width: fixed per breakpoint, never by content. Every bubble in a lane has the same one. */
export const BUBBLE_WIDTH = { wide: px(680), medium: '72%', narrow: '86%', phone: '100%' } as const;

/** The 4px scale: 12 between actors, 4 inside a group, 24 above a divider, 16 inside a bubble, 8 between its parts. */
export const SPACE = { actor: px(12), group: px(4), divider: px(24), pad: px(16), part: px(8) } as const;

export const RADIUS = { bubble: px(14), tail: px(6), detail: px(8), pill: px(999) } as const;

export const SIZE = {
  stripe: px(3),
  avatar: px(24),
  avatarIcon: px(16),
  progress: px(2),
  topBar: 48,
  feed: 520,
  skeleton: px(72),
} as const;

/** How much of the error color tints a problem bubble, and of the text color its soft shadow. */
export const TINT = { problem: '8%', shadow: '8%' } as const;

/** The monospace block of a bubble: command output, a document, the tool list. */
export const DETAIL = { fontSize: 13, lineHeight: 1.5, maxHeight: 360 } as const;

/** Milliseconds of a fade or a height change. */
export const MOTION_MS = 150;

/** The theme palette key of each kind of bubble, for its stripe. */
export const ACCENT = {
  input: 'info.main',
  agent: 'primary.main',
  activity: 'text.secondary',
  command: 'text.secondary',
  artifact: 'success.main',
  success: 'success.main',
  warning: 'warning.main',
  problem: 'error.main',
} as const;

export type Accent = keyof typeof ACCENT;

/** The width of a bubble at this window. It reads `matchMedia`, so a test sets a window with it. */
export function useBubbleWidth(): string {
  const wide = useMediaQuery(`(min-width:${WIDE}px)`, { noSsr: true });
  const medium = useMediaQuery(`(min-width:${MEDIUM}px)`, { noSsr: true });
  const narrow = useMediaQuery(`(min-width:${NARROW}px)`, { noSsr: true });
  if (wide) {
    return BUBBLE_WIDTH.wide;
  }
  if (medium) {
    return BUBBLE_WIDTH.medium;
  }
  return narrow ? BUBBLE_WIDTH.narrow : BUBBLE_WIDTH.phone;
}

/** True when the reader asks for no motion. */
function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)', { noSsr: true });
}

/** The duration of a transition: none under reduced motion. */
export function useMotionMs(): number {
  return useReducedMotion() ? 0 : MOTION_MS;
}
