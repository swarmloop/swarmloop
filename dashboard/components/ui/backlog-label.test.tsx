import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ListItemButton from '@mui/material/ListItemButton';
import { describe, expect, it, vi } from 'vitest';
import { BacklogLabel } from './backlog-label';

describe('BacklogLabel', () => {
  it('reads the name and milestone and links to the backlog', () => {
    render(<BacklogLabel label={{ name: 'swarmloop', milestone: 3 }} />);

    const link = screen.getByRole('link', { name: 'Open backlog swarmloop' });
    expect(link).toHaveTextContent('swarmloop · M3');
    expect(link).toHaveAttribute('href', '/backlogs/swarmloop');
  });

  it('reads the name alone with no milestone', () => {
    render(<BacklogLabel label={{ name: 'swarmloop', milestone: null }} />);

    expect(screen.getByRole('link')).toHaveTextContent(/^swarmloop$/);
  });

  it('does not pass the click to a clickable parent', async () => {
    const user = userEvent.setup({ delay: null });
    const onParent = vi.fn();
    render(
      <ListItemButton component="div" onClick={onParent}>
        <BacklogLabel label={{ name: 'swarmloop', milestone: 3 }} />
      </ListItemButton>,
    );

    await user.click(screen.getByRole('link'));

    expect(onParent).not.toHaveBeenCalled();
  });
});
