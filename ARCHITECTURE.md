# swarmloop architecture

swarmloop brings a task to a merged change. Agents write the code. The project's own checks and five reviewers judge it. A person is asked only what no planner can answer.

This page is the yardstick for every change to swarmloop:

- **Part 1** is the core: the concepts, the states of a run and one rule per mechanism. It fits on a page and every contributor, human or agent, reads it first.
- **Part 2** maps the code onto the concepts.
- **Part 3** describes every process in detail. Each one gives the target and then *Today*: where the code still differs, and the task that closes the gap.
- **Part 4** lists the decisions this model rests on.

How the page is used:

- A brief names the rule it carries out and the old path it removes.
- A reviewer returns a change that adds a second way to do something this page does once, as it returns a red test.
- A change that moves a mechanism updates its section, and its *Today* line, in the same change. A *Today* line that no longer matches the code is a defect, like a failing test.

---

# Part 1. The core

## 1.1 Concepts

| Concept | What it is |
|---|---|
| **Person** | Someone signed in to the server, an `admin` or a `member`. The person who starts a run is its *starter*. The run uses the starter's connections, and a child run uses its parent's starter. |
| **Repository** | A git clone under the checkouts root, with an `origin` on a code host. A repository with a `.swarmloop.json` is a *project*: the file says how to build and check it. |
| **Run** | One task, from its request to its merge. It has a key, a brief, a requirements list, one branch per repository, a base, a flow of steps and a planner. There is one kind of run. |
| **Child run** | A run started by another run. Its base is the parent's branch, and it merges into that branch. |
| **Epic** | A run whose plan split the work into child runs. Its implement step runs them instead of an agent. It is not a separate kind of run. |
| **Requirements** | What the run must deliver, as a list with stable ids (`R1`, `R2`…). They are written once, can only grow, and are checked by the requirements reviewer. |
| **Step** | One stage of the flow (see 1.3). A step runs as an agent visit or as server code, and ends by one of the routes in 1.3. |
| **Visit** | One pass of a step: one or more agent launches (*attempts*) in one chat, with its cost, tokens, samples and outcome. |
| **Document** | Everything a run produces is a document of a named *kind*: requirements, plan, implementation, review, report, logs and so on. A step declares the kinds it reads and writes. |
| **Generation and gate** | A run's *generation* goes up with every Replay or Rebase. A *gate* is a document that judges work (a review, a CI result). It is stamped with the generation and the files it judged, and counts only for them. |
| **Agent** | A runtime (`claude`, `codex`, `cursor`), a model and an effort, written `runtime:model[:effort]`. Each *role* (plan, implement, review, subtask roles, backlog plan) has an ordered list of agents, and the next one takes over when a provider's limit stops the first. |
| **Chat** | The session an agent keeps across visits. Research, plan and plan-improve share one chat; implement and implement-improve share another; each reviewer has its own. |
| **Skill** | The instructions of one step's agent, kept in `skills/`. A skill is generic and knows no project. A project's own rules come from its `AGENTS.md`. |
| **Result block** | The only way an agent hands data to the server: a JSON block that is checked against the step's schema. An answer that fails the check gets one follow-up that lists every error. |
| **Planner** | The agent that owns a plan and answers questions about it. A run's planner is its plan chat, and an epic's planner answers for its child runs. The backlog planner works in *turns*. Planners form one chain: run → parent run → backlog → person. |
| **Question** | What an agent or a planner cannot decide. It goes up the chain (rule 9). |
| **Check** | A command from the project's `.swarmloop.json`, run in the project's image: tests, lint, types, build. The same commands run in CI. |
| **Reviewer** | One of five agents that judge a change: `requirements`, `quality`, `regressions`, `security` and `performance`. A sixth visit writes the *report* a person reads. |
| **Merge request** | The change on the code host, with the report in its body. The host's CI judges it once more. |
| **Command** | Every change asked of a run (start, resume, replay, rebase, answer, stop…) is a command. It has an idempotency key that names the event it is for. A planner sends the same commands a person does. |
| **Wait** | A run that cannot go on now waits on one named thing (rule 10). |
| **Place** | A slot of a limited resource: an agent container (`AGENTS_PARALLEL`), a check slot (`CHECKS_PARALLEL` and the cores), a child run of an epic (`SUBTASKS_PARALLEL`), a backlog task (`BACKLOG_PARALLEL`). |
| **Backlog** | A project's ordered work: repositories, milestones, requirements (`M1.R1`), tasks with `depends` and `covers`, decisions, items, events and a merge mode. It has its own planner and starts its tasks as runs. |
| **Sandbox** | The container an agent or a check runs in. It holds only the run's own worktrees and reaches the network only through the egress proxy. |
| **Connection** | A person's credential for a code host, an agent runtime or a tracker. It is stored encrypted, and a run uses its starter's connections. |

## 1.2 States of a run

A run is in exactly one of five states:

| State | Meaning |
|---|---|
| **working** | A step runs. |
| **waiting** | It waits on one named thing, with the time of its next try when there is one. The thing is one of: a child run, a planner's answer, a person, a merge, an outside service (model provider, code host, CI, docker, disk) or a free place. |
| **stopped** | A person stopped it. Only a person starts it again. |
| **done** | It is merged, or it was closed or skipped, and it says which. |
| **failed** | A step could not go on, and no planner could decide. It says which step failed and why. |

What a person may do in each state comes from the server, never from the dashboard.

## 1.3 The flow

`requirements → prepare → research → plan → plan-improve → branch → implement → implement-improve → checks → code-review → commit → merge-request → pipeline → done`

A step ends in one of these routes:

- **next**: go to the following step;
- **jump**: go to a later step the table allows;
- **return**: send the run back to an earlier step, with the reason;
- **wait**: wait on a named thing;
- **fail**: fail with the reason.

