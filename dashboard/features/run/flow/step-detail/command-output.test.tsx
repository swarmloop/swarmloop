import { useEffect } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTheme } from '@mui/material/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckCommandView } from '@contract/api';
import { getRunLog } from '../../../../lib/endpoints';
import { receive } from '../../../../test/fake-socket';
import { QueryWrapper } from '../../../../test/query-wrapper';
import { LiveBridgeProvider, useLiveActions } from '../../../shell';
import { CommandOutput } from './command-output';

vi.mock('../../../../lib/endpoints', () => ({ getRunLog: vi.fn() }));
vi.mock('../../../../lib/live', async () => (await import('../../../../test/fake-socket')).fakeLive());

const command = (overrides: Partial<CheckCommandView> = {}): CheckCommandView => ({
  attempt: 'att-1',
  index: 0,
  repo: 'api',
  command: 'tsc --noEmit',
  name: 'types',
  status: 'passed',
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:00:05.000Z',
  exitCode: 0,
  ...overrides,
});

function Watching(): null {
  const { watchRun } = useLiveActions();
  useEffect(() => watchRun('run-1'), [watchRun]);
  return null;
}

function show(row: CheckCommandView) {
  return render(
    <LiveBridgeProvider>
      <Watching />
      <CommandOutput runKey="run-1" command={row} />
    </LiveBridgeProvider>,
    { wrapper: QueryWrapper },
  );
}

/** The offset of each row, as a layout would give it: its line number times 20. */
function layOutRows() {
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
      const number = this.firstElementChild?.textContent;
      return number && /^\d+$/.test(number) ? Number(number) * 20 : 0;
    },
  });
}

const error = createTheme().palette.error.main;

beforeEach(() => {
  layOutRows();
});

describe('CommandOutput', () => {
  it('gives each line its own numbered row, and a copy holds no numbers', async () => {
    const long = (letter: string) => letter.repeat(600);
    vi.mocked(getRunLog).mockResolvedValue(`${long('a')}\n${long('b')}\n${long('c')}\n`);
    show(command());

    const output = await screen.findByLabelText('Output of tsc --noEmit');
    expect(await within(output).findByText(long('c'))).toBeInTheDocument();
    const gutters = ['1', '2', '3'].map((number) => within(output).getByText(number));
    for (const gutter of gutters) {
      expect(gutter).toHaveStyle({ userSelect: 'none' });
    }
    expect(within(output).getByText(long('a'))).not.toHaveStyle({ userSelect: 'none' });
    expect(within(output).getByText(long('b')).textContent).toBe(long('b'));
  });

  it('puts a line with error TS2741 in the error colour and Found 0 errors not', async () => {
    vi.mocked(getRunLog).mockResolvedValue('src/a.ts(1,1): error TS2741: missing\nFound 0 errors.\n');
    show(command());

    expect(await screen.findByText(/error TS2741/)).toHaveStyle({ color: error });
    expect(screen.getByText('Found 0 errors.')).not.toHaveStyle({ color: error });
  });

  it('opens a failed command at its first error line, and the first error link goes there again', async () => {
    vi.mocked(getRunLog).mockResolvedValue('start\nsrc/a.ts: error TS1\nmore\nsrc/b.ts: error TS2\n');
    show(command({ status: 'failed', exitCode: 2 }));

    const output = await screen.findByLabelText('Output of tsc --noEmit');
    await screen.findByText('src/a.ts: error TS1');
    expect(output.scrollTop).toBe(40);

    output.scrollTop = 0;
    await userEvent.click(screen.getByRole('button', { name: 'first error' }));
    expect(output.scrollTop).toBe(40);
  });

  it('draws a row for every line of a very long output, the first and the last included', async () => {
    const lines = Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`);
    vi.mocked(getRunLog).mockResolvedValue(`${lines.join('\n')}\n`);
    show(command());

    const output = await screen.findByLabelText('Output of tsc --noEmit');
    expect(await within(output).findByText('line 5000')).toBeInTheDocument();
    expect(within(output).getByText('line 1')).toBeInTheDocument();
    expect(within(output).queryByText(/lines not shown/)).toBeNull();
  });

  it('has no first error link for a command that passed', async () => {
    vi.mocked(getRunLog).mockResolvedValue('error TS1\n');
    show(command());

    await screen.findByText('error TS1');
    expect(screen.queryByRole('button', { name: 'first error' })).toBeNull();
    expect(screen.getByLabelText('Output of tsc --noEmit').scrollTop).toBe(0);
  });

  it('brings the live lines of a running command into the same view', () => {
    show(command({ status: 'running', endedAt: null }));

    act(() => receive('log', { key: 'run-1', step: 'checks', command: 0, body: 'compiling\nlinking\n' }));

    expect(screen.getByText('linking')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('says a command that never ran has no output', () => {
    show(command({ status: 'waiting', startedAt: null, endedAt: null }));

    expect(screen.getByText('no output: it did not run')).toBeInTheDocument();
  });
});
