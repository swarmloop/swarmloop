import type { FlowItem } from '../../contract/api';
import type { RunState } from '../../contract/run-state';
import type { ComposerMode, ConversationView, PlanChatLog } from '../../contract/plan-chat';
import type { DocumentEntity, RunEntity } from '../../history/entities';
import { messageTurn, type MessageTurn } from '../../pipeline/plan-chat-route';

/** The mode of the message box for where a message goes. The answer to a question is a message to the plan. */
const COMPOSER: Record<MessageTurn, ComposerMode> = {
  answer: 'plan',
  planning: 'plan',
  amend: 'amend',
  'add-tasks': 'add-tasks',
  reopen: 'reopen',
  'follow-up': 'follow-up',
  subtask: 'read-only',
};

interface ConversationInput {
  run: Pick<RunEntity, 'currentStep' | 'workspace'>;
  /** True when the run's plan holds tasks. */
  split: boolean;
  state: RunState;
  parentKey?: string;
  /** The open questions and paste items of the run. */
  items: FlowItem[];
  /** The run's own stored plan chat. */
  log: PlanChatLog;
  /** True while a planner turn of the run runs. */
  replying: boolean;
  /** The run's documents, which tell when a question was asked. */
  documents?: DocumentEntity[];
}

/** The kinds of document that ask a question or a paste request. */
const ASKING_KINDS = ['questions', 'subtask_questions', 'review_questions', 'pending'];

/** When the item was asked: its own time, else the newest asking document that holds the first line of its id. */
function askedAt(item: FlowItem, documents: DocumentEntity[]): string | undefined {
  if (item.parts?.askedAt) {
    return item.parts.askedAt;
  }
  const first = item.id.split('\n')[0];
  return [...documents]
    .reverse()
    .find((document) => ASKING_KINDS.includes(document.kind) && document.body.includes(first))?.createdAt;
}

/** The conversation of one run, built from its own plan chat, open questions and answers. */
export function conversationView({
  run,
  split,
  state,
  parentKey,
  items,
  log,
  replying,
  documents = [],
}: ConversationInput): ConversationView {
  const turn = messageTurn(run, { state, parentKey, openItems: items.length, split });
  return {
    composer: COMPOSER[turn],
    replying,
    ...(parentKey ? { parentKey } : {}),
    entries: [...log.entries].sort((a, b) => a.at.localeCompare(b.at)),
    revisions: log.revisions,
    questions: items.map((item) => {
      const at = askedAt(item, documents);
      return { kind: item.kind, id: item.id, text: item.label, answer: item.answer, ...(at ? { askedAt: at } : {}) };
    }),
  };
}
