export const DENY_BACKGROUND_REASON =
  'Run it in the foreground and wait for it. Your answer ends this process and kills anything still running.';

export const DENY_BACKGROUND_HOOK = 'deny-background.sh';

/** A POSIX sh script, because the project image may have no node. It reads the PreToolUse input from stdin. */
export const DENY_BACKGROUND_SCRIPT = `#!/bin/sh
if cat | grep -Eq '"run_in_background"[[:space:]]*:[[:space:]]*true'; then
  printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"${DENY_BACKGROUND_REASON}"}}'
fi
exit 0
`;
