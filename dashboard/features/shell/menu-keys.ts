import type { KeyboardEvent, RefObject } from 'react';
import { useEffect } from 'react';

const ITEMS = '[role^=menuitem]';
const THEME_PARTS = '[role=menuitemradio]';

function itemsOf(list: HTMLElement, selector: string): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>(selector));
}

function step(items: HTMLElement[], by: number): HTMLElement | undefined {
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (at < 0) {
    return by > 0 ? items[0] : items[items.length - 1];
  }
  return items[(at + by + items.length) % items.length];
}

/** Left and right only move between the theme parts, and only while one of them has focus. */
function stepWithin(parts: HTMLElement[], by: number): HTMLElement | undefined {
  return parts.includes(document.activeElement as HTMLElement) ? step(parts, by) : undefined;
}

/** Keyboard for the account list: focus the first item when it mounts and move with the arrow keys, Home and End. */
export function useMenuKeys(list: RefObject<HTMLElement | null>): {
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
} {
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(ITEMS)?.focus();
  }, [list]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!list.current) {
      return;
    }
    const all = itemsOf(list.current, ITEMS);
    const parts = itemsOf(list.current, THEME_PARTS);
    const moves: Record<string, () => HTMLElement | undefined> = {
      ArrowDown: () => step(all, 1),
      ArrowUp: () => step(all, -1),
      ArrowRight: () => stepWithin(parts, 1),
      ArrowLeft: () => stepWithin(parts, -1),
      Home: () => all[0],
      End: () => all[all.length - 1],
    };
    const target = moves[event.key]?.();
    if (target) {
      event.preventDefault();
      target.focus();
    }
  };
  return { onKeyDown };
}
