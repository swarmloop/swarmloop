import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DisclosureIcon } from './disclosure-icon';

describe('DisclosureIcon', () => {
  it('points right when closed', () => {
    const { container } = render(<DisclosureIcon open={false} />);

    expect(container.querySelector('svg')).toHaveAttribute('data-direction', 'right');
    expect(getComputedStyle(container.querySelector('svg')!).transform).toBe('none');
  });

  it('points down when open', () => {
    const { container } = render(<DisclosureIcon open />);

    expect(container.querySelector('svg')).toHaveAttribute('data-direction', 'down');
    expect(getComputedStyle(container.querySelector('svg')!).transform).toBe('rotate(90deg)');
  });
});
