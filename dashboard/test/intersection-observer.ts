import { act } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

interface Watcher {
  callback: IntersectionObserverCallback;
  targets: Set<Element>;
  observer: IntersectionObserver;
}

/** What a test sees of the fake observer: which elements are watched, and a way to scroll them into view. */
export interface FakeIntersection {
  /** The number of elements watched now; a disconnected observer watches none. */
  watching: () => number;
  /** Tells every watcher that its elements scrolled into view. */
  scrollIntoView: () => void;
}

/** jsdom has no IntersectionObserver: for each test of the file, a fake that the test can trigger stands in for it. */
export function fakeIntersectionObserver(): FakeIntersection {
  const watchers = new Set<Watcher>();
  beforeEach(() => {
    class Fake {
      private readonly watcher: Watcher;
      constructor(callback: IntersectionObserverCallback) {
        this.watcher = { callback, targets: new Set(), observer: this as unknown as IntersectionObserver };
        watchers.add(this.watcher);
      }
      observe(target: Element): void {
        this.watcher.targets.add(target);
      }
      unobserve(target: Element): void {
        this.watcher.targets.delete(target);
      }
      disconnect(): void {
        watchers.delete(this.watcher);
      }
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    vi.stubGlobal('IntersectionObserver', Fake);
  });
  afterEach(() => {
    watchers.clear();
    vi.unstubAllGlobals();
  });
  return {
    watching: () => [...watchers].reduce((sum, watcher) => sum + watcher.targets.size, 0),
    scrollIntoView: () =>
      act(() => {
        for (const { callback, targets, observer } of watchers) {
          const entries = [...targets].map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry);
          callback(entries, observer);
        }
      }),
  };
}
