'use client';

import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import type { StepEvent } from '@contract/step-events';
import { ActionCard } from './action-card';
import { ActivityCard, ReadsCard } from './activity-card';
import { AgentCard, KillCard, type AgentRole } from './agent-card';
import type { AgentLog } from './agent-log';
import { ArtifactCard } from './artifact-card';
import { foldActions } from './action-rows';
import { AttemptDivider } from './attempt-divider';
import { BubbleLayoutProvider, BubbleProvider, useBubbleLayout } from './bubble';
import { CommandCard } from './command-card';
import { HandoffCard } from './handoff-card';
import { InputCard } from './input-card';
import { IssueCard } from './issue-card';
import { problemId } from './problem-card';
import { RADIUS, SIZE, SPACE, useBubbleWidth, useMotionMs } from './tokens';
import { actorOf, groupByActor, groupByAttempt, type IssueLinks, type TranscriptItem } from './transcript-model';

/** A running step that has been silent for longer than this is said to have no output. */
const SILENT_MS = 2 * 60_000;

/** `live`, `no output for <n> min`, or nothing when the step is not running. A `now` of 0 means the time is not known. */
function statusLine(live: boolean, now: number, lastTime: string | undefined): string | null {
  if (!live) {
    return null;
  }
  const silent = lastTime && now > 0 ? now - Date.parse(lastTime) : 0;
  return silent > SILENT_MS ? `no output for ${Math.floor(silent / 60_000)} min` : 'live';
}

/** How far from the bottom the reader still counts as being at the bottom. */
const BOTTOM_SLACK = 48;

/** The words of the problems chip, and of the step header link that goes to the same card. */
export function problemsLabel(count: number): string {
  return `${count} ${count === 1 ? 'problem' : 'problems'}`;
}

function Card({
  runKey,
  item,
  issues,
  attempt,
  agent,
  role,
  live,
  activities,
}: {
  runKey: string;
  item: TranscriptItem;
  issues: IssueLinks;
  attempt: number;
  agent: AgentLog | null;
  role: AgentRole | null;
  live: boolean;
  activities: boolean;
}): ReactElement | null {
  const { event } = item;
  if (item.reads) {
    return <ReadsCard reads={item.reads} />;
  }
  switch (event.kind) {
    case 'input.received':
    case 'handoff.received':
      return <InputCard runKey={runKey} event={event} issues={issues} />;
    case 'issue.opened':
    case 'issue.resolved':
      return <IssueCard event={event} issues={issues} attempt={attempt} />;
    case 'handoff.sent':
      return <HandoffCard event={event} issues={issues} />;
    case 'command.started':
      return <CommandCard event={event} end={item.end} />;
    case 'activity.started':
      return item.activity && activities ? <ActivityCard event={event} activity={item.activity} live={live} /> : null;
    case 'agent.launched':
      return item.bubble ? <AgentCard bubble={item.bubble} agent={agent} role={role} /> : null;
    case 'agent.finished':
      return <KillCard event={event} />;
    case 'artifact.produced':
      return <ArtifactCard runKey={runKey} event={event} />;
    case 'attempt.finished':
    case 'attempt.interrupted':
    case 'http.call':
    case 'host.suspended':
    case 'agent.limited':
    case 'agent.effort_capped':
    case 'agent.loop_hint':
      return <ActionCard event={event} outcome={item.outcome} />;
    case 'attempt.started':
    case 'command.finished':
    case 'session.changed':
    case 'context.manifest':
    case 'agent.tool':
    case 'agent.message':
    case 'activity.finished':
      return null;
  }
}

/** Three placeholder bubbles, one on the right and two on the left, at the width the real ones get. */
function SkeletonBubbles(): ReactElement {
  const { width } = useBubbleLayout();
  return (
    <>
      {(['left', 'right', 'left'] as const).map((side, index) => (
        <Skeleton
          key={index}
          data-testid="skeleton-bubble"
          variant="rounded"
          height={SIZE.skeleton}
          sx={{
            width,
            maxWidth: '100%',
            mt: SPACE.actor,
            borderRadius: RADIUS.bubble,
            alignSelf: side === 'right' ? 'flex-end' : 'flex-start',
          }}
        />
      ))}
    </>
  );
}

