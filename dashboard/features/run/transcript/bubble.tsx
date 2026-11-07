import { createContext, type ReactElement, type ReactNode, useContext, useState } from 'react';
import AccountTree from '@mui/icons-material/AccountTree';
import CallSplit from '@mui/icons-material/CallSplit';
import Dns from '@mui/icons-material/Dns';
import ErrorOutline from '@mui/icons-material/ErrorOutline';
import Person from '@mui/icons-material/Person';
import SmartToy from '@mui/icons-material/SmartToy';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import LinearProgress from '@mui/material/LinearProgress';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { Theme } from '@mui/material/styles';
import { clock } from '../../../lib/format';
import { ACCENT, type Accent, BUBBLE_WIDTH, DETAIL, MOTION_MS, RADIUS, SIZE, SPACE, TINT } from './tokens';
import { problemId } from './problem-card';
import type { Actor, ActorKind, Problem, Side } from './transcript-model';

const ICONS = { server: Dns, agent: SmartToy, person: Person, pipeline: AccountTree, git: CallSplit } satisfies Record<
  ActorKind,
  typeof Dns
>;

/** What the feed knows about the card it renders: who speaks, when, whether the actor repeats, and whether it failed. */
interface BubbleItem {
  actor: Actor;
  /** The ISO time of the event. */
  time: string;
  grouped: boolean;
  problem: Problem | null;
  eventId: string;
}

const BubbleContext = createContext<BubbleItem | null>(null);

/** What the media queries say, read once by the feed: the width of every bubble, and the duration of a transition (0 under reduced motion). */
interface BubbleLayout {
  width: string;
  ms: number;
}

const LayoutContext = createContext<BubbleLayout>({ width: BUBBLE_WIDTH.phone, ms: MOTION_MS });

export const BubbleLayoutProvider = LayoutContext.Provider;

export const useBubbleLayout = (): BubbleLayout => useContext(LayoutContext);

/** The feed wraps each card in it, so a card says only what it shows and `Bubble` knows the rest. */
export const BubbleProvider = BubbleContext.Provider;

const ALONE: BubbleItem = {
  actor: { kind: 'server', name: 'Server' },
  time: '',
  grouped: false,
  problem: null,
  eventId: '',
};

/** The palette as CSS variables when the theme has them, so one rule serves both color schemes. */
const palette = (theme: Theme) => (theme.vars ?? theme).palette;

/** A monospace line or block. It scrolls sideways inside its box, so it never widens a bubble. */
export function Code({ children, title }: { children: ReactNode; title?: string }): ReactElement {
  return (
    <Box
      component="code"
      data-code
      title={title}
      sx={{
        display: 'block',
        whiteSpace: 'pre',
        overflowX: 'auto',
        fontFamily: 'var(--font-mono)',
        fontSize: 'inherit',
      }}
    >
      {children}
    </Box>
  );
}

