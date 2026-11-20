import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useRef, useState, type ReactElement } from 'react';
import { fitHeight, useFitWindow } from './use-fit-window';

let renders = 0;

function Probe(): ReactElement {
  const ref = useRef<HTMLButtonElement>(null);
  const [, setTick] = useState(0);
  useFitWindow(ref, true);
  renders += 1;
  return <button type="button" ref={ref} data-testid="box" onClick={() => setTick((t) => t + 1)} />;
}

describe('fitHeight', () => {
  it('ends the box at the bottom of the window, whatever its top', () => {
    expect(fitHeight(500, 900)).toBe(900 - 500 - 16);
  });
  it('treats a box above the sticky gap as sitting at the gap', () => {
    expect(fitHeight(-300, 900)).toBe(900 - 16 - 16);
  });
  it('keeps a usable minimum when the box starts near the bottom', () => {
    expect(fitHeight(880, 900)).toBe(240);
  });
});

describe('useFitWindow', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sets the height from the top on screen and follows a scroll without rendering again', () => {
    window.innerHeight = 800;
    let top = 400;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ top }) as DOMRect);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((run) => {
      run(0);
      return 1;
    });
    renders = 0;
    render(<Probe />);
    expect(screen.getByTestId('box').style.height).toBe(`${800 - 400 - 16}px`);

    top = 16;
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(screen.getByTestId('box').style.height).toBe(`${800 - 16 - 16}px`);
    expect(renders).toBe(1);
  });
});
