'use client';

import { type RefObject, type UIEvent, useEffect, useRef, useState } from 'react';

/** How far from the bottom the reader still counts as being at the bottom. */
const BOTTOM_SLACK = 48;

interface FollowBottom {
  box: RefObject<HTMLDivElement | null>;
  onScroll: (event: UIEvent<HTMLElement>) => void;
  /** True when something new came while the reader was scrolled up. */
  unseen: boolean;
  scrollToBottom: () => void;
}

/**
 * Keeps a scroll box at its bottom while the reader is there. `total` is how many entries it holds; `extra` is text that
 * can grow without a new entry (a reply being written). When the reader is scrolled up, a bigger total or a changed
 * extra sets `unseen` and the view stays where it is.
 */
export function useFollowBottom(total: number, extra = ''): FollowBottom {
  const [unseen, setUnseen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const seen = useRef(0);
  const seenExtra = useRef(extra);

  useEffect(() => {
    const node = box.current;
    if (!node) {
      return;
    }
    if (stick.current) {
      node.scrollTop = node.scrollHeight;
    } else if (total > seen.current || extra !== seenExtra.current) {
      setUnseen(true);
    }
    seen.current = total;
    seenExtra.current = extra;
  }, [total, extra]);

  const onScroll = (event: UIEvent<HTMLElement>): void => {
    const node = event.currentTarget;
    stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < BOTTOM_SLACK;
    if (stick.current) {
      setUnseen(false);
    }
  };

  const scrollToBottom = (): void => {
    const node = box.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
    stick.current = true;
    setUnseen(false);
  };

  return { box, onScroll, unseen, scrollToBottom };
}
