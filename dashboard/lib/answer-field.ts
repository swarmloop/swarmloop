import type { FlowItem } from './types.ts';

export interface AnswerPresentation {
  heading: string | null;
  label: string | null;
}

export function answerPresentation(item: Pick<FlowItem, 'kind' | 'label'>): AnswerPresentation {
  if (item.kind === 'question') {
    return { heading: item.label, label: null };
  }
  return { heading: null, label: item.label };
}
