import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QueryWrapper } from '../../../test/query-wrapper';
import { commandEvents, stepEvent } from '../../../test/step-events';
import { TaskRow } from '../flow/run-screen/task-row';
import { Bubble } from './bubble';
import { TranscriptFeed } from './transcript-feed';

vi.mock('../../../lib/endpoints', () => ({ getHistory: vi.fn() }));

const launch = { runtime: 'claude', model: 'opus', tools: 'write' as const, chatId: null, resumed: false };
const numbered = (from: number, to: number): string =>
  Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`).join('\n');

function feed(events: Parameters<typeof TranscriptFeed>[0]['events']) {
  return render(<TranscriptFeed runKey="run-1" events={events} />, { wrapper: QueryWrapper });
}

function agentWork(...work: Parameters<typeof stepEvent>[1][]) {
  return [
    stepEvent(1, { kind: 'agent.launched', ...launch }),
    ...work.map((body, index) => stepEvent(2 + index, body)),
  ];
}

describe('shortened text', () => {
  it('shows a 5000-char agent message whole', () => {
    const text = `${'a'.repeat(4999)}Z`;
    feed(agentWork({ kind: 'agent.message', text, chars: 5000 }));

    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByText('full exchange')).not.toBeInTheDocument();
  });

  it('marks a message recorded before events kept it whole and links to the full exchange', () => {
    feed(agentWork({ kind: 'agent.message', text: 'a'.repeat(600), chars: 5000 }));

    expect(screen.getByText('full exchange')).toHaveAttribute('href', '#exchanges');
    expect(screen.getByText(/^a{600}…$/)).toBeInTheDocument();
  });

  it('cuts a 400-char tool target at 300 with a mark and opens it whole on click', async () => {
    const target = 'x'.repeat(399) + 'Y';
    feed(agentWork({ kind: 'agent.tool', tool: 'Read', target, status: 'ok', durationMs: 5, resultLine: '' }));

    const button = screen.getByRole('button', { name: `${'x'.repeat(300)}…` });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await userEvent.setup({ delay: null }).click(button);
    expect(screen.getByRole('button', { name: target })).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows the last 40 of 100 lines under a mark and all of them after Show whole output', async () => {
    feed(commandEvents(1, 's', { executable: 'make', output: numbered(1, 100) }));

    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: /Show output/ }));
    expect(screen.getByText(/… 60 earlier lines not shown/)).toBeInTheDocument();
    expect(screen.getByText(/line 100/)).toBeInTheDocument();
    expect(screen.getByText(/line 61 /)).toBeInTheDocument();
    expect(screen.queryByText(/line 1 /)).not.toBeInTheDocument();

    const whole = screen.getByRole('button', { name: 'Show whole output' });
    await userEvent.setup({ delay: null }).click(whole);
    expect(whole).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/line 1 /)).toBeInTheDocument();
    expect(screen.queryByText(/earlier lines not shown/)).not.toBeInTheDocument();
  });

  it('says the omitted lines are in the step log when the server dropped them', async () => {
    feed(commandEvents(1, 's', { executable: 'make', output: numbered(1, 30), omittedLines: 500 }));

    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: /Show output/ }));
    expect(screen.getByText(/^… 500 earlier lines not shown /)).toBeInTheDocument();
    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Show whole output' }));
    expect(
      screen.getByText(/^… 500 earlier lines not shown; the whole output is in the step's log /),
    ).toBeInTheDocument();
  });

  it('carries the whole task title and bubble summary on hover', async () => {
    const title = 'a long task title '.repeat(10).trim();
    const summary = 'a long bubble summary '.repeat(10).trim();
    render(
      <>
        <TaskRow
          task={{ id: 't1', index: 0, title, files: [], proof: '', depends: [], status: 'pending' }}
          dependents={[]}
          onSkip={vi.fn()}
        />
        <Bubble side="left" title={summary} type="agent">
          body
        </Bubble>
      </>,
    );

    const user = userEvent.setup({ delay: null });
    for (const text of [title, summary]) {
      await user.hover(screen.getAllByText(text)[0]);
      expect(await screen.findByRole('tooltip')).toHaveTextContent(text);
      await user.unhover(screen.getAllByText(text)[0]);
      await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
    }
  });
});
