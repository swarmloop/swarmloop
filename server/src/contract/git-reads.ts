const READ_ONLY = new Set(['rev-parse', 'status', 'show-ref', 'merge-base', 'ls-tree']);

/** The subcommand of a git call, after `-C <path>` and `-c <key=value>`. */
function subcommand(args: string[]): { name: string; rest: string[] } {
  let index = 0;
  while ((args[index] === '-C' || args[index] === '-c') && index + 1 < args.length) {
    index += 2;
  }
  return { name: args[index] ?? '', rest: args.slice(index + 1) };
}

/** Whether a command only asks git a question: `rev-parse`, `branch --show-current`, `status`, `show-ref`, `merge-base`, `ls-tree`. */
export function isReadOnlyGit(executable: string, args: string[]): boolean {
  if (executable !== 'git') {
    return false;
  }
  const { name, rest } = subcommand(args);
  return READ_ONLY.has(name) || (name === 'branch' && rest.length === 1 && rest[0] === '--show-current');
}
