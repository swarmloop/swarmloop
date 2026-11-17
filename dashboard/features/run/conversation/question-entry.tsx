import type { ReactElement } from 'react';
import Typography from '@mui/material/Typography';
import type { FlowItem } from '@contract/api';
import { answerPresentation } from '../../../lib/answer-field';
import { QuestionCard } from '../flow/question-card';
import { Bubble, BubbleProvider } from '../transcript/bubble';

const PLANNER = { kind: 'agent', name: 'Planner' } as const;

/**
 * An open question, or an open paste request, as the planner's message marked `Question for you` in the accent color.
 * It has no answer field: the person answers by writing in the message box.
 */
export function QuestionEntry({ item }: { item: FlowItem }): ReactElement {
  const presentation = answerPresentation(item);
  return (
    <BubbleProvider value={{ actor: PLANNER, time: '', grouped: false, problem: null, eventId: '' }}>
      <Bubble side="left" type="agent" title="Question for you">
        {presentation.heading ? (
          <QuestionCard item={item} />
        ) : (
          <Typography variant="body2">{`Please paste: ${presentation.label}`}</Typography>
        )}
      </Bubble>
    </BubbleProvider>
  );
}
