import type { ReactElement } from 'react';
import Typography from '@mui/material/Typography';
import type { FlowItem } from '@contract/api';
import { MarkdownBody } from '../../../components/ui/markdown-body';
import { answerPresentation } from '../../../lib/answer-field';
import { QuestionCard } from '../flow/question-card';
import { Bubble, BubbleProvider } from '../transcript/bubble';

const PLANNER = { kind: 'agent', name: 'Planner' } as const;

/**
 * An open question, or an open paste request, as the planner's message marked `Question for you` in the accent color.
 * It has no answer field: the person answers by writing in the message box. One that has its answer reads `Answered`
 * and shows the answer under the question.
 */
export function QuestionEntry({ item }: { item: FlowItem }): ReactElement {
  const presentation = answerPresentation(item);
  const answered = item.answer.trim() !== '';
  return (
    <BubbleProvider value={{ actor: PLANNER, time: '', grouped: false, problem: null, eventId: '' }}>
      <Bubble side="left" type="agent" title={answered ? 'Answered' : 'Question for you'}>
        {answered ? (
          <>
            {presentation.heading ? (
              <MarkdownBody text={presentation.heading} />
            ) : (
              <Typography variant="body2">{`Please paste: ${presentation.label}`}</Typography>
            )}
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {item.answer}
            </Typography>
          </>
        ) : presentation.heading ? (
          <QuestionCard item={item} />
        ) : (
          <Typography variant="body2">{`Please paste: ${presentation.label}`}</Typography>
        )}
      </Bubble>
    </BubbleProvider>
  );
}
