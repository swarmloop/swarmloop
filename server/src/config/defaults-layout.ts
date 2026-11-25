import { Injectable } from '@nestjs/common';
import { readDefaultSettingsText } from './default-settings';

interface LayoutSetting {
  name: string;
  /** The comment lines between the setting and the heading or setting before it; absent when there are none. */
  description?: string;
}

interface LayoutGroup {
  /** The first comment line of the block; empty when the block opens with a setting. */
  name: string;
  settings: LayoutSetting[];
}

const SETTING = /^(?:export\s+)?([^=\s]+)\s*=/;

/** Groups the text of defaults.env: a group per blank-line block, in the file's order. */
export function parseDefaultsLayout(text: string): LayoutGroup[] {
  const groups: LayoutGroup[] = [];
  let group: LayoutGroup | null = null;
  let comments: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) {
      group = null;
      comments = [];
    } else if (line.startsWith('#')) {
      const comment = line.replace(/^#\s?/, '');
      if (group === null) {
        group = { name: comment, settings: [] };
        groups.push(group);
      } else {
        comments.push(comment);
      }
    } else {
      const name = SETTING.exec(line)?.[1];
      if (name === undefined) continue;
      if (group === null) {
        group = { name: '', settings: [] };
        groups.push(group);
      }
      group.settings.push(comments.length > 0 ? { name, description: comments.join(' ') } : { name });
      comments = [];
    }
  }
  return groups;
}

/** How defaults.env groups and describes the server's settings. */
@Injectable()
export class DefaultsLayout {
  constructor(readonly groups: readonly LayoutGroup[]) {}

  static fromDefaultsFile(): DefaultsLayout {
    return new DefaultsLayout(parseDefaultsLayout(readDefaultSettingsText()));
  }
}
