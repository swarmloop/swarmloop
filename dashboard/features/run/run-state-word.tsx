'use client';

import type { ReactElement } from 'react';
import AccountTree from '@mui/icons-material/AccountTree';
import Autorenew from '@mui/icons-material/Autorenew';
import Block from '@mui/icons-material/Block';
import CallMerge from '@mui/icons-material/CallMerge';
import CheckCircle from '@mui/icons-material/CheckCircle';
import CheckCircleOutline from '@mui/icons-material/CheckCircleOutline';
import ChatBubbleOutline from '@mui/icons-material/ChatBubbleOutline';
import ErrorOutline from '@mui/icons-material/ErrorOutline';
import HighlightOff from '@mui/icons-material/HighlightOff';
import PauseCircleOutline from '@mui/icons-material/PauseCircleOutline';
import Replay from '@mui/icons-material/Replay';
import SkipNext from '@mui/icons-material/SkipNext';
import StopCircleOutlined from '@mui/icons-material/StopCircleOutlined';
import Tooltip from '@mui/material/Tooltip';
import type { StateIcon, StateTone, StateWord } from '@contract/run-state';

/** One color rule for every state: who acts next. */
function toneColor(tone: StateTone): string {
  return {
    working: 'info.main',
    person: 'warning.main',
    error: 'error.main',
    done: 'var(--chart-done)',
    neutral: 'var(--swarmloop-skipped, #8a847a)',
  }[tone];
}

const ICONS: Record<StateIcon, typeof Autorenew> = {
  working: Autorenew,
  person: ChatBubbleOutline,
  paused: PauseCircleOutline,
  retrying: Replay,
  subtasks: AccountTree,
  queued: CallMerge,
  blocked: Block,
  failed: ErrorOutline,
  stopped: StopCircleOutlined,
  ready: CheckCircleOutline,
  merged: CheckCircle,
  closed: HighlightOff,
  skipped: SkipNext,
};

/** The icon of a state in its tone's color. The word, and the tip when there is one, are the tooltip and the label. */
export function RunStateIcon({ view, size = 18 }: { view: StateWord; size?: number }): ReactElement {
  const Icon = ICONS[view.icon];
  const label = view.tip ? `${view.word}: ${view.tip}` : view.word;
  return (
    <Tooltip title={label}>
      <Icon
        titleAccess={label}
        aria-label={label}
        sx={{ fontSize: size, color: toneColor(view.tone), flexShrink: 0 }}
      />
    </Tooltip>
  );
}
