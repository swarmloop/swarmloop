import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { getHistory } from '../../../lib/endpoints';
import { historyView } from '../../../test/fixtures';
import { QueryWrapper } from '../../../test/query-wrapper';
import { commandEvents, stepEvent } from '../../../test/step-events';
import { overflowing, narrowViewport } from '../../../test/viewport';
import { TranscriptFeed } from './transcript-feed';
import { issueLinks } from './transcript-model';

vi.mock('../../../lib/endpoints', () => ({ getHistory: vi.fn() }));

narrowViewport();

const input = stepEvent(1, {
  kind: 'input.received',
  name: 'plan',
  inputKind: 'plan',
  documentId: 3,
  summary: 'the plan',
});
const artifact = stepEvent(3, {
  kind: 'artifact.produced',
  artifactKind: 'diff',
  documentId: 4,
  summary: 'a diff of 3 files',
});

function feed(events: Parameters<typeof TranscriptFeed>[0]['events']) {
  const view = render(<TranscriptFeed runKey="run-1" events={events} />, { wrapper: QueryWrapper });
  return {
    ...view,
    again: (next: typeof events) => view.rerender(<TranscriptFeed runKey="run-1" events={next} />),
  };
}

function scrollBox() {
  const box = screen.getByTestId('transcript-feed');
  Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(box, 'clientHeight', { configurable: true, value: 100 });
  return box;
}

