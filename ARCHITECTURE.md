# swarmloop architecture

swarmloop brings a task to a merged change. Agents write the code. The project's own checks and three reviewers judge it. A person is asked only what no planner can answer.

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
| **Agent** | A runtime (`claude`, `codex`, `cursor`), a model and an effort, written `runtime:model[:effort]`. Each *role* (plan, implement, review, subtask roles, backlog plan) has an ordered list of agents, and the next one takes over when a provider's limit stops the first. An entry without an effort runs at the level of the entry before it, else at the `defaults.env` level of its role and tier, capped to what its runtime offers. |
| **Chat** | The session an agent keeps across visits. Research, plan and plan-improve share one chat; implement and implement-improve share another; each reviewer has its own. |
| **Skill** | The instructions of one step's agent, kept in `skills/`. A skill is generic and knows no project. A project's own rules come from its `AGENTS.md`. |
| **Result block** | The only way an agent hands data to the server: a JSON block that is checked against the step's schema. An answer that fails the check gets up to two follow-ups, each listing every error with the part of the definition it is about. |
| **Planner** | The agent that owns a plan and answers questions about it. A run's planner is its plan chat, and an epic's planner answers for its child runs. The backlog planner works in *turns*. Planners form one chain: run → parent run → backlog → person. |
| **Question** | What an agent or a planner cannot decide. It goes up the chain (rule 9). |
| **Check** | A command from the project's `.swarmloop.json`, run in the project's image: tests, lint, types, build. The same commands run in CI. |
| **Reviewer** | One of three agents that judge a change: `requirements`; `code`, with a quality and a security section; and `behavior`, with a regressions and a performance section. A fourth visit writes the *report* a person reads. |
| **Merge request** | The change on the code host, with the report in its body. The host's CI judges it once more. |
| **Command** | Every change asked of a run (start, resume, replay, rebase, answer, stop…) is a command. It is asked of a run, or of a scope when there is no run (a person's repositories), through the same executor. It has an idempotency key that names the event it is for. A planner sends the same commands a person does. |
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
| **done** | It is merged, or it was closed or skipped, and it says which. A skip ends a started run as skipped through one path and closes each of its open questions, a planner's escalation among them, with the skip as the reason, so no one is asked it again. |
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
2. **One door for every start.** Every agent start goes through one door: a step's agent, a reviewer, a planner visit or turn, a conflict agent, a merge look. The door checks that the input changed since the last start, that the run's one budget (money, `MAX_RUN_USD`, for every start but a person's) and the loop limits allow it, and that a place is free. Then it records the start.
3. **One door for every state change.** A run's state changes only through `history/run-state.ts`, in the same write as the change that causes it.
4. **Gates by generation.** A review, a check pass or a CI result counts only for the generation and the files it judged. Replay and Rebase raise the generation, so stale judgements stop counting by themselves.
5. **Returns go to the step that can fix.** A defect found by checks, review, commit or CI returns the run to implement with the reason. A run is never left waiting for a fix that no step will make.
6. **Base moves.** When a run's base moves, the run moves onto it. A conflict goes to that run's implement agent, and the resolution passes checks and review like any change. No conflict waits for a person.
7. **One merge rule.** Work lands only in order, with green checks, reviews and, when the repository has CI, CI on the very tree that merges. This applies to a child run merging into its parent's branch and to a run merging into `main`.
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
18. **Limits are waits with a reason.** Money, time and loop limits stop a run in a wait that says which limit it hit and what clears it.

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

- **Dashboard** (`dashboard/`, Next.js): Overview, Runs, the Run page (flow board, conversation, history, logs), Backlogs (board, chat with the planner, progress), Stats, Settings (agents, API tokens, and the read-only server settings, grouped and described as in `defaults.env` through `DefaultsLayout`), Connections and Login. It reaches the API only through `lib/api.ts`, and live events only through `features/shell/use-live-bridge.ts`.
- **Skills** (`skills/`): one per agent step, plus `code-review/<reviewer>`, `backlog-plan` and `reader` (the prompt of a helper). `plan/planner-core.md` is the core text the three planners share; the `plan` and `backlog-plan` skills include it through one `[planner core]` line, and `backlog-plan` takes its list of actions and their fields through one `[backlog actions]` line, written from the backlog turn's definition. Every skill of a role that can have a reader (`research`, `plan`, `plan-improve`, `backlog-plan`, `implement`, `implement-improve`, the three reviewers and the report) takes the shared `skills/reader/asking.md` through one `[reading with a reader]` line; the reviewers', the report's and implement's skills add one line that the diff and the lines being edited are read by the agent itself.
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
| branch | server | Creates the feature branch per repository. For an epic, it pushes the branch to every repository first: the child runs start from it, sync with it and target it, and nothing says yet which repositories they change. | next |
| implement | agent, or server for an epic | Applies the checklist in the worktree; the agent never commits or pushes. For an epic, it runs the split pass (3.10). It also takes returns, conflicts and a planner's answers. | next; jump (to implement, commit, checks or code-review); wait |
| implement-improve | agent | Looks for gaps in the change and fixes only those. An epic skips it, because each task checked its own work. | next |
| checks | server, in the project image | Runs the project's checks on the worktree (3.6). | next; return to implement |
| code-review | three agents, then a report | Judges the change (3.7). | next; return to implement |
| commit | server | Commits the planned paths as the starter and pushes only the repositories whose branch has a commit beyond its base (`hasOwnWork`), or starts CI again for a branch that is already pushed. A repository the run only read gets no push, no pipeline ref and no merge request. | next; return to implement (a refused name); jump to done (nothing to merge) |
| merge-request | server and agent | Opens or updates the merge request, with the report in its body. It stays a draft until the run is done. | next; back to code-review on stale gates |
| pipeline | server | Waits for CI on the head commit of each project that has CI. A red job goes back to implement with its trace (3.8). | next (done); return to implement; back to code-review |
| done | — | The run waits for its merge (3.9). | — |

**Where a repository lives.** A remote repository is picked by owner and name (`acme/team/app`, the label the picker shows) and placed in the checkout folder of its bare name, or in `<name>-<owner>` (the owner path with `/` turned into `-`) when another repository holds the bare name. `RemoteRepositories.clone` is the one clone path: it takes an `owner/name`, or a bare name that one repository has, and returns the folder (`steps/prepare/checkout-placement.ts` chooses it). A run's projects and a backlog's repositories end up holding folder names: the requirements step clones the picks and stores the folders, and creating a backlog and adding a repository to one (3.17) do the same through the same call.

**Today.**
- The step list, the routes and the tables live in `contract/steps.ts` and `steps/contract/` (`returns.ts`, `route.ts`).
- Picks and folders hold as above: `POST /runs` takes `owner/name` projects, the requirements step clones them (`requirements-clones.ts`) and stores the folders, and the picker offers every not-cloned repository by owner and name, a fork whose upstream is a local folder included. Adding a project to a running run takes an `owner/name` too, clones it the same way and adds the folder; so does adding a repository to a backlog's scope.
- There is an extra route, **block**, which the target replaces with *wait on a person* or *fail*.

## 3.3 An agent visit

**Target.**

1. **The door** (rule 2) checks the input fingerprint against the last start, the money limit (`MAX_RUN_USD`) for a start that is not a person's, the loop limit and a free agent place. It records the start.
2. **The launch** resolves the role's agent, from the person's saved agents or else the env lists. It builds the prompt from:
   - the step's skill;
   - the `AGENTS.md` of each mounted repository;
   - the requirements brief and the step's declared documents;
   - the run's attachments;
   - for a child run, its parent's tasks, results and contract, but only what changed since its last prompt.

   It mounts the run's worktrees (read-only for reviewers) and the run's log folder, and starts the container behind the egress proxy. The chat of the step's session group resumes. A launch may give its agent read-only helpers on another model of its own runtime, inside its container and on the same mounts; their cost is the visit's. A launch that gives its agent helpers gives the helper its own skill (`skills/reader/SKILL.md`) and leaves the agent every read tool of its own: its skill says when it reads itself.
3. **While it runs**, the stream is logged and sampled (CPU and memory). The step's time limit, idle silence (`IDLE_TIMEOUT_MS`), the per-step token ceiling and the loop detector each end it with a reason.
4. **When a provider's limit** stops the agent, the next agent of the role takes over. When none is left, the run waits until the limit's reset (a cooldown) and then goes on by itself.
5. **The answer** is the result block, checked against the step's schema plus the server's own checks. An invalid answer gets a follow-up, at most two times in the same chat, that lists every error and under each the part of the definition it is about (the field with its type, whether it is required and its allowed values, and for a choice the fields each choice needs and may also give; for a key the object does not take, the keys it takes), or the field list for a block that cannot be read, and nothing of the skill or the rules. Errors that say the same of one key in several places are one line with every place, and no line is cut. It asks for the result block only, with nothing before or after it. An answer that is still invalid after the follow-ups ends the visit, and its errors are kept for the next launch.
6. **The call** is one row of one log (`agent_exchanges`), written at the launcher, the one place every call passes. A step's visit and each return to it, each reviewer, the review report, a planner's answer, an epic's merge look and a backlog turn are a row each, and so is each helper a call starts and each failover to another runtime. Rows of keep-warm pings, which swarmloop no longer sends, stay in the log as history and read as before. A row links the call that started it (a helper's parent), the previous call of its chat and the call it replaces (a failover). It holds the planner's level (run planner, epic planner or backlog planner) and purpose, why the call started, its chat (new or resumed, and the minutes since the chat's last call), its runtime, model and effort, its tokens per model (uncached input, cache read, cache write and output) with the prices they were counted at, its own cost, its duration and how it ended: done, failed with its error, a limit with its reset, an outage, refused by the door, stopped by a person or timed out. A call's cost is summed from the usage of each model request as the stream comes in, so a call that fails, dies, hits a limit or is stopped keeps what it spent; the CLI's final line only cross-checks it. A helper's requests are its own row and are not counted again in its parent. A backlog turn is tied to at least one task or epic from the moment its row opens, by what its events name, or to the first running task (else the first waiting one) marked general when they name none; its valid result adds what its actions name. The visit links its rows and records its effort, samples and outcome.

