import type { ReactElement } from 'react';
import type { StepEvent } from '@contract/step-events';
import { CardFrame } from './card-frame';

export function ArtifactCard({ event }: { event: Extract<StepEvent, { kind: 'artifact.produced' }> }): ReactElement {
  return (
    <CardFrame side="left" label="Artifact">
      {event.artifactKind} · document {event.documentId}
    </CardFrame>
  );
}
