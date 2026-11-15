// Lint rules for test code: specs wait on fake time only, and start a real process only in whole-flow specs or through git-fixture.
export const SOCKET_SYNTAX = {
  selector: "CallExpression[callee.object.name='socket'][callee.property.name=/^(on|off)$/]",
  message: 'Subscribe to socket events only in features/shell/use-live-bridge.ts',
};
export const KEY_ID_SYNTAX = {
  selector: "JSXAttribute[name.name='key'] > JSXExpressionContainer > MemberExpression[property.name='id']",
  message: 'An id can be -1 for a live visit: key a list by the visit `key`.',
};
export const DATE_SYNTAX = {
  selector: "NewExpression[callee.name='Date'][arguments.length=0]",
  message: 'Read time through Clock.',
};

// The fields of a run that one module writes: history/run-state.ts. Every other writer calls it.
export const RUN_STATE_WRITE = {
  selector:
    'AssignmentExpression[left.type="MemberExpression"][left.property.name=/^(status|currentStep|ownerPid|ownerInstance|activeAttempt|state|stateReason)$/]',
  message: 'Write the state of a run through history/run-state.ts (writeRunState, claim, release or finalize).',
};

const TIMER_MODULE = '/^(node:)?timers\\/promises$/';
const PROCESS_MODULE = '/^(node:)?child_process$/';
const CLOCK_READ = "CallExpression[callee.object.name=/^(Date|performance)$/][callee.property.name='now']";

const WAIT_SYNTAX = [
  {
    selector: 'CallExpression[callee.name=/^(setTimeout|setInterval)$/]',
    message: 'Use fake timers instead of waiting on real time in specs.',
  },
  {
    selector: `ImportDeclaration[source.value=${TIMER_MODULE}]`,
    message: 'Use fake timers instead of timers/promises in specs.',
  },
  {
    selector: `CallExpression[callee.name='require'][arguments.0.value=${TIMER_MODULE}]`,
    message: 'Use fake timers instead of timers/promises in specs.',
  },
  {
    selector: `:matches(WhileStatement, DoWhileStatement, ForStatement, ForInStatement, ForOfStatement):has(${CLOCK_READ})`,
    message: 'Do not poll real time in a loop in specs: use fake timers.',
  },
];

const PROCESS_SYNTAX = [
  {
    selector: `ImportDeclaration[source.value=${PROCESS_MODULE}]`,
    message:
      'Start git through server/src/testing/git-fixture.ts, and a process or container only in a whole-flow spec.',
  },
  {
    selector: `CallExpression[callee.name='require'][arguments.0.value=${PROCESS_MODULE}]`,
    message:
      'Start git through server/src/testing/git-fixture.ts, and a process or container only in a whole-flow spec.',
  },
];

// Specs that keep a real process on purpose, one line each with its reason.
export const PROCESS_EXCEPTIONS = [
  // Proves the lock between two real processes, which a fake cannot show.
  'server/src/pipeline/worktree-lock.spec.ts',
  // Runs the real hook script as a child process.
  'server/src/integrations/agent-runtime/claude/claude-hook.spec.ts',
  // Proves what a real child process reads from stdin.
  'server/src/sandbox/sandbox-stdin.spec.ts',
];

const PROCESS_IGNORES = ['**/*.e2e.spec.ts', 'server/src/testing/git-fixture.ts', ...PROCESS_EXCEPTIONS];

const GROUPS = [
  {
    files: ['server/src/**/*.spec.ts', 'server/src/**/*.spec-helpers.ts', 'server/test/**'],
    ignores: [],
    extra: [],
  },
  {
    // Testing support that is not a spec keeps the clock and run-state rules of the server.
    files: ['server/src/testing/**'],
    ignores: ['**/*.spec.ts', '**/*.spec-helpers.ts'],
    extra: [DATE_SYNTAX, RUN_STATE_WRITE],
  },
  {
    // The socket selector is repeated: a later block replaces the options.
    files: ['dashboard/**/*.test.{ts,tsx}', 'dashboard/test/**'],
    ignores: [],
    extra: [SOCKET_SYNTAX],
  },
  {
    files: ['dashboard/features/run/**/*.test.{ts,tsx}'],
    ignores: [],
    extra: [SOCKET_SYNTAX, KEY_ID_SYNTAX],
  },
];

export const specRuleBlocks = GROUPS.flatMap(({ files, ignores, extra }) => [
  { files, ignores, rules: { 'no-restricted-syntax': ['error', ...extra, ...WAIT_SYNTAX] } },
  {
    files,
    ignores: [...ignores, ...PROCESS_IGNORES],
    rules: { 'no-restricted-syntax': ['error', ...extra, ...WAIT_SYNTAX, ...PROCESS_SYNTAX] },
  },
]);
