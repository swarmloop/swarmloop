import Joi from 'joi';

/** The kinds of change a commit or a merge request title can name. */
const CHANGE_TYPES = ['feat', 'fix', 'refactor', 'perf', 'docs', 'test', 'build', 'ci', 'chore', 'revert'] as const;

/** The longest subject of a change, in characters. */
const SUBJECT_MAX = 72;

/** What a change means, without the format: the repository's own rules say how it is written. */
export interface GitChange {
  type: (typeof CHANGE_TYPES)[number];
  scope?: string;
  subject: string;
}

/** A rule of the repository for a name, met on the way and missing from `.swarmloop.json`. Each entry is a template. */
export interface GitRules {
  branch?: string;
  commit?: string;
  title?: string;
}

/** The `change` key of a result. */
export const CHANGE_KEY = Joi.object({
  type: Joi.string()
    .valid(...CHANGE_TYPES)
    .required()
    .description(`The type of the change: ${CHANGE_TYPES.join(', ')}`),
  scope: Joi.string().description('The part of the repository the change is in; leave out when it has no one part'),
  subject: Joi.string()
    .max(SUBJECT_MAX)
    .required()
    .description(`What the change does, imperative, at most ${SUBJECT_MAX} characters`),
}).description('What the change means: its type, an optional scope and an imperative subject');

/** The `gitRules` key of a result. */
export const GIT_RULES_KEY = Joi.object({
  branch: Joi.string().description('A rule for branch names'),
  commit: Joi.string().description('A rule for commit messages'),
  title: Joi.string().description('A rule for merge request titles'),
}).description(
  'A rule for branch names, commit messages or merge request titles that you met in the repository (CONTRIBUTING, a lint config, a host refusal) and that .swarmloop.json lacks; leave out when none',
);
