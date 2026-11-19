// Directory work on the server's main thread blocks every request while it runs. Product code uses the async form
// from fs/promises; a file in the allowlist below still needs a sync call and says why.
const BANNED = new Set(['readdirSync', 'rmSync', 'cpSync', 'opendirSync']);
const FS_MODULES = new Set(['fs', 'node:fs']);
const MESSAGE =
  'Do not do directory work on the main thread: use the async form from fs/promises (readdir, rm, cp, opendir).';

const noSyncDirectoryWork = {
  meta: { type: 'problem', schema: [], docs: { description: 'Forbid sync directory calls in server code.' } },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (!FS_MODULES.has(node.source.value)) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportSpecifier' && BANNED.has(specifier.imported.name)) {
            context.report({ node: specifier, message: MESSAGE });
          }
        }
      },
      MemberExpression(node) {
        if (!node.computed && node.property.type === 'Identifier' && BANNED.has(node.property.name)) {
          context.report({ node: node.property, message: MESSAGE });
        }
      },
    };
  },
};

export const mainThreadPlugin = { rules: { 'no-sync-directory-work': noSyncDirectoryWork } };

// The product files that still do sync directory work, each with the reason it has not moved to the async form.
export const SYNC_DIRECTORY_ALLOWLIST = {
  'server/src/acp/cli-token.ts': 'runs in the CLI process, not the server',
  'server/src/acp/skills.ts': 'runs in the CLI process, not the server',
  'server/src/agent/agent-args.ts': 'builds the argument list of one launch in a sync function',
  'server/src/agent/chat-mode.ts': 'reads the skill folders while it builds a prompt in a sync function',
  'server/src/agent/skill-briefs.ts': 'reads the skill folders while it builds a prompt in a sync function',
  'server/src/api/mcp-config.ts': 'writes the MCP config of one launch in a sync function',
  'server/src/config/checkout-path.ts': 'resolves a checkout path at start-up',
  'server/src/core/attempt-output.ts':
    'one listing for a run from before attempts, which has no attempt rows to look up',
  'server/src/environment/project-image.ts': 'looks for the project image files at start-up',
  'server/src/git/rebase/hidden-worktree.ts': 'works in a throwaway worktree during a rebase',
  'server/src/git/rebase/rebase.ts': 'works in a throwaway worktree during a rebase',
  'server/src/git/repo-names.ts': 'reads the repository folder names at start-up',
  'server/src/git/worktree-tree.ts': 'copies and lists a worktree in a sync function',
  'server/src/history/attachment-store.ts': 'removes a small attachment folder in a sync function',
  'server/src/history/migration-guard.ts': 'lists the migration folder at start-up',
  'server/src/history/run-paths.ts': 'removes a run folder in a sync function',
  'server/src/history/stored-files.ts': 'lists the stored files of one run in a sync function',
  'server/src/integrations/code-host/code-host-adapters.ts': 'lists the adapters at start-up',
  'server/src/pipeline/backlog/planner/turn-workspace.ts': 'prepares a small turn folder in a sync function',
  'server/src/pipeline/workspace-guard.ts': 'checks a workspace folder in a sync function',
  'server/src/sandbox/egress.ts': 'writes the proxy files at container start in a sync function',
  'server/src/sandbox/env-masks.ts': 'lists the env files to mask in a sync function',
  'server/src/sandbox/project-git.ts': 'copies the small git metadata of a container start in a sync function',
  'server/src/sandbox/sandbox-launch.ts': 'prepares the state folder of one launch in a sync function',
  'server/src/steps/prepare/prepare.step.ts': 'lists the project files while preparing in a sync function',
  'server/src/steps/research/research.step.ts': 'lists the project files while researching in a sync function',
  'server/src/steps/shared/checkout.service.ts': 'removes and lists a checkout in a sync function',
  'server/src/steps/shared/skill-prompt.ts': 'reads the skill folders while it builds a prompt in a sync function',
};