**Today.**
- Steps one to seven hold for run agents through `steps/shared/agent-door.ts` (launch-door).
- A visit that ended by its own answer (still invalid after its follow-ups) or by its own limit counts as finished in `steps/shared/same-input.ts`, so the next start of the machine or a planner on that input is refused as the same input and asked up the planners' chain once, with its answer errors. A visit cut by something outside the agent (an outage, a usage limit, an outside wait, a process that died, a person's Stop) runs again on its input. A code review's input is the tree, the brief and implement's account (its stored results), so an answer given only in the account is a new input.
- A model host that does not answer is a wait. Each runtime adapter reads it (`classifyOutage`), `AgentLauncher` ends such a launch as `HostUnavailable` with its next try, and this holds for a step's agent, a plan visit, a reviewer, the report, the implement chat, the planner's question turns and the backlog planner's turn. A model host outage of the chain asked after a same-input refusal is the host's wait of the table, resumed once per outage; the start stays refused.
- `resultFollowUp` in `agent-result/result-follow-up.ts` builds the follow-up from the step's definition; `exchangeResult` and `withAnswerErrors` in `steps/shared/result-exchange.ts` and `correctCoverage` in `steps/shared/coverage-correction.ts` send it. The backlog turn's required and optional fields per action live in its definition (`needs` and `takes` of `agent-result/required-by.ts`): the check reads `needs`, and the follow-up and `choiceList` (`agent-result/result-choices.ts`) read both. The backlog skill's list of actions is written from that definition.
- The backlog planner's turns start through their own `turn-runner.ts` and are not admitted by the door. Their rows are recorded at the launcher, with their ties from the moment each row opens, until planner-turn-door puts the turns through the door.
- `agentFor`, `agentsFor` and `backlogPlanAgents` (`config/agents.ts`) give each use that `READ_ROLES` names (`config/read-roles.ts`; by default every planner, the reviewers and implement when the owner adds them) the `AGENTS_READ` list as the `helpers` of its agent, and the launch carries it. A failover keeps the launch's own helpers, and a launch with no tools gets none. `AgentLauncher` picks the first entry of the runtime that runs, on a new turn, a Resume, a follow-up and a failover alike. It gives each helper the reader's skill (`readerPrompt`, `steps/shared/skill-prompt.ts`), and the agent keeps all its read tools: no hook holds it to its helper. A helper's requests are a row of their own, linked to the call that started it, and a visit's cost is the sum of its linked rows, helpers included.
- The log of step six (`steps/shared/agent-launcher.ts` with `agent-call-recorder.ts` and `call-end.ts`; the one writer is `history/agent-call.repository.ts`) holds. A call's request usage is counted as the stream comes in (`agent/stream.ts`, `agent/request-usage.ts`), per message id once, at the runtime's prices. A failover is a row linked to the row that hit the limit, which ends as that limit. `reported_usd` is a cross-check, not a cost. A row keeps what its first request read from the cache; a call after a past ping-stop mark links to the chat's last call, not to the mark. Totals (optionally of one step), timelines and the keep-warm figures over the ping rows kept from before are queries over the log (`history/agent-call-queries.ts`, `api/agent-calls.controller.ts`). A visit whose process died, or whose container outlived a restart, is charged from the log after the launcher counts the requests its output files hold that no server read (`pipeline/attempt-stream.ts`, `agent/stream-requests.ts`).

## 3.4 Documents, gates and generations

**Target.** A step declares the document kinds it reads (`inputs`, or `late` inputs read when needed) and the kinds it writes (`outputs`). It can write only what it declares. Each kind has one codec: the schema of the result block, or a legacy text reader for old runs. Gates follow rule 4: a review or a CI result whose generation or files differ makes the run go through review again before anything is published.

**Today.** Holds through `steps/contract/` (`artifacts`, `input-reader`, `output-writer`) and through `document.repository` together with `gate-stamp`, `stale-review` and `stale-gates`.

## 3.5 Returns and loops

**Target.**
- Checks, code-review, commit and pipeline return to implement with the reason.
- The return limits are `MAX_RETURNS` and `MAX_PIPELINE_RETURNS`. A loop that goes on past them, or the same input twice, stops in a wait for the planner, with the history of the returns.
- After a return is answered, the next round reviews again: by a fix, or by implement's account explaining why no change is needed. A code review's input includes implement's account, so only the same tree with the same account is refused as the same input.
- A finding that implement refuses comes back to the reviewer with implement's reason. If the two still disagree, it goes to the planner and then to the person.

