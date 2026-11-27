/**
 * The characters `hasTitleText` takes for markdown marks and blanks: a line made only of them has no text a title can
 * be taken from. SQL strips them from the left of a prompt, so the prompt that stats read is cut where `hasTitleText`
 * would find the first title line.
 */
export const TITLE_MARK_CHARACTERS =
  '#>*`-_' +
  // Every character that a regular expression's `\s` matches.
  ' \t\n\v\f\r' +
  '\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
