import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { flowView } from '../../../test/fixtures';
import { GitAuthBanner } from './git-auth-banner';

describe('GitAuthBanner', () => {
  it('asks the person to reconnect, with a link to Connections', () => {
    const flow = flowView({
      status: 'waiting',
      state: 'waiting',
      stateReason: { code: 'GIT_AUTH', message: 'Reconnect GitHub' },
    });
    render(<GitAuthBanner flow={flow} />);

    expect(screen.getByText(/Reconnect GitHub/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connections' })).toHaveAttribute('href', '/connections');
  });

  it('shows nothing for a run that waits for another reason', () => {
    const flow = flowView({
      status: 'waiting',
      state: 'waiting',
      stateReason: { code: 'NEEDS_ANSWERS', message: 'x' },
    });
    const { container } = render(<GitAuthBanner flow={flow} />);

    expect(container).toBeEmptyDOMElement();
  });
});