The tables of allowed returns and jumps are the only place a route is decided.

## 1.4 Rules, one per mechanism

1. **One kind of run.** A top-level run, a child run and an epic go through the same flow and the same code. A difference between them is data (the base, the parent, the task list), never a separate path.
2. **One door for every start.** Every agent start goes through one door: a step's agent, a reviewer, a planner visit or turn, a conflict agent, a merge look. The door checks that the input changed since the last start, that spend and loop limits allow it, and that a place is free. Then it records the start.
3. **One door for every state change.** A run's state changes only through `history/run-state.ts`, in the same write as the change that causes it.
4. **Gates by generation.** A review, a check pass or a CI result counts only for the generation and the files it judged. Replay and Rebase raise the generation, so stale judgements stop counting by themselves.
5. **Returns go to the step that can fix.** A defect found by checks, review, commit or CI returns the run to implement with the reason. A run is never left waiting for a fix that no step will make.
6. **Base moves.** When a run's base moves, the run moves onto it. A conflict goes to that run's implement agent, and the resolution passes checks and review like any change. No conflict waits for a person.
7. **One merge rule.** Work lands only in order, with green checks, reviews and CI on the very tree that merges. This applies to a child run merging into its parent's branch and to a run merging into `main`.
8. **Questions go up one chain.** An agent that cannot decide asks its run's planner. A planner that cannot decide asks the next one up, and the last one asks the person. The answer comes back the same way. No question is dropped and none is asked twice.
9. **A person steers through planners.** A person's message goes to a run's planner. The planner changes the plan, answers, or sends a command, and a person's command goes the same way.
10. **Named waits, one wake rule.** A run waits only on a named thing. It says what that thing is and when the next try comes, and it wakes by one rule when the thing changes. A delay or outage of anything outside swarmloop is a wait, never a failure. A person is asked only when such a wait runs out.
11. **Commands are events.** Every command carries an idempotency key that names its event (the attempt that died, the outage, the commit), never a counter. Sending it twice does the work once.
12. **Recovery by one reconciler.** After a crash or a restart, one reconciler looks at every run. Each one either goes on from its journal or waits with a reason. Nothing needs a person to edit data.
13. **Verification before landing.** Every change passes the project's checks and the reviewers before it lands, including a conflict resolution and a fix after review. A check gives the same result on a busy machine. A red check the run did not cause goes to its planner, and it does not go into the run's diff.
14. **Agents hand data only in result blocks.** The server never reads structured data out of an agent's prose.
15. **Vendors only in adapters.** Code hosts, agent runtimes and trackers live behind their interface in `integrations/`. No vendor name appears in core code.
16. **The server never runs project commands.** Project commands run only in the project's image: in the agent sandbox, in the checks, and in CI.
17. **What a person sees is the run's own live state.** Every wait says what it waits on and until when. No screen shows a copy that another run wrote.
18. **Limits are waits with a reason.** Money, tokens, time and loop limits stop a run in a wait that says which limit it hit and what clears it.

---

# Part 2. Map of the code

## 2.1 Server layers (`server/src`)

| Layer | Folders | Job |
|---|---|---|
| Input and output | `api/`, `api/run-view/`, `cli/`, `live/` | HTTP routes, the run page's view model, the CLI, the websocket. They translate; they decide nothing. |
| Orchestration | `pipeline/`, `pipeline/backlog/`, `pipeline/backlog/planner/` | Driving runs from step to step, the reconciler, commands, waits, merges, the backlog scheduler and planner turns. |
| Steps | `steps/<step>/`, `steps/shared/`, `steps/contract/` | One folder per step. Shared services hold whatever more than one step needs, and the contract holds routes, returns and document kinds. |
| Agents | `agent/`, `agent-result/`, `integrations/agent-runtime/` | Launching an agent process, streaming it, limits, sessions, prices, result blocks and their schemas. |
| Environment | `environment/`, `sandbox/` | Project images, setup, checks, check slots and CPU slices, containers, the egress proxy, memory caps. |
| Git | `git/`, `git/rebase/`, `git/naming/` | Worktrees, fetch, rebase with its journal, squash, merge-tree, branch and commit names. |
| Storage | `history/`, `history/migrations/` | SQLite in WAL mode, entities, repositories, guarded migrations, visits, waits, stalls. |
| Integrations | `integrations/code-host/`, `issue-tracker/`, `linked-pages/`, `requirements-source/` | Adapters for GitHub, GitLab, Jira, Confluence, Drive and pasted pages. |
| Access | `auth/`, `config/` | People, sessions, tokens, OAuth apps, connections, the secret box, env and redaction. |
| Shared language | `contract/`, `core/` | Types and words shared with the dashboard: states, reasons, error codes, steps, commands, and the clock. |
| Side services | `readiness/`, `eta/` | Readiness checks of the server and estimates of time left. |

The ESLint boundaries enforce these layers: input and output → orchestration → steps → storage.

## 2.2 Other parts

- **Dashboard** (`dashboard/`, Next.js): Overview, Runs, the Run page (flow board, conversation, history, logs), Backlogs (board, chat with the planner, progress), Stats, Settings (agents, people, API tokens), Connections and Login. It reaches the API only through `lib/api.ts`, and live events only through `features/shell/use-live-bridge.ts`.
- **Skills** (`skills/`): one per agent step, plus `code-review/<reviewer>` and `backlog-plan`.
- **Images** (`docker/`): `server`, `dashboard`, `egress`, and one agent image per runtime. A project image is built from the project's own config, and the agent CLI is mounted into it.
- **Data** (`data/`): the database, the run logs, the secret key and backups. The worktrees live in their own volume.

---

