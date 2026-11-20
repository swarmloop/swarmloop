'use client';

import { type RefObject, useLayoutEffect } from 'react';

const GAP_PX = 16;
const MIN_HEIGHT_PX = 240;

/** The height that ends a box at the bottom of the window, from where its top is on screen (never above the sticky gap). */
export function fitHeight(top: number, viewportHeight: number): number {
  return Math.max(viewportHeight - Math.max(top, GAP_PX) - GAP_PX, MIN_HEIGHT_PX);
}

/**
 * Keeps the height of `ref` so that its bottom is the bottom of the window, on scroll and resize. The height goes
 * straight to the node, at most once per frame, so scrolling does not render the React tree again.
 */
export function useFitWindow(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!active || !node) {
      return undefined;
    }
    let frame = 0;
    const apply = (): void => {
      frame = 0;
      node.style.height = `${fitHeight(node.getBoundingClientRect().top, window.innerHeight)}px`;
    };
    const schedule = (): void => {
      if (frame === 0) {
        frame = window.requestAnimationFrame(apply);
      }
    };
    apply();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.cancelAnimationFrame(frame);
      node.style.height = '';
    };
  }, [ref, active]);
}
