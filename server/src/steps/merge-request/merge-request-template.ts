import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { isAbsolute, join, relative } from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { mergeRequestText } from '../../agent-result/definitions/merge-request-text';
import type { RunEntity } from '../../history/entities';
import { codeHostAdapter } from '../../integrations/code-host/code-host-adapters';
import { REPORT_START, foldedReport, spliceReport } from '../shared/report-markers';
import { ImplementChat } from '../shared/implement-chat';
import type { Tree } from './merge-request-trees';

/** The text of the body, and whether it is the rendered report, which goes between the markers. */
export interface Summary {
  text: string;
  report: boolean;
}

/**
 * The lines the note holds for a repository: the block the rules writer wrote, `Add to the "git" section of
 * .swarmloop.json[ of <repo>]:` and its lines. A block that names no repository is the one repository of the run.
 */
export function noteLines(note: string | null, repo: string): string {
  const blocks = (note ?? '').split(/\n\s*\n/).map((block) => block.trim());
  return (
    blocks.find((block) => {
      const named = /^Add to the "git" section of \S+?(?: of ([\w./@-]+))?:\n/.exec(`${block.split('\n')[0]}\n`);
      return named !== null && (named[1] === undefined || named[1] === repo);
    }) ?? ''
  );
}

/** The body with the lines to add as its last lines. A body that already ends with them stays as it is. */
function withNote(body: string, lines: string): string {
  return !lines || body.trimEnd().endsWith(lines) ? body : `${body.trimEnd()}\n\n${lines}`;
}

function templatePrompt(template: string, report: string): string {
  return [
    'Fill in the merge request template below for this run, from the report of the run.',
    'Tick a checkbox only for what the run did and proved. Keep the template headings and wording; do not add the report itself.',
    'Do not use tools and do not edit files. Answer with the merge_request_text result.',
    '',
    '## Template',
    template,
    '',
    '## Report of the run',
    report,
  ].join('\n');
}

/** What the bodies of the trees are, and why a template was not used. */
interface Bodies {
  trees: Tree[];
  errors: string[];
}

/** Builds the body of each merge request: the report, or the repository's filled template with the report folded last. */
@Injectable()
export class MergeRequestTemplate {
  private readonly logger = new Logger(MergeRequestTemplate.name);

  constructor(private readonly chat: ImplementChat) {}

  async bodies(run: RunEntity, trees: Tree[], built: Summary, note: string | null): Promise<Bodies> {
    const paths = codeHostAdapter(run.codeHost)?.rules.mergeRequestTemplates ?? [];
    const errors: string[] = [];
    const bodied: Tree[] = [];
    for (const tree of trees) {
      const body = await this.body(run, tree, built, paths, errors);
      bodied.push({ ...tree, summary: withNote(body, noteLines(note, tree.repo)) });
    }
    return { trees: bodied, errors };
  }

  private async body(
    run: RunEntity,
    tree: Tree,
    built: Summary,
    paths: readonly string[],
    errors: string[],
  ): Promise<string> {
    const existing = tree.existing?.summary ?? '';
    const marked = existing.includes(REPORT_START);
    const template = built.report && !marked ? templateOf(tree.path, paths) : null;
    if (template === null) {
      return built.report ? spliceReport(existing, built.text) : built.text;
    }
    const answer = await this.chat.ask(run, [tree.repo], templatePrompt(template, built.text), mergeRequestText);
    const text = 'value' in answer ? (answer.value as { text?: unknown }).text : undefined;
    if (typeof text === 'string' && text.trim()) {
      return `${text.trim()}\n\n${foldedReport(built.text)}`;
    }
    const reason = 'error' in answer ? answer.error : 'the answer had no text';
    this.logger.warn(`${tree.repo}: merge request template not filled: ${reason}`);
    errors.push(`${tree.repo}: template not filled: ${reason}`);
    return spliceReport(existing, built.text);
  }
}

/** The first of the host's template paths that is a file inside the worktree, read; null when there is none. A link out of the worktree is no template. */
function templateOf(tree: string, paths: readonly string[]): string | null {
  const base = realpathSync(tree);
  for (const path of paths) {
    const file = join(tree, path);
    if (!existsSync(file)) {
      continue;
    }
    const real = realpathSync(file);
    const inside = relative(base, real);
    if (!inside.startsWith('..') && !isAbsolute(inside) && statSync(real).isFile()) {
      return readFileSync(real, 'utf8');
    }
  }
  return null;
}
