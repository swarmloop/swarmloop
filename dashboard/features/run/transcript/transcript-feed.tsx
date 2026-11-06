'use client';

import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import type { StepEvent } from '@contract/step-events';
import { ActionCard } from './action-card';
import { AgentCard, SessionCard } from './agent-card';
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
}: {
  runKey: string;
  item: TranscriptItem;
  issues: IssueLinks;
}): ReactElement | null {
  const { event } = item;
  switch (event.kind) {
    case 'input.received':
    case 'handoff.received':
      return <InputCard event={event} issues={issues} />;
    case 'issue.opened':
    case 'issue.resolved':
      return <IssueCard event={event} />;
    case 'session.changed':
    case 'context.manifest':
      return <SessionCard event={event} />;
    case 'handoff.sent':
      return <HandoffCard event={event} />;
    case 'command.started':
      return <CommandCard runKey={runKey} event={event} end={item.end} />;
    case 'agent.launched':
    case 'agent.finished':
      return <AgentCard event={event} />;
    case 'artifact.produced':
      return <ArtifactCard event={event} />;
    case 'attempt.finished':
    case 'attempt.interrupted':
    case 'http.call':
      return <ActionCard event={event} />;
    case 'attempt.started':
    case 'command.finished':
      return null;
  }
}

export function TranscriptFeed({
  runKey,
  events,
  issues = new Map(),
}: {
  runKey: string;
  events: StepEvent[];
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
              {group.items.map((item) =>
                item.problem ? (
                  <ProblemCard key={item.event.eventId} eventId={item.event.eventId} problem={item.problem}>
                    <Card runKey={runKey} item={item} issues={issues} />
                  </ProblemCard>
                ) : (
                  <Card key={item.event.eventId} runKey={runKey} item={item} issues={issues} />
                ),
              )}
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