/** A quiet button that opens `children` in place, in the monospace block with its own scroll. */
export function Detail({
  label,
  lines,
  children,
}: {
  label: string;
  lines?: number;
  children: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const { ms } = useBubbleLayout();
  return (
    <Box sx={{ minWidth: 0 }}>
      <Button
        size="small"
        color="inherit"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        sx={{ color: 'text.secondary' }}
      >
        {`${open ? 'Hide' : 'Show'} ${label}${lines ? ` · ${lines} lines` : ''}`}
      </Button>
      <Collapse in={open} timeout={ms} unmountOnExit>
        <Box
          sx={{
            mt: SPACE.group,
            p: SPACE.part,
            minWidth: 0,
            overflow: 'auto',
            maxHeight: DETAIL.maxHeight,
            bgcolor: 'background.default',
            borderRadius: RADIUS.detail,
            fontFamily: 'var(--font-mono)',
            fontSize: DETAIL.fontSize,
            lineHeight: DETAIL.lineHeight,
          }}
        >
          {children}
        </Box>
      </Collapse>
    </Box>
  );
}

/**
 * The one frame of every card: a chat bubble of fixed width in the left lane (what the step did) or the right lane
 * (what came in). `children` is the body line, `meta` the footer chips, `detail` stays closed until asked for.
 */
export function Bubble({
  side,
  title,
  type = 'activity',
  running = false,
  children,
  meta,
  detail,
  detailLabel = 'details',
  detailLines,
}: {
  side: Side;
  title: string;
  type?: Accent;
  running?: boolean;
  children: ReactNode;
  meta?: ReactNode;
  detail?: ReactNode;
  detailLabel?: string;
  detailLines?: number;
}): ReactElement {
  const { actor, time, grouped, problem, eventId } = useContext(BubbleContext) ?? ALONE;
  const { width, ms } = useBubbleLayout();
  const phone = width === BUBBLE_WIDTH.phone;
  const lane = side === 'right' ? 'right' : 'left';
  const Icon = ICONS[actor.kind];
  const accent = ACCENT[problem ? 'problem' : type];
  const shown = problem ? problem.cause : title;
  return (
    <Box
      component="article"
      id={problem ? problemId(eventId) : undefined}
      aria-label={problem ? `Error: ${problem.cause}` : `${actor.name} ${title}`}
      sx={(theme) => ({
        position: 'relative',
        overflow: 'hidden',
        boxSizing: 'border-box',
        alignSelf: side === 'right' ? 'flex-end' : 'flex-start',
        width,
        maxWidth: '100%',
        minWidth: 0,
        mt: grouped ? SPACE.group : SPACE.actor,
        p: SPACE.pad,
        display: 'flex',
        flexDirection: 'column',
        gap: SPACE.part,
        bgcolor: 'background.paper',
        ...(problem
          ? {
              backgroundImage: `linear-gradient(color-mix(in srgb, ${palette(theme).error.main} ${TINT.problem}, transparent), color-mix(in srgb, ${palette(theme).error.main} ${TINT.problem}, transparent))`,
            }
          : {}),
        border: 1,
        borderColor: problem ? 'error.main' : 'divider',
        borderRadius: RADIUS.bubble,
        [side === 'right' ? 'borderBottomRightRadius' : 'borderBottomLeftRadius']: RADIUS.tail,
        ...theme.applyStyles('light', {
          boxShadow: `0 1px 2px color-mix(in srgb, ${palette(theme).text.primary} ${TINT.shadow}, transparent)`,
        }),
        animationName: ms ? 'swarmloop-fade' : 'none',
        animationDuration: `${ms}ms`,
        '&::before': {
          content: '""',
          position: 'absolute',
          top: 0,
          bottom: 0,
          [lane]: 0,
          width: SIZE.stripe,
          bgcolor: accent,
        },
      })}
    >
      {running ? (
        <LinearProgress
          variant={ms === 0 ? 'determinate' : 'indeterminate'}
          value={100}
          sx={{ position: 'absolute', top: 0, left: 0, right: 0, height: SIZE.progress }}
        />
      ) : null}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: SPACE.part,
          minWidth: 0,
          color: problem ? 'error.main' : undefined,
        }}
      >
        {grouped ? null : (
          <>
            <Avatar
              sx={{
                width: SIZE.avatar,
                height: SIZE.avatar,
                bgcolor: 'background.default',
                color: 'text.secondary',
                '& svg': { fontSize: SIZE.avatarIcon },
              }}
            >
              <Icon aria-hidden />
            </Avatar>
            <Typography variant="subtitle2" noWrap>
              {actor.name}
            </Typography>
          </>
        )}
        {problem ? (
          <>
            <ErrorOutline fontSize="small" aria-hidden />
            <Typography variant="subtitle2" component="span">
              Error
            </Typography>
          </>
        ) : null}
        <Typography
          variant="body2"
          noWrap
          sx={{ flex: '1 1 auto', minWidth: 0, color: problem ? 'inherit' : 'text.secondary' }}
        >
          {shown}
        </Typography>
        {phone ? (
          <Typography variant="caption" color="text.secondary">
            {side === 'right' ? 'Input' : 'Step'}
          </Typography>
        ) : null}
        {time ? (
          <Tooltip title={time}>
            <Typography variant="caption" color="text.secondary" component="time" dateTime={time}>
              {clock(time)}
            </Typography>
          </Tooltip>
        ) : null}
      </Box>
      <Typography
        data-testid="card-main"
        variant="body2"
        component="div"
        sx={{ minWidth: 0, overflowWrap: 'anywhere' }}
      >
        {children}
      </Typography>
      {meta || problem ? (
        <Tooltip
          title={
            <>
              {problem ? `${problem.action} · id ${eventId}` : null} {meta}
            </>
          }
        >
          <Typography
            data-testid="card-meta"
            variant="caption"
            color="text.secondary"
            component="div"
            noWrap
            sx={{ display: 'flex', gap: SPACE.part, overflow: 'hidden', whiteSpace: 'nowrap' }}
          >
            {problem ? <span>{`${problem.action} · id ${eventId}`}</span> : null}
            {meta ? <span>{meta}</span> : null}
          </Typography>
        </Tooltip>
      ) : null}
      {detail ? (
        <Detail label={detailLabel} lines={detailLines}>
          {detail}
        </Detail>
      ) : null}
    </Box>
  );
}