export function TranscriptFeed({
  runKey,
  events,
  issues = new Map(),
  agent = null,
  role = null,
  live = false,
  now = 0,
  activities = true,
}: {
  runKey: string;
  /** What the step recorded. Null while it is read: the feed shows placeholders. */
  events: StepEvent[] | null;
  /** The log and the exchanges of the visit shown. They go into the card of its last agent launch. */
  agent?: AgentLog | null;
  /** The role and tier of the step's agent, which its card names. */
  role?: AgentRole | null;
  /** The issues of the whole run, so a card can link to the window the issue came from. */
  issues?: IssueLinks;
  /** Whether the step is still running, so the feed is still being added to. */
  live?: boolean;
  /** The time now in ms, to tell how long a running step has been silent. */
  now?: number;
  /** Whether the activity cards show. The checks window leaves them out: it lists its commands itself. */
  activities?: boolean;
}): ReactElement {
  const [unseen, setUnseen] = useState(false);
  const width = useBubbleWidth();
  const ms = useMotionMs();
  const layout = useMemo(() => ({ width, ms }), [width, ms]);
  const box = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const seen = useRef(0);
  const total = events?.length ?? 0;
  const attempts = useMemo(() => groupByAttempt(events ?? []), [events]);
  const all = useMemo(() => attempts.flatMap((group) => group.items), [attempts]);
  const groups = useMemo(
    () =>
      attempts
        .map((group) => ({ ...group, rows: foldActions(groupByActor(group.items)) }))
        .filter((group) => group.rows.length > 0),
    [attempts],
  );
  const problems = all.filter((item) => item.problem);
  const lastLaunch = useMemo(() => all.filter((item) => item.bubble).at(-1)?.event.eventId, [all]);
  const lastTime = events?.at(-1)?.occurredAt;

  useEffect(() => {
    const node = box.current;
    if (!node) {
      return;
    }
    if (stick.current) {
      node.scrollTop = node.scrollHeight;
    } else if (total > seen.current) {
      setUnseen(true);
    }
    seen.current = total;
  }, [total]);

  return (
    <BubbleLayoutProvider value={layout}>
      <Box sx={{ mt: 2, minWidth: 0, position: 'relative' }}>
        <Box
          ref={box}
          role="log"
          aria-live="polite"
          aria-label="Transcript"
          data-testid="transcript-feed"
          onScroll={(event) => {
            const node = event.currentTarget;
            stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < BOTTOM_SLACK;
            if (stick.current) {
              setUnseen(false);
            }
          }}
          sx={{
            maxHeight: SIZE.feed,
            overflowY: 'auto',
            overflowX: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <Box
            sx={{
              position: 'sticky',
              top: 0,
              zIndex: 2,
              height: SIZE.topBar,
              flexShrink: 0,
              boxSizing: 'border-box',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: SPACE.part,
              bgcolor: 'background.default',
            }}
          >
            {problems.length > 0 ? (
              <Chip
                size="small"
                color="error"
                variant="outlined"
                label={problemsLabel(problems.length)}
                onClick={() =>
                  document.getElementById(problemId(problems[0].event.eventId))?.scrollIntoView({ block: 'center' })
                }
              />
            ) : (
              <span />
            )}
            <Typography variant="caption" color="text.secondary">
              {statusLine(live, now, lastTime)}
            </Typography>
          </Box>
          {events === null ? <SkeletonBubbles /> : null}
          {events !== null && groups.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: SPACE.divider, textAlign: 'center' }}>
              Nothing to show yet
            </Typography>
          ) : null}
          {groups.map((group) => {
            const cardOf = (item: TranscriptItem): ReactElement => (
              <BubbleProvider
                key={item.event.eventId}
                value={{
                  actor: actorOf(item),
                  time: item.event.occurredAt,
                  grouped: item.grouped ?? false,
                  problem: item.problem,
                  eventId: item.event.eventId,
                }}
              >
                <Card
                  runKey={runKey}
                  item={item}
                  issues={issues}
                  attempt={group.number}
                  agent={item.event.eventId === lastLaunch ? agent : null}
                  role={role}
                  live={live}
                  activities={activities}
                />
              </BubbleProvider>
            );
            return (
              <Box key={group.attemptId} sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <AttemptDivider group={group} />
                {group.rows.map((row) =>
                  'run' in row ? (
                    <Accordion key={row.run.key} disableGutters elevation={0} sx={{ bgcolor: 'transparent' }}>
                      <AccordionSummary
                        expandIcon={<ExpandMoreIcon />}
                      >{`${row.run.items.length} actions`}</AccordionSummary>
                      <AccordionDetails sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        {row.run.items.map(cardOf)}
                      </AccordionDetails>
                    </Accordion>
                  ) : (
                    cardOf(row.item)
                  ),
                )}
              </Box>
            );
          })}
        </Box>
        {unseen ? (
          <Button
            size="small"
            variant="contained"
            onClick={() => {
              const node = box.current;
              if (node) {
                node.scrollTop = node.scrollHeight;
              }
              stick.current = true;
              setUnseen(false);
            }}
            sx={{
              position: 'absolute',
              bottom: SPACE.part,
              left: '50%',
              transform: 'translateX(-50%)',
              borderRadius: RADIUS.pill,
            }}
          >
            New messages
          </Button>
        ) : null}
      </Box>
    </BubbleLayoutProvider>
  );
}
