import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import prettier from 'eslint-config-prettier/flat';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

const sourceFiles = ['**/*.{js,mjs,ts,tsx}'];
const dashboardFiles = ['dashboard/**/*.{js,mjs,ts,tsx}'];
const serverLayers = [
  'core',
  'contract',
  'config',
  'live',
  'history',
  'git',
  'integrations',
  'sandbox',
  'agent',
  'environment',
  'steps',
  'pipeline',
  'api',
  'acp',
  'cli',
];
const layerImports = {
  core: [],
  contract: [],
  config: ['core', 'integrations'],
  live: ['core'],
  history: ['core', 'config', 'live'],
  git: ['core', 'config', 'integrations'],
  integrations: ['core', 'config', 'history'],
  sandbox: ['core', 'config', 'git', 'integrations'],
  agent: ['core', 'config', 'history', 'integrations', 'sandbox', 'live'],
  environment: ['core', 'config', 'git', 'history', 'integrations', 'sandbox', 'live'],
  steps: ['core', 'config', 'git', 'history', 'integrations', 'sandbox', 'agent', 'environment', 'live'],
  pipeline: ['core', 'config', 'git', 'history', 'sandbox', 'agent', 'steps', 'live'],
  api: [
    'core',
    'contract',
    'config',
    'live',
    'history',
    'git',
    'integrations',
    'sandbox',
    'agent',
    'environment',
    'steps',
    'pipeline',
  ],
  acp: ['core', 'config', 'integrations', 'sandbox'],
  cli: ['core', 'config', 'history', 'pipeline'],
};

// Test code is the files the package builds leave out: tsconfig.json and tsconfig.build.json exclude the same list.
const TEST_FILES = [
  '**/*.{test,spec}.{ts,tsx,js,mjs}',
  '**/*.spec-helpers.ts',
  'dashboard/test/**',
  'dashboard/vitest.{config,setup}.ts',
  'server/src/testing/**',
  'server/test/**',
  'server/jest.{config,setup}.js',
];
const TEST_LIBRARIES = ['vitest', 'jest', '@jest/globals', '@testing-library/*', '@nestjs/testing'];

const SOCKET_SYNTAX = {
  selector: "CallExpression[callee.object.name='socket'][callee.property.name=/^(on|off)$/]",
  message: 'Subscribe to socket events only in features/shell/use-live-bridge.ts',
};
const KEY_ID_SYNTAX = {
  selector: "JSXAttribute[name.name='key'] > JSXExpressionContainer > MemberExpression[property.name='id']",
  message: 'An id can be -1 for a live visit: key a list by the visit `key`.',
};
const DATE_SYNTAX = {
  selector: "NewExpression[callee.name='Date'][arguments.length=0]",
  message: 'Read time through Clock.',
};

// The fields of a run that one module writes: history/run-state.ts. Every other writer calls it.
const RUN_STATE_WRITE = {
  selector:
    'AssignmentExpression[left.type="MemberExpression"][left.property.name=/^(status|currentStep|ownerPid|ownerInstance|activeAttempt|state|stateReason)$/]',
  message: 'Write the state of a run through history/run-state.ts (writeRunState, claim, release or finalize).',
};

const STEP_SYNTAX = [
  DATE_SYNTAX,
  RUN_STATE_WRITE,
  {
    selector: "CallExpression[callee.property.name='end'][arguments.length>=2]",
    message: 'Pass one object to end: { outcome, exitCode, line, ... }.',
  },
];

const DOCUMENT_CALL = {
  selector:
    'CallExpression[callee.property.name=/^(latestBody|latestDocument|hasDocument|listDocuments|putDocument)$/]',
  message: 'Read through the declared inputs or ctx.reread, and write through StepResult.outputs or ctx.write.',
};

// Folders under server/src/steps. A step reaches another step's behavior through a service in shared/, not its class.
const STEP_FOLDERS = [
  'branch',
  'code-review',
  'commit',
  'contract',
  'implement',
  'merge-request',
  'pipeline',
  'plan',
  'plan-improve',
  'prepare',
  'requirements',
  'research',
  'shared',
];