**Today.**
- The tables hold.
- A code review's input is the tree, the brief and implement's account (`readVisitInput` in `steps/shared/visit-input.ts`), so a return that implement answers in its account with no file change gets one next round with no planner or person asked; the same tree with the same account is refused by the door.

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
- The Resume of a `CHECK_FAILED` block starts implementation with the stored notes, wherever the block was written (`steps/shared/check-block-resume.ts`); the run view's sentence (`flow-waiting.ts`) reads the same rule, so a block at `checks` no longer runs the same checks again.
- Since 24.11 the checks run no tests. From 21.11 to 24.11 the server and dashboard tests took 47 of the 61 hours of checks and failed 47 times, most of them timeouts under load. A test that only fails under load is still broken (3.24): steady-vitest and steady-agent-limit fix those tests. Server: each of the four specs that sent runs back on 24.11 takes 2.6 to 6.1 s as a file, alone on four cores and squeezed onto one, before and after the fix (before/after, alone then squeezed: `agent-limit.e2e` 3.8/4.1 s and 4.5/4.9 s, `plan-chat-subtask.e2e` 3.4/3.9 s and 4.1/5.3 s, `runs-rebase.journal` 2.6/2.9 s and 3.5/3.4 s, `flow-default-test.e2e` 4.8/5.1 s and 5.9/6.1 s), so neither a spec's own work nor the workers against the cores explains a timeout. Git is 0.6 to 1.4 s of each file. The numbers of the 71-file run point to one cause, not yet confirmed on the whole suite: a Jest worker's heap grows with every flow spec file (2.3 GB over the 71 files of `server/src/testing` in one process) and a grown worker runs the same spec two to three times slower (`flow-default-test.e2e` 15.4 s grown against 5.8 s fresh, `flow-ci-silent.e2e` 23.3 s against 8 s). `server/jest.config.js` now sets `workerIdleMemoryLimit` to 1500 MB, about four to six times the 250 to 400 MB of a fresh worker, so a grown worker is replaced between files, and `server/jest.global-setup.js` turns off git's `gc.auto` and `maintenance.auto` for every git a spec starts (16 and 23 upkeep processes of about 500 in two of the four specs). In one worker over the files `server/src/testing/[a-f]*.spec.ts` (`npx jest --maxWorkers=1 --logHeapUsage` on one core, cut at 285 s) the heap reached 1962 MB without the limit and 885 MB with it, and `flow-ci-silent.e2e` took 13.9 s against 11.6 s. Over the 37 files `server/src/testing/[a-f]*.e2e.spec.ts` in one worker on one core, `agent-limit.e2e` took 12.2 s without the limit and 5.0 s with it, `flow-default-test.e2e` 9.9 s and 6.3 s, `flow-ci-silent.e2e` 13.2 s and 6.9 s; a second pair of runs of the same files gave 6.5 s and 5.1 s, 7.9 s and 7.6 s, 11.0 s and 8.5 s, with heaps of 328 to 667 MB without the limit and 295 to 641 MB with it, and 231 s against 243 s for the whole set, so the gain of the limit is not stable on this machine and the growth to 2 GB showed only in the 71-file run. `flow-epic-main.e2e` is still the slowest file (12.3 s alone on one core, 21 to 26 s in a run of many files, eight tests sharing the 12.3 s alone) and is left as it is. No whole-suite run has measured the effect; CI's jobs `server-test` and `server-test-seeds` judge the whole server suite, and a spec that is slow under load is not ruled out. The timeout, the worker count and the specs are unchanged. Dashboard: jsdom's `getComputedStyle` matches every emotion style rule on each call, and role queries, clicks and style reads make one per element, so a test slows with the rules in `document.head`. `dashboard/vitest.setup.ts` now empties emotion's style rules after each test (`dashboard/test/emotion-cache.ts`), and the dialog and edit tests were split into one flow each, while the paging, layout and conversation tests were made cheaper. Since 24.11 the dashboard suite runs only in CI, where the `dashboard-test` job judges it; a dialog test still spends a third of its time in `getComputedStyle` on the rules of its own tree, so a test that is slow under load is not ruled out.

## 3.7 Code review

**Target.**
1. A round starts the three reviewers together. Each one reads only its own skill and the diff, the brief, the requirements list, the plan and the decisions.
2. Each answers `ok` or `return` with findings, and the server checks the requirements reviewer's answer against the requirements list. The code and behavior reviewers answer each of their named sections (`quality` and `security`; `regressions` and `performance`) as `checked` or with its findings, and the server refuses a result that leaves a section out, as it refuses a missing decision.
3. Any `return` sends the run to implement with the findings.
4. When all three say `ok`, the report visit writes the report for the merge request: what was decided, where to look, and what was refused and why. The stored document and the merge request body head it from the facts of the checks and CI; the run page heads it from the run's outcome (`Merged` or `Closed without a merge`, else the same heading) through `RunReport.renderForPage`.
5. A reviewer's question that it cannot settle goes up the chain (rule 8). A reviewer and the report read through a reader only when `READ_ROLES` names `code-review` or `code-review-report`; the reader is for searching and reading around the change, and the diff and the lines under review are read by the reviewer itself.
6. A round interrupted by a restart resumes only its own reviewers' files.

**Today.** Holds (`steps/code-review/`). A review reads each worktree's head commit plus a read-only fingerprint of its uncommitted changes, then the brief, the added instructions and implement's account (`implementation_result` and `implementation_improve_result`; `readVisitInput` in `steps/shared/visit-input.ts`, `changeFingerprint` in `git/change-fingerprint.ts`). Its prompt lists the files changed outside the plan through `MergeMarks`' rule (`outsideOwn`; a subtask's own files come from `StarterBriefing.ownFiles`), and the requirements reviewer returns each test among them that the plan or an answer does not approve. A run's stored reviews are read with the reviewer set they were written by (`reviewerSetOf` in `contract/steps.ts`, `storedReviewers` in `agent-result/stored-review.ts`): a run reviewed before the three reviewers keeps its five rows, with the retired names `quality`, `regressions`, `security` and `performance` read only and never started again.

## 3.8 Commit, merge request and CI

**Target.**
- **Commit.** The server commits only the planned paths, as the starter (`run-author`), and pushes. Branch names, commit messages and titles follow the repository's own format, which is Conventional Commits by default. A name that the host refuses goes to the implement agent once. The rule it learns is written into the `git` section of the repository's `.swarmloop.json`.
- **Merge request.** The server opens or updates it from the repository's template, with the report in its body between markers, and keeps the report current.
- **CI.** The pipeline step reads CI on the exact head commit. A red job's cleaned trace is saved, and the run returns to implement with it. A job that only CI fails, on the same content the checks passed, is marked CI-only. A known flaky test is told apart. When CI never starts, the step looks again on a timer and then triggers it. A run is done only when its merge requests are ready for review. A run writes only to the projects it changed, and whether a project has CI is decided in one place: it has none only when the host refuses to read its pipelines or its main and the run's own head and merge request never had one. A project with none is not waited for; when no project has CI the step ends skipped, and the swarmloop checks and the reviewers are the gate.
- **Delivery list.** A run stores one list, one entry per repository of the run: `read` (no work of its own), `publishing` (it has work, but its branch, pipeline ref or merge request are not all made yet) or `published` (all three made). Only the steps that make them write it: commit decides `read` or `publishing` through `hasOwnWork`, the one place that decides it, and the merge request step marks `published` and writes `read` for a repository the code host answers nothing-to-merge for. Commit, the merge request step, the pipeline step, the merge watch, backlog merge and the run page read the list and derive nothing of their own. A `read` repository is never asked for a branch check, a merge request, a CI wait or a merge. A run is done only when no entry is `publishing`, except a run whose CI was skipped, which ends skipped as before and never reaches a merge request. A task is merged when every `published` entry is merged. A run made before the list has none and reads as every repository `published`.

**Today.** Holds (`steps/commit/`, `steps/merge-request/`, `steps/pipeline/`). Commit, the publisher after a base move and the pipeline refs push and record only a repository with `hasOwnWork` (`rebased-publisher.ts`, a commit beyond its base); an epic's early push of its feature branch is the one exception. The delivery list is the `delivery` document (`steps/contract/delivery-list.ts` holds its codec and the one set of readers). Commit writes it on every pass that ends, `read` or `publishing` by `hasOwnWork` (`commit-delivery.ts`). The merge request step builds trees, checks the push and opens requests only for the entries that are not `read` (`merge-request-trees.ts`), checks the review gate against every repository of the run, and writes `published` with the project of each opened request, or `read` for a repository the host had nothing to merge for (`merge-request-delivery.ts`). The pipeline step fails naming a repository still `publishing`, after its CI-skipped end and before any watch (`pipeline.step.ts`). The merge watch (`merge-watch.ts`) settles nothing while an entry is `publishing`, and backlog merge (`backlog-merge.ts`) walks only the entries that are not `read`; a run with no list reads as every repository `published` (`deliveryOf`). The run page shows each repository with its entry (`api/run-view/delivery.ts`, `run-delivery.tsx`), and labels each merge request with the repository whose entry names its project. `steps/shared/ci-reading.ts` is the one rule of whether a ref has CI: a refusal is a reading (`readCi`), and `noCi` reads none only when the run's own ref and the project's main both read none. The main reading (`repository-host.ts`) and the pipeline step (`load-seen.ts`, `pipeline-no-ci.ts`) both use it; the pipeline step decides on its first look, before any wait, which projects have no CI (`dropNoCi` by `noCi`): a project whose host refuses to read its pipelines is dropped whatever its tree holds, while a project with a workflow file whose branch never had a pipeline is kept, waits for its start and, if none comes, is a missing pipeline with its diagnosis; when no project is left the step marks the merge requests ready and ends skipped on that pass, with no watch (stale gates send it back to code review first); projects with CI are watched as before, and each project left out is named in the log. The CI wait names each watched project with its own commit. When a merge conflict keeps CI from starting, the pipeline step (`missing-pipeline.ts`) joins the code host's reasons into one conflict text, counts the try, records the loop and waits with "automatic rebase". `pipeline-rebase.ts` then sends the run's Rebase with that text, bounded by the try limit, whose stop says how many automatic rebases were tried. A move that leaves every head where it was parks the text and starts implement, whose conflict agent resolves it (`run-rebase.ts`, `implement-host-conflict.ts`). A move that changes a head goes back through code review. No such conflict stops for a person. The stop for a changed worktree, the wait on a code host outage and the block for other failed moves stay.

