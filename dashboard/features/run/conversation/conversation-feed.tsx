'use client';

import { type ReactElement, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { FlowView } from '@contract/api';
import { MarkdownBody } from '../../../components/ui/markdown-body';
import { Bubble, BubbleProvider } from '../transcript/bubble';
import { useStepEvents } from '../transcript/use-step-events';
import { type AgentTalk, type FeedEntry, plainText, spokenText, talkSentence } from './conversation-words';
import { FeedLog } from './feed-log';
import { feedTimeline } from './feed-timeline';
import { InfoLine } from './info-line';
import { MessageBubble, PLANNER } from './message-bubble';
import { ProblemEntry } from './problem-entry';
import { QuestionEntry } from './question-entry';
import { RevisionCard } from './revision-card';

/** The height kept for a reply that streams, so the entries below it do not move while it grows. */
const STREAM_HEIGHT = 160;

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
  const replying = flow.conversation?.replying ?? false;
  const [written, setWritten] = useState('');
  const streaming = replying ? written : '';
  const rows = feedTimeline(flow, entries);
  return (
    <>
      <FeedLog count={rows.length} streaming={streaming}>
        {rows.map((row) => {
          switch (row.type) {
            case 'message':
              return <MessageBubble key={row.key} entry={row.entry} />;
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
      </FeedLog>
      {replying ? <StreamReader runKey={flow.key} cursor={flow.revision} onText={setWritten} /> : null}
    </>
  );
}
