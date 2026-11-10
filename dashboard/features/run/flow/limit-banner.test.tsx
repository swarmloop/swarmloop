import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { localTime } from '../../../lib/format';
import { flowView } from '../../../test/fixtures';
import { LimitBanner } from './limit-banner';

const limit = { runtime: 'claude', resetsAt: '2026-11-08T21:50:00.000Z', resumesAt: '2026-11-08T21:51:00.000Z' };

describe('LimitBanner', () => {
  it('shows the runtime, the reset and when the run goes on, in the viewer’s time', () => {
    const flow = flowView({
      status: 'waiting',
      state: 'waiting',
      stateReason: { code: 'RUNTIME_LIMIT', message: 'Claude hit its usage limit.', limit },
    });
    render(<LimitBanner flow={flow} />);

    expect(
      screen.getByText(
        `Claude hit its usage limit (resets ${localTime(limit.resetsAt)}). The run goes on at ${localTime(limit.resumesAt)}.`,
      ),
    ).toBeInTheDocument();
  });

  it('shows nothing for a run that waits for another reason', () => {
    const flow = flowView({
      status: 'waiting',
      state: 'waiting',
      stateReason: { code: 'NEEDS_ANSWERS', message: 'x' },
    });
    const { container } = render(<LimitBanner flow={flow} />);

    expect(container).toBeEmptyDOMElement();
  });
});