# Part 3. Processes

Each process gives the target first, then **Today** for where the code stands.

## 3.1 Starting a run

**Target.** A run starts from one of four sources, all through the one start command:

- the New run dialog (a prompt, tickets, linked pages, attachments and repositories);
- the CLI (`bin/swarmloop run`);
- a backlog task;
- an epic starting a child run.

The key follows one rule, `^[a-z][a-z0-9-]{1,48}$`. A child run's key is `<parent>-<task id>`, so a task id is checked when the plan is made, never at launch.

**Today.**
- Holds through `POST /runs`, `backlog-start` ("as `POST /runs` starts a run") and `run-subtask-commands`.
- The CLI runs the pipeline in its own process, which writes the same history, so the panel shows a CLI run only after a reload.
- part-keys (merged) validates task ids at plan time.
- The IDE bridge is gone: `bin/sloop`, `server/src/acp/` and what only they used were removed.

## 3.2 Steps one by one

| Step | Runs as | Does | Ends |
|---|---|---|---|
| requirements | server and agent | Builds the requirements record from the prompt, tickets (Jira) and linked pages (Confluence, Drive, paste), read with the starter's connections. | next |
| prepare | server | Puts the run's repositories in place (clone, add, create) and records them. | next |
| research | agent | Reads the code and writes the impact list, the questions it cannot settle, and the sibling tasks it needs (for a child run). | next; wait on questions |
| plan | agent (the run's planner) | Writes one checklist, or questions, or a split into tasks with `depends`, `covers`, a contract and kept capabilities (when `SPLIT` allows). Also answers a person's messages. | next; jump to branch |
| plan-improve | agent | Checks the requirements list against the input and the plan's coverage, and adds what is missing. | next; back to plan |
| branch | server | Creates the feature branch per repository. For an epic, it pushes the branch first, because the child runs start from it. | next |
| implement | agent, or server for an epic | Applies the checklist in the worktree; the agent never commits or pushes. For an epic, it runs the split pass (3.10). It also takes returns, conflicts and a planner's answers. | next; jump (to implement, commit, checks or code-review); wait |
| implement-improve | agent | Looks for gaps in the change and fixes only those. An epic skips it, because each task checked its own work. | next |
| checks | server, in the project image | Runs the project's checks on the worktree (3.6). | next; return to implement |
| code-review | five agents, then a report | Judges the change (3.7). | next; return to implement |
| commit | server | Commits the planned paths as the starter and pushes, or starts CI again for a branch that is already pushed. | next; return to implement (a refused name); jump to done (nothing to merge) |
| merge-request | server and agent | Opens or updates the merge request, with the report in its body. It stays a draft until the run is done. | next; back to code-review on stale gates |
| pipeline | server | Waits for CI on the head commit. A red job goes back to implement with its trace (3.8). | next (done); return to implement; back to code-review |
| done | — | The run waits for its merge (3.9). | — |

**Today.**
- The step list, the routes and the tables live in `contract/steps.ts` and `steps/contract/` (`returns.ts`, `route.ts`).
- There is an extra route, **block**, which the target replaces with *wait on a person* or *fail*.

## 3.3 An agent visit

**Target.**

1. **The door** (rule 2) checks the input fingerprint against the last start, the spend and token limits, the loop limit and a free agent place. It records the start.
2. **The launch** resolves the role's agent, from the person's saved agents or else the env lists. It builds the prompt from:
   - the step's skill;
   - the `AGENTS.md` of each mounted repository;
   - the requirements brief and the step's declared documents;
   - the run's attachments;
   - for a child run, its parent's tasks, results and contract, but only what changed since its last prompt.

   It mounts the run's worktrees (read-only for reviewers) and the run's log folder, and starts the container behind the egress proxy. The chat of the step's session group resumes. A launch may give its agent read-only helpers on another model of its own runtime, inside its container and on the same mounts; their cost is the visit's. A launch that gives its agent helpers leaves the agent no reading of the code of its own but Grep.
3. **While it runs**, the stream is logged and sampled (CPU and memory). The step's time limit, idle silence (`IDLE_TIMEOUT_MS`), the token ceiling and the loop detector each end it with a reason.
4. **When a provider's limit** stops the agent, the next agent of the role takes over. When none is left, the run waits until the limit's reset (a cooldown) and then goes on by itself.
5. **The answer** is the result block, checked against the step's schema plus the server's own checks. An invalid answer gets a follow-up that lists every error and nothing else. An answer that is still invalid after the follow-ups ends the visit, and its errors are kept for the next launch.
6. **The visit** records its cost and tokens: the provider's cost, or the price table when the provider gives none. It also records its effort, samples and outcome.

**Today.**
- Steps one to six hold for run agents through `steps/shared/agent-door.ts` (launch-door).
- A visit that ended by its own answer (still invalid after its follow-ups) or by its own limit counts as finished in `steps/shared/same-input.ts`, so the next start of the machine or a planner on that input is refused as the same input and asked up the planners' chain once, with its answer errors. A visit cut by something outside the agent (an outage, a usage limit, an outside wait, a process that died, a person's Stop) runs again on its input.
- A model host that does not answer is a wait. Each runtime adapter reads it (`classifyOutage`), `AgentLauncher` ends such a launch as `HostUnavailable` with its next try, and this holds for a step's agent, a plan visit, a reviewer, the report, the implement chat, the planner's question turns and the backlog planner's turn. The chain asked after a same-input refusal keeps that refusal's wait.
- The backlog planner's turns start through their own `turn-runner.ts` and are not admitted by the door.
- Only the backlog planner's turn gives helpers: `AGENTS_BACKLOG_READ` lists them, and `AgentLauncher` picks the first entry of the runtime that runs, on a new turn, a Resume, a follow-up and a failover alike. It sets the code-only-by-helper rights on each helper it gives, so the runtime's adapter holds the agent to its helper for every one of those launches. A visit's cost counts its helpers: each model of a result line is priced at its own price when the runtime reports no cost.

