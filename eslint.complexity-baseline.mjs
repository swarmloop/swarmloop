import { relative } from 'node:path';
import { builtinRules } from 'eslint/use-at-your-own-risk';

const schema = [
  {
    type: 'object',
    properties: {
      max: { type: 'integer' },
      baseline: { type: 'object', additionalProperties: { type: 'object', additionalProperties: { type: 'integer' } } },
    },
    additionalProperties: false,
  },
];

// Measures every function with the built-in complexity rule and hands the list to `judge` at the end of the file.
function measuringRule(judge, description) {
  return {
    meta: { type: 'suggestion', schema, docs: { description } },
    create(context) {
      const found = [];
      const collect = (problem) =>
        found.push({ node: problem.node, name: problem.data.name, number: Number(problem.data.complexity) });
      const measuring = Object.create(context, { options: { value: [0] }, report: { value: collect } });
      const visitors = builtinRules.get('complexity').create(measuring);
      return {
        ...visitors,
        'Program:exit'() {
          const { max, baseline } = context.options[0];
          const file = relative(context.cwd, context.filename).split('\\').join('/');
          const listed = baseline[file] ?? {};
          const functions = withKeys(found);
          judge({ context, functions, max, listed, file });
        },
      };
    },
  };
}

// The key is the names of the enclosing functions and the function's own name, so it does not move with line numbers.
function keyOf(entry, all) {
  const names = [];
  for (let node = entry.node.parent; node; node = node.parent) {
    const outer = all.find((other) => other.node === node);
    if (outer) names.unshift(outer.name);
  }
  return [...names, entry.name].join(' > ');
}

// Functions that share a key within the file are told apart by their order in the source: the second one ends in " #2".
function withKeys(found) {
  const ordered = [...found].sort((a, b) => a.node.range[0] - b.node.range[0]);
  const seen = new Map();
  return ordered.map((entry) => {
    const path = keyOf(entry, found);
    const count = (seen.get(path) ?? 0) + 1;
    seen.set(path, count);
    return { ...entry, key: count === 1 ? path : `${path} #${count}` };
  });
}

function over({ context, functions, max, listed, file }) {
  for (const { node, key, number } of functions) {
    const isListed = Object.hasOwn(listed, key);
    const limit = isListed ? listed[key] : max;
    if (number <= limit) continue;
    const where = isListed ? ' (its number in scripts/complexity-baseline.json)' : '';
    context.report({
      loc: node.loc.start,
      message: `${key} in ${file} has complexity ${number}; its limit is ${limit}${where}.`,
    });
  }
}

function leaving({ context, functions, max, listed, file }) {
  const remove = 'remove its entry from scripts/complexity-baseline.json.';
  for (const { node, key, number } of functions) {
    if (!Object.hasOwn(listed, key) || number > max) continue;
    context.report({
      loc: node.loc.start,
      message: `${key} in ${file} has complexity ${number}, at most ${max}: it leaves the list, ${remove}`,
    });
  }
  const present = new Set(functions.map((entry) => entry.key));
  for (const key of Object.keys(listed).filter((listedKey) => !present.has(listedKey))) {
    context.report({
      loc: { line: 1, column: 0 },
      message: `${key} in ${file} is no longer in the file: it leaves the list, ${remove}`,
    });
  }
}

export const complexityPlugin = {
  rules: {
    complexity: measuringRule(over, 'A function is over its complexity limit, or over its number in the baseline.'),
    'complexity-baseline-leave': measuringRule(leaving, 'A listed function is at the limit or below, or gone.'),
  },
};