## 3.9 Merge

**Target.** One merge rule (rule 7) with one queue per target branch:
- children into the epic's branch, one at a time as they turn green;
- backlog tasks into `main`, in backlog order, by the backlog's merge mode: `green` merges on green, `ok` waits for the owner. Both wait for a green `main`; a `main` with no CI counts as green: the code host has no pipeline at all for its default branch, or it refuses the pipelines read with 403.

Every merge stores the files it changed, as the run's `merged_files` document, before its merge is recorded, so what a merged task changed outside its plan is read from its whole merge.

Both queues use one order rule per target branch: ready items are offered to the merge in queue order, and the first ready item that comes back held with a wait, a person or a refusal holds every later ready item of the same target branch for that pass. An item that comes back rebased is running again, so it holds nothing; an item that is not ready never holds.

A run that is not in a backlog is merged by a person on the host. The merge watch reads how every done run's merge requests ended, every `MERGE_WATCH_MIN`, and marks the run merged or closed. A merge method is tried in its order (squash, rebase, merge commit).

**Today.** One merge path holds: `steps/shared/merge-landing.ts`, with the rules of `merge-rules.ts` and the files of `merged-files-record.ts`, used by two queues:
- the epic's split pass (`steps/implement/split-merge.ts`), children into the epic's branch;
- `pipeline/backlog/backlog-merge.ts`, backlog tasks into `main`, which also rebases a task that is behind `main`, walks only the repositories of the run's delivery list that are not `read`, so a repository the run only read is never asked for a request, and adopts a run the merge watch saw merged. It lands each task through `MergeLanding`, which records the merged files before the task is saved merged and `task-merged` is recorded, on a merge and on an adopt. A later done task of a repository that an earlier task still has to merge into waits behind it, with the note `waits for <slug> to merge first`.

`pipeline/merge-watch.ts` only reads how a done run's merge requests ended, and settles nothing while a repository of the delivery list is `publishing`.

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
  - the epic may read its tasks before their queued move has run (epic-round-moves, not in M1);
  - an epic's plan review may not change a task that has not started (plan-review-waiting-part, not in M1).
