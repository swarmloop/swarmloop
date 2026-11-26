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
    expect(card).toHaveTextContent('Runs use your alice@acme.test');
    expect(card).toHaveTextContent('f3a9');
    expect(screen.getByRole('button', { name: 'Test' })).toBeInTheDocument();
  });

  it('says a key ending in the last four characters when only a key is stored', () => {
    render(
      <ConnectionCard card={connectionCard({ status: 'connected', last4: 'f3a9' })} onChanged={() => undefined} />,
    );

    const card = screen.getByRole('region', { name: 'Claude' });
    expect(card).toHaveTextContent('Runs use your key ending in f3a9');
    expect(card).not.toHaveTextContent('· ends in');
  });

  it("says the server's key when the server default is all there is", () => {
    render(
      <ConnectionCard
        card={connectionCard({ status: 'connected', serverDefault: true })}
        onChanged={() => undefined}
      />,
    );

    expect(screen.getByRole('region', { name: 'Claude' })).toHaveTextContent("Runs use the server's key");
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

  it('offers Test but not Disconnect when the server default is all there is', () => {
    render(
      <ConnectionCard
        card={connectionCard({ status: 'connected', serverDefault: true })}
        onChanged={() => undefined}
      />,
    );

    expect(screen.getByRole('button', { name: 'Test' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  });

  it('offers Disconnect once the person stored their own credential next to a server default', () => {
    render(
      <ConnectionCard
        card={connectionCard({ status: 'connected', serverDefault: true, last4: 'f3a9' })}
        onChanged={() => undefined}
      />,
    );

    expect(screen.getByRole('button', { name: 'Test' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });

  it('a card with an unknown logo key still renders', () => {
    render(
      <ConnectionCard card={connectionCard({ logo: 'brand-new', label: 'Brand new' })} onChanged={() => undefined} />,
    );

    expect(screen.getByRole('region', { name: 'Brand new' })).toBeInTheDocument();
  });
});
