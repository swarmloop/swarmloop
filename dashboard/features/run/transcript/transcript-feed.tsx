'use client';

import { Fragment, type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import type { StepEvent } from '@contract/step-events';
import { ActionCard } from './action-card';
import { ActivityCard, ReadsCard } from './activity-card';
import { AgentCard, KillCard } from './agent-card';
import type { AgentLog } from './agent-log';
import { ArtifactCard } from './artifact-card';
import { AttemptDivider } from './attempt-divider';
import { CommandCard } from './command-card';
import { HandoffCard } from './handoff-card';
import { InputCard } from './input-card';
import { IssueCard } from './issue-card';
import { ProblemCard } from './problem-card';
import {
  filterEvents,
  groupByAttempt,
  type IssueLinks,
  type TranscriptFilter,
  type TranscriptItem,
} from './transcript-model';

const FILTERS: TranscriptFilter[] = ['all', 'inputs', 'actions', 'problems'];

/** How far from the bottom the reader still counts as being at the bottom. */
const BOTTOM_SLACK = 48;

function Card({
  runKey,
  item,
  issues,
  attempt,
  agent,
}: {
  runKey: string;
  item: TranscriptItem;
  issues: IssueLinks;
  attempt: number;
  agent: AgentLog | null;
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
      return item.activity ? <ActivityCard event={event} activity={item.activity} /> : null;
    case 'agent.launched':
      return item.bubble ? <AgentCard bubble={item.bubble} agent={agent} /> : null;
    case 'agent.finished':
      return <KillCard event={event} />;
    case 'artifact.produced':
      return <ArtifactCard runKey={runKey} event={event} />;
    case 'attempt.finished':
    case 'attempt.interrupted':
    case 'http.call':
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

export function TranscriptFeed({
  runKey,
  events,
  issues = new Map(),
  agent = null,
}: {
  runKey: string;
  events: StepEvent[];
  /** The log and the exchanges of the visit shown. They go into the card of its last agent launch. */
  agent?: AgentLog | null;
  /** The issues of the whole run, so a card can link to the window the issue came from. */
  issues?: IssueLinks;
}): ReactElement {
  const [filter, setFilter] = useState<TranscriptFilter>('all');
  const [unseen, setUnseen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const seen = useRef(0);
  const groups = useMemo(
    () =>
      groupByAttempt(events)
        .map((group) => ({ ...group, items: filterEvents(group.items, filter) }))
        .filter((group) => group.items.length > 0),
    [events, filter],
  );

  const lastLaunch = useMemo(
    () =>
      groupByAttempt(events)
        .flatMap((group) => group.items)
        .filter((item) => item.bubble)
        .at(-1)?.event.eventId,
    [events],
  );

  useEffect(() => {
    const node = box.current;
    if (!node) {
      return;
    }
    if (stick.current) {
      node.scrollTop = node.scrollHeight;
    } else if (events.length > seen.current) {
      setUnseen(true);
    }
    seen.current = events.length;
  }, [events.length]);

  return (
    <Box sx={{ mt: 2, minWidth: 0 }}>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={filter}
        aria-label="Filter the transcript"
        onChange={(_, value: TranscriptFilter | null) => setFilter(value ?? 'all')}
      >
        {FILTERS.map((name) => (
          <ToggleButton key={name} value={name}>
            {name}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <Box sx={{ position: 'relative', mt: 1 }}>
        <Box
          ref={box}
          data-testid="transcript-feed"
          onScroll={(event) => {
            const node = event.currentTarget;
            stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < BOTTOM_SLACK;
            if (stick.current) {
              setUnseen(false);
            }
          }}
          sx={{
            maxHeight: 520,
            overflowY: 'auto',
            overflowX: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
          }}
        >
          {groups.map((group) => (
            <Box key={group.attemptId} sx={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
              <AttemptDivider group={group} />
              {group.items.map((item) => {
                const card = (
                  <Card
                    runKey={runKey}
                    item={item}
                    issues={issues}
                    attempt={group.number}
                    agent={item.event.eventId === lastLaunch ? agent : null}
                  />
                );
                return item.problem ? (
                  <ProblemCard key={item.event.eventId} eventId={item.event.eventId} problem={item.problem}>
                    {card}
                  </ProblemCard>
                ) : (
                  <Fragment key={item.event.eventId}>{card}</Fragment>
                );
              })}
            </Box>
          ))}
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
            sx={{ position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)' }}
          >
            New messages
          </Button>
        ) : null}
      </Box>
    </Box>
  );
}
