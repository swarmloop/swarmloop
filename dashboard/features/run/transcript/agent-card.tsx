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

export function SessionCard({
  event,
}: {
  event: Extract<StepEvent, { kind: 'session.changed' | 'context.manifest' }>;
}): ReactElement {
  if (event.kind === 'session.changed') {
    return (
      <CardFrame side="left" label="Session">
        {event.session} · {event.model} · {event.runtime}
        {event.reason ? ` · ${event.reason}` : ''}
      </CardFrame>
    );
  }
  const cut = event.cut.map((item) => `${item.what} ${item.size}`).join(', ');
  return (
    <CardFrame side="left" label="Context">
      {event.sections.map((section) => `${section.heading} ${section.size}`).join(' · ')}
      {event.artifacts.length > 0 ? ` · by reference: ${event.artifacts.join(', ')}` : ''}
      {cut ? ` · cut: ${cut}` : ''}
    </CardFrame>
  );
}
