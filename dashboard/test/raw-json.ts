import { expect } from 'vitest';

/** The text of every element of the container that has text of its own. */
function ownTexts(container: HTMLElement): string[] {
  return [container, ...container.querySelectorAll('*')].flatMap((element) =>
    [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? ''),
  );
}

/** Asserts that nothing rendered is a raw stream event or a JSON object as text. */
export function expectNoRawJson(container: HTMLElement): void {
  const texts = ownTexts(container);
  expect(texts.filter((text) => text.includes('{"type":'))).toEqual([]);
  expect(texts.filter((text) => /^\s*\{\s*"/.test(text))).toEqual([]);
}
