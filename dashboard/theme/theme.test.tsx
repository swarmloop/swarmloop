import { render, screen } from '@testing-library/react';
import CssBaseline from '@mui/material/CssBaseline';
import Link from '@mui/material/Link';
import { ThemeProvider } from '@mui/material/styles';
import { describe, expect, it, vi } from 'vitest';
import type { TaskEntry } from '@contract/api';
import { TaskRow } from '../features/run/flow/run-screen/task-row';
import { theme } from './theme';

const task: TaskEntry = {
  id: 't1',
  index: 0,
  title: 'Add the column',
  files: [],
  proof: '',
  depends: [],
  status: 'running',
  run: { key: 'run-1-t1', state: 'running', currentStep: 'implement', usd: 0, durationMs: 0 },
};

function renderThemed(children: React.ReactNode) {
  return render(
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {children}
    </ThemeProvider>,
  );
}

describe('dashboard link style', () => {
  it('gives a plain anchor the primary color and no underline', () => {
    renderThemed(<a href="/somewhere">plain</a>);

    const style = getComputedStyle(screen.getByRole('link', { name: 'plain' }));
    expect(style.color).toBe('var(--mui-palette-primary-main)');
    expect(style.textDecoration).toBe('none');
  });

  it('gives a MUI Link the primary color and no underline until hover', () => {
    renderThemed(<Link href="/somewhere">mui</Link>);

    const style = getComputedStyle(screen.getByRole('link', { name: 'mui' }));
    expect(style.color).toBe('var(--mui-palette-primary-main)');
    expect(style.textDecoration).toBe('none');
  });

  it('leaves a run row that styles its own anchor with color inherit', () => {
    renderThemed(
      <ul>
        <TaskRow task={task} dependents={[]} onSkip={vi.fn()} />
      </ul>,
    );

    expect(getComputedStyle(screen.getByRole('link', { name: 'Open run Add the column' })).color).toBe('inherit');
  });
});
