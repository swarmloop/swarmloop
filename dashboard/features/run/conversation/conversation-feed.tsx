'use client';

import { Fragment, type ReactElement } from 'react';
import type { Route } from 'next';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { FlowView } from '@contract/api';
import type { PlanChatEntry, PlanRevision } from '@contract/plan-chat';
import { MarkdownBody } from '../../../components/ui/markdown-body';
import { Bubble, BubbleLayoutProvider, BubbleProvider } from '../transcript/bubble';
import { useMotionMs } from '../transcript/tokens';
import { useStepEvents } from '../transcript/use-step-events';
import {
  type AgentTalk,
  type FeedEntry,
  isTalk,
  limitWaitSentence,
  plainText,
  spokenText,
  talkSentence,
} from './conversation-words';
import { InfoLine } from './info-line';
import { hasProblem, ProblemEntry } from './problem-entry';
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

/** The reply the planner is writing now, read from the events of the running plan visit. */
function StreamingReply({ runKey, cursor }: { runKey: string; cursor: number }): ReactElement {
  const { events } = useStepEvents(runKey, 'plan', cursor, true);
  const visit = (events ?? []).filter((event) => event.step === 'plan');
  const start = visit.findLastIndex((event) => event.kind === 'attempt.started');
  const message = visit
    .slice(start + 1)
    .filter((event) => event.kind === 'agent.message')
    .at(-1);
  const text = message?.kind === 'agent.message' ? spokenText(message.text) : '';
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

/**
 * The conversation of a run, in order: the person's messages, the planner's replies (the one being written streams), talk
 * between agents as muted lines, what needs the person (questions, a usage-limit wait, a failed or blocked step).
 */
export function ConversationFeed({
  flow,
  entries,
  onResume,
}: {
  flow: FlowView;
  entries: FeedEntry[];
  onResume: () => void;
}): ReactElement {
  const ms = useMotionMs();
  const limit = limitWaitSentence(flow);
  const revisions = flow.conversation?.revisions ?? [];
  const lastReply = (version: number): number =>
    entries.findLastIndex((entry) => entry.role === 'planner' && entry.version === version);
  const cardsAfter = (index: number): PlanRevision[] =>
    revisions.filter((revision) =>
      lastReply(revision.version) >= 0 ? lastReply(revision.version) === index : index === entries.length - 1,
    );
  return (
    <BubbleLayoutProvider value={{ width: '92%', ms }}>
      <Box role="log" aria-label="Conversation" sx={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        {entries.length === 0
          ? revisions.map((revision) => <RevisionCard key={revision.version} revision={revision} />)
          : null}
        {entries.map((entry, index) => (
          <Fragment key={entry.key}>
            {isTalk(entry) ? (
              <Talk talk={entry} />
            ) : entry.kind === 'info' ? (
              <Exchange entry={entry} />
            ) : (
              <Message entry={entry} />
            )}
            {cardsAfter(index).map((revision) => (
              <RevisionCard key={revision.version} revision={revision} />
            ))}
          </Fragment>
        ))}
        {flow.conversation?.replying ? <StreamingReply runKey={flow.key} cursor={flow.revision} /> : null}
        {flow.items.map((item) => (
          <QuestionEntry key={`${item.kind}:${item.id}`} item={item} />
        ))}
        {limit ? <InfoLine sentence={limit} /> : null}
        {hasProblem(flow) ? <ProblemEntry flow={flow} onResume={onResume} /> : null}
      </Box>
    </BubbleLayoutProvider>
  );
}
