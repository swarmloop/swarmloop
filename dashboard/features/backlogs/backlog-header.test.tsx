import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addBacklogRepository, getRepositoryMain, pauseBacklog, unpauseBacklog } from '../../lib/backlog-endpoints';
import { listProjects, listRemote } from '../../lib/endpoints';
import { backlogView } from '../../test/backlog-fixtures';
import { BacklogHeader } from './backlog-header';

vi.mock('../../lib/backlog-endpoints', () => ({
  getRepositoryMain: vi.fn(),
  addBacklogRepository: vi.fn(),
  pauseBacklog: vi.fn(),
  unpauseBacklog: vi.fn(),
}));
vi.mock('../../lib/endpoints', () => ({ createRepository: vi.fn(), listProjects: vi.fn(), listRemote: vi.fn() }));

const main = (repository: string, state: 'green' | 'pending' | 'red', url: string | null = null) => ({
  repository,
  branch: 'main',
  state,
  head: null,
  failingJobs: [],
  durationMs: null,
  url,
});

beforeEach(() => {
  vi.mocked(getRepositoryMain).mockResolvedValue(main('shop', 'green'));
  vi.mocked(listProjects).mockResolvedValue({ projects: ['shop', 'api'] });
  vi.mocked(listRemote).mockResolvedValue({ repositories: [], owners: [], reason: null, allowedNames: [] });
});

describe('BacklogHeader', () => {
  it('shows the name and each repository with its main in words, the url as a link', async () => {
    vi.mocked(getRepositoryMain).mockImplementation(async (name) =>
      name === 'shop'
        ? main(name, 'green', 'https://host/shop')
        : name === 'api'
          ? main(name, 'pending')
          : main(name, 'red'),
    );
    render(<BacklogHeader view={backlogView({ repositories: ['shop', 'api', 'web'] })} login="ada" onView={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'swarmloop' })).toBeInTheDocument();
    expect(await screen.findByLabelText('shop: main is green')).toHaveAttribute('href', 'https://host/shop');
    expect(await screen.findByLabelText('api: main is running')).not.toHaveAttribute('href');
    expect(await screen.findByLabelText('web: main is red')).toBeInTheDocument();
  });

  it('shows the + chip to the owner only', () => {
    const { rerender } = render(<BacklogHeader view={backlogView()} login="ada" onView={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Add a repository' })).toBeInTheDocument();

    rerender(<BacklogHeader view={backlogView()} login="bob" onView={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Add a repository' })).not.toBeInTheDocument();
  });

  it('adds the picked repository and hands the answer on', async () => {
    const answer = backlogView({ repositories: ['shop', 'api'] });
    vi.mocked(addBacklogRepository).mockResolvedValue(answer);
    const onView = vi.fn();
    render(<BacklogHeader view={backlogView()} login="ada" onView={onView} />);

    await userEvent.click(screen.getByRole('button', { name: 'Add a repository' }));
    await userEvent.click(await screen.findByRole('combobox', { name: 'Projects' }));
    expect(screen.queryByRole('option', { name: 'shop' })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('option', { name: 'api' }));

    expect(addBacklogRepository).toHaveBeenCalledWith('swarmloop', { repository: 'api' });
    expect(onView).toHaveBeenCalledWith(answer);
  });

  it('shows the pause switch to a signed-in person and toggles it', async () => {
    vi.mocked(pauseBacklog).mockResolvedValue(backlogView({ paused: true }));
    vi.mocked(unpauseBacklog).mockResolvedValue(backlogView({ paused: false }));
    const onView = vi.fn();
    const { rerender } = render(<BacklogHeader view={backlogView()} login="bob" onView={onView} />);

    await userEvent.click(screen.getByRole('switch', { name: 'Paused' }));
    expect(pauseBacklog).toHaveBeenCalledWith('swarmloop');
    expect(onView).toHaveBeenCalledWith(backlogView({ paused: true }));

    rerender(<BacklogHeader view={backlogView({ paused: true })} login="bob" onView={onView} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Paused' }));
    expect(unpauseBacklog).toHaveBeenCalledWith('swarmloop');

    rerender(<BacklogHeader view={backlogView()} login={null} onView={onView} />);
    expect(screen.queryByRole('switch', { name: 'Paused' })).not.toBeInTheDocument();
  });

  it('shows a refusal as an alert without a confirm', async () => {
    vi.mocked(pauseBacklog).mockRejectedValue(new Error('Only members may pause'));
    render(<BacklogHeader view={backlogView()} login="bob" onView={vi.fn()} />);

    await userEvent.click(screen.getByRole('switch', { name: 'Paused' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Only members may pause');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
