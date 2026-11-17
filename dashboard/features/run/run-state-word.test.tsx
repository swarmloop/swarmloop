import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { StateWord } from '@contract/run-state';
import { RunStateIcon } from './run-state-word';

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
