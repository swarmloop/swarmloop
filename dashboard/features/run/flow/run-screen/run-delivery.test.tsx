import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunDelivery } from './run-delivery';

describe('RunDelivery', () => {
  it('shows each repository with its delivery in words', () => {
    render(
      <RunDelivery
        delivery={[
          { repo: 'web', state: 'read' },
          { repo: 'api', state: 'publishing' },
          { repo: 'docs', state: 'published' },
        ]}
      />,
    );
    expect(screen.getByText('web · only read, nothing to publish')).toBeInTheDocument();
    expect(screen.getByText('api · publishing')).toBeInTheDocument();
    expect(screen.getByText('docs · published')).toBeInTheDocument();
  });

  it('shows nothing without entries', () => {
    const { container } = render(<RunDelivery delivery={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
