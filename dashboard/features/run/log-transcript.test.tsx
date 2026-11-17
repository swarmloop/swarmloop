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

  it('shows the message type in the UI font and a shell block in the monospace font', () => {
    const raw = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Running the tests.' }] } },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'npm test' } }] },
      },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'ok' }] } },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n');
    const { container } = render(<LogTranscript raw={raw} />);

    const fontOf = (element: Element | null) => getComputedStyle(element as HTMLElement).fontFamily;
    const header = container.firstElementChild?.firstElementChild?.firstElementChild;
    expect(header).toHaveTextContent('assistant');
    expect(fontOf(header ?? null)).not.toContain('--font-mono');
    expect(fontOf(container.querySelector('pre'))).toContain('var(--font-mono)');
  });
});