- An epic whose pass waits on a question that its parts or its gaps raised takes a new green main (or a new main with no CI) too, with no part running (rule 6; `takesMain` in `steps/shared/epic-between-passes.ts`, which also takes an epic that waits at implement for a green main (`WAITS_FOR_MAIN`), read by the main move and by an epic's Rebase; a structure rule in `scripts/structure-rules.json` fails any other file that names `takesMain`). Every open part moves with its epic; a part that waits on a question or a sibling is moved and keeps its wait.
- A question of a skipped task is not handed down, not carried and not shown as open: the pass drops it (`withoutSkipped` in `steps/shared/subtask-question-line.ts`, read by `SplitQuestions.deliver`, the pass's carried questions and `openItems`), and an answer given to it adds no decision to the contract. Each pass first sends every task the list already reads skipped through the one skip (`closeSkipped` in `steps/implement/split-pass.ts`), so an epic that failed at implement on such a task goes on by a Resume.
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

**Today.** A relaunch after a rebase is marked on its flow row (`cause: rebase`). The run view and the history read its reason from the subtask's handoff `rebase` note, or say `Rebased onto main`, and show it until its steps ran on the new head; it is not a return. A step it runs again that has a visit reads `will run again` with its last outcome and its count (`api/run-view/last-outcome.ts`); one with no visit reads not started. A run whose red the backlog planner confirms is main's waits for a green main and is then rebased through the existing Rebase and resumed. A plain run goes through `pipeline/backlog/main-wait-wake.ts`, which sends through `main-rebase-send.ts`, the send-once-per-head logic it shares with the epic main move; an epic and its parts take main through the main move. About eight paths move a branch:
1. a person's Rebase, or a parent's or the machine's (`steps/run-rebase.ts`, `api/run-rebase.service.ts`);
2. implement finishing a parked rebase (`implement-rebase.ts`);
3. an epic's own edits (`implement-own-conflict.ts`, `subtask-worktrees.commitOwnEdits`);
4. a child after a sibling merged, or a child behind its parent (`split-rebase.ts`, then `subtask-rebases.ts`);
5. the end of an epic's resolution round (`epic-round.ts`);
6. a child catching up with its parent's branch (`subtask-worktrees.catchUp`, which only warns when it fails);
7. the backlog merge queue (`backlog-merge.ts`);
8. the reconciler finishing a journal (`run-settler.ts`).

Implement's conflict agent takes the planner's answer only when it answers the question `askConflict` asked (`answersConflict`, checked once in `settleRebase` for the rebase, own-edits and host-reported conflicts); any other answer stays pending for the visit whose question it answers.

Every path that carries a run's change takes the one rule of step 2, `ownChangeBase` in `git/rebase/own-change.ts`. Paths 1, 2, 4, 5, 7 and 8 reach it through `rebaseFeatureRepos` and `squashOffMount` (a squash of `ownBase..HEAD` in a scratch clone, one commit with the run's message; nothing to carry means the worktree is reset to the new base). Path 6 (`catchUp`) and path 3 (`ParentTreeSync.commit`) run `git rebase --onto <new> <ownBase>`. A conflict that the squash from git's merge base parked before this rule (a journal entry with no `ownBase`) is not resolved: the worktree goes back to the head before that move and the move is taken again by the rule (`git/rebase/retake.ts`). A review stands when `sameOwnDiff` finds the carried change equal to the one reviewed, both measured from the same `ownBase`.

Paths 1, 4 and 5 move an epic's open parts through one rule, `pipeline/subtask-rebases.ts` (rule 6). A part that waits on a question or a sibling moves onto the new tip and keeps its wait: the move does not start it. A stopped part stays a person's and is not moved. A clean Rebase of an epic publishes the rebased branch before its parts move, as the main move does. The move of an epic's open parts onto its new tip is one path, `EpicTasksMove` (`steps/shared/epic-tasks-move.ts`): `RunRebaseService` calls it after a clean Rebase (not after a conflict, `resolve`) and `EpicRound.finish` calls it after its commit. Every part's move is keyed by the tip it moves onto (`subtask-rebase-<part>-<tip>`), the plain move included, so a move sent twice is sent once. A `rebase` command that a dead process took runs again (`CommandService.settleLost`, like Stop and Remove), and `RunSettler.settleRebase` leaves a run whose rebase command is still to run to that command, so the parts move after a restart too. The one-path target above stays with base-moves. A structure rule fails any other file that sends a part its move as its parent (`byParent: true`), and another rule fails any file but `own-change.ts`, `parent-tree-sync.ts` and `subtask-worktrees.ts` that says what a move carries (`'merge-base', 'HEAD'` or `--onto`); both are in `scripts/structure-rules.json`.

epic-conflict-implement removed the wait for a person. One path is planned after M1.

## 3.12 Planners and the conversation

**Target.**
- **A run's planner** is the plan chat of that run. It writes the plan, answers a person's messages (a question gets a reply, a change gets a plan revision), and answers the questions of its steps. After implement has started, a change amends the plan: done items stay done and the work goes on, and a done run reopens when its plan changes.
- **An epic's planner** also answers its child runs, looks at each merge, and turns gaps into tasks.
- **The backlog planner** works in turns, woken by events: a person's message, a run's state, a merge, `main` going red or green. It acts only through the actions and commands a person has: tasks, milestones, requirements, decisions, starting runs, messages to a run's planner. A turn that fails holds the backlog only while it is the latest. One planner of a level runs at a time. A turn takes the messages and events that arrive while it runs and gets them in one follow-up in the same chat before its answer is applied; only what comes after starts the next turn. It keeps one chat for the backlog, which every turn resumes, so a short message costs a short call; the database stays the truth, and a resumed turn's prompt holds only what changed since the chat's last turn. The chat is renewed, with a line in the log and nothing in the chat, when it is gone, when the turn runs on another agent than the chat's, or when its last request passed a share of the model's context. A renewed chat starts from the short state brief, with the full task briefs and all decisions in files the planner reads when it needs them. A turn has its own time limit, and a turn stopped at it says so in the chat with the Resume line. A turn hands heavy reading (code, long briefs, logs, diffs) to read-only helpers and decides itself (so does every planner by default): its skill takes the shared text `Reading with a reader`: it hands the reading to the reader, reads itself only to settle a doubt, and checks a fact it acts on by its quote with one search.
- **The three planners read one core text**: questions go up one chain (decide what you hold, pass up what you do not), the look after a merge, and what a new task or a plan change carries. Each level keeps only its own: the run planner how it plans and escalates, the epic planner its parts, contract and answer fields, the backlog planner its turns, actions, milestones and helpers. Every skill of a role that has a reader takes the shared text `Reading with a reader` (`skills/reader/asking.md`) by its mark.

**Today.**
- Holds through `steps/plan/`, `steps/shared/plan-conversation.ts` (visits and turns ordered one at a time), `pipeline/subtask-planner-answer.ts`, `pipeline/backlog/planner/`, `pipeline/run-reopen.ts` and `pipeline/plan-chat-route.ts`.
- The core text is `skills/plan/planner-core.md`. `skillText` (`steps/shared/skill-prompt.ts`, `steps/shared/planner-core.ts`) expands its marker in both skills; the run's and the epic's plan chats read its parts through `skillSection` (`steps/plan/plan.prompts.ts`); the epic's merge look reads its merge part (`steps/implement/merge-look.prompts.ts`); the backlog turn reads the whole skill. The backlog planner's actions and their fields come from its definition through the `[backlog actions]` mark (`backlogActionsText` in `steps/shared/backlog-actions-text.ts`, expanded by `skillText`), so the skill and the check cannot differ.
- A planner's change or delete of a task names the revision its brief showed (`revision` of `changeTask` and `deleteTask` in `agent-result/definitions/backlog-turn.ts`, shown on each task line of the brief by `turn-lines.ts`); a stale one is refused by the one writer (3.17) with the task as it is now, and the refusal comes back in the follow-up in the same chat like every other refusal (`nameRefusalsOnce`), so the turn decides again on the fresh record.
- The backlog planner's one chat: `plannerChatKey` (`pipeline/backlog/planner/planner-chat-key.ts`) names it `backlog-<id>-planner`, and every launch of a turn passes it as `chatKey`. `plannerChatFor` (`planner-chat.ts`) decides before the brief is built whether the first launch resumes it: no stored chat or state folder, another runtime, model or effort than the chat's last call in the call log, or a last prompt at or above `BACKLOG_CHAT_CONTEXT_SHARE` of the model's context (an unknown size counts as past) renews it. A resumed chat gets `prompt` of `BacklogTurnPrompt.build` (`turn-prompt.ts`: what `turn-changes.ts` finds changed since the `seenState` of the last turn, and the turn's messages and events, in lines of `turn-lines.ts`); a renewed one gets `fresh` with `resume` false. The task line of a failed or blocked run carries its reason as a `reason:` line, read by `RunReasons` (`pipeline/backlog/planner/run-reason.ts`): the run's stored state reason as `code: message`, or else `<step> step: <line>`, the first line of the result the run's current step last ended with, read from the step event log (`StepEventLog.lastEnd`) through `resultLine` (`contract/event-text.ts`), the function the run page's attempt outcome uses too; a run with neither shows no line. Every launch carries `fresh` as `freshPrompt`, `brief` and `briefFor`, so a chat the CLI lost, a start on a cooling runtime and a move after a limit all open the new chat from the short state brief. The follow-up always resumes the chat of the first launch. After a valid answer the turn's row stores `seen`. `turn-brief-files.ts` writes `/work/brief/tasks/<slug>.md` and `/work/brief/decisions.md` (newest first) for the read-only brief mount. A turn's launches run under `BACKLOG_PLAN_TIMEOUT_MS` with no continue message, and a call killed at it fails the turn with the time limit as the reason; the row keeps what the call streamed, and its tokens in and out are the log's sums (`turnTokens`).
- A backlog planner turn takes what arrives while it runs: `TurnTakes` (`pipeline/backlog/planner/turn-takes.ts`) holds the window of the running turn, each take goes through the one `takeInto` (`history/backlog-chat.repository.ts`), and `turn-runner.ts` closes the window after the first valid answer and sends what the turn took since its brief as one follow-up through `AgentLauncher` in the backlog's chat (`followUp` in `turn-prompt.ts`, facts from the same `BacklogTurnState` reading as the brief's events); the answer to it is the one applied, and what comes after waits for the next turn.
- Every planner reads through the helpers of `AGENTS_READ` by default (`READ_ROLES`: the backlog turn, research, plan, plan improve and the planner's answers, the epic planner's included): the agent comes from the one `agentFor`/`agentsFor` call with its `helpers`, and the skills take `Reading with a reader` by its mark (`skills/backlog-plan/SKILL.md` and the others). A turn stays read-only and its row counts the helpers' tokens and dollars. `AgentLauncher` gives every helper the reader's skill, the turn's agent keeps all its read tools, and a settled task shows in the state brief as one line. Only Claude Code turns get a helper today (3.21).
- Implement of any run sends a need that names no task up the chain (`steps/implement/implement-asks.ts`, `StarterExchange`); a red outside the task's own files is sent up that way, not changed.
- A backlog planner turn whose next try comes while other work of its backlog runs runs once right after that work, in the backlog's planner chat (`backlog-planner.ts`, `waitsForTry`); the timer records it as due, and the backlog's work loop runs it before woken turns.

## 3.13 Questions to a person

**Target.** Rule 8.
1. A question reaches a person only after every planner below them has tried.
2. It shows whole, with where it came from and each planner's line.
3. An answer is matched to its question, goes back down to the step that asked, and the step takes it in its next visit.
4. A question the person has answered is never asked again.

