import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteEntry, RemoteListView } from '@contract/api';
import { ProjectPicker } from './project-picker';

const entry = (owner: string, name: string, extra: Partial<RemoteEntry> = {}): RemoteEntry => ({
  host: 'github',
  owner,
  name,
  visibility: 'private',
  defaultBranch: 'main',
  cloned: false,
  ...extra,
});

const view = (repositories: RemoteEntry[], extra: Partial<RemoteListView> = {}): RemoteListView => ({
  repositories,
  owners: [{ host: 'github', login: 'acme', kind: 'organization' }],
  reason: null,
  allowedNames: [],
  ...extra,
});

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
  it('lists local folders first and then the repositories that are not cloned, tagged', async () => {
    const user = userEvent.setup();
    render(
      <ProjectPicker
        frozenProjects={false}
        projectOptions={['swarmloop']}
        pickedProjects={[]}
        onChange={vi.fn()}
        remote={view([entry('acme', 'billing'), entry('acme', 'swarmloop', { cloned: true })])}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Projects' }));
    const options = await screen.findAllByRole('option');

    expect(options.map((option) => option.textContent)).toEqual(['swarmloop', 'privateacme/billingnot cloned']);
  });

  it('searches the owner and name of remote entries and picks one by its folder name', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ProjectPicker
        frozenProjects={false}
        projectOptions={['swarmloop', 'docs']}
        pickedProjects={['docs']}
        onChange={onChange}
        remote={view([entry('acme', 'billing'), entry('other', 'tool')])}
      />,
    );

    await user.type(screen.getByRole('combobox', { name: 'Projects' }), 'acme/bil');
    expect(screen.queryByRole('option', { name: /tool/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: /acme\/billing/ }));

    expect(onChange).toHaveBeenCalledWith(['docs', 'billing']);
  });

  it('disables a blocked entry and shows why', async () => {
    const user = userEvent.setup();
    render(
      <ProjectPicker
        frozenProjects={false}
        projectOptions={[]}
        pickedProjects={[]}
        onChange={vi.fn()}
        remote={view([entry('acme', 'billing', { blocked: 'billing already exists as a folder for another remote' })])}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Projects' }));

    expect(await screen.findByRole('option', { name: /acme\/billing/ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('billing already exists as a folder for another remote')).toBeInTheDocument();
  });

  it('says why there is nothing remote, and disables New repository with that reason', async () => {
    const user = userEvent.setup();
    render(
      <ProjectPicker
        frozenProjects={false}
        projectOptions={[]}
        pickedProjects={[]}
        onChange={vi.fn()}
        remote={view([], { owners: [], reason: 'GITHUB_TOKEN or GITLAB_TOKEN is missing' })}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Projects' }));

    expect(await screen.findByText('GITHUB_TOKEN or GITLAB_TOKEN is missing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New repository' })).toBeDisabled();
  });
});
