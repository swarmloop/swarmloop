import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { resetEmotionCache } from './test/emotion-cache';
import { resetFakeSocket } from './test/fake-socket';

// Unmount first, so nothing a test rendered runs against a reset mock.
afterEach(() => {
  cleanup();
  resetEmotionCache();
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
