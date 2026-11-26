import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FoldedText } from './folded-text';

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');

describe('FoldedText', () => {
  it('clamps a 20-line text to five lines and shows the rest on Show all', async () => {
    const user = userEvent.setup({ delay: null });
    render(<FoldedText text={lines(20)} />);

    const body = screen.getByText(/line 1/);
    expect(body.parentElement).toHaveStyle({ WebkitLineClamp: '5', overflow: 'hidden' });
    await user.click(screen.getByRole('button', { name: 'Show all' }));
    expect(body.parentElement).not.toHaveStyle({ WebkitLineClamp: '5' });
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
  });

  it('shows no button for a text of five lines', () => {
    render(<FoldedText text={lines(5)} />);

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the button for a box that overflows its clamp once laid out', () => {
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 200 });
    try {
      render(
        <FoldedText>
          <p>one long wrapped paragraph</p>
        </FoldedText>,
      );

      expect(screen.getByRole('button', { name: 'Show all' })).toBeInTheDocument();
    } finally {
      if (height) {
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', height);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
      }
    }
  });
});
