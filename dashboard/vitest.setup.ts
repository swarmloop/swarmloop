import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { resetFakeSocket } from './test/fake-socket';

// Vitest runs afterEach hooks in reverse order: this one runs second, after cleanup has unmounted every component,
// so no component can run an effect against a mock that was already reset.
afterEach(() => {
  vi.resetAllMocks();
  resetFakeSocket();
});

afterEach(cleanup);

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
