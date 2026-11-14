Four tasks in one chain.

```json
{
  "summary": ["four tasks, one chain"],
  "contract": ["rule files are named by the runtime adapter; no task names a project"],
  "tasks": [
    {
      "id": "runtime-rule-files",
      "title": "Name the rule files per runtime",
      "depends": [],
      "files": ["server/src/integrations/agent-runtime/agent-runtime.ts"],
      "proof": "agent-runtime.spec.ts \"names the rule files\"",
      "description": "Each adapter says which rule files its CLI reads:\n- claude reads CLAUDE.md\n- cursor reads AGENTS.md\n\nThe adapter spec pins both."
    },
    {
      "id": "prompt-rules",
      "title": "Put the rules in the prompts",
      "depends": ["runtime-rule-files"],
      "files": ["server/src/steps/shared/skill-prompt.ts"],
      "proof": "skill-prompt.spec.ts \"names the rule files\"",
      "description": "Add the rule files to every agent prompt, after the working directory block:\n- one line per file\n- none when the project has no rule file"
    },
    {
      "id": "plan-skills",
      "title": "Teach the plan skill the rules",
      "depends": ["prompt-rules"],
      "files": ["skills/plan/SKILL.md"],
      "proof": "skill-prompt.spec.ts \"plan skill\"",
      "description": "In skills/plan/SKILL.md, add one generic paragraph that names no project, file or tool:\n\n- the plan keeps to the rules of the project"
    },
    {
      "id": "repo-rules",
      "title": "Add the repository rules",
      "depends": ["plan-skills"],
      "files": ["AGENTS.md", "README.md"],
      "proof": "check-structure.mjs",
      "description": "Add AGENTS.md with its structure rule:\n- one rule per line\n- a README paragraph that links it"
    }
  ]
}
```