export default tseslint.config(
  {
    ignores: ['**/dist', '**/.next', '**/node_modules', 'data', 'worktrees', 'docs'],
  },
  {
    files: sourceFiles,
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      eqeqeq: 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-console': 'error',
    },
  },
  {
    // The typescript-eslint rule, because a later block that sets the core no-restricted-imports would replace these options.
    files: sourceFiles,
    ignores: TEST_FILES,
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: TEST_LIBRARIES,
              message:
                'Only test code imports a test library: name the file *.spec.ts, *.test.ts, *.spec-helpers.ts, or put it in test/.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['server/**', 'scripts/**'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['server/src/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'import/resolver': { node: { extensions: ['.js', '.ts', '.tsx'] } },
      'boundaries/elements': serverLayers.map((type) => ({ type, pattern: `server/src/${type}/**`, mode: 'folder' })),
      'boundaries/ignore': [
        '**/*.spec.ts',
        '**/*.spec-helpers.ts',
        'server/src/main.ts',
        'server/src/api-main.ts',
        'server/src/**/*.module.ts',
      ],
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: Object.entries(layerImports).map(([from, allow]) => ({ from, allow: [...allow, from, 'contract'] })),
        },
      ],
    },
  },
  {
    files: ['server/src/config/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex:
                '^(?!.*integrations/(agent-runtime/agent-runtime[.]registry|issue-tracker/issue-tracker[.]registry|requirements-source/requirements-source[.]registry)$).*integrations/',
              message: 'Config may import only registries that list allowed names.',
            },
          ],
        },
      ],
    },
  },
  {
    // The contract is compiled by the dashboard too, so it may import only its own files.
    files: ['server/src/contract/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^(?!\\./)', message: 'server/src/contract may import only its own files through ./ paths.' },
          ],
        },
      ],
    },
  },
  {
    files: ['server/src/cli/**', 'server/src/main.ts', 'server/src/api-main.ts', 'scripts/**'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['server/src/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'process.stderr', property: 'write', message: 'Log through a Nest Logger instead.' },
        { object: 'process.stdout', property: 'write', message: 'Log through a Nest Logger instead.' },
        { object: 'process', property: 'env', message: 'Read config through AppConfig, or rawEnv() outside Nest.' },
        { object: 'Date', property: 'now', message: 'Read time through Clock.' },
      ],
      'no-restricted-syntax': ['error', DATE_SYNTAX, RUN_STATE_WRITE],
    },
  },
  {
    // Step code reads and writes documents through its declared inputs and outputs. The Date selector is repeated:
    // a later block replaces the options.
    files: ['server/src/steps/**/*.ts'],
    ignores: ['**/*.spec.ts', '**/*.spec-helpers.ts'],
    rules: { 'no-restricted-syntax': ['error', ...STEP_SYNTAX, DOCUMENT_CALL] },
  },
  {
    // The files that may call the document repository. Each reason is the whole case for the exception.
    files: [
      'server/src/steps/contract/**/*.ts', // the input reader is where a declared input is read
      'server/src/steps/base-step.ts', // the step context writes outside the visit and records the handoff
      'server/src/steps/agent-step.ts', // reads the instructions a person gave the step
      'server/src/steps/step.ts', // checks the stored plan and the required kind before a step starts
      'server/src/steps/run-rebase.ts', // a rebase of a stopped run has no visit to write through
      'server/src/steps/shared/handoff.ts', // reads and merges the handoff document
      'server/src/steps/shared/rebased-publisher.ts', // records the refs it pushed for the implement step
      'server/src/steps/prepare/project-append.service.ts', // adds a project to a run between its visits
      'server/src/steps/commit/commit-delivered.ts', // reads the stored reviews an unchanged tree is judged from
      'server/src/steps/code-review/review-input.ts', // reads the run's repos and records the ones it detaches
      'server/src/steps/code-review/review-round.ts', // reads the stored reviews a round continues from
      'server/src/steps/code-review/review-report.ts', // reads the handoff the report is written from
      'server/src/steps/shared/rebase-journal.ts', // keeps the rebase journal as a document of the run
      'server/src/steps/merge-request/merge-request-draft.ts', // a Rebase or Replay turns the merge requests back into drafts with no visit to write through
    ],
    ignores: ['**/*.spec.ts', '**/*.spec-helpers.ts'],
    rules: { 'no-restricted-syntax': ['error', ...STEP_SYNTAX] },
  },
  {
    // These steps hold no document repository at all.
    files: [
      'server/src/steps/branch/branch.step.ts',
      'server/src/steps/commit/commit.step.ts',
      'server/src/steps/merge-request/merge-request.step.ts',
      'server/src/steps/pipeline/pipeline.step.ts',
      'server/src/steps/prepare/prepare.step.ts',
      'server/src/steps/requirements/requirements.step.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...STEP_SYNTAX,
        DOCUMENT_CALL,
        {
          selector: 'MemberExpression[object.type="ThisExpression"][property.name="documents"]',
          message: 'Read through the declared inputs or ctx.reread, and write through ctx.write.',
        },
      ],
    },
  },
  ...STEP_FOLDERS.map((folder) => ({
    // A step imports no step class of another folder.
    files: [`server/src/steps/${folder}/**/*.ts`],
    ignores: ['**/*.spec.ts', '**/*.spec-helpers.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: `(^\\.\\./|/steps/)(?!${folder}/)[^/]+/[^/]+\\.step$`,
              message: 'Share behavior between steps through a service in steps/shared, not another step class.',
            },
          ],
        },
      ],
    },
  })),
  {
    // Person-facing CLI, bootstrap, and prompt output is written directly, as the no-console exceptions are.
    // The stdout and stderr entries are off here, but the env and clock checks stay on.
    files: [
      'server/src/cli/**',
      'server/src/main.ts',
      'server/src/api-main.ts',
      'server/src/acp/shell.ts',
      'server/src/integrations/linked-pages/paste-page.reader.ts',
    ],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: 'Read config through AppConfig, or rawEnv() outside Nest.' },
        { object: 'Date', property: 'now', message: 'Read time through Clock.' },
      ],
    },
  },
  {
    // The config layer, the clock itself, the entry points, and specs read the raw env and the clock directly.
    files: [
      'server/src/config/**',
      'server/src/core/clock.ts',
      'server/src/main.ts',
      'server/src/api-main.ts',
      '**/*.spec.ts',
      '**/*.spec-helpers.ts',
    ],
    rules: { 'no-restricted-properties': 'off', 'no-restricted-syntax': 'off' },
  },
  {
    // The one module that writes the state of a run. The clock rule stays on for it.
    files: ['server/src/history/run-state.ts'],
    rules: { 'no-restricted-syntax': ['error', DATE_SYNTAX] },
  },
  {
    files: ['server/src/**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='setTimeout']",
          message: 'Use fake timers instead of sleeping in specs.',
        },
      ],
    },
  },
  {
    files: dashboardFiles,
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
    settings: { next: { rootDir: 'dashboard/' } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: dashboardFiles,
    rules: {
      'no-restricted-globals': ['error', { name: 'fetch', message: 'Call the API through lib/api.' }],
    },
  },
  {
    files: ['dashboard/lib/api.ts', 'dashboard/middleware.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    files: dashboardFiles,
    rules: {
      'no-restricted-syntax': ['error', SOCKET_SYNTAX],
    },
  },
  {
    // A synthetic visit has the id -1, so a key built from an id repeats. Use the visit's `key`.
    // The socket selector is repeated: a later block replaces the options.
    files: ['dashboard/features/run/**/*.tsx'],
    rules: {
      'no-restricted-syntax': ['error', SOCKET_SYNTAX, KEY_ID_SYNTAX],
    },
  },
  {
    // A card sets no size, padding, border or radius, and no number: they belong to Bubble and transcript/tokens.ts.
    // The socket selector is repeated: a later block replaces the options.
    files: ['dashboard/features/run/transcript/*-card.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        SOCKET_SYNTAX,
        KEY_ID_SYNTAX,
        {
          selector:
            "JSXAttribute[name.name='sx'] Property[key.name=/^(width|maxWidth|minWidth|p|px|py|border|borderRadius)$/]",
          message: 'A card sets no width, padding, border or radius in sx: they belong to Bubble.',
        },
        {
          selector: "JSXAttribute[name.name='sx'] Property > Literal[raw=/^-?[0-9]/]",
          message: 'A card has no number in sx: take it from transcript/tokens.ts.',
        },
      ],
    },
  },
  {
    files: ['dashboard/features/shell/use-live-bridge.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['dashboard/features/**/*.{js,mjs,ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'import/resolver': { node: { extensions: ['.js', '.ts', '.tsx'] } },
      'boundaries/elements': [
        ...['shell', 'runs', 'run', 'new-run', 'stats'].map((feature) => ({
          type: feature,
          pattern: `dashboard/features/${feature}/**`,
          mode: 'folder',
        })),
        { type: 'dashboard-lib', pattern: 'dashboard/lib/**', mode: 'folder' },
        { type: 'dashboard-ui', pattern: 'dashboard/components/ui/**', mode: 'folder' },
        { type: 'contract', pattern: 'server/src/contract/**', mode: 'folder' },
      ],
      'boundaries/ignore': ['dashboard/features/**/*.test.*'],
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            {
              from: ['shell', 'runs', 'run', 'new-run', 'stats'],
              allow: ['shell', 'runs', 'run', 'new-run', 'stats', 'dashboard-lib', 'dashboard-ui', 'contract'],
            },
          ],
        },
      ],
    },
  },
  {
    files: ['dashboard/features/**/*.{js,mjs,ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(\\.\\.?/)+(?:features/)?(shell|runs|run|new-run|stats)/',
              message: 'Import another feature through its index.ts.',
            },
            {
              regex: '^(\\.\\.?/)+(?!.*components/ui/).*components/',
              message: 'Features may import shared UI only from components/ui.',
            },
            {
              regex: '^(\\.\\.?/)+(app|hooks)/',
              message: 'Features may not import app routes or legacy hooks.',
            },
          ],
        },
      ],
    },
  },
  {
    ...jsxA11y.flatConfigs.recommended,
    files: dashboardFiles,
  },
  {
    // Next.js writes this file, and its reference line is not ours to change.
    files: ['dashboard/next-env.d.ts'],
    rules: { '@typescript-eslint/triple-slash-reference': 'off' },
  },
  prettier,
);
