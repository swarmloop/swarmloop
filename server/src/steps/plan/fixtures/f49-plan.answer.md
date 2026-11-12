contract:

- rule files are named by the runtime adapter; no task names a project

tasks:

- runtime-rule-files | Name the rule files per runtime | depends: none | files: server/src/integrations/agent-runtime/agent-runtime.ts | proof: agent-runtime.spec.ts "names the rule files"
  Each adapter says which rule files its CLI reads:
  - claude reads CLAUDE.md
  - cursor reads AGENTS.md

  The adapter spec pins both.

- prompt-rules | Put the rules in the prompts | depends: runtime-rule-files | files: server/src/steps/shared/skill-prompt.ts | proof: skill-prompt.spec.ts "names the rule files"
  Add the rule files to every agent prompt, after the working directory block:
  - one line per file
  - none when the project has no rule file
- plan-skills | Teach the plan skill the rules | depends: prompt-rules | files: skills/plan/SKILL.md | proof: skill-prompt.spec.ts "plan skill"
  In skills/plan/SKILL.md, add one generic paragraph that names no project, file or tool:

  - the plan keeps to the rules of the project

- repo-rules | Add the repository rules | depends: plan-skills | files: AGENTS.md, README.md | proof: check-structure.mjs
  Add AGENTS.md with its structure rule:
  - one rule per line
  - a README paragraph that links it

summary:

- four tasks, one chain
