import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { resetFakeSocket } from './test/fake-socket';

afterEach(cleanup);

afterEach(() => {
  vi.resetAllMocks();
  resetFakeSocket();
});

// jsdom has no matchMedia, and MUI's color-scheme code reads it.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});
