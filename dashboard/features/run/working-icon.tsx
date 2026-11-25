'use client';

import type { ReactElement } from 'react';
import { keyframes, styled } from '@mui/material/styles';
import SvgIcon, { type SvgIconProps } from '@mui/material/SvgIcon';

const turn = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`;

const Turning = styled(SvgIcon)`
  animation: ${turn} 1s linear infinite;
  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

/** The state icon of work in progress: a ring of three quarters that turns once a second, or a still dashed circle. */
export function WorkingIcon({ dashed = false, ...props }: SvgIconProps & { dashed?: boolean }): ReactElement {
  const Icon = dashed ? SvgIcon : Turning;
  return (
    <Icon {...props}>
      {dashed ? (
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray="3.5 3.5" />
      ) : (
        <path d="M12 3a9 9 0 1 1-9 9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      )}
    </Icon>
  );
}
