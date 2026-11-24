# swarmloop: rules for agents and contributors

swarmloop runs coding agents through a fixed flow: requirements, research, plan, implement, checks, code review, merge request, CI. These rules apply to every change in this repository, whoever writes it. Read them before you plan or write code. The lint config, `scripts/structure-rules.json` and `.github/workflows/ci.yml` enforce many of them; write the code so that they never fire.

## Architecture

- `ARCHITECTURE.md` is the model of swarmloop: its concepts, the states of a run and one rule per mechanism, then every process with where the code stands. Read its Part 1, and the section of every process your change touches, before you plan or write code.
- A change that adds a second way to do something `ARCHITECTURE.md` does once is wrong: a second path for a mechanism, a new state or reason of a run, a new kind of run. Change the one path; when it cannot take the case, change the design and its section.
- A change to a mechanism updates its section, and its `Today` line, in the same change. A `Today` line that no longer matches the code is a defect.

## Product code

- Do not assume one project, language, repository name, path, toolchain or ecosystem folder. What one project needs comes from its own files (`.swarmloop.json`, `AGENTS.md`, its skills) or from env, never from code that knows the project, this repository included.
- The server never runs a project's commands (npm, pip, go…) itself. Project commands run only in the project's image (the agent sandbox and the checks step) and in CI.
- Vendor code (agent runtimes, code hosts, issue trackers, other providers) goes in its adapter under `server/src/integrations/`, behind the interface of its kind. Do not add a vendor name or a branch on a vendor (`if (runtime === 'claude')`) to code outside its adapter; when the core needs something new from a vendor, add it to the interface and implement it in every adapter.
- Every failure path ends in a state the flow already handles: a return with the reason, a retry with the reason, or a stop that says what to do. Never leave a run in a state that only a person editing data can fix.
- A delay or outage of something outside swarmloop (a code host, CI, docker, a model's usage limit) is a wait that shows its next try, never a failure. A person is asked only when such a wait runs out, and the message says what was tried.
- A new idempotency key names the event it is for (the attempt that died, the outage, the commit), never a counter that other writes move, such as a run's revision.
- Work a call starts (a file write, a timer, a background pass) ends before the call returns, or belongs to an owner that waits for it or stops it on close; writes to one file go one after another.
- What the dashboard shows of a run comes from that run's own state, live; never from a copy that another run wrote.
- Never log a secret, put it in a URL, or send it to the browser.
- Text the dashboard shows is plain words for a person: no raw JSON, no internal ids or class names, each document shown by its kind.
- Never cut text an agent or a person reads without saying so: a shortened log or text says how much is left out and where the whole is.
- An agent hands data to the server only as the JSON block of its step's result, declared with defineResult in server/src/agent-result/; never read structured data out of an agent's prose.

## Code structure

- The server layers under `server/src/` are fixed (`eslint.config.mjs`, boundaries): `server/src/api/` and `server/src/cli/` translate input and output, `server/src/pipeline/` orchestrates, `server/src/steps/` holds each step, `server/src/history/` owns persistence, `server/src/sandbox/` owns process and container boundaries, `server/src/integrations/` holds vendors. `server/src/contract/` is shared with the dashboard and imports only its own files.
- A step reaches another step's behavior through a service in `server/src/steps/shared/`, never through the other step's class.
- The state of a run is written only through `server/src/history/run-state.ts`.
- Time through `Clock`, config through `AppConfig`, logs through a Nest `Logger`. Named exports in the server.
- Dashboard: the API only through `dashboard/lib/api.ts`; socket events only in `dashboard/features/shell/use-live-bridge.ts`; list keys by the visit `key`, never by an id.
- Prefer interfaces and small classes with one job (SOLID, KISS, DRY). Add an abstraction when it makes the code clearer and matches the tree, not before.
- Every dangerous action (stops work, throws work away, rewrites a branch or cannot be undone) asks through ConfirmDialog; never a confirm of its own.

## Size and shape

- A product file has at most 400 counted lines (blank lines and comments do not count); a spec file 800. A function has complexity 20 at most.
- Before adding code to a file, look at its size. When the change would take it past about 340 counted lines, first split the file by responsibility in a move-only change (no logic change), then add the new code to the file that now owns it. Plan that split as its own checklist item.
- Never squeeze code under a limit: no deleted comments, joined lines, shortened names, or branches moved into tables just to pass a count.
- A limit never decides which requirement goes. When a required change does not fit a limit (a prompt budget, a size or complexity limit, a time limit), do not drop it and do not cut another rule or requirement to make room. The plan names the conflict as a question to whoever started the run, before implement; found later, it is a `needs:` with the limit, the numbers and the change that does not fit. A limit that restructuring meets (file size, complexity, folder size: split by responsibility) is not such a conflict, and restructuring is the normal answer; the question is only for a limit that no change within the rules can meet.
- A new responsibility goes in its own file, named for it. Before writing a helper, search the tree for one that does the same.
- When a change leaves a file, export, import, comment or commented-out code with no remaining use, remove it in the same change.

## Tests

One approach for every test, whoever writes it:

1. **Prove each behavior once, at the cheapest level that proves it.**
   - Logic: a function or class through its own public interface. No DOM, git, process, container or network.
   - A component: that component alone, with only the props and providers it needs, not the page or dialog around it.
   - A flow: one whole-flow spec per flow. It boots the real application with the defaults the server ships with, sets only the setting it is about, and asserts the flow's own path. The details along the flow are proven at the levels above.
   - Before writing a test, extend the one that already covers that code.
2. **A test proves behavior.** It fails when the change is reverted. It goes through the public interface the tree already tests: no private calls, no mock call counts, no large snapshot where one value matters.
3. **A test does not depend on time or load.**
   - It waits only on fake time or on the promise or state it drives, never on a sleep or the wall clock.
   - It drives a component with the fewest events that prove the behavior: a long value is set in one step, not typed key by key, unless the behavior is about typing.
   - It starts real git, a process or a container only in a whole-flow spec or through `server/src/testing/git-fixture.ts` (the lint enforces it).
   - It starts every timer and background pass it depends on itself, and gives the same result on every run, under every seed of `server-test-seeds`, and on a busy machine. A failure under one seed is a race in the code or the test, to be found.
4. **A slow or load-sensitive test is a broken test: fix its design.** Move it to a cheaper level, split it into smaller tests, or make it wait on fake time. Never raise a timeout, add a retry, skip it, loosen an assertion or widen a tolerance. When a test is split, every assertion moves to the smaller test that proves it and still fails when its code is reverted, and the summary maps each old assertion to its new test. A test is deleted only when its assertions moved this way or the behavior it proves is removed on purpose.
5. **A red you did not cause is not yours.** A test outside your plan that fails only on a busy machine, or that also fails on the base: name it in your summary and do not change it. Its planner gives that class of failure one task.
6. Change a test only when the test itself is wrong or your task changes the behavior it proves, and say why in the summary.
7. Each test run prints the ten slowest spec files. A change that adds a spec file that shows up in that list names it in implement's account with its time and cause; the performance reviewer reads it.
8. Test helpers live in `*.spec-helpers.ts`, `server/src/testing/` or `dashboard/test/`. Product code never imports a test library.
9. The golden traces in `server/src/testing/golden/` change only when the task names that behavior change.
10. Database changes are additive migrations in `server/src/history/migrations/`.

## Checks and CI

- Before handing over a change, run `bash scripts/autofix.sh origin/main` from the repository root. It runs ESLint's fixers, the strict lint of changed files and Prettier on the files you changed, in seconds. It exits 1 after it changed a file, so run it again until it exits 0; a lint error it cannot fix is yours to fix. The checks step runs the same lint, and a lint error there costs a whole round.
- Before handing over a change, run the spec files you changed and, for each source file you changed, the specs whose names start with its name without the extension, with `npm test --prefix server -- <spec paths>` and `npm test --prefix dashboard -- <spec paths>`, and the golden specs, with `npm test --prefix server -- golden`, until they pass. The golden specs record the main flows, so they catch a changed flow that the specs of the file miss. The checks step runs no tests; CI runs every test, and a red test there returns the run after its review.
- Every check lives in the one workflow `.github/workflows/ci.yml`, and the checks step runs the same commands from `.swarmloop.json`, except the tests: the checks step runs the static checks and the build, and CI also runs the server and dashboard tests, the server suite also under the seeds. A new lint rule or test goes into an existing job. No second workflow, no `paths` or `branches` filter.
- Never raise a timeout, a retry count or a poll limit to make a test pass. Find the cause.
- No new dependency unless the task needs it and says so.

## Changes

- The smallest change that does the task: no drive-by edits, no renames outside the scope.
- Fix the cause, not the symptom: a fix that only matches the name, message, id or value seen in the failure, while the same failure under another name still happens, is not a fix.
- Simple, transparent, stable: one general rule for every case. No special cases, no extra checks, no exceptions for one input or one name. When a fix needs an exception, change the design instead.
- In a subtask of an epic, change only your task's files, the files its own tests need and the shared files the contract names. A red check in code that another task owns, or in a test that also fails on the base, is not yours: name it in your summary and do not change it.
- A capability (what a screen shows, what a command does, what a step receives, what the server guarantees) changes or goes only when the task names it in `Removes` or `Behavior change` (see `CONTRIBUTING.md`). Any other removed capability is a stop, not a silent change.
- Code, comments, commit messages and agent output are in English.
- `docs/` is the maintainer's local folder (git ignores it): never add, change or commit anything there.
