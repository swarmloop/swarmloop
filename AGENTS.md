# swarmloop: rules for agents and contributors

swarmloop runs coding agents through a fixed flow: requirements, research, plan, implement, checks, code review, merge request, CI. These rules apply to every change in this repository, whoever writes it. Read them before you plan or write code. The lint config, `scripts/structure-rules.json` and `.github/workflows/ci.yml` enforce many of them; write the code so that they never fire.

## Product code

- Do not assume one project, language, repository name, path, toolchain or ecosystem folder. What one project needs comes from its own files (`.swarmloop.json`, `AGENTS.md`, its skills) or from env, never from code that knows the project, this repository included.
- The server never runs a project's commands (npm, pip, go…) itself. Project commands run only in the project's image (the agent sandbox and the checks step) and in CI.
- Vendor code (agent runtimes, code hosts, issue trackers, other providers) goes in its adapter under `server/src/integrations/`, behind the interface of its kind. Do not add a vendor name or a branch on a vendor (`if (runtime === 'claude')`) to code outside its adapter; when the core needs something new from a vendor, add it to the interface and implement it in every adapter.
- Every failure path ends in a state the flow already handles: a return with the reason, a retry with the reason, or a stop that says what to do. Never leave a run in a state that only a person editing data can fix.
- Never log a secret, put it in a URL, or send it to the browser.
- Text the dashboard shows is plain words for a person: no raw JSON, no internal ids or class names, each document shown by its kind.

## Code structure

- The server layers under `server/src/` are fixed (`eslint.config.mjs`, boundaries): `server/src/api/` and `server/src/cli/` translate input and output, `server/src/pipeline/` orchestrates, `server/src/steps/` holds each step, `server/src/history/` owns persistence, `server/src/sandbox/` owns process and container boundaries, `server/src/integrations/` holds vendors. `server/src/contract/` is shared with the dashboard and imports only its own files.
- A step reaches another step's behavior through a service in `server/src/steps/shared/`, never through the other step's class.
- The state of a run is written only through `server/src/history/run-state.ts`.
- Time through `Clock`, config through `AppConfig`, logs through a Nest `Logger`. Named exports in the server.
- Dashboard: the API only through `dashboard/lib/api.ts`; socket events only in `dashboard/features/shell/use-live-bridge.ts`; list keys by the visit `key`, never by an id.
- Prefer interfaces and small classes with one job (SOLID, KISS, DRY). Add an abstraction when it makes the code clearer and matches the tree, not before.

## Size and shape

- A product file has at most 400 counted lines (blank lines and comments do not count); a spec file 800. A function has complexity 20 at most.
- Before adding code to a file, look at its size. When the change would take it past about 340 counted lines, first split the file by responsibility in a move-only change (no logic change), then add the new code to the file that now owns it. Plan that split as its own checklist item.
- Never squeeze code under a limit: no deleted comments, joined lines, shortened names, or branches moved into tables just to pass a count.
- A new responsibility goes in its own file, named for it. Before writing a helper, search the tree for one that does the same.
- When a change leaves a file, export, import, comment or commented-out code with no remaining use, remove it in the same change.

## Tests

- A test fails when the change is reverted. It checks behavior through the public interface the tree already tests: no private calls, no mock call counts, no large snapshots where one value matters, fake timers instead of sleeping.
- Test helpers live in `*.spec-helpers.ts`, `server/src/testing/` or `dashboard/test/`. Product code never imports a test library.
- The golden traces in `server/src/testing/golden/` change only when the task names that behavior change.
- Database changes are additive migrations in `server/src/history/migrations/`.

## Checks and CI

- Every check lives in the one workflow `.github/workflows/ci.yml`, and the checks step runs the same commands from `.swarmloop.json`. A new lint rule or test goes into an existing job. No second workflow, no `paths` or `branches` filter.
- Never raise a timeout, a retry count or a poll limit to make a test pass. Find the cause.
- No new dependency unless the task needs it and says so.

## Changes

- The smallest change that does the task: no drive-by edits, no renames outside the scope.
- A capability (what a screen shows, what a command does, what a step receives, what the server guarantees) changes or goes only when the task names it in `Removes` or `Behavior change` (see `CONTRIBUTING.md`). Any other removed capability is a stop, not a silent change.
- Code, comments, commit messages and agent output are in English.
- `docs/` is the maintainer's local folder (git ignores it): never add, change or commit anything there.
