import type { ReactElement } from 'react';
import type { StepEvent } from '@contract/step-events';
import { Bubble } from './bubble';
import { DocumentDetail } from './document-detail';

export function ArtifactCard({
  runKey,
  event,
}: {
  runKey: string;
  event: Extract<StepEvent, { kind: 'artifact.produced' }>;
}): ReactElement {
  const kind = event.artifactKind.replace(/_/g, ' ');
  return (
    <Bubble
      side="left"
      title="Artifact"
      type="artifact"
      meta={`${kind} · document ${event.documentId}`}
      detail={<DocumentDetail runKey={runKey} kind={event.artifactKind} />}
      detailLabel="document"
    >
      {event.summary ?? `a ${kind} document was written`}
    </Bubble>
  );
}
