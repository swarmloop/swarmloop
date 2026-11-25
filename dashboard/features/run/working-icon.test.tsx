import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkingIcon } from './working-icon';

const css = (): string => [...document.querySelectorAll('style')].map((node) => node.textContent ?? '').join('\n');

describe('WorkingIcon', () => {
  it('turns once a second and is still under reduced motion', () => {
    const { container } = render(<WorkingIcon />);

    const svg = container.querySelector('svg') as SVGElement;
    expect(getComputedStyle(svg).animation).toMatch(/1s linear infinite/);
    expect(css()).toMatch(/prefers-reduced-motion: reduce\)\s*\{[^}]*animation:\s*none/);
  });

  it('draws a still dashed circle for the dashed variant', () => {
    const { container } = render(<WorkingIcon dashed />);

    expect(container.querySelector('circle')?.getAttribute('stroke-dasharray')).not.toBeNull();
    expect(getComputedStyle(container.querySelector('svg') as SVGElement).animation).not.toMatch(/infinite/);
  });

  it('forwards its label', () => {
    const { getByRole } = render(<WorkingIcon titleAccess="Working" />);

    expect(getByRole('img', { name: 'Working' })).toBeInTheDocument();
  });
});
