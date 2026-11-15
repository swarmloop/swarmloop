/**
 * The color of the stripe on the left of a transcript card. The stripe is a `::before` rule that jsdom does not
 * compute, so the color is read from the rule the card matches.
 */
export function stripeColor(card: HTMLElement): string | undefined {
  const rules = Array.from(document.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules));
  const stripe = rules.find(
    (rule): rule is CSSStyleRule =>
      rule instanceof CSSStyleRule &&
      rule.selectorText.endsWith('::before') &&
      card.matches(rule.selectorText.replace('::before', '')),
  );
  return /background-color:\s*([^;]+);/.exec(stripe?.cssText ?? '')?.[1];
}
