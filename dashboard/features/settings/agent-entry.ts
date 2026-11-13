import { isEffort } from '@contract/effort';

interface ListedAgent {
  runtime: string;
  model: string;
  effort?: string;
}

/** The list text is `runtime:model[:effort]`. */
export const entryOf = (agent: ListedAgent): string =>
  `${agent.runtime}:${agent.model}${agent.effort ? `:${agent.effort}` : ''}`;

/** A runtime holds no colon; a model may, so a last word is a level only when it is one of the five. */
export function agentOf(entry: string): ListedAgent {
  const at = entry.indexOf(':');
  const runtime = entry.slice(0, at);
  const rest = entry.slice(at + 1);
  const last = rest.lastIndexOf(':');
  if (last > 0 && isEffort(rest.slice(last + 1))) {
    return { runtime, model: rest.slice(0, last), effort: rest.slice(last + 1) };
  }
  return { runtime, model: rest };
}