## 3.4 Documents, gates and generations

**Target.** A step declares the document kinds it reads (`inputs`, or `late` inputs read when needed) and the kinds it writes (`outputs`). It can write only what it declares. Each kind has one codec: the schema of the result block, or a legacy text reader for old runs. Gates follow rule 4: a review or a CI result whose generation or files differ makes the run go through review again before anything is published.

**Today.** Holds through `steps/contract/` (`artifacts`, `input-reader`, `output-writer`) and through `document.repository` together with `gate-stamp`, `stale-review` and `stale-gates`.

## 3.5 Returns and loops

**Target.**
- Checks, code-review, commit and pipeline return to implement with the reason.
- The return limits are `MAX_RETURNS` and `MAX_PIPELINE_RETURNS`. A loop that goes on past them, or the same input twice, stops in a wait for the planner, with the history of the returns.
- After the reviewers' findings are fixed, the next round reviews again.
- A finding that implement refuses comes back to the reviewer with implement's reason. If the two still disagree, it goes to the planner and then to the person.

**Today.**
- The tables hold.
- A return of an epic does not always reach its implement; f124 (running) closes this.

## 3.6 Checks and the project environment

**Target.**

`.swarmloop.json` gives:
- the image (a base image or a Dockerfile);
- the setup command;
- the checks, each with an optional name and the paths it covers;
- the cache folders;
- the network mode (`setup` keeps the agent off the registries).

A check runs:
- only when the change touches its paths;
- only once per tree: a command that already passed on the same tree and image is not run again.

Each check gets its own cores. Only as many checks run at once as fit with at least four cores each (`CHECKS_PARALLEL`), and agents and setup use cores only after the checks. CI runs the same commands from the one workflow, and the tests besides: a run's checks run the static checks and the build, and only CI runs the server and dashboard tests, the server suite also under the seeds. Before handing over, the implement agent runs the specs of the files it changed and the golden specs. The tests therefore run once in full, on the code host's runners, not on the machine that runs the agents.

**Today.**
- The above holds: f118 and f119 added the cores, and the passes are recorded.
- Since 24.11 the checks run no tests. From 21.11 to 24.11 the server and dashboard tests took 47 of the 61 hours of checks and failed 47 times, most of them timeouts under load. A test that only fails under load is still broken (3.24): steady-vitest and steady-agent-limit fix those tests. Server: each of the four specs that sent runs back on 24.11 takes 2.6 to 6.1 s as a file, alone on four cores and squeezed onto one, before and after the fix (before/after, alone then squeezed: `agent-limit.e2e` 3.8/4.1 s and 4.5/4.9 s, `plan-chat-subtask.e2e` 3.4/3.9 s and 4.1/5.3 s, `runs-rebase.journal` 2.6/2.9 s and 3.5/3.4 s, `flow-default-test.e2e` 4.8/5.1 s and 5.9/6.1 s), so neither a spec's own work nor the workers against the cores explains a timeout. Git is 0.6 to 1.4 s of each file. The numbers of the 71-file run point to one cause, not yet confirmed on the whole suite: a Jest worker's heap grows with every flow spec file (2.3 GB over the 71 files of `server/src/testing` in one process) and a grown worker runs the same spec two to three times slower (`flow-default-test.e2e` 15.4 s grown against 5.8 s fresh, `flow-ci-silent.e2e` 23.3 s against 8 s). `server/jest.config.js` now sets `workerIdleMemoryLimit` to 1500 MB, about four to six times the 250 to 400 MB of a fresh worker, so a grown worker is replaced between files, and `server/jest.global-setup.js` turns off git's `gc.auto` and `maintenance.auto` for every git a spec starts (16 and 23 upkeep processes of about 500 in two of the four specs). In one worker over the files `server/src/testing/[a-f]*.spec.ts` (`npx jest --maxWorkers=1 --logHeapUsage` on one core, cut at 285 s) the heap reached 1962 MB without the limit and 885 MB with it, and `flow-ci-silent.e2e` took 13.9 s against 11.6 s. Over the 37 files `server/src/testing/[a-f]*.e2e.spec.ts` in one worker on one core, `agent-limit.e2e` took 12.2 s without the limit and 5.0 s with it, `flow-default-test.e2e` 9.9 s and 6.3 s, `flow-ci-silent.e2e` 13.2 s and 6.9 s; a second pair of runs of the same files gave 6.5 s and 5.1 s, 7.9 s and 7.6 s, 11.0 s and 8.5 s, with heaps of 328 to 667 MB without the limit and 295 to 641 MB with it, and 231 s against 243 s for the whole set, so the gain of the limit is not stable on this machine and the growth to 2 GB showed only in the 71-file run. `flow-epic-main.e2e` is still the slowest file (12.3 s alone on one core, 21 to 26 s in a run of many files, eight tests sharing the 12.3 s alone) and is left as it is. No whole-suite run has measured the effect; CI's jobs `server-test` and `server-test-seeds` judge the whole server suite, and a spec that is slow under load is not ruled out. The timeout, the worker count and the specs are unchanged. Dashboard: jsdom's `getComputedStyle` matches every emotion style rule on each call, and role queries, clicks and style reads make one per element, so a test slows with the rules in `document.head`. `dashboard/vitest.setup.ts` now empties emotion's style rules after each test (`dashboard/test/emotion-cache.ts`), and the dialog and edit tests were split into one flow each, while the paging, layout and conversation tests were made cheaper. Since 24.11 the dashboard suite runs only in CI, where the `dashboard-test` job judges it; a dialog test still spends a third of its time in `getComputedStyle` on the rules of its own tree, so a test that is slow under load is not ruled out.

