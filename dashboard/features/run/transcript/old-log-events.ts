import type { StepEvent } from '@contract/step-events';

const LOG_KIND = 'log';

/** Old runs recorded the agent log as an artifact and as a handoff summary. Both are dropped, so old runs read like new ones. */
export function withoutLogs(events: StepEvent[]): StepEvent[] {
  return events.flatMap((event): StepEvent[] => {
    if (event.kind === 'artifact.produced') {
      return event.artifactKind === LOG_KIND ? [] : [event];
    }
    if (event.kind !== 'handoff.sent' || !event.artifactKinds.includes(LOG_KIND)) {
      return [event];
    }
    const keep = event.artifactKinds.map((kind) => kind !== LOG_KIND);
    return [
      {
        ...event,
        artifactKinds: event.artifactKinds.filter((_, index) => keep[index]),
        ...(event.summaries ? { summaries: event.summaries.filter((_, index) => keep[index]) } : {}),
      },
    ];
  });
}
