import type { ElementType } from 'react';
import Bolt from '@mui/icons-material/Bolt';
import Cloud from '@mui/icons-material/Cloud';
import Code from '@mui/icons-material/Code';
import Extension from '@mui/icons-material/Extension';
import GitHub from '@mui/icons-material/GitHub';
import Hub from '@mui/icons-material/Hub';
import Source from '@mui/icons-material/Source';
import Terminal from '@mui/icons-material/Terminal';

/** The only place in the dashboard that names an integration: a logo key to its icon. */
const LOGOS: Record<string, ElementType> = {
  claude: Bolt,
  codex: Terminal,
  cursor: Code,
  jira: Hub,
  confluence: Cloud,
  github: GitHub,
  gitlab: Source,
};

/** A key the map does not know gets one neutral icon, so a new integration needs only an entry here. */
export function logoFor(key: string): ElementType {
  return LOGOS[key] ?? Extension;
}
