import { __unsafe_useEmotionCache as useEmotionCache } from '@emotion/react';
import type { EmotionCache } from '@emotion/cache';
import { createElement } from 'react';
import { render } from '@testing-library/react';

let defaultCache: EmotionCache | undefined;

/** The cache MUI's styled engine uses when no CacheProvider is above it, as the tests render it. */
function emotionCache(): EmotionCache {
  if (!defaultCache) {
    function Probe(): null {
      defaultCache = useEmotionCache() ?? undefined;
      return null;
    }
    const probe = render(createElement(Probe));
    probe.unmount();
    probe.container.remove();
  }
  return defaultCache as EmotionCache;
}

/**
 * Empties emotion's style rules, so the next test inserts the rules it needs again. Left in place, the rules of every
 * earlier test of a file stay in document.head, and jsdom matches each of them again on every getComputedStyle call,
 * which role queries, clicks and style reads make for each element.
 */
export function resetEmotionCache(): void {
  const cache = emotionCache();
  cache.sheet.flush();
  for (const key of Object.keys(cache.inserted)) {
    delete cache.inserted[key];
  }
  for (const key of Object.keys(cache.registered)) {
    delete cache.registered[key];
  }
}