**Today.** Since f129 a message and an answer take one route (`pipeline/plan-chat-route.ts`). About 25 files take part, and these question paths still have their own code:
- starter answers and asks (`steps/shared/starter-*`);
- research questions;
- split questions (a skipped part's question on its epic is closed by the skip path, see 3.14);
- escalation (`pipeline/escalation.ts`);
- passing a backlog run's questions on (`question-pass-on.ts`);
- question parts and holds;
- the answers route.
- f129's message route has no structure rule: `messageTurn` is a pure decision its readers import, and a second decision would carry another name that no pattern catches.

The backlog planner's answer to a run's question, given while an unsettled fix task for a red main names the run's repository and that main is not green, holds the run for that main (`pipeline/backlog/red-main-wait.ts`).

An open question and the state it gives are written together, in the write of the question (`RunOpenItems` in `history/run-open-items.ts`, through `history/run-state.ts`); no later pass rewrites the state, and the structure rules in `scripts/structure-rules.json` fail a write of `state` or `state_reason` outside `history/run-state.ts` and the migrations, and inside `history/` also a query builder's `.set`, an object, a spread or raw SQL that names them.

A part's starter answer escalates by the chain of f124 (`starter-answer.ts`, `StarterExchange`).
Every other planner answer, a step's question and a reply to a message on any path (the plan step's `answerMessages`, f129's own turn), has its `escalate` read by one function (`steps/shared/reply-escalation.ts`). It goes up only through `pipeline/escalation.ts`: `PlannerTurns.raise` puts the entry the plan step wrote to the person or, on a backlog run, to the backlog planner first. A subtask's message escalation is a `StarterExchange` hand-up for its epic's planner. A person's message has no step to read the planner's answer, so that answer is a taken line of the chat.

They join in one path after M1 (one-question-path).

## 3.14 Commands and a person's actions

**Target.** A person acts by:
- a message to a planner;
- an answer;
- Stop and Resume;
- confirmed dangerous actions: Replay of a step, Rebase, Skip, Remove.

A Skip ends the task's started run as skipped and closes each of its open questions, a planner's escalation among them, with the skip as the reason; no planner or person is asked them afterwards.

Each one is a command with an idempotency key that names its event (rule 11) and an expected revision. The server says which actions each state allows. A dangerous action asks through one confirm dialog. A planner sends the same commands; the backlog planner's skip of a started task (`skipBacklogTask`) is the person's Skip.

**Today.**
- The backlog planner sends Resume, Replay of a step with its instruction, Rebase, an answer, Stop, Skip and a message on every run of its backlog, an epic's parts included, through `PlannerRunCommands.send`, and reads a run's failed step, check output and failed CI jobs (`pipeline/backlog/planner/run-facts.ts`, cut in `event-facts.ts`), and the reason of a failed or blocked run on every task line (`run-reason.ts`, 3.12), so it decides on that reason and asks the person only when no action of its own can act on it.
- There are 13 command types: `start`, `resume`, `replay`, `rebase`, `answer`, `plan-chat`, `stop`, `step`, `remove`, `skip`, `projects`, `create-repository` and `remote-refresh`. The last two are commands of no run: the `commands` table has `run_id` null and a `scope` (`repositories:<login>`), `CommandService.acceptScoped` stores one and queues it under its scope in the same executor (start, finish, `recover` and `settleLost` work as for a run command; a lost one fails with `server restarted`), and it has no policy check, no expected revision and moves no run's revision. Its handler gets the actor. When it ends, `LiveHub.commandEnded` sends the `command` live event `{ commandId, state }` to every socket, and its actor reads the outcome with `GET /commands/:id` (`CommandView`; any other person gets a 404). `acceptCommand` answers the command id at once; `dispatchCommand` still waits for the handler of a run command.
- Creating a repository and refreshing a person's remote list are commands of no run (scope `repositories:<login>`). `POST /checkouts/repositories` takes the `idempotency-key` header and answers 202 with the command id at once. `GET /checkouts/remote` answers from the cache (`steps/prepare/remote-cache.ts`), says `loading` on the first read and starts one `remote-refresh` command for each stale host with no refresh pending and no failure kept; `POST /checkouts/remote/refresh` drops the kept failures and does the same. The run commands' own reads (`clone`, `offers`) still read a fresh list.
- The dashboard follows these commands through their stored state: Create sends the attempt's `idempotency-key`, then reads `GET /commands/:id` when the `command` event moves `commandEnds` and after a reconnect (`useCommandOutcome`); a lost answer keeps the attempt and re-reads the list. The remote list (`useRemoteList`) reads again on every such event while a dialog is open (so a created repository enters the list, and a refresh ends a `loading` list), shows a failed read with a Retry that calls `POST /checkouts/remote/refresh`, and keeps the last list.
- The resume rule in `scripts/structure-rules.json` fails a resume or a detached start outside the start gate, the API, the CLI, `pipeline.service.ts` and `run-lifecycle.ts`, also when the command type is passed in a variable (`commands.submit(type, …)`). `planner-own-turn.ts` is on its allow list: it sends through `CommandService` and `StartGate` as a person's start (`PERSON_RESUME`).
- A skip ends a run only through `skipRun` (`pipeline/skip-run.ts`), which closes its questions wherever they are held: through `closeSkippedQuestions` (`pipeline/skipped-questions.ts`) the run page lists each open question answered with the skip's reason and the pending questions and escalations of its plan chat are taken with it, and through `closeEpicQuestions` (the same file) the lines of a part's questions on its epic (`subtask_questions`) are answered with the same reason, answers already given kept. A run already stored skipped has its questions closed again with the reason stored with its skip. It is reached from a person's Skip of a part and the backlog planner's `skipTask` on a part (`PlannerRunCommands` sends `skip`, and `RunSubtaskCommandsService.skipTask` closes the part, closes its merge requests, writes the list and resumes the epic when a pass is due or it waits at implement on questions), from a backlog task's skip and the backlog tick, which ends the run of a task saved skipped before (`pipeline/backlog/task-run-skip.ts`), from the epic's pass for the parts it marks skipped and for the parts the list already reads skipped (`pipeline/subtask-end.ts`), and from the reconciler's sweep of the leftover parts of a merged or closed epic (`pipeline/epic-leftovers.ts`, which closes them through the same `pipeline/subtask-end.ts`). The backlog planner's `skipBacklogTask` on a started task saves the task skipped inside its turn and leaves the run to the backlog tick, because the stop command cannot join the turn's transaction.
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
  - the run's state and reason (13 states, 29 error codes, 19 reason codes);
  - `run_waits` stretches;
  - runtime and credential cooldowns;
  - agent places and check slots;
  - backlog turn waits and holds;
  - child-run waits;
  - a stopped run's pending message in its plan chat, which waits for the model host (`wait` of the entry).
- Outside waits (usage limit, code or model host, CI not started, docker, disk, git auth) end by one table (`contract/outside-waits.ts`) and one reconciler pass (`ReconcilerResumes.resumeOutsideWaits`), which also takes a stopped run's pending message at its next try. The backlog's turn wait, merges, main readings and an epic's main move read the same table. A structure rule fails an outside-wait test outside that table and `model-host-unavailable.ts`. The stall watch's tries stay with 3.16.
- An outside wait's next try is the next boundary of its interval (`nextTryAt` in `contract/outside-waits.ts`), fixed for the whole try, so an outage writes a waiting run once per try and not once per pass.
- An agent ended by SIGTERM or SIGKILL with no kill of ours and no Stop (its container stopped from outside) is a wait like a model host's outage: the launch throws `AgentStoppedFromOutside` (`steps/shared/stopped-from-outside.ts`), every caller of `agentFailure` takes it where it takes that outage (a planner turn stores it on its turn row), and `ReconcilerResumes.resumeOutsideWaits` takes it at its next try (the `HOST_UNAVAILABLE` row, no new row or retry count). Exit 137 of a container with a memory cap is the cap's kill, swarmloop's own limit: it is no stop from outside, relaunches under `MAX_LAUNCHES` and then fails (`killedByMemoryCap`, `agent/agent-result.ts`). Any other signal ends a step as `<step> failed: ended by <signal>`, with Resume offered. A person's Stop stays a stop.
- The wait for a green main (`WAITS_FOR_MAIN`) is not an outside wait: it ends only when a backlog fix task lands and main reads green, which only the scheduler's main reading sees. That reading is its single wake rule (`MainWaitWake` for a plain run, the epic main move for an epic and its parts), and its rebase reads a failed try through the same table (`outsideWaitOf`). Gap: an epic that already holds main's green head waits for the next head.
- An agent start that waits before its first output, for a free agent place (with how many are busy) or for the server's pause, stores that wait with its run's state (on its turn row for a backlog planner turn) through `steps/shared/start-waits.ts` (a structure rule fails any other file that calls `recordStartWait`), and the run page, the run list and the backlog chat show it. A place comes back when its launch ends, because the launch ends its container in every ending (`agent/agent-launch.ts`).
- wait-frees-place and held-run-says-so come after.

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

**Today.** Holds (`pipeline/reconciler*.ts`, `run-settler.ts`, `stall-watch.ts`, `stall-decision.ts`, `contract/interruption.ts`, `server-stalls/`). Waits after a restart end by the one table and pass of 3.15. The stall watch reads the stored state at once, with no pass to wait for; the structure rule named in 3.13 holds the door that writes it.

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
  2. starts the ready ones: their dependencies have merged, the `main` of every repository they touch is green or has no CI (no pipeline on its default branch at all, or the host refuses the pipelines read with 403: that refusal is this reading, logged once per repository and state change, never an error of the call), and a place is free under `BACKLOG_PARALLEL`. Places go to the backlogs in turn;
  3. says what every waiting task waits for.
- **A merged task** closes the requirements it covers, and a milestone whose requirements are all closed asks for acceptance.
- **When `main` moves,** epics take it (3.10), and other running tasks are rebased before they merge.
- **Writes.** The planner (3.12) and the person write through one writer (`backlog-actions`), which validates the change, writes it in one transaction and records who did it. A task change or delete carries the revision it read (3.14's expected revision), and a stale one is refused with the current task.
- **Creating a backlog** first clones the picked repositories that are not cloned yet, by the same `RemoteRepositories.clone` a new run uses (3.2), then stores their folders. A repository that cannot be cloned is named with the reason and no backlog is written; a code host outage is a wait as everywhere else.
- **Adding a repository** to a backlog clones its pick the same way and adds the folder the clone returns. A repository that cannot be cloned is refused with the reason and nothing is written; a code host outage is a wait as everywhere else. A repository already in scope, picked or named by its folder, changes nothing.

**Today.** Holds (`pipeline/backlog/`; the clone on create and on add is `backlog-clones.ts`, called from `backlog-scope-actions.ts`). A task has a `revision` column, moved by one with each change or delete of the task by `BacklogWriters.claimTask`, which is `conditionalUpdate` (`history/conditional-write.ts`) on the revision; `claimOrRefuse` (`pipeline/backlog/task-claim.ts`) refuses a stale revision with the task as it is now in plain words. A change that names none claims the revision it just read; the scheduler's and the merge's bookkeeping writes leave the column alone. The task editor sends the revision it opened with; moves, drag and drop and Delete send none. Gaps:
- a task that waits for another task's merge still holds a place (wait-frees-place);
- a milestone proposed while another runs does not wait behind it (queue-behind-active).

## 3.18 Limits, cost and estimates

**Target.**
- **Per run:** `MAX_RUN_USD`, the run's one budget, checked in the door. Money is tokens weighted by their price, so it also follows the subscription's weekly limit; a count of agent calls or of raw tokens does not measure cost and is no budget.
- **Per step:** `STEP_USD_MAX`, `STEP_TOKEN_MAX` and a timeout for each step.
- **Per agent:** `IDLE_TIMEOUT_MS`, `MAX_LAUNCHES` and `LOOP_REPEAT`. The loop guards (`MAX_RETURNS`, `MAX_PIPELINE_RETURNS`, `MAX_LAUNCHES`, `LOOP_REPEAT`, the same-input refusal) are not budgets.

A limit stops the run in a wait that names it (rule 18). Every call is a row of the log (rule 2, section 3.3) with only its own cost and tokens, by one rule for a resumed chat, and a run's spend is the sum of its rows. A call's cost prices every token: uncached input, cache reads, and cache writes at the rate of the cache they went to (the request's 5-minute and 1-hour split, else the runtime's declared cache). A rate the price page lacks comes from the runtime's declared cache and is never 0. The estimate of time left comes from the history of finished runs of the same kind, and an epic's estimate from its tasks. The statistics read the same records.

**Today.** Holds (`steps/shared/spend-limit.ts`, `agent/limits.ts`, `visit-costs`, `eta/`, `api/stats*`). A relaunched run's time left is the visit times of the steps it runs. Stats count two units, epic and task, defined in `api/stats-units.ts`. A run's spend and tokens are the sums of its rows in the log (`agent_exchanges`, read through `history/agent-call.repository.ts`): the limit check (`steps/shared/spend-limit.ts`), the run list, the run page, the Overview's Done lately read (`api/done-lately.service.ts`: one `spendOfRuns` for the shown items, their runs and subtasks), the requirements step's source and the settler's charge of a visit whose process died (after the requests its output files hold are counted into the log) all read it, and the run list reads a run's cost with the run and again on each read only while the run can still gain rows, and no live figure is added on top because rows are saved request by request. Stats take a visit's cost and tokens from the rows linked to it, and the keep-warm pings of earlier versions as rows of their step that add cost but no visit and no agent time. `GET /stats` reads each table once per request (`history/stats.repository.ts`, `history/stats-documents.ts`): the runs of the range with the prompts a name and a title need and the time of the first run, in one statement; the step rows with their log sums, the code-review report times and the pings, in one statement whose rows `RunRepository.durationByRun` reuses for the working time; and the latest documents the report counts (the requirements of untitled runs, the requirement list and reviews of merged runs) with the latest plan chat of each run that changed in the range, in one statement. No body of a run that was neither created nor changed in the range is read. The cost columns of `step_stats` and `backlog_turns` stay written; the readers above do not read them. A call's cost is summed from the usage of each model request as it streams, so a call that dies keeps what it spent. Each request is priced at the launch's price table (`agent/prices.ts` reads the page's cache read, 5-minute and 1-hour write columns; `agent/declared-cache-rates.ts` fills a rate the page lacks from the runtime's declared prompt cache; `agent/limits.ts` `priceTokens` prices cache reads and writes, a write by the request's cache split from `agent/stream-usage.ts` when it has one, a missing rate at the input rate, never at 0), so the run's spend and `MAX_RUN_USD` read the corrected cost. Rows logged earlier keep the cost they were logged with. A run has one budget, money, checked in `AgentDoor` (`steps/shared/agent-door.ts`) for every automatic start: a hop of the machine or a planner (`admitStep`) and every start outside a step's visit (`checked`). A person's start, the backlog planner's resume and a run planner's own turn (all `by: 'person'`) pass it, and no other place reads the limit; code review asks once for its whole round (`admitRound`), so a round never starts half and its reviewers and report skip the per-start check. Over the limit the run is blocked with `SPEND_LIMIT` and words that name the limit, the run's spend and what clears it: a Resume runs the step past the limit (the machine's next start is held back again), and the reconciler (`resumeUnderSpendLimit`) resumes the run by itself once the spend is under a higher `MAX_RUN_USD`, once per attempt and limit. `MAX_AGENT_CALLS` and `MAX_RUN_TOKENS` are no longer read: an old value in a person's `.env` is ignored with one warning at start (`config/env.ts`). The agent call log and the call counts on the run page are shown, not enforced; an old blocked run with `DID_NOT_FIT` can still be resumed. Limit stops are still blocks, not waits.

## 3.19 Storage and housekeeping

**Target.**
- **The database** is one SQLite database in WAL mode. Changes come only through additive migrations, behind a guard that backs up the database before it migrates.
- **What is written once:** documents, events and stalls are appended and never rewritten. A newer document of a kind supersedes the older one.
- **A write of a run** sets only the columns its writer changed, so a copy read earlier never sets back a change made since; after the write the copy is the stored row.
- **A change of a run's row** goes through one door, `RunRepository.change`. It writes the columns its apply changed only while each still holds the value read (c01's record, `history/run-read.ts`, through `history/conditional-write.ts`). A write that lost a race is applied again on the row as it is now, in the same process one at a time and against a CLI process on the same database. Rows are created in two places inside `history/`: `RunRepository.insertRun`, and `CommandRepository.accept`, which creates the row of a command for a run that does not exist yet inside its own transaction.
- **The disk guard** stops a step from starting on a disk it may fill. It frees old runs first, then docker leftovers, and only then makes the run wait (`MIN_FREE_GB`).
- **Retention** removes everything a finished run leaves after `RETAIN_DONE_DAYS`, and deleting a run removes everything of it.
- **Housekeeping** runs at startup and once a day.

**Today.** Holds (`history/`, a run's row is written by `history/run.repository.ts`, `history/visit.repository.ts` and `history/run-open-items.ts` from what the copy read, kept in `history/run-read.ts`; a change of it goes through `RunRepository.change` and `history/conditional-write.ts`, and the lint rule `run-write/no-run-write` (`eslint.run-write-rules.mjs`, registered in `eslint.config.mjs`) and the structure rule in `scripts/structure-rules.json` fail a second path; `pipeline/disk-guard.ts`, `run-retention.ts`, `housekeeping.ts`).

## 3.20 People, access and connections

**Target.**
- **Sign-in** is through a code host (GitHub or GitLab OAuth), or with a personal API token for scripts. On first run the server creates its OAuth app. GitLab sign-in leads with a personal access token and offers an OAuth application second. The server checks an application with an invalid-code token request before it stores it. Its maker or an admin can replace it from Connections, or this machine from the login page while nobody has signed in through it.
- **The first person** is an admin, and one admin always stays.
- **Connections.** Each person keeps their own connections (code hosts, agent runtimes, Jira, Confluence, Drive), encrypted with the server's secret. A connection is tested when it is saved and refreshed before it expires. A run uses its starter's connections.
- **Request guard.** Every mutating request must:
  - carry `X-Swarmloop: 1`;
  - be JSON;
  - come from an allowed host and origin.
- **Secrets** are never logged, never put in a URL, and never sent to the browser.

**Today.** Holds (`auth/`, `config/redact.ts`, `api/request-guard.ts`). The photo is stored with the person. A token the host accepts from Connections (`POST /auth/:provider/token` with a signed-in person) adds a connection for that person and starts no session. The installation warning of a host names only the repositories of this server that neither the installation nor the server token reaches (`LoginProvider.serverTokenMisses`). `POST /auth/:host/application` (`ApplicationController`) stores a GitLab application only after `LoginProvider.checkApp` accepts it; a replace drops only the connections with a refresh token the application issued, so token sign-ins stay. A 401 from the token endpoint in the callback redirects to the login page with `error=app`.

## 3.21 Integrations

**Target.** Rule 15. Each vendor is one adapter behind the interface of its kind:
- **code host:** repositories, pushes, merge requests, CI, merge methods and push-refusal rules;
- **agent runtime:** launch, helpers, how it words a limit, and its model list (cached for a day);
- **issue tracker;**
- **linked-page reader;**
- **requirements source.**

Adapters are found by folder. A fake of each kind serves the tests.

**Today.** Holds (`integrations/`, `testing/fake-*`). Only Claude Code has helpers today (its subagent tool, on the helper's model and level, with the tools that read). Its adapter puts the reader's skill into the helper's definition and sets no hook on the launching agent, which reads itself when its skill says so. This change did not read Codex 0.167.0 or Cursor CLI 2025.11.25, so those adapters declare no helpers and launch as before. A host call for a run goes through `CodeHostRegistry.hostFor(run)`, with the token of the run's person; a person's own action and the server's own token (`forRun(null)`) go through `forRun`, which gives a `RunHosts` (`run-hosts.ts`). The registry itself, with no person, names hosts and matches origins and gives no host to call. A structure rule in `scripts/structure-rules.json` fails any other path to a host API.

## 3.22 Sandbox and network

**Target.**
- **What a container sees.** It holds only its run's worktrees; reviewers get them read-only. A worktree holds only what is in git and what the run wrote; secrets never enter it, they live in Connections and reach an agent as its environment. A container of no run (a sign-in, a connection test) gets only one empty folder at `/work`.
- **How it runs.** It never runs as root. All capabilities are dropped, `no-new-privileges` is set, the root filesystem is read-only, and it has a process cap, a memory cap and its own `/tmp` on disk. It has no docker socket.
- **Network.** The only route out is the egress proxy. It allows each container's hosts by policy: a model step reaches its vendor only, and implement and setup may also reach the package registries. DNS answers nothing inside.
- **Model keys** are swapped in by the proxy where the vendor allows it.
- **Lifetime.** A container never outlives its step.

**Today.** Holds (`sandbox/`, `docker/egress`). The empty folder is `emptyWorkPath` in `sandbox/empty-work-mount.ts`; the service hands it to the mount check on the launch, and `assertMount` accepts it by exact host path at `/work`, while every other `/work` mount must lie inside the work roots.

## 3.23 What a person sees

**Target.** Rule 17. The dashboard reads the run's own state live over the websocket. Its screens:
- **Overview:** now, what needs you, done lately, numbers;
- **Runs:** epics grouped with their tasks;
- **Run page:** the flow board by phase, the conversation with the planner, the history of visits, documents and logs;
- **Backlogs:** board, chat, progress; the chat shows a turn at work and where each of the person's messages stands;
- **Stats, Settings, Connections:** Settings' Server section is read only; its groups, order and descriptions are those of `defaults.env`, read once through `DefaultsLayout`.

The text is plain words for a person: no raw JSON and no internal ids. A cut text says how much is left out and where the whole is.

**Today.** Holds in the main. The board shows one quiet row per return (`from → to`, how many times, the return in words, from `FlowView.returns`), and a step's muted ×N names the returns that caused it in its hover; ×N is the agent visits of an agent step and the stored visits of a server step (`chipAttempts`). Plain names. Settings' Server section follows `defaults.env` through `DefaultsLayout`; People and Appearance are not in Settings. Short lines come from the server, decisions read in words, long texts and path lists fold, and Connections say what a run uses (the server's key or the person's own) and fold a host's repositories; the report heading on the run page is in 3.7. The backlog chat ends with a thinking row while a turn works (`chat-rows.ts`, `thinking-row.tsx`, the state icon map's working icon), and each of the person's messages says `Waiting`, `Read` or `Answered` (`messageState` in `pipeline/backlog/planner/planner-views.ts`). Done lately reads `GET /overview/done` once when the Overview opens and follows the `done` event (`use-done-lately.ts`); it reads again on a reconnect and on the next connect after a failed read, and keeps its lines while a read fails. Gaps:
- held runs read as failures (held-run-says-so);
- several screens are still being reworked in M1 (f131, f132, b04, f26).

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

**Today.** The approach is the rule since 24.11. Existing tests that break it time out under load (3.6); since 24.11 they run only in CI. steady-vitest fixed them for the dashboard (3.6). For the server, steady-agent-limit replaces a grown Jest worker between spec files and turns off git's upkeep in specs (3.6); CI's `server-test` and `server-test-seeds` jobs judge the whole suite, and the class is not called closed before they do. The fault suite in `server/src/testing/faults/` injects the faults real runs met into the real application and checks each run with `assertSettled`.

## 3.25 The server process, health and readiness

**Target.**
- **Two processes.** The API server drives runs and alone runs the reconciler, the scheduler, the merge watch and housekeeping. A CLI process drives only its own run.
- **The main loop does no heavy work.** Large file walks, git metadata copies and deletions run off the main thread, and a lint rule keeps them there. A worker thread ticks every second, so a blocked main loop or a sleeping machine is recorded as a stall.
- **Health and readiness.** `/health` answers whether the server is up and paused. `/readiness` lists what the server needs and whether it has it: docker, volume mounts, a model credential for every role, and stalls in the last hour. Each item links to where it is fixed.

**Today.** Holds (`pipeline/server-stalls/`, `eslint.main-thread-rules.mjs`, `readiness/`, `api/health.controller.ts`). Each readiness item carries a short line the server cuts, and the Disk item what swarmloop itself uses; the dashboard shows both as sent.

---

# Part 4. Decisions (24.11)

1. **An epic is a run with child runs**, not a separate concept (rule 1).
2. **`blocked` goes.** A block becomes *waiting on a person* or *failed*. *Done* means merged, closed or skipped, and a run whose merge request is ready waits on its merge.
3. **One merge rule and one merge path** for children into an epic and for tasks into `main` (rule 7).
4. **A waiting run holds no place.** A run that waits on a person, a merge or a sibling frees its place, and takes one again when it goes on.
5. **The IDE bridge goes**, and with it `chat`, `shell`, `rewind`, the snapshots and the CLI login flow. A person steers only through planners (rule 9).
6. **The backlog planner's turns go through the same door** as every other agent start (rule 2).