## 3.7 Code review

**Target.**
1. A round starts the five reviewers together. Each one reads only its own skill and the diff, the brief, the requirements list, the plan and the decisions.
2. Each answers `ok` or `return` with findings, and the server checks the requirements reviewer's answer against the requirements list.
3. Any `return` sends the run to implement with the findings.
4. When all five say `ok`, the report visit writes the report for the merge request: what was decided, where to look, and what was refused and why.
5. A reviewer's question that it cannot settle goes up the chain (rule 8).
6. A round interrupted by a restart resumes only its own reviewers' files.

**Today.** Holds (`steps/code-review/`). The f124 parts *review-input* (merged into the epic) and *review-input-read* and *review-input-bytes* (pending) make the review read exactly the committed change.

## 3.8 Commit, merge request and CI

**Target.**
- **Commit.** The server commits only the planned paths, as the starter (`run-author`), and pushes. Branch names, commit messages and titles follow the repository's own format, which is Conventional Commits by default. A name that the host refuses goes to the implement agent once. The rule it learns is written into the `git` section of the repository's `.swarmloop.json`.
- **Merge request.** The server opens or updates it from the repository's template, with the report in its body between markers, and keeps the report current.
- **CI.** The pipeline step reads CI on the exact head commit. A red job's cleaned trace is saved, and the run returns to implement with it. A job that only CI fails, on the same content the checks passed, is marked CI-only. A known flaky test is told apart. When CI never starts, the step looks again on a timer and then triggers it. A run is done only when its merge requests are ready for review.

**Today.** Holds (`steps/commit/`, `steps/merge-request/`, `steps/pipeline/`).

## 3.9 Merge

**Target.** One merge rule (rule 7) with one queue per target branch:
- children into the epic's branch, one at a time as they turn green;
- backlog tasks into `main`, in backlog order, by the backlog's merge mode: `green` merges on green, `ok` waits for the owner.

A run that is not in a backlog is merged by a person on the host. The merge watch reads how every done run's merge requests ended, every `MERGE_WATCH_MIN`, and marks the run merged or closed. A merge method is tried in its order (squash, rebase, merge commit).

**Today.** Three places decide merges:
- the epic's split pass (children);
- `pipeline/backlog/backlog-merge.ts` (backlog tasks), which also rebases a task that is behind `main`;
- `pipeline/merge-watch.ts`, which only reads.

They follow similar rules but separate code. One merge path is planned after M1.

## 3.10 Epics

**Target.** An epic is a run (rule 1). Its plan splits the work into tasks, with:
- `depends`, and `covers` (requirement ids);
- a **contract**: decisions any task may rely on, with a log of who decided what;
- **kept capabilities**: what must keep working, and which tasks touch it.

Its implement step is the **split pass**, which runs on every change and in this order:

1. Commit the epic's own edits onto its branch. A conflict here goes to the epic's implement agent once every task is settled.
2. Take the child runs' reports and questions, and answer them through the epic's planner (rule 8). An answer may add, change or drop a task that has not started, or make a task wait for a sibling.
3. Turn the final review's partial or missing requirements into new tasks (gaps).
4. Take each task's *needs*: what it needs from a sibling, and wait for it.
5. Follow each task's state from its run.
6. Merge the green tasks into the epic's branch (rule 7). After each merge, the planner looks at what merged (*merge look*): it is told which files the task changed outside its plan, and it may change the open tasks. The other tasks move onto the new tip (rule 6).
7. Start the tasks whose dependencies are merged or skipped, up to `SUBTASKS_PARALLEL`. A task that waits for a sibling takes no place.
8. Then wait on the open tasks, or go on when all are settled. The epic then runs its own checks, review, merge request and CI on the whole branch like any run.

When `main` moves while the epic waits, the epic takes it (rule 6). A conflict goes to its implement agent, and the resolution is checked and reviewed before the open tasks move. An epic that ends closes every child that did not finish.

**Today.**
- Holds (`steps/implement/split-*`, `pipeline/subtask-*`, `steps/shared/epic-*`, `epic-conflict-implement`), with these gaps:
  - a return of an epic does not always reach implement (f124);
  - the epic may read its tasks before their queued move has run (epic-round-moves, not in M1);
  - an epic's plan review may not change a task that has not started (plan-review-waiting-part, not in M1).
