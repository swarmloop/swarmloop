import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { receive, resetFakeSocket } from '../../test/fake-socket';
import { PauseBanner } from './pause-banner';
import { LiveBridgeProvider } from './use-live-bridge';

vi.mock('../../lib/live', async () => (await import('../../test/fake-socket')).fakeLive());

const SENTENCE = 'The server is about to restart; this step starts right after it.';

afterEach(() => {
  resetFakeSocket();
});

describe('PauseBanner', () => {
  it('shows nothing while the server is not paused', () => {
    render(<PauseBanner />, { wrapper: LiveBridgeProvider });
    expect(screen.queryByText(SENTENCE)).toBeNull();
  });

  it('shows the sentence once while the server is paused', () => {
    render(<PauseBanner />, { wrapper: LiveBridgeProvider });
    act(() => receive('server', { paused: true }));
    expect(screen.getAllByText(SENTENCE)).toHaveLength(1);
  });
});
