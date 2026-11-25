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

export const READ_BY_HELPER_REASON =
  'Read code only through your helper. Ask it for each fact with the exact line, its file and its line number, then check that quote with one search.';

export const READ_BY_HELPER_HOOK = 'read-by-helper.sh';

/**
 * A POSIX sh script. Its arguments are the code mounts. A call that comes from a subagent (its input has an `agent_id`)
 * is let through, so the helper reads. The agent itself is denied Bash, a Read inside a code mount, and a Glob inside a
 * mount or of a folder that holds one (such as /work). A path that is relative or has `.`, `..` or `//` is denied, since
 * it may reach a mount; a Glob with no path searches the working folder, so it is denied too. Search and the turn's own
 * folder stay open.
 */
export const READ_BY_HELPER_SCRIPT = `#!/bin/sh
input=$(cat)
deny() {
  printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"${READ_BY_HELPER_REASON}"}}'
  exit 0
}
case $input in *'"agent_id"'*) exit 0 ;; esac
tool=$(printf '%s' "$input" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\\([A-Za-z]*\\)".*/\\1/p')
case $tool in
  Bash) deny ;;
  Read) key=file_path ;;
  Glob) key=path ;;
  *) exit 0 ;;
esac
path=$(printf '%s' "$input" | sed -n "s/.*\\"$key\\"[[:space:]]*:[[:space:]]*\\"\\([^\\"]*\\)\\".*/\\1/p")
case $path in
  "") [ "$tool" = Glob ] && deny ;;
  /*) ;;
  *) deny ;;
esac
case $path in *//* | */./* | */../* | */. | */..) deny ;; esac
path=\${path%/}
for mount in "$@"; do
  case $path in "$mount" | "$mount"/*) deny ;; esac
  if [ "$tool" = Glob ]; then case $mount in "$path"/*) deny ;; esac; fi
done
exit 0
`;
