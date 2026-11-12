import type { ComponentType } from 'react';
import type { SvgIconProps } from '@mui/material/SvgIcon';
import Block from '@mui/icons-material/Block';
import CheckCircle from '@mui/icons-material/CheckCircle';
import HourglassEmpty from '@mui/icons-material/HourglassEmpty';
import PlayCircleOutline from '@mui/icons-material/PlayCircleOutline';
import SkipNext from '@mui/icons-material/SkipNext';
import TaskAlt from '@mui/icons-material/TaskAlt';
import type { TaskLayer } from '@contract/api';

type SubtaskStatus = TaskLayer['tasks'][number]['status'];

/** The icon, theme color and word of each subtask status. */
export const TASK_STATUS: Record<SubtaskStatus, { Icon: ComponentType<SvgIconProps>; color: string; word: string }> = {
  pending: { Icon: HourglassEmpty, color: 'warning.main', word: 'waiting' },
  waiting: { Icon: HourglassEmpty, color: 'warning.main', word: 'waiting' },
  running: { Icon: PlayCircleOutline, color: 'info.main', word: 'running' },
  green: { Icon: TaskAlt, color: 'success.main', word: 'green' },
  blocked: { Icon: Block, color: 'error.main', word: 'blocked' },
  merged: { Icon: CheckCircle, color: 'success.main', word: 'merged' },
  skipped: { Icon: SkipNext, color: 'text.secondary', word: 'skipped' },
};