describe('TranscriptFeed', () => {
  it('shows a failed command as an error with the word, an accessible name, its cause, id and action', () => {
    feed([...commandEvents(1, 's', { executable: 'make', args: ['test'], exitCode: 2 })]);

    const card = screen.getByRole('article', { name: 'Error: exit code 2' });
    expect(within(card).getByText('Error')).toBeInTheDocument();
    expect(within(card).getByText('exit code 2')).toBeInTheDocument();
    expect(within(card).getByText(/command: make test · id event-1/)).toBeInTheDocument();
    expect(card).toHaveAttribute('id', 'problem-event-1');
  });

  it('puts inputs and actions in seq order under a divider for each attempt', () => {
    const second = { attemptId: 'attempt-2' };
    feed([
      input,
      stepEvent(2, { kind: 'attempt.finished', route: 'return', summary: 'tests failed' }),
      stepEvent(4, { kind: 'attempt.started', stepKind: 'server', agent: null }, second),
      stepEvent(
        5,
        { kind: 'artifact.produced', artifactKind: 'diff', documentId: 4, summary: 'a diff of 3 files' },
        second,
      ),
    ]);

    const dividers = screen.getAllByRole('separator').map((item) => item.textContent);
    expect(dividers).toEqual(['Attempt 1 · first runMoved to return', 'Attempt 2 · run again']);
    const text = screen.getByTestId('transcript-feed').textContent ?? '';
    expect(text.indexOf('the plan')).toBeLessThan(text.lastIndexOf('Moved to return'));
    expect(text.lastIndexOf('Moved to return')).toBeLessThan(text.indexOf('a diff'));
  });

  it('lists every check of the pipeline attempt and opens the annotations of a failed one', async () => {
    const user = userEvent.setup();
    const check = { durationMs: 65000, url: '', summary: '', annotations: [] };
    feed([
      stepEvent(
        2,
        {
          kind: 'attempt.finished',
          route: 'return',
          summary: 'pipeline failed',
          facts: {
            details: ['group/demo: success'],
            checks: [
              { ...check, name: 'ci / lint', app: 'GitHub Actions', status: 'success', url: 'https://ci.example/lint' },
              {
                ...check,
                name: 'Code scanning results',
                app: 'CodeQL',
                status: 'failed',
                summary: '2 new alerts',
                annotations: [
                  { path: 'src/a.ts', line: 3, level: 'failure', title: 'Path injection', message: 'first' },
                  { path: 'src/b.ts', line: 8, level: 'warning', title: '', message: 'second' },
                ],
              },
            ],
          },
        },
        { step: 'pipeline' },
      ),
    ]);

    const list = screen.getByRole('list', { name: 'Checks' });
    expect(within(list).getByText(/ci \/ lint · GitHub Actions · success · 1m/)).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Open ci / lint' })).toHaveAttribute(
      'href',
      'https://ci.example/lint',
    );
    expect(within(list).getByText(/Code scanning results · CodeQL · failed/)).toBeInTheDocument();
    expect(screen.queryByText(/src\/a.ts:3/)).not.toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: /ci \/ lint/ })).not.toBeInTheDocument();

    await user.click(within(list).getByRole('button', { name: 'Show annotations of Code scanning results' }));
    const notes = screen.getByRole('list', { name: 'Annotations of Code scanning results' });
    expect(within(notes).getByText('2 new alerts')).toBeInTheDocument();
    expect(within(notes).getByText('src/a.ts:3 · failure · Path injection: first')).toBeInTheDocument();
    expect(within(notes).getByText('src/b.ts:8 · warning · second')).toBeInTheDocument();
  });

  it('keeps the order when a filter is chosen', () => {
    feed([
      input,
      ...commandEvents(2, 's', { executable: 'make', exitCode: 1 }),
      stepEvent(4, { kind: 'handoff.received', handoffId: 7, issueIds: ['i'] }),
      artifact,
    ]);

    expect(screen.queryByRole('button', { name: /^(all|inputs|actions|problems)\b/ })).not.toBeInTheDocument();
    const text = screen.getByTestId('transcript-feed').textContent ?? '';
    expect(text.indexOf('the plan')).toBeLessThan(text.indexOf('make'));
    expect(text.indexOf('make')).toBeLessThan(text.indexOf('From pipeline / review'));
  });

  it('shows a chip for the problems that scrolls to the first one', async () => {
    const user = userEvent.setup();
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    feed([
      ...commandEvents(1, 's', { executable: 'make', exitCode: 1 }),
      ...commandEvents(4, 's', { executable: 'lint', exitCode: 2 }),
    ]);

    await user.click(screen.getByRole('button', { name: '2 problems' }));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(document.getElementById('problem-event-1'));
  });

  it('folds seven consecutive actions into one expandable row', async () => {
    const user = userEvent.setup();
    const run = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        commandEvents(index * 3 + 1, `s${index}`, { executable: `tool${index}` }),
      ).flat();
    const view = feed(run(7));

    expect(screen.queryByText(/tool0/)).not.toBeVisible();
    await user.click(screen.getByRole('button', { name: '7 actions' }));
    expect(screen.getByText(/tool6/)).toBeVisible();

    view.unmount();
    feed(run(5));
    expect(screen.queryByRole('button', { name: /actions$/ })).not.toBeInTheDocument();
    expect(screen.getByText(/tool4/)).toBeInTheDocument();
  });

  it('follows new events while the reader is at the bottom', () => {
    const { again } = feed([input]);
    const box = scrollBox();
    box.scrollTop = 0;

    again([input, artifact]);

    expect(box.scrollTop).toBe(1000);
    expect(screen.queryByRole('button', { name: 'New messages' })).not.toBeInTheDocument();
  });

  it('stops following once the reader scrolled up, and offers the new messages instead', async () => {
    const user = userEvent.setup();
    const { again } = feed([input]);
    const box = scrollBox();
    box.scrollTop = 0;
    fireEvent.scroll(box);

    again([input, artifact]);

    expect(box.scrollTop).toBe(0);
    await user.click(screen.getByRole('button', { name: 'New messages' }));
    expect(box.scrollTop).toBe(1000);
    expect(screen.queryByRole('button', { name: 'New messages' })).not.toBeInTheDocument();
  });

  it('wraps a long command line and a 5000-line output inside the feed', async () => {
    const user = userEvent.setup();
    const long = 'x'.repeat(400);
    const output = Array.from({ length: 5000 }, (_, index) => `line ${index} ${long}`).join('\n');
    const { container } = feed(commandEvents(1, 's', { executable: 'curl', args: [long], output }));

    expect(screen.queryByText(/line 4999/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Show output/ }));

    expect(await screen.findByText(/line 4999/)).toBeInTheDocument();
    expect(window.innerWidth).toBe(320);
    // Code scrolls sideways inside its own block and the header cuts a long title with an ellipsis; the rest wraps.
    const clipped = (element: HTMLElement) =>
      element.closest('[data-code]') !== null || getComputedStyle(element).textOverflow === 'ellipsis';
    expect(overflowing(container).filter((element) => !clipped(element))).toEqual([]);
  });

  it('says so when the output of a command is not stored', () => {
    feed(commandEvents(1, 's', { executable: 'ls' }));

    expect(screen.queryByRole('button', { name: /^Show output/ })).not.toBeInTheDocument();
  });

  it('reads the history once for every card that opens its document', async () => {
    const user = userEvent.setup();
    vi.mocked(getHistory).mockResolvedValue(historyView());
    feed([
      stepEvent(1, { kind: 'artifact.produced', artifactKind: 'plan', documentId: 3, summary: 'a plan' }),
      stepEvent(2, { kind: 'artifact.produced', artifactKind: 'diff', documentId: 4, summary: 'a diff' }),
    ]);

    for (const button of screen.getAllByRole('button', { name: 'Show document' })) {
      await user.click(button);
    }
    await act(async () => {});

    expect(getHistory).toHaveBeenCalledTimes(1);
  });

  it('links the input card of a returned issue to the source card and marks it resolved', () => {
    const source = [
      stepEvent(
        1,
        { kind: 'issue.opened', issueId: 'i-1', source: 'pipeline', title: 'lint failed' },
        { step: 'pipeline' },
      ),
      stepEvent(9, { kind: 'issue.resolved', issueId: 'i-1', evidence: 'pipeline a-2' }, { step: 'pipeline' }),
    ];
    const target = [stepEvent(5, { kind: 'handoff.received', handoffId: 3, issueIds: ['i-1'] })];
    render(<TranscriptFeed runKey="run-1" events={target} issues={issueLinks(source)} />, {
      wrapper: QueryWrapper,
    });

    expect(screen.getByText('Input from pipeline / review')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'lint failed' })).toHaveAttribute('href', '#problem-event-1');
    expect(screen.getByText(/resolved/)).toBeInTheDocument();
  });

  it('shows the problem card of an issue and the card of its resolution side by side', () => {
    feed([
      stepEvent(1, { kind: 'issue.opened', issueId: 'i-1', source: 'pipeline', title: 'lint failed' }),
      stepEvent(2, { kind: 'issue.resolved', issueId: 'i-1', evidence: 'pipeline a-2' }),
    ]);

    expect(screen.getByRole('article', { name: 'Error: lint failed' })).toHaveAttribute('id', 'problem-event-1');
    expect(screen.getByText('Issue resolved')).toBeInTheDocument();
  });

  it('shows a handoff that carries issues as returned to its target step', () => {
    const events = [
      stepEvent(
        1,
        {
          kind: 'handoff.sent',
          handoffId: 3,
          targetStep: 'implement',
          artifactKinds: [],
          issueIds: ['i-1'],
        },
        { step: 'pipeline' },
      ),
    ];
    render(<TranscriptFeed runKey="run-1" events={events} />, { wrapper: QueryWrapper });

    expect(screen.getByText('Passed to implement')).toBeInTheDocument();
  });
});
