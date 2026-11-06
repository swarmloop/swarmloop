import type { ReactElement } from 'react';
import type { StepEvent } from '@contract/step-events';
import { money, tokens } from '../../../lib/format';
import { CardFrame } from './card-frame';

export function AgentCard({
  event,
}: {
  event: Extract<StepEvent, { kind: 'agent.launched' | 'agent.finished' }>;
}): ReactElement {
  const who = `${event.model} · ${event.runtime}${event.resumed ? ' · resumed' : ''}`;
  if (event.kind === 'agent.launched') {
    return (
      <CardFrame side="left" label="Agent launched">
        {who}
      </CardFrame>
    );
  }
  return (
    <CardFrame side="left" label="Agent finished">
      {who} · {tokens(event.tokensIn)} in · {tokens(event.tokensOut)} out · {money(event.usd)}
      {event.killReason ? ` · killed: ${event.killReason}` : ''}
    </CardFrame>
  );
}
