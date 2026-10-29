export const ISSUE_TRACKER = Symbol('ISSUE_TRACKER');
export const REQUIREMENTS_SOURCE = Symbol('REQUIREMENTS_SOURCE');
export const PASTE_READER = Symbol('PASTE_READER');

export interface PasteReader {
  read(url: string): Promise<string>;
}
