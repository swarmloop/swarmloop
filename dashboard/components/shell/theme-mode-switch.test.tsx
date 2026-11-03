import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { describe, expect, it } from 'vitest';
import { ThemeModeSwitch } from './theme-mode-switch';

const theme = createTheme({ cssVariables: true, colorSchemes: { light: true, dark: true } });

describe('ThemeModeSwitch', () => {
  it('shows light, system, and dark toggles and presses dark after a click', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider theme={theme}>
        <ThemeModeSwitch />
      </ThemeProvider>,
    );

    expect(await screen.findByRole('button', { name: 'light' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'system' })).toBeInTheDocument();
    const dark = screen.getByRole('button', { name: 'dark' });
    expect(dark).toBeInTheDocument();

    await user.click(dark);

    expect(dark).toHaveAttribute('aria-pressed', 'true');
  });
});
