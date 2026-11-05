import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProjectPicker } from './project-picker';

describe('ProjectPicker', () => {
  it('shows frozen projects as chips with no way to remove them', () => {
    render(
      <ProjectPicker
        frozenProjects
        projectOptions={['swarmloop', 'docs']}
        pickedProjects={['swarmloop']}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText('swarmloop')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete|remove|clear/i })).not.toBeInTheDocument();
  });

  it('reports the chosen projects through onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ProjectPicker
        frozenProjects={false}
        projectOptions={['swarmloop', 'docs']}
        pickedProjects={['swarmloop']}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Projects' }));
    await user.click(await screen.findByRole('option', { name: 'docs' }));

    expect(onChange).toHaveBeenCalledWith(['swarmloop', 'docs']);
  });
});
