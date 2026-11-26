import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { stateWord, type StateWord } from '@contract/run-state';
import { RunStateIcon } from './run-state-word';
import { StepStateIcon } from './step-state-icon';

const working: StateWord = { word: 'Working', tone: 'working', icon: 'working', tip: '' };
const person: StateWord = { word: 'Waiting for you', tone: 'person', icon: 'person', tip: 'Answer the questions' };

const pending: StateWord = { word: 'Waiting to start', tone: 'working', icon: 'pending', tip: '' };

describe('RunStateIcon', () => {
  it('renders the pending icon labelled with its word', () => {
    render(<RunStateIcon view={pending} />);

    expect(screen.getByRole('img', { name: 'Waiting to start' })).toBeInTheDocument();
  });

  it('carries the word in the label and the tooltip', async () => {
    render(<RunStateIcon view={working} />);

    const icon = screen.getByRole('img', { name: 'Working' });
    await userEvent.setup({ delay: null }).hover(icon);

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Working');
  });

  it('adds the tip to the word', () => {
    render(<RunStateIcon view={person} />);

    expect(screen.getByRole('img', { name: 'Waiting for you: Answer the questions' })).toBeInTheDocument();
  });

  it('shows the word of a blocked run that a git rule of the repository stopped', () => {
    const reason = { code: 'GIT_RULES', message: 'title must start with a ticket refuses feat: add x' };
    render(<RunStateIcon view={stateWord('blocked', reason, {}, (iso) => iso)} />);

    expect(
      screen.getByRole('img', {
        name: 'Waits for you: a git rule of the repository: title must start with a ticket refuses feat: add x',
      }),
    ).toBeInTheDocument();
  });

  it('colors the icon by the tone', () => {
    render(
      <>
        <RunStateIcon view={working} />
        <RunStateIcon view={person} />
      </>,
    );

    const [first, second] = screen.getAllByRole('img');
    expect(getComputedStyle(first).color).not.toBe('');
    expect(getComputedStyle(first).color).not.toBe(getComputedStyle(second).color);
  });
});

describe('RunStateIcon working and retrying', () => {
  it('renders the turning ring for a working run, not Autorenew', () => {
    render(<RunStateIcon view={working} />);

    const icon = screen.getByRole('img', { name: 'Working' });
    expect(icon.querySelector('path')).not.toBeNull();
    expect(icon.getAttribute('data-testid')).not.toBe('AutorenewIcon');
  });

  it('renders the dashed circle for a preparing step and the ring for a working one', () => {
    const state = (icon: 'working' | 'preparing') => ({ icon, tone: 'working' as const, label: icon });
    const { container, rerender } = render(<StepStateIcon state={state('preparing') as never} />);
    expect(container.querySelector('circle')).not.toBeNull();

    rerender(<StepStateIcon state={state('working') as never} />);
    expect(container.querySelector('circle')).toBeNull();
    expect(container.querySelector('path')).not.toBeNull();
  });

  it('keeps its own icon for a retrying run', () => {
    render(<RunStateIcon view={{ word: 'Retrying', tone: 'working', icon: 'retrying', tip: '' }} />);

    expect(screen.getByRole('img', { name: 'Retrying' }).getAttribute('data-testid')).toBe('ReplayIcon');
  });
});
