/** The key of the epic planner's typed answer to the review questions of a subtask: it names the ask document it answers. */
export function reviewAnswerKey(askId: number): string {
  return `review-answer-${askId}`;
}
