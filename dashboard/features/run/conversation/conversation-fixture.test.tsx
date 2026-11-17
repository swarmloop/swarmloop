import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PlanChatEntry } from '@contract/plan-chat';
import { LiveBridgeProvider } from '../../shell';
import { flowView } from '../../../test/fixtures';
import { QueryWrapper } from '../../../test/query-wrapper';
import { expectNoRawJson } from '../../../test/raw-json';
import type { AgentTalk } from './conversation-words';
import { ConversationFeed } from './conversation-feed';

vi.mock('../../../lib/endpoints', () => ({ getStepEvents: vi.fn(), resumeRun: vi.fn() }));
vi.mock('../../../lib/live', async () => (await import('../../../test/fake-socket')).fakeLive());

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryWrapper>
      <LiveBridgeProvider>{children}</LiveBridgeProvider>
    </QueryWrapper>
  );
}

const at = '2026-11-15T07:11:43.444Z';
const longReview = Array.from({ length: 40 }, (_, index) => `${index + 1}. Point ${index + 1} is met`).join('\n');

describe('a whole conversation', () => {
  it('shows no JSON, field or document name, step id, error code or ISO time, and folds a long review', () => {
    const entries: (PlanChatEntry | AgentTalk)[] = [
      { key: 'message-1', role: 'person', author: 'alice', text: 'Add logging', at, state: 'taken' },
      { key: 'reply-1', role: 'planner', text: 'Done, the plan has **logging** now.', at, state: 'taken', version: 2 },
      {
        key: 'talk-1',
        role: 'talk',
        at,
        who: 'Implement',
        to: 'the planner',
        asked: `Which format? (asked ${at})`,
        answered: 'JSON lines, as in the brief.',
      },
      {
        key: 'talk-2',
        role: 'talk',
        at,
        who: 'The planner',
        to: 'you',
        asked: 'Which store should hold the logs?',
      },
    ];
    const flow = flowView({
      status: 'failed',
      state: 'failed',
      currentStep: 'code-review',
      reason: `STEP_FAILED: the review stopped at ${at}`,
      stateReason: { code: 'STEP_FAILED', message: 'the review stopped' },
      items: [
        {
          kind: 'question',
          id: 'q1',
          label: 'Which store?',
          answer: '',
          parts: {
            decide: 'Which store should hold the logs?',
            sides: [{ who: 'requirements', text: 'A file is enough' }],
            full: longReview,
            askedAt: at,
          },
        },
      ],
      conversation: {
        composer: 'plan',
        replying: false,
        entries: entries.filter((entry): entry is PlanChatEntry => entry.role !== 'talk'),
        revisions: [
          {
            version: 2,
            reason: 'You asked for logging',
            summary: 'Logging added',
            added: ['Add request logging'],
            changed: [],
            dropped: [],
            at,
          },
        ],
        questions: [],
      },
    });
    const { container } = render(<ConversationFeed flow={flow} entries={entries} onResume={vi.fn()} />, {
      wrapper: Wrapper,
    });

    expectNoRawJson(container);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(text).not.toMatch(/STEP_FAILED|code-review|plan_chat|requirements_review|\bparts\b|askedAt/);
    expect(screen.getByText('Question for you')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Plan v2' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Problem' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    const folds = container.querySelectorAll('details');
    expect(folds).toHaveLength(1);
    expect(folds[0].querySelector('summary')?.textContent).toBe('Show the whole review');
    expect(screen.queryByText(/Point 20 is met/)).not.toBeVisible();
  });
});
