import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DocumentBody } from './document-detail';

const first = 'project: group/demo\niid: 1\nurl: https://code.example/demo/1\ndraft: true\n\nShips the field.';
const second = 'project: group/web\niid: 2\nurl: https://code.example/web/2\ndraft: false';

describe('merge request document', () => {
  it('shows Draft or Ready next to each link', () => {
    render(<DocumentBody kind="merge_request" body={`${first}\n\n${second}\n`} />);
    const draft = screen.getByRole('link', { name: 'https://code.example/demo/1' });
    const ready = screen.getByRole('link', { name: 'https://code.example/web/2' });
    expect(draft.parentElement?.textContent).toContain('Draft');
    expect(draft.parentElement?.textContent).toContain('Ships the field.');
    expect(ready.parentElement?.textContent).toContain('Ready');
    expect(ready.parentElement?.textContent).not.toContain('Draft');
  });

  it('reads a document from before drafts as ready', () => {
    render(
      <DocumentBody kind="merge_request" body={'project: group/demo\niid: 1\nurl: https://code.example/demo/1\n'} />,
    );
    expect(screen.getByRole('link').parentElement?.textContent).toContain('Ready');
  });
});