- An epic whose pass waits on a question that its parts or its gaps raised takes a new green main too, with no part running (rule 6; `takesMain` in `steps/shared/epic-between-passes.ts`, read by the main move and by an epic's Rebase). Every open part moves with its epic; a part that waits on a question or a sibling is moved and keeps its wait.
- Child runs follow the flow, but several mechanisms have their own code for children (3.11, 3.12).

## 3.11 Base moves and conflicts

**Target.** Rule 6, one path:
1. The base moved.
2. Fetch it and rebase the run's branch onto it, writing a journal first. A move carries only the run's own change: what lies between the base tip the run stands on and its head, as `git rebase --onto <new> <tip>` does, never what git's merge base adds once the base was rewritten. The tip is recorded per repository in `runs.base_tips`: when the worktree is made (prepare), after each move (written with the move, before the journal completes) and after a child catches up. A run with no recorded tip takes it, at its first move, from the journal history main already keeps: its own completed moves and its parent's heads before they moved. A run with no change of its own stands on the new tip, with no agent, no conflict and no commit.
3. On a conflict, park it and go to implement.
4. The conflict agent resolves it.
5. The resolution goes through checks and review.
6. Publish the rebased branch, and move the run's children onto it.

The journal makes a rebase that a crash cut finish or roll back. Every git operation on a worktree takes that worktree's lock, so two operations never touch one worktree at once.

**Today.** About eight paths move a branch:
1. a person's Rebase, or a parent's or the machine's (`steps/run-rebase.ts`, `api/run-rebase.service.ts`);
2. implement finishing a parked rebase (`implement-rebase.ts`);
3. an epic's own edits (`implement-own-conflict.ts`, `subtask-worktrees.commitOwnEdits`);
4. a child after a sibling merged, or a child behind its parent (`split-rebase.ts`, then `subtask-rebases.ts`);
5. the end of an epic's resolution round (`epic-round.ts`);
6. a child catching up with its parent's branch (`subtask-worktrees.catchUp`, which only warns when it fails);
7. the backlog merge queue (`backlog-merge.ts`);
8. the reconciler finishing a journal (`run-settler.ts`).

Every path that carries a run's change takes the one rule of step 2, `ownChangeBase` in `git/rebase/own-change.ts`. Paths 1, 2, 4, 5, 7 and 8 reach it through `rebaseFeatureRepos` and `squashOffMount` (a squash of `ownBase..HEAD` in a scratch clone, one commit with the run's message; nothing to carry means the worktree is reset to the new base). Path 6 (`catchUp`) and path 3 (`ParentTreeSync.commit`) run `git rebase --onto <new> <ownBase>`. A conflict that the squash from git's merge base parked before this rule (a journal entry with no `ownBase`) is not resolved: the worktree goes back to the head before that move and the move is taken again by the rule (`git/rebase/retake.ts`). A review stands when `sameOwnDiff` finds the carried change equal to the one reviewed, both measured from the same `ownBase`.

Paths 1, 4 and 5 move an epic's open parts through one rule, `pipeline/subtask-rebases.ts` (rule 6). A part that waits on a question or a sibling moves onto the new tip and keeps its wait: the move does not start it. A stopped part stays a person's and is not moved. A clean Rebase of an epic publishes the rebased branch before its parts move, as the main move does. The one-path target above stays with base-moves.

epic-conflict-implement removed the wait for a person. One path is planned after M1.

## 3.12 Planners and the conversation

**Target.**
- **A run's planner** is the plan chat of that run. It writes the plan, answers a person's messages (a question gets a reply, a change gets a plan revision), and answers the questions of its steps. After implement has started, a change amends the plan: done items stay done and the work goes on, and a done run reopens when its plan changes.
- **An epic's planner** also answers its child runs, looks at each merge, and turns gaps into tasks.
- **The backlog planner** works in turns, woken by events: a person's message, a run's state, a merge, `main` going red or green. It acts only through the actions and commands a person has: tasks, milestones, requirements, decisions, starting runs, messages to a run's planner. A turn that fails holds the backlog only while it is the latest. One planner of a level runs at a time. A turn hands heavy reading (code, long briefs, logs, diffs) to read-only helpers and decides itself: it reads code only through its read-only helpers, which its launch enforces, and checks a fact it acts on by its quote with one search.

**Today.**
- Holds through `steps/plan/`, `steps/shared/plan-conversation.ts` (visits and turns ordered one at a time), `pipeline/subtask-planner-answer.ts`, `pipeline/backlog/planner/`, `pipeline/run-reopen.ts` and `pipeline/plan-chat-route.ts`.
- Gaps:
  - a planner's change can overwrite one it did not see (f130).
- A backlog planner turn hands heavy reading to the helpers of `AGENTS_BACKLOG_READ` (`pipeline/backlog/planner/turn-runner.ts`, `skills/backlog-plan/SKILL.md`); the turn stays read-only and its row counts the helpers' tokens and dollars. `AgentLauncher` asks for the code-only-by-helper rights with the helper on every launch that gets one, Claude Code's adapter denies the turn's agent its own Read and Glob of the code and Bash, and a settled task shows in the turn's brief as one line. Only Claude Code turns get a helper today (3.21).

## 3.13 Questions to a person

**Target.** Rule 8.
1. A question reaches a person only after every planner below them has tried.
2. It shows whole, with where it came from and each planner's line.
3. An answer is matched to its question, goes back down to the step that asked, and the step takes it in its next visit.
4. A question the person has answered is never asked again.

**Today.** Since f129 a message and an answer take one route (`pipeline/plan-chat-route.ts`). About 25 files take part, and these question paths still have their own code:
- starter answers and asks (`steps/shared/starter-*`);
- research questions;
- split questions;
- escalation (`pipeline/escalation.ts`);
- passing a backlog run's questions on (`question-pass-on.ts`);
- question parts and holds;
- the answers route.

A part's starter answer escalates on main (`starter-answer.ts`, `StarterExchange`). One gap remains: an escalation in a top-level run's message reply can be dropped; message-escalation closes it.

They join in one path after M1 (one-question-path).

## 3.14 Commands and a person's actions

**Target.** A person acts by:
- a message to a planner;
- an answer;
- Stop and Resume;
- confirmed dangerous actions: Replay of a step, Rebase, Skip, Remove.

Each one is a command with an idempotency key that names its event (rule 11) and an expected revision. The server says which actions each state allows. A dangerous action asks through one confirm dialog. A planner sends the same commands.

**Today.**
- The backlog planner sends Resume, Replay of a step with its instruction, Rebase, an answer, Stop, Skip and a message on every run of its backlog, an epic's parts included, through `PlannerRunCommands.send`, and reads a run's failed step, check output and failed CI jobs (`pipeline/backlog/planner/run-facts.ts`, cut in `event-facts.ts`).
- There are 11 command types: `start`, `resume`, `replay`, `rebase`, `answer`, `plan-chat`, `stop`, `step`, `remove`, `skip` and `projects`.
- `step` stays as the type through which the local CLI's `swarmloop step` records its run. A reviewer's `Run again` and its route are gone.
- A run's planner answers a message in a turn of its own when no step drives the run (`pipeline/planner-own-turn.ts`). It sends Resume, which leaves the message for the resumed run, or Replay of a step with its instruction.

