import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDocumentTitle } from './document-title';

function Page({ title }: { title: string | null }) {
  useDocumentTitle(title);
  return null;
}

describe('useDocumentTitle', () => {
  it('sets the tab to the title and the app name, and restores the app name on unmount', () => {
    const { rerender, unmount } = render(<Page title="Add a stats page" />);
    expect(document.title).toBe('Add a stats page · swarmloop');

    rerender(<Page title="Fix the bug" />);
    expect(document.title).toBe('Fix the bug · swarmloop');

    unmount();
    expect(document.title).toBe('swarmloop');
  });

  it('leaves the tab alone while there is no title', () => {
    document.title = 'swarmloop';
    render(<Page title={null} />);
    expect(document.title).toBe('swarmloop');
  });
});
