import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LogTranscript } from './log-transcript';

describe('LogTranscript', () => {
  it('renders each message from the raw log', () => {
    render(<LogTranscript raw={'starting the agent\nreading the plan'} />);

    expect(screen.getByText('starting the agent')).toBeInTheDocument();
    expect(screen.getByText('reading the plan')).toBeInTheDocument();
  });

  it('renders nothing for an empty log', () => {
    const { container } = render(<LogTranscript raw="" />);

    expect(container).toBeEmptyDOMElement();
  });
});
