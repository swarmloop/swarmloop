import { afterEach, beforeEach } from 'vitest';

/** Sets the window to a phone width for each test of the file. */
export function narrowViewport(width = 320): void {
  let before = window.innerWidth;
  beforeEach(() => {
    before = window.innerWidth;
    window.innerWidth = width;
  });
  afterEach(() => {
    window.innerWidth = before;
  });
}

const WRAPS = ['anywhere', 'break-word'];

/**
 * The elements under `root` that would push the page sideways: text that may not wrap (`pre`, `nowrap`), or a long
 * word with no `overflow-wrap` on it or on an ancestor. jsdom has no layout, so this reads the computed styles.
 */
export function overflowing(root: HTMLElement, longWord = 40): HTMLElement[] {
  const wraps = (element: HTMLElement | null): boolean =>
    element !== null && (WRAPS.includes(getComputedStyle(element).overflowWrap) || wraps(element.parentElement));
  return [...root.querySelectorAll<HTMLElement>('*')].filter((element) => {
    const white = getComputedStyle(element).whiteSpace;
    if (white === 'pre' || white === 'nowrap') {
      return true;
    }
    const own = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE);
    const long = own.some((node) => (node.textContent ?? '').split(/\s+/).some((word) => word.length > longWord));
    return long && !wraps(element);
  });
}
