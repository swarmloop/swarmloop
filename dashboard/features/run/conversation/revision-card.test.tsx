import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PlanChatEntry, PlanRevision } from '@contract/plan-chat';
import { LiveBridgeProvider } from '../../shell';
import { flowView } from '../../../test/fixtures';
import { QueryWrapper } from '../../../test/query-wrapper';
import { ConversationFeed } from './conversation-feed';
import { RevisionCard } from './revision-card';

vi.mock('../../../lib/endpoints', () => ({ getStepEvents: vi.fn(), resumeRun: vi.fn() }));
vi.mock('../../../lib/live', async () => (await import('../../../test/fake-socket')).fakeLive());

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryWrapper>
      <LiveBridgeProvider>{children}</LiveBridgeProvider>
    </QueryWrapper>
  );
}

const revision = (overrides: Partial<PlanRevision> = {}): PlanRevision => ({
  version: 3,
  reason: 'You asked for logging',
  summary: 'Logging added',
  added: ['Add request logging'],
  changed: ['Send the mail'],
  dropped: ['Old cache'],
  at: '2026-11-15T07:11:43.444Z',
  ...overrides,
});

describe('RevisionCard', () => {
  it('shows the version, the reason in one line and the added, changed and removed items', () => {
    render(<RevisionCard revision={revision()} />);

    const card = screen.getByRole('region', { name: 'Plan v3' });
    expect(within(card).getByText('Plan v3 · what changed')).toBeInTheDocument();
    expect(within(card).getByText('Logging added · You asked for logging')).toBeInTheDocument();
    expect(within(within(card).getByRole('region', { name: 'Added' })).getByText('Add request logging')).toBeVisible();
    expect(within(within(card).getByRole('region', { name: 'Changed' })).getByText('Send the mail')).toBeVisible();
    expect(within(within(card).getByRole('region', { name: 'Removed' })).getByText('Old cache')).toBeVisible();
  });

  it('leaves out a list that is empty', () => {
    render(<RevisionCard revision={revision({ changed: [], dropped: [] })} />);

    expect(screen.getByRole('region', { name: 'Added' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Changed' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Removed' })).toBeNull();
  });

  it('is placed in the feed right after the reply that made the version', () => {
    const entry = (key: string, role: PlanChatEntry['role'], version?: number): PlanChatEntry => ({
      key,
      role,
      text: key,
      state: 'taken',
      at: '2026-11-15T07:11:43.444Z',
      version,
    });
    const entries = [
      entry('reply-one', 'planner', 3),
      { ...entry('message-two', 'person'), at: '2026-11-15T07:12:00.000Z' },
    ];
    const flow = flowView({
      conversation: {
        composer: 'plan',
        replying: false,
        entries,
        revisions: [revision({ at: '2026-11-15T07:11:43.444Z' })],
        questions: [],
      },
    });
    render(<ConversationFeed flow={flow} entries={entries} onResume={vi.fn()} />, { wrapper: Wrapper });

    const reply = screen.getByText('reply-one');
    const card = screen.getByRole('region', { name: 'Plan v3' });
    const next = screen.getByText('message-two');
    expect(reply.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('folds a long list of paths of a plan item after five', () => {
    const files = Array.from({ length: 30 }, (_, index) => `src/file-${index}.ts`);
    const item = `Add logging - files: ${files.join(', ')} - proof: a.spec.ts`;
    render(<RevisionCard revision={revision({ added: [item], changed: [], dropped: [] })} />);

    expect(screen.getByText('src/file-4.ts')).toBeVisible();
    expect(screen.queryByText('src/file-5.ts')).toBeNull();
    expect(screen.getByRole('button', { name: 'and 25 more files' })).toBeVisible();
  });
});
