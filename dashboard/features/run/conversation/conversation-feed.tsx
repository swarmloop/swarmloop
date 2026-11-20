'use client';

import { type ReactElement, useEffect, useState } from 'react';
import type { Route } from 'next';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import type { FlowView } from '@contract/api';
import type { PlanChatEntry } from '@contract/plan-chat';
import { MarkdownBody } from '../../../components/ui/markdown-body';
import { Bubble, BubbleLayoutProvider, BubbleProvider } from '../transcript/bubble';
import { RADIUS, SPACE, useMotionMs } from '../transcript/tokens';
import { useStepEvents } from '../transcript/use-step-events';
import { useFollowBottom } from '../use-follow-bottom';
import { type AgentTalk, type FeedEntry, plainText, spokenText, talkSentence } from './conversation-words';
import { feedTimeline } from './feed-timeline';
import { InfoLine } from './info-line';
import { ProblemEntry } from './problem-entry';
import { QuestionEntry } from './question-entry';
import { RevisionCard } from './revision-card';

/** The height kept for a reply that streams, so the entries below it do not move while it grows. */
const STREAM_HEIGHT = 160;
const PLANNER = { kind: 'agent', name: 'Planner' } as const;

function Message({ entry }: { entry: PlanChatEntry }): ReactElement {
  const person = entry.role === 'person';
  const actor = person ? { kind: 'person' as const, name: entry.author ?? 'You' } : PLANNER;
  return (
    <BubbleProvider value={{ actor, time: '', grouped: false, problem: null, eventId: '' }}>
      <Bubble
        side={person ? 'right' : 'left'}
        type={person ? 'input' : 'agent'}
        title={person ? 'Message' : 'Reply'}
        meta={entry.state === 'pending' ? 'Pending' : undefined}
      >
        {person ? (
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {entry.text}
          </Typography>
        ) : (
          <MarkdownBody text={entry.text} />
        )}
      </Bubble>
    </BubbleProvider>
  );
}

/** The words of the reply the planner is writing now, read from the events of the running plan visit. */
function useStreamingText(runKey: string, cursor: number): string {
  const { events } = useStepEvents(runKey, 'plan', cursor, true);
  const visit = (events ?? []).filter((event) => event.step === 'plan');
  const start = visit.findLastIndex((event) => event.kind === 'attempt.started');
  const message = visit
    .slice(start + 1)
    .filter((event) => event.kind === 'agent.message')
    .at(-1);
  return message?.kind === 'agent.message' ? spokenText(message.text) : '';
}

/** Reads the words of the reply being written and hands them up. It is mounted only while the planner replies. */
function StreamReader({
  runKey,
  cursor,
  onText,
}: {
  runKey: string;
  cursor: number;
  onText: (text: string) => void;
}): null {
  const text = useStreamingText(runKey, cursor);
  useEffect(() => onText(text), [text, onText]);
  return null;
}

function StreamingReply({ text }: { text: string }): ReactElement {
  return (
    <BubbleProvider value={{ actor: PLANNER, time: '', grouped: false, problem: null, eventId: '' }}>
      <Box aria-live="polite" sx={{ minHeight: STREAM_HEIGHT, display: 'flex', flexDirection: 'column' }}>
        <Bubble side="left" type="agent" title="Reply" running meta="Writing">
          <Box sx={{ maxHeight: STREAM_HEIGHT - 72, overflow: 'auto' }}>
            {text ? <MarkdownBody text={text} /> : <Typography variant="body2">The planner is replying…</Typography>}
          </Box>
        </Bubble>
      </Box>
    </BubbleProvider>
  );
}

function Talk({ talk }: { talk: AgentTalk }): ReactElement {
  return (
    <InfoLine
      sentence={talkSentence({
        ...talk,
        asked: plainText(talk.asked),
        answered: talk.answered && plainText(talk.answered),
      })}
      label="Show the whole talk"
      detail={
        <>
          <Typography variant="caption" component="p" sx={{ whiteSpace: 'pre-wrap' }}>
            {`Question: ${plainText(talk.asked)}`}
          </Typography>
          {talk.answered ? (
            <Typography variant="caption" component="p" sx={{ whiteSpace: 'pre-wrap' }}>
              {`Answer: ${plainText(talk.answered)}`}
            </Typography>
          ) : null}
        </>
      }
    />
  );
}

/** What a person said to a subtask's planner, as one line of the parent's conversation with a link to the subtask. */
function Exchange({ entry }: { entry: PlanChatEntry }): ReactElement {
  const reply = entry.reply ? ` Reply: ${plainText(entry.reply)}` : '';
  const target = entry.link ?? '';
  return (
    <InfoLine
      sentence={`${entry.text}${reply}`}
      link={{ href: `/runs/${encodeURIComponent(target)}` as Route, text: `Open ${target}` }}
    />
  );
}

interface FeedProps {
  flow: FlowView;
  entries: FeedEntry[];
  onResume: () => void;
}

/**
 * The conversation of a run, in order: the person's messages, the planner's replies (the one being written streams), talk
 * between agents as muted lines, what needs the person (questions, a failed or blocked step, a wait only a person ends), and one line for a wait
 * the run ends by itself.
 */
export function ConversationFeed({ flow, entries, onResume }: FeedProps): ReactElement {
  const ms = useMotionMs();
  const replying = flow.conversation?.replying ?? false;
  const [written, setWritten] = useState('');
  const streaming = replying ? written : '';
  const rows = feedTimeline(flow, entries);
  const { box, onScroll, unseen, scrollToBottom } = useFollowBottom(rows.length, streaming);
  return (
    <BubbleLayoutProvider value={{ width: '92%', ms }}>
      <Box sx={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Box
          ref={box}
          role="log"
          aria-label="Conversation"
          onScroll={onScroll}
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            minWidth: 0,
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
          }}
        >
          {rows.map((row) => {
            switch (row.type) {
              case 'message':
                return row.entry.kind === 'info' ? (
                  <Exchange key={row.key} entry={row.entry} />
                ) : (
                  <Message key={row.key} entry={row.entry} />
                );
              case 'talk':
                return <Talk key={row.key} talk={row.talk} />;
              case 'revision':
                return <RevisionCard key={row.key} revision={row.revision} />;
              case 'question':
                return <QuestionEntry key={row.key} item={row.item} />;
              case 'limit':
              case 'info':
                return <InfoLine key={row.key} sentence={row.sentence} />;
              case 'problem':
                return <ProblemEntry key={row.key} flow={flow} onResume={onResume} />;
              case 'streaming':
                return <StreamingReply key={row.key} text={streaming} />;
            }
          })}
        </Box>
        {replying ? <StreamReader runKey={flow.key} cursor={flow.revision} onText={setWritten} /> : null}
        {unseen ? (
          <Button
            size="small"
            variant="contained"
            onClick={scrollToBottom}
            sx={{
              position: 'absolute',
              bottom: SPACE.part,
              left: '50%',
              transform: 'translateX(-50%)',
              borderRadius: RADIUS.pill,
            }}
          >
            New messages ↓
          </Button>
        ) : null}
      </Box>
    </BubbleLayoutProvider>
  );
}