## 3.15 Waits, places and timers

**Target.** Rule 10.
- **What a run can wait on:**
  - a child run;
  - a planner's answer;
  - a person;
  - its merge;
  - a model provider's limit, until its reset;
  - a code host, CI start, docker, disk space or a person's connection, each until its next try;
  - a free place.
- **Each wait** is stored as one record: what it waits on, since when, and its next try. One rule wakes it.
- **The scheduler tick** runs the timed wakes. A wait that runs out asks the person once, saying what was tried.
- **A place** is held only while there is work in flight (decision 4 of Part 4).

**Today.**
- Waits are kept in many ways:
  - the run's state and reason (13 states, 29 error codes, 18 reason codes);
  - `run_waits` stretches;
  - runtime and credential cooldowns;
  - agent places and check slots;
  - backlog turn waits and holds;
  - child-run waits;
  - a stopped run's pending message in its plan chat, which waits for the model host (`wait` of the entry).
- The reconciler has eight separate timed resumes: limits, host, CI not started, docker, disk, stalled, git auth and a stopped run's message turn.
- An agent start that waits before its first output, for a free agent place (with how many are busy) or for the server's pause, stores that wait with its run's state (on its turn row for a backlog planner turn) through `steps/shared/start-waits.ts`, and the run page, the run list and the backlog chat show it. A place comes back when its launch ends, because the launch ends its container in every ending (`agent/agent-launch.ts`).
- c04 closes this in M1; wait-frees-place and held-run-says-so come after.

## 3.16 Recovery after a crash or restart

**Target.** Rule 12.
- **Ownership.** Each run is owned by one server process: an instance id, the attempt and a claim on its step.
- **The reconciler.** At startup and every `RECONCILE_MS`, it looks at every run in flight and every command left accepted or executing. For each one it:
  - relaunches the step it cut, or waits for the agent that a dead process started;
  - finishes a rebase from its journal;
  - settles the command.
- **The stall watch** finds a run that stopped moving with no reason. It tries the step again up to three times, then waits for a person.
- **A planned restart** pauses the server: running visits end, no new ones start, and the dashboard says so.
- **Server stalls**, when the main loop was blocked or the machine slept, are recorded.

**Today.** Holds (`pipeline/reconciler*.ts`, `run-settler.ts`, `stall-watch.ts`, `stall-decision.ts`, `contract/interruption.ts`, `server-stalls/`). The gap is that waits after a restart follow the many wait paths of 3.15.

## 3.17 Backlog

**Target.**
- **What a backlog holds:**
  - repositories;
  - milestones: one active, the next queued, accepted by the owner;
  - requirements per milestone (`M<n>.R<n>`);
  - tasks with a brief, `depends`, `covers`, a milestone and a state;
  - decisions;
  - items (ideas outside milestones);
  - events.
- **Each tick, the scheduler:**
  1. merges the done tasks (3.9);
  2. starts the ready ones: their dependencies have merged, the `main` of every repository they touch is green, and a place is free under `BACKLOG_PARALLEL`. Places go to the backlogs in turn;
  3. says what every waiting task waits for.
- **A merged task** closes the requirements it covers, and a milestone whose requirements are all closed asks for acceptance.
- **When `main` moves,** epics take it (3.10), and other running tasks are rebased before they merge.
- **Writes.** The planner (3.12) and the person write through one writer (`backlog-actions`), which validates the change, writes it in one transaction and records who did it.

**Today.** Holds (`pipeline/backlog/`). Gaps:
- a task that waits for another task's merge still holds a place (wait-frees-place);
- a milestone proposed while another runs does not wait behind it (queue-behind-active).

## 3.18 Limits, cost and estimates

**Target.**
- **Per run:** `MAX_RUN_USD` and `MAX_RUN_TOKENS`.
- **Per step:** `STEP_USD_MAX`, `STEP_TOKEN_MAX` and a timeout for each step.
- **Per agent:** `IDLE_TIMEOUT_MS`, `MAX_AGENT_CALLS`, `MAX_LAUNCHES` and `LOOP_REPEAT`.

A limit stops the run in a wait that names it (rule 18). Every visit stores only its own cost and tokens, by one rule for a resumed chat. The estimate of time left comes from the history of finished runs of the same kind, and an epic's estimate from its tasks. The statistics read the same records.

**Today.** Holds (`steps/shared/spend-limit.ts`, `agent/limits.ts`, `visit-costs`, `eta/`, `api/stats*`). Limit stops are still blocks, not waits.

## 3.19 Storage and housekeeping

**Target.**
- **The database** is one SQLite database in WAL mode. Changes come only through additive migrations, behind a guard that backs up the database before it migrates.
- **What is written once:** documents, events and stalls are appended and never rewritten. A newer document of a kind supersedes the older one.
- **A write of a run** sets only the columns its writer changed, so a copy read earlier never sets back a change made since; after the write the copy is the stored row.
- **The disk guard** stops a step from starting on a disk it may fill. It frees old runs first, then docker leftovers, and only then makes the run wait (`MIN_FREE_GB`).
- **Retention** removes everything a finished run leaves after `RETAIN_DONE_DAYS`, and deleting a run removes everything of it.
- **Housekeeping** runs at startup and once a day.

