import type { SxProps, Theme } from '@mui/material/styles';

/** The look of a row button: a left accent bar and a raised background when selected, a raised background on hover. */
export function rowButtonSx(selected: boolean): SxProps<Theme> {
  return {
    position: 'relative',
    borderRadius: 1,
    '&:hover': { bgcolor: 'action.hover' },
    '&.Mui-selected, &.Mui-selected:hover': { bgcolor: 'action.selected' },
    '&::before': selected
      ? {
          content: '""',
          position: 'absolute',
          left: 0,
          top: 4,
          bottom: 4,
          width: 3,
          borderRadius: 2,
          bgcolor: 'primary.main',
        }
      : undefined,
  };
}
