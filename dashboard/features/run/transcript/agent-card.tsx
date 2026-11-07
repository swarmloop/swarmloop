import { type ReactElement, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import type { StepEvent } from '@contract/step-events';
import { duration, money, tokens } from '../../../lib/format';
import { AgentLogPanel, type AgentLog } from './agent-log';
import { Bubble } from './bubble';
import { DETAIL, SPACE } from './tokens';
import type { AgentBubble, AgentWork } from './transcript-model';

/** How many tool calls and messages show before `show all`. */
const SHOWN_WORK = 8;
const MESSAGE_CHARS = 600;

function size(chars: number): string {
  return `${(chars / 1000).toFixed(1)}k`;
}

/** `Context: prompt 2.3k chars, requirements 0.4k`, with the mount as the workspace and the cut parts named. */
function contextText(context: NonNullable<AgentBubble['context']>): string {
  const sections = context.sections.map(
    (section, index) => `${section.heading.toLowerCase()} ${size(section.size)}${index === 0 ? ' chars' : ''}`,
  );
  const workspace = context.artifacts.map((path) => `workspace: ${path.split('/').filter(Boolean).at(-1) ?? path}`);
  const cut = context.cut.map((item) => `cut: ${item.what} ${size(item.size)}`);
  return `Context: ${[...sections, ...workspace, ...cut].join(', ')}`;
}

function WorkLine({ work }: { work: AgentWork }): ReactElement {
  if (work.kind === 'agent.message') {
    return (
      <Box>
        {work.text}
        {work.chars > MESSAGE_CHARS ? (
          <>
            {'… '}
            <Link href="#exchanges">full exchange</Link>
          </>
        ) : null}
      </Box>
    );
  }
  return (
    <Box
      sx={{
        fontFamily: 'var(--font-mono)',
        fontSize: DETAIL.fontSize,
        color: work.status === 'failed' ? 'error.main' : undefined,
      }}
    >
      {work.tool} {work.target}
      {work.resultLine ? ` → ${work.resultLine}` : ''}
      {work.status === 'unfinished' ? ' → no result' : ''} · {duration(work.durationMs)}
    </Box>
  );
}

function WorkList({
  work,
  runtime,
  ended,
}: {
  work: AgentWork[];
  runtime: string;
  ended: boolean;
}): ReactElement | null {
  const [all, setAll] = useState(false);
  if (work.length === 0) {
    return null;
  }
  const shown = all ? work : work.slice(0, SHOWN_WORK);
  const noTools = ended && work.every((item) => item.kind === 'agent.message');
  return (
    <Box sx={{ mt: SPACE.group, display: 'flex', flexDirection: 'column', gap: SPACE.group }}>
      {noTools ? <Box sx={{ color: 'text.secondary' }}>{`tool details not available from ${runtime}`}</Box> : null}
      {shown.map((item) => (
        <WorkLine key={item.eventId} work={item} />
      ))}
      {work.length > SHOWN_WORK && !all ? (
        <Button size="small" onClick={() => setAll(true)} sx={{ alignSelf: 'flex-start' }}>
          {`show all ${work.length}`}
        </Button>
      ) : null}
    </Box>
  );
}

/** One launch of an agent: who ran and in what chat, the work it did, the raw log and the exchanges, and what it cost. */
export function AgentCard({ bubble, agent }: { bubble: AgentBubble; agent: AgentLog | null }): ReactElement {
  const { launched, finished, session, context, work } = bubble;
  const chat =
    launched.resumed || session?.session === 'same chat'
      ? 'resumed chat'
      : `new chat: ${session?.reason ?? 'no stored chat'}`;
  const hasTools = work.some((item) => item.kind === 'agent.tool');
  const spent = finished
    ? [
        duration(Date.parse(finished.occurredAt) - Date.parse(launched.occurredAt)),
        `${tokens(finished.tokensIn)} in`,
        `${tokens(finished.tokensOut)} out`,
        money(finished.usd),
      ].join(' · ')
    : 'running';
  return (
    <Bubble
      side="left"
      title="Agent"
      type="agent"
      running={finished === null}
      meta={spent}
      detail={context ? <div>{contextText(context)}</div> : undefined}
      detailLabel="context"
    >
      <div>{`${launched.model} · ${launched.runtime} · ${chat}`}</div>
      <WorkList work={work} runtime={launched.runtime} ended={finished !== null} />
      {agent ? <AgentLogPanel agent={agent} tools={hasTools} /> : null}
    </Bubble>
  );
}

/** The stop of an agent that was killed. It is a problem card, so the cause is in words. */
export function KillCard({ event }: { event: Extract<StepEvent, { kind: 'agent.finished' }> }): ReactElement {
  return (
    <Bubble
      side="left"
      title="Agent stopped"
      type="agent"
      meta={`${tokens(event.tokensIn)} in · ${tokens(event.tokensOut)} out · ${money(event.usd)}`}
    >
      {event.model} was stopped: {event.killReason}
    </Bubble>
  );
}
