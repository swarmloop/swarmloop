import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QuestionCard } from './question-card';

describe('QuestionCard', () => {
  const parts = {
    decide: 'Which database?',
    sides: [
      { who: 'run planner', text: 'Use sqlite.' },
      { who: 'run planner', text: 'Or postgres.' },
    ],
    full: '',
    askedAt: '2026-01-01T00:00:00.000Z',
    asker: 'research',
  };

  it('shows two sides that share a who', () => {
    render(<QuestionCard item={{ label: 'Which database?', parts }} />);

    expect(screen.getAllByText('run planner')).toHaveLength(2);
    expect(screen.getByText('Use sqlite.')).toBeInTheDocument();
    expect(screen.getByText('Or postgres.')).toBeInTheDocument();
  });

  it('says who asks', () => {
    render(<QuestionCard item={{ label: 'Which database?', parts }} />);

    expect(screen.getByText('Research asks')).toBeInTheDocument();
  });
});
