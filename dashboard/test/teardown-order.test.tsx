import { render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getOwner } from '../lib/endpoints';

vi.mock('../lib/endpoints', () => ({ getOwner: vi.fn() }));

let answeredAtUnmount: Promise<{ owner: string; others: string[] }> | undefined;

/** Calls the endpoint when it unmounts: after the test's last assertion. */
function Probe() {
  useEffect(
    () => () => {
      answeredAtUnmount = getOwner();
    },
    [],
  );
  return <p>probe</p>;
}

beforeEach(() => {
  vi.mocked(getOwner).mockResolvedValue({ owner: 'acme', others: [] });
});

afterAll(async () => {
  await expect(answeredAtUnmount).resolves.toEqual({ owner: 'acme', others: [] });
});

describe('teardown order', () => {
  it('unmounts a rendered tree before the mocks are reset', () => {
    render(<Probe />);
    expect(screen.getByText('probe')).toBeInTheDocument();
  });
});
