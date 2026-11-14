import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { connectionCard } from '../../test/fixtures';
import { ConnectionCard } from './connection-card';

describe('ConnectionCard', () => {
  it('says it is not connected and offers each flow', () => {
    render(<ConnectionCard card={connectionCard()} onChanged={() => undefined} />);

    const card = screen.getByRole('region', { name: 'Claude' });
    expect(card).toHaveTextContent('Not connected');
    expect(screen.getByRole('button', { name: 'Sign in with Claude' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Paste an API key' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  });

  it('shows the account and only the last four characters of the secret', () => {
    render(
      <ConnectionCard
        card={connectionCard({ status: 'connected', account: 'alice@acme.test', last4: 'f3a9' })}
        onChanged={() => undefined}
      />,
    );

    const card = screen.getByRole('region', { name: 'Claude' });
    expect(card).toHaveTextContent('Connected as alice@acme.test');
    expect(card).toHaveTextContent('f3a9');
    expect(screen.getByRole('button', { name: 'Test' })).toBeInTheDocument();
  });

  it('shows the reason when it needs attention', () => {
    render(
      <ConnectionCard
        card={connectionCard({ status: 'attention', reason: 'the key was revoked' })}
        onChanged={() => undefined}
      />,
    );

    expect(screen.getByRole('region', { name: 'Claude' })).toHaveTextContent('Needs attention: the key was revoked');
  });

  it('marks the server default', () => {
    render(<ConnectionCard card={connectionCard({ serverDefault: true })} onChanged={() => undefined} />);

    expect(screen.getByText('Server default')).toBeInTheDocument();
  });

  it('a card with an unknown logo key still renders', () => {
    render(
      <ConnectionCard card={connectionCard({ logo: 'brand-new', label: 'Brand new' })} onChanged={() => undefined} />,
    );

    expect(screen.getByRole('region', { name: 'Brand new' })).toBeInTheDocument();
  });
});