**Today.** Holds (`history/`, a run's row is written by `history/run.repository.ts` and `history/visit.repository.ts` from what the copy read, kept in `history/run-read.ts`; `pipeline/disk-guard.ts`, `run-retention.ts`, `housekeeping.ts`).

## 3.20 People, access and connections

**Target.**
- **Sign-in** is through a code host (GitHub or GitLab OAuth), or with a personal API token for scripts. On first run the server creates its OAuth app.
- **The first person** is an admin, and one admin always stays.
- **Connections.** Each person keeps their own connections (code hosts, agent runtimes, Jira, Confluence, Drive), encrypted with the server's secret. A connection is tested when it is saved and refreshed before it expires. A run uses its starter's connections.
- **Request guard.** Every mutating request must:
  - carry `X-Swarmloop: 1`;
  - be JSON;
  - come from an allowed host and origin.
- **Secrets** are never logged, never put in a URL, and never sent to the browser.

**Today.** Holds (`auth/`, `config/redact.ts`, `api/request-guard.ts`).

## 3.21 Integrations

**Target.** Rule 15. Each vendor is one adapter behind the interface of its kind:
- **code host:** repositories, pushes, merge requests, CI, merge methods and push-refusal rules;
- **agent runtime:** launch, helpers, how it words a limit, and its model list (cached for a day);
- **issue tracker;**
- **linked-page reader;**
- **requirements source.**

Adapters are found by folder. A fake of each kind serves the tests.

**Today.** Holds (`integrations/`, `testing/fake-*`). Only Claude Code has helpers today (its subagent tool, on the helper's model and level, with the tools that read). Its adapter enforces the code-only-by-helper rights with a per-launch hook that denies the launching agent Bash and Read or Glob of the mounts' paths and leaves its search, the turn's folder and the helper alone. This change did not read Codex 0.167.0 or Cursor CLI 2025.11.25, so those adapters declare no helpers and launch as before.

## 3.22 Sandbox and network

**Target.**
- **What a container sees.** It holds only its run's worktrees; reviewers get them read-only. A `.env` file in a worktree is masked.
- **How it runs.** It never runs as root. All capabilities are dropped, `no-new-privileges` is set, the root filesystem is read-only, and it has a process cap, a memory cap and its own `/tmp` on disk. It has no docker socket.
- **Network.** The only route out is the egress proxy. It allows each container's hosts by policy: a model step reaches its vendor only, and implement and setup may also reach the package registries. DNS answers nothing inside.
- **Model keys** are swapped in by the proxy where the vendor allows it.
- **Lifetime.** A container never outlives its step.

**Today.** Holds (`sandbox/`, `docker/egress`).

## 3.23 What a person sees

**Target.** Rule 17. The dashboard reads the run's own state live over the websocket. Its screens:
- **Overview:** now, what needs you, done lately, numbers;
- **Runs:** epics grouped with their tasks;
- **Run page:** the flow board by phase, the conversation with the planner, the history of visits, documents and logs;
- **Backlogs:** board, chat, progress;
- **Stats, Settings, Connections.**

The text is plain words for a person: no raw JSON and no internal ids. A cut text says how much is left out and where the whole is.

**Today.** Holds in the main. Gaps:
- held runs read as failures (held-run-says-so);
- several screens are still being reworked in M1 (f95, f121, f131, f132, done-lately, b04, f26).

## 3.24 Tests, CI and releases

**Target.**
- **How a test is written** is defined once, in the Tests section of `AGENTS.md`:
  - each behavior is proven once, at the cheapest level: logic, a component alone, or one whole-flow spec per flow;
  - no test depends on time or load;
  - a slow or load-sensitive test is fixed by its design (a cheaper level, a split, fake time), never by its limit.
- **Whole-flow specs** boot the real application with the shipped defaults and assert the flow invariants after every tick.
- **Golden traces** record the exact behaviour of the main flows and change only when a task names that behaviour change.
- **CI** is one workflow with the same commands as the checks, and it alone runs the server and dashboard tests (3.6).
- **A release** tags a version, builds the images, runs a smoke test and publishes.

**Today.** The approach is the rule since 24.11. Existing tests that break it time out under load (3.6); since 24.11 they run only in CI. steady-vitest fixed them for the dashboard (3.6). For the server, steady-agent-limit replaces a grown Jest worker between spec files and turns off git's upkeep in specs (3.6); CI's `server-test` and `server-test-seeds` jobs judge the whole suite, and the class is not called closed before they do.

## 3.25 The server process, health and readiness

**Target.**
- **Two processes.** The API server drives runs and alone runs the reconciler, the scheduler, the merge watch and housekeeping. A CLI process drives only its own run.
- **The main loop does no heavy work.** Large file walks, git metadata copies and deletions run off the main thread, and a lint rule keeps them there. A worker thread ticks every second, so a blocked main loop or a sleeping machine is recorded as a stall.
- **Health and readiness.** `/health` answers whether the server is up and paused. `/readiness` lists what the server needs and whether it has it: docker, volume mounts, a model credential for every role, and stalls in the last hour. Each item links to where it is fixed.

**Today.** Holds (`pipeline/server-stalls/`, `eslint.main-thread-rules.mjs`, `readiness/`, `api/health.controller.ts`).

---

# Part 4. Decisions (24.11)

1. **An epic is a run with child runs**, not a separate concept (rule 1).
2. **`blocked` goes.** A block becomes *waiting on a person* or *failed*. *Done* means merged, closed or skipped, and a run whose merge request is ready waits on its merge.
3. **One merge rule and one merge path** for children into an epic and for tasks into `main` (rule 7).
4. **A waiting run holds no place.** A run that waits on a person, a merge or a sibling frees its place, and takes one again when it goes on.
5. **The IDE bridge goes**, and with it `chat`, `shell`, `rewind`, the snapshots and the CLI login flow. A person steers only through planners (rule 9).
6. **The backlog planner's turns go through the same door** as every other agent start (rule 2).
