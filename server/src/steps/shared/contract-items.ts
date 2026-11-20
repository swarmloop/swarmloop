import type { ContractItem } from '../../agent-result/definitions/split-fields';

/** One line of the contract's `decisions:` log. `task` is empty for a line the server wrote, `at` is null when none was written. */
interface ContractDecision {
  task: string;
  at: string | null;
  text: string;
}

interface ReadContract {
  items: ContractItem[];
  decisions: ContractDecision[];
}

const ITEM = /^(\S+) \(owner (\S+)\): ([\s\S]*)$/;
const DECISION = /^subtask (\S+?)(?: at (\S+))?: ([\s\S]*)$/;
const HEADING = /^decisions:\s*$/i;

/** The bullets of some contract lines: each starts with `- `, and the lines after it are indented two spaces. */
function bullets(lines: string[]): string[] {
  const found: string[] = [];
  for (const line of lines) {
    if (line.startsWith('- ')) {
      found.push(line.slice(2));
    } else if (found.length > 0 && (line.startsWith('  ') || !line.trim())) {
      found[found.length - 1] += `\n${line.slice(2)}`;
    }
  }
  return found.map((entry) => entry.trimEnd());
}

/**
 * The items and the decisions of a stored contract. A contract written as text, before items had owners, gives items
 * with an empty id and owner, and decisions with no time.
 */
export function readContract(contract: string): ReadContract {
  const lines = contract.split('\n');
  const heading = lines.findIndex((line) => HEADING.test(line.trim()));
  const above = heading < 0 ? lines : lines.slice(0, heading);
  const below = heading < 0 ? [] : lines.slice(heading + 1);
  const items = bullets(above).map((entry): ContractItem => {
    const match = ITEM.exec(entry);
    return match ? { id: match[1], owner: match[2], text: match[3] } : { id: '', owner: '', text: entry };
  });
  const decisions = bullets(below).map((entry): ContractDecision => {
    const match = DECISION.exec(entry);
    return match ? { task: match[1], at: match[2] ?? null, text: match[3] } : { task: '', at: null, text: entry };
  });
  return { items, decisions };
}
