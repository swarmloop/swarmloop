import { render, screen } from '@testing-library/react';
import { usePathname } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mediaWidth } from '../../test/viewport';
import { MainNav } from './main-nav';

vi.mock('next/navigation', () => ({ usePathname: vi.fn() }));

beforeEach(() => {
  vi.mocked(usePathname).mockReturnValue('/');
});

describe('MainNav at 375 px', () => {
  mediaWidth(375);

  it('gives each link a 40 px touch target', () => {
    render(<MainNav />);
    for (const name of ['Runs', 'Backlogs']) {
      expect(screen.getByRole('link', { name })).toHaveStyle({ minHeight: '40px' });
    }
  });
});

describe('MainNav at 1280 px', () => {
  mediaWidth(1280);

  it('sets no minimum height and marks the current page', () => {
    render(<MainNav />);
    expect(screen.getByRole('link', { name: 'Runs' })).not.toHaveStyle({ minHeight: '40px' });
    expect(screen.getByRole('link', { name: 'Runs' })).toHaveAttribute('aria-current', 'page');
  });
});
