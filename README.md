<div align="center">

<br>
<img src="dashboard/public/logo.svg" alt="swarmloop logo: a sailboat inside a loop arrow" width="112">

# swarmloop

[![CI](https://github.com/swarmloop/swarmloop/actions/workflows/ci.yml/badge.svg)](https://github.com/swarmloop/swarmloop/actions/workflows/ci.yml)

**Coding agents that have to pass five reviewers and your CI before they reach you. A sandbox around every step, a record of every dollar.**

<p>
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-blue.svg"></a>
  <img alt="Agents: Cursor, Claude, and Codex" src="https://img.shields.io/badge/agents-Cursor%20%7C%20Claude%20%7C%20Codex-6fbf96.svg">
  <img alt="Runs on Docker" src="https://img.shields.io/badge/runs%20on-Docker-2496ED.svg?logo=docker&logoColor=white">
  <img alt="Built with NestJS and Next.js" src="https://img.shields.io/badge/built%20with-NestJS%20%2B%20Next.js-e0234e.svg">
</p>

[Quick start](#-quick-start) · [CI](#-commit-merge-request-and-ci) · [Features](#-features) · [Settings](#-settings)

</div>

swarmloop takes a ticket or a prompt and walks a coding agent through requirements, research, a plan, and implementation. Then the work has to earn your attention. Five reviewers read the diff in parallel, and any finding sends it back to the agent. Only when they agree does the server commit, push a branch, open a merge request, and watch your pipeline. A red job sends the work back too. You open the merge request when the reviewers and every check in your pipeline have passed.

Every step runs in a locked container. Every prompt, diff, review, token, and dollar is stored. Cursor, Claude, or Codex is one line in `.env`.

![One real swarmloop run through planning, implementation, checks, five reviewers and CI. Checks sent it back to implement once, code review twice and the pipeline once, then it merged.](swarmloop-pipeline.png)

![swarmloop over 30 days: 286 runs, 99% merged, and work sent back 922 times by checks, reviewers and CI before a person had to look.](swarmloop-stats.png)

| Feature | What you get |
| --- | --- |
| 🔒 **Sandbox** | The only way out is a proxy that lets each step reach its own hosts. Claude and Codex API keys never enter the container. Read-only root, no capabilities, no Docker socket. Git and Jira tokens stay out. |
| 🧵 **Parallel runs** | Several tasks at once, even in one repository. Each run has its own worktree and branch. Your working copy is not touched. |
| 🗂 **One history** | Prompt, plan, diff, reviews, model exchanges, tokens, dollars, CPU, and memory in one SQLite file. |
| 🔀 **Cursor, Claude, or Codex** | One line in `.env`. Research, plan, and implementation each pick their own model. |
| 🎫 **Jira, Confluence, Drive** | The ticket, its epic, links, subtasks, attachments, and the pages around it. |
| 🌿 **GitHub and GitLab** | Feature branch, commit once the reviewers pass, merge request, pipeline watch. |
| 🔍 **Five reviewers** | Requirements, quality, regressions, security, performance. A finding sends the work back. |
| 🔄 **Rebase** | One button rebases onto the latest base branch, hands conflicts to the agent, and reviews again. The same rebase runs by itself when the host reports a merge conflict on the merge request. |
| 💰 **Limits** | Dollars, tokens, time, silence, and retries are server settings, not the agent's choice. |
| 🖥 **Live panel, CLI** | The panel updates as each step runs. The CLI starts the same runs, with the same steps, rules, and history. |
| 📊 **Statistics** | Spend, tokens, and CPU and memory charts for every step, plus every external HTTP call. |
| 👥 **Team server** | One machine, one flow, shared rules in `skills/`, one bill. Login with GitHub or GitLab. |

## 🚀 Quick start

You need Docker. No `.env`, no Jira, no CI. Install the latest release, which pulls the images:

```sh
mkdir swarmloop && cd swarmloop && curl -fsSLO https://github.com/swarmloop/swarmloop/releases/latest/download/compose.yml && docker compose up -d --wait && echo "swarmloop is ready: $(docker compose exec -T dashboard node -p process.env.SWARMLOOP_PUBLIC_URL)"
```

Or build from source:

```sh
git clone https://github.com/swarmloop/swarmloop && cd swarmloop && docker compose up -d --wait && echo "swarmloop is ready: $(docker compose exec -T dashboard node -p process.env.SWARMLOOP_PUBLIC_URL)"
```

What the machine needs: these are the numbers of swarmloop's own repository, the 90th percentile of the peak per agent visit and per check command since 15.11. One agent visit takes 1.7 GB and up to 3 cores, and up to 6 GB when the agent runs the full server test suite itself. One check command takes 3.3 GB and up to 3.7 cores; the heaviest, `npm test --prefix server`, takes 6 GB and 5 cores, and the others stay under 2 GB. The defaults run 4 agents (`AGENTS_PARALLEL`) and 3 check commands (`CHECKS_PARALLEL`) at once, about 19 GB, plus 2 GB for the server and the dashboard. Give Docker Desktop every CPU but two (macOS and its file sharing need them) and memory of 2 GB + 2 GB per agent + 3 GB per check command, about 20 GB for the defaults. On a smaller machine, lower `AGENTS_PARALLEL` and `CHECKS_PARALLEL`. Your project's own tests decide what its check commands take. **Readiness** shows the server's stalls when the machine is short.

The commands print the dashboard's address once the stack is ready, [http://127.0.0.1:3921](http://127.0.0.1:3921) by default; open it and, in the browser:

1. **Connect GitHub**, or **Connect GitLab**: on GitLab, sign in with a personal access token (the quickest way: create one at `<GITLAB_BASE_URL>/-/user_settings/personal_access_tokens`, for example `https://gitlab.com/-/user_settings/personal_access_tokens`, with the scopes `read_user`, `api` and `write_repository`); a team that wants OAuth registers an application instead, see [Login](#login).
2. Go to **Settings → Connections** and connect a model for the runtime your `AGENTS_*` name (Claude by default): sign in with your Claude account or paste an API key. Codex signs in with ChatGPT or takes an API key; Cursor takes an API key. Each connection is tested before it is saved and belongs to the person who made it. The server starts without a key, and **Readiness** shows which runtime still needs one. To use Cursor or Codex, switch `AGENTS_PLAN`, `AGENTS_IMPLEMENT` and `AGENTS_REVIEW` to `cursor:<model>` or `codex:<model>`. A subscription login is for your own use on your own server, not one plan shared by a team. Scripts, CI and servers without a browser: see [Headless setup](#-headless-setup).
3. The start page shows what a run needs: Docker, images, disk, paths, ports, and your keys. **New run** stays off while an item says `fail`, and the item says what to do. `docker compose exec server node dist/main.js doctor` prints the same list. Then click **New run**, pick a repository, untick **ci**, and describe the change. Leave ticket numbers out.

The installation folder can sit anywhere: it does not need to be next to your repositories. Docker Engine 26 or newer is needed. Repositories come in through **New run** (clone or create) as swarmloop's own clones in the `swarmloop-checkouts` volume, and run worktrees live in the `swarmloop-worktrees` volume, so nothing a run writes lands in a folder of the host. `SWARMLOOP_REPOS` (comma-separated folder names) narrows the repository list.

To change a setting, copy its line from [`defaults.env`](https://github.com/swarmloop/swarmloop/blob/main/defaults.env) into a `.env` next to `compose.yml`, or set it in the shell. A variable set in the shell wins over `.env`, and `.env` wins over `defaults.env`.

The repository list is every clone in the `swarmloop-checkouts` volume, or only the ones named in `SWARMLOOP_REPOS`. The server only resolves, fetches and works in those; a run that names another repository is refused. A run `path` must lie inside one of those clones or inside the worktrees. The agent edits its own worktree, not your working copy. Nothing is pushed, and Jira is not called.

**Update:** from a release folder, `docker compose pull && docker compose up -d --wait && echo "swarmloop is ready: $(docker compose exec -T dashboard node -p process.env.SWARMLOOP_PUBLIC_URL)"`; from a clone, `git pull && SWARMLOOP_BUILD_VERSION=$(git describe --tags --abbrev=0) SWARMLOOP_BUILD_REVISION=$(git rev-parse --short HEAD) docker compose up -d --build --wait && echo "swarmloop is ready: $(docker compose exec -T dashboard node -p process.env.SWARMLOOP_PUBLIC_URL)"`. To stay on one release, set `SWARMLOOP_VERSION` in `.env`, for example `0.2.0`. `SWARMLOOP_HOME`, `UID` and `COMPOSE_FILE` are Compose controls, not server settings. **If your `.env` still has a `COMPOSE_FILE=compose.yml:compose.build.yml` line, delete it:** that file is gone, and Compose refuses to start while the line is there. Before it migrates the database, the server copies it to `data/backups/` (the last 3 are kept). An older version refuses a database a newer one migrated and names the backup. To go back: `docker compose down`, restore that backup from `data/backups/` over `data/swarmloop.sqlite` (`gunzip -c` for a `.gz` backup; a copy of the database is always a backup from `data/backups/` and never the live `data/swarmloop.sqlite`, whose latest commits may still be in its WAL), delete `data/swarmloop.sqlite-wal` and `-shm`, copy the session files from its `.sessions` folder into `data/`, set the older `SWARMLOOP_VERSION` and `docker compose up -d`.

### 🚢 Commit, merge request, and CI

Start: `docker compose up -d`, open the dashboard, then **Connect GitHub** (a private GitHub App made from a manifest, on the account that owns your repositories) or **Connect GitLab** (a personal access token first; a team that wants OAuth registers an application). After the app is made, the page asks you to install it on the repositories, and the login comes after the install. Every run then uses the access of the person who started it, and a run whose token was revoked waits with `GIT_AUTH` until that person reconnects. The browser needs a session; the CLI and scripts act as a person through a personal API token (`SWARMLOOP_TOKEN`). Secrets are stored encrypted with `SWARMLOOP_SECRET` (or a key made in `data/secret`).

For a headless setup, or for runs started by the CLI or a script, copy the empty `GITHUB_TOKEN` or `GITLAB_TOKEN` line from `defaults.env` into `.env` (or set it in the shell) and set a git token instead and run `docker compose up -d` again. This time leave **ci** ticked. When the reviewers pass, the server pushes a feature branch, opens a merge request, and watches the pipeline. Nobody has to click in between.

- GitHub needs `GITHUB_TOKEN`. GitLab needs `GITLAB_TOKEN`, and `GITLAB_BASE_URL` when it is self-hosted. Both may be set. The server picks the host whose hostname equals the checkout `origin`.
- The same token is also used to fetch the base branch, and a run on an SSH origin stops at prepare without it.
- The server commits as the clone's own `user.email`. If the clone has none, set `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL`.

<details>
<summary><strong>GitLab token</strong></summary>

`GITLAB_BASE_URL` is `https://gitlab.com` when the remotes are on gitlab.com. Create `GITLAB_TOKEN` from [Personal access tokens](https://gitlab.com/-/user_settings/personal_access_tokens): **Generate token** → **Fine-grained token**, scoped to the group that owns the repositories. Grant only these permissions:

| Resource | Permission |
| --- | --- |
| Code | Download, Push |
| Pipeline | Read |
| Job | Read |
| Merge request | Read, Create, Update |

**Code: Download** is the git read. Rebase fetches the remote source branch with this token. Without Download, GitLab refuses the fetch: `This operation requires a fine-grained personal access token with the following project permissions: [Code: Download].` **Code: Push** is the git write the server uses once the reviewers pass. Your role on each project still has to be at least Developer.

</details>

<details>
<summary><strong>GitHub token</strong></summary>

`GITHUB_BASE_URL` is `https://github.com` when the remotes are on github.com. Create `GITHUB_TOKEN` from [Fine-grained personal access tokens](https://github.com/settings/personal-access-tokens): **Generate new token**. Resource owner is the account or organization that owns the repositories. Repository access is only the repositories this run pushes. Grant only these permissions:

| Resource | Permission |
| --- | --- |
| Contents | Read and write |
| Pull requests | Read and write |
| Actions | Read |
| Workflows | Read and write |
| Metadata | Read |

**Contents: Read and write** is the git read and the git write. Rebase fetches the remote source branch with this token, and that fetch uses the read half. The write half is what the server uses once the reviewers pass. Your account still has to be able to push to each repository. **Workflows: Read and write** is required when a commit creates or changes a file under `.github/workflows`. Without it GitHub rejects the push: `refusing to allow a Personal Access Token to create or update workflow ... without workflow scope`. GitHub shows the token once.

</details>

### 🧪 Project environment

Without any file the agent works as before: it writes code and CI is the judge. Describe the project's environment, and the implementation agent works inside it, with your toolchain, and checks its own work before the reviewers see it.

Give one of these, swarmloop reads the first it finds on the committed branch:

1. `.swarmloop.json` in the repository root:

   ```json
   {
     "version": 1,
     "image": "node:22-bookworm-slim",
     "setup": "npm ci",
     "checks": ["npm run lint", "npm test"],
     "cache": ["/home/sandbox/.npm"]
   }
   ```

   | Key | Meaning |
   | --- | --- |
   | `image` | The image to work in. Give this or `dockerfile`, not both. |
   | `dockerfile` | A file under `.swarmloop/` that builds the image, with `.swarmloop/` as its build context. |
   | `setup` | One command that installs dependencies. Optional. |
   | `checks` | Commands the agent must run and see pass before it finishes. Optional. Each entry is a command string, or `{ "run", "name"?, "paths"? }`: `name` is the short name the dashboard shows, `paths` are git pathspecs relative to the repository. |
   | `cache` | Absolute paths below `/home/sandbox/` that survive between runs, such as a package-manager cache. |
   | `network` | `registries` (default): the agent may install and upgrade packages itself. `setup`: only the setup reaches the registries, and the agent gets the model API alone. Choose `setup` when dependencies should change only by hand. Optional. |

2. `.devcontainer/devcontainer.json`, if the project already has one: `image`, or `build.dockerfile` with `build.context`, and `onCreateCommand`, `updateContentCommand` and `postCreateCommand` as the setup. Add the checks as `"customizations": { "swarmloop": { "checks": ["npm test"] } }`, and `"network": "setup"` there too if you want it. `features` and Docker Compose are not supported yet: put those tools in the Dockerfile.

How it runs:

- The image is pulled once, or built from the committed Dockerfile and reused until a file in its build context changes.
- The image must be Debian or Ubuntu based and have `bash`, because the Claude and Cursor CLIs need glibc. `scripts/agent-env-probe.sh <image>` tells you whether it works. If it does not, the step stops and says so.
- `setup` runs before implementation, in the project image, with the package registries and no model key. Successful setup is reused. A failure stops the step with its exit code and last lines; Resume retries setup.
- `implement` and `implement-improve` run in the image, with the agent CLI mounted read-only from its own image. Everything else of the sandbox stays: no root, no capabilities, read-only system, no Docker, the network only through the egress proxy, for the model and the package registries, no secret but the model key. The agent may run any command in its worktree: tests, lint, type checks, and the package manager, so it can add or upgrade a dependency. The lockfile it writes is committed with the code.
- The agent runs `checks` while working. After `implement-improve`, the `checks` step runs every declared check in each repository's project image, without network or model credentials. It has no agent. Up to `CHECKS_PARALLEL` check commands run at once on the whole server, across all runs and subtasks; the rest wait in line, showing `waiting for a free check slot (<n> ahead)`. All of them run: a failure does not stop the others. When any command failed, one return lists every failed command with its repository, exit code and the last lines of its output, and the run goes back to `implement`, as it does after a review. The full output of every command is kept under `data/`, and its CPU and memory are sampled like the agent's. A run without the checks phase goes on without them. A command without a `name` is shown by a short label made from it (at most 24 characters, such as `npm test server`), unique within the repository. A command with `paths` runs only when the run's diff against its base touches one of them; otherwise it is skipped with `no change under <paths>`, except when the last return named it. When CI fails in a job named like a command that its paths skipped on the same commit, the return says `<name> was skipped by its paths`. Checks must be executable shell commands, without placeholders. Without declared checks there is no local completion gate; CI remains the final judge.
- Planning and read-only review limits belong to those stages; they are not implementation requirements. Implementation and Resume receive the current environment's execution rules. Without a project environment, the agent keeps the local test restriction. Explicit task restrictions are preserved, and conflicts with required checks must be reported.
- Project containers receive a temporary, read-only copy of Git metadata, so tools can read tracked files and diffs even in linked worktrees. The original Git state, credentials and host configuration are not mounted.
- The reviewers and CI come after it, as before. CI stays the final judge.
- The environment is frozen during a run. When an explicit Rebase changes the base commit, it refreshes the environment from that commit, including its Dockerfile, and reruns setup. Uncommitted or feature-branch manifest edits do not replace these trusted checks.
- Keep it the same as CI: the same image or version, and one command, such as `npm run check`, that both CI and `checks` call.

CI configuration is committed like other project files when the task requires it; explicit deny paths still apply. CI can execute changed workflows and scripts on push or PR/MR creation, before human review. Keep privileged secrets and deployment credentials behind protected branches/environments and required approvals; restrict job-token permissions and isolate runners used for unreviewed code. Human review before merge does not by itself protect earlier CI execution. The legacy `ALLOW_CI_CHANGES` setting is no longer used.

### 🔑 Headless setup

For scripts, CI and servers without a browser, set the tokens instead of using Connections: copy their empty lines from `defaults.env` into `.env`, or set them in the shell. They stay the server fallback: a person's own connection is used first, and readiness does not ask for an env token when the connection exists.

- Claude: `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` to use your Claude subscription, or `ANTHROPIC_API_KEY` from [Claude Console](https://platform.claude.com/settings/keys).
- Cursor: set `CURSOR_API_KEY` from the [Cursor dashboard](https://cursor.com/dashboard), **API Keys** (it uses your Cursor plan, so there is no separate API bill), and switch `AGENTS_PLAN`, `AGENTS_IMPLEMENT` and `AGENTS_REVIEW` to `cursor:<model>`.
- Codex, with the three lists on `codex:<model>`:
  - Subscription (ChatGPT Plus or Pro, no API bill): on your own machine run `codex login`. On a server without a browser run `codex login --device-auth`. Then put the file in `.env` as one line: `CODEX_AUTH=$(base64 -w0 ~/.codex/auth.json)` (macOS: `base64 -i ~/.codex/auth.json | tr -d '\n'`), pasted as the value, not as a command. The file is a password: never commit it, never share it. It is for your own use on your own server, not one plan shared by a team. Use this login only for swarmloop: a ChatGPT login can be refreshed from one place at a time, so also running `codex` with it on your laptop would log the server out. On a team server, log in once on that server.
  - API key instead: `CODEX_API_KEY` from the [OpenAI platform dashboard](https://platform.openai.com/api-keys) (API keys); it is billed per token. If both are set, `CODEX_AUTH` wins.
  - The server keeps the login in `data/codex/` (it survives restarts) and refreshes it itself every few days, so parallel reviewers and steps never fight over it. `CODEX_AUTH` in `.env` is only the starting point: it is used again only when you change its value. Nothing to do by hand, unless the log says `Codex login expired`: then run `codex login`, paste the new value into `CODEX_AUTH` and restart the server.
  - **Subscriptions and automated use.** A subscription (Claude, ChatGPT or Cursor plan) has usage windows, and swarmloop stops using a runtime for the rest of a window when its CLI reports the limit (see `LIMIT_COOLDOWN_MIN`). Whether a plan may drive a CLI unattended is the provider's rule, not swarmloop's: read [Anthropic's consumer and commercial terms](https://www.anthropic.com/legal), [OpenAI's terms of use](https://openai.com/policies/terms-of-use/) and [Cursor's terms of service](https://cursor.com/terms-of-service) before you run a subscription login unattended. The API-key settings (`ANTHROPIC_API_KEY`, `CODEX_API_KEY`) are the metered, automation-friendly path. This note was written without opening those pages, so check the current wording yourself.
  - A quick check: start a run with the three lists on `codex:<model>`; the first step answers if the login works.
- Jira: `JIRA_BASE_URL` is your site, such as `https://your-team.atlassian.net`; `JIRA_EMAIL` is the email you sign in to Atlassian with; `JIRA_API_TOKEN` comes from [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens): **Create API token**.

### 🎫 Jira (optional)

Only for prompts that name a ticket. A prompt without one never calls Jira.

- Connect Jira in **Settings → Connections**: site URL, email and API token from [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens). Env values are in [Headless setup](#-headless-setup).
- `JIRA_PROJECTS` is a comma-separated list of project keys, such as `PROJ,OPS`. Only keys of these projects count as tickets in a prompt. Empty means every project that exists on the site.

Run `docker compose up -d` again after saving.

## ✨ Features

### 🔒 Sandbox and security

Every model step runs in a fresh container. The server starts it for the step and removes it when the step ends.

- **Disk.** Only this run's worktrees are mounted. Reviewers get them read-only. Home, `~/.ssh`, and other repositories are not there. A worktree holds only what is in git and what the run wrote; secrets never enter it, they live in Connections and reach an agent as its environment.
- **Parallel.** Each run gets its own worktree of every repository in the `swarmloop-worktrees` volume, under `<run>/` and its own `feature/<run>-…` branch, so several runs, even in one repository, go at once. A run locks only itself, and `MAX_RUN_USD` counts each run separately.
- **Network.** A step that names no hosts runs with `--network none`. Every other step runs on `swarmloop-sandbox`, an internal Docker network with no route out. Its only exit is the `swarmloop-egress` proxy container, which the server starts by itself. Before a container starts, the server writes a policy for that container's address: which hosts it may reach. The proxy refuses everything else. It lets a model step reach only its vendor's API. Implementation and setup may also reach package registries: npm, Yarn, PyPI, Go, RubyGems, crates.io, Packagist, Maven, and Gradle. The setup also reaches GitHub release downloads and `nodejs.org`, where packages with native code (better-sqlite3, esbuild, sharp) fetch their prebuilt binaries; the agent does not, because `github.com` also takes pushes. With `"network": "setup"` in `.swarmloop.json` only the setup reaches the registries. Only HTTPS on port 443 passes, plus plain HTTP to those same hosts. The container gets `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY` and `JAVA_TOOL_OPTIONS`, so npm, pip, Go, Composer, cargo, Node and Gradle go through the proxy. Maven ignores these: give it a `<proxy>` for `198.18.0.2:3128` in `settings.xml`. A tool that ignores them is not let out at all, because there is no other route. DNS inside the sandbox answers nothing (`--dns 198.18.0.2`, where nothing listens on port 53): the proxy resolves names, so DNS can't carry data out either. A refused request is logged: `docker logs swarmloop-egress` shows the address and host. If a project needs another host, set `SANDBOX_EGRESS=open` for a while to check. That brings back the old per-host networks, which don't filter by host.
- **Model key.** Claude (API key or `CLAUDE_CODE_OAUTH_TOKEN`) and Codex with `CODEX_API_KEY` get a placeholder key, and their API address points at the proxy. The proxy replaces the placeholder with the real key, so the agent cannot print it, send it anywhere, or leave it in a file. A Cursor key and a Codex ChatGPT login (`CODEX_AUTH`) can't be replaced this way, so those stay in the container, but they can only reach their own vendor.
- **What the proxy can't stop.** The proxy only sees host names, not what is sent to them. An agent that wants to leak code could publish it to a package registry under an account of its own. `"network": "setup"` closes that for the agent, though the setup can still reach the registries. Keep secrets out of the worktree.
- **Process.** Never root: a launch as root is refused. All Linux capabilities are dropped, `no-new-privileges` is set, the root filesystem is read-only, and the container gets at most 256 processes. There is no Docker socket, so it cannot start another container. The sandboxes share the host kernel: with gVisor installed on the Docker host, `SANDBOX_DOCKER_RUNTIME=runsc` gives each one a kernel of its own, so a kernel bug does not reach the host.
- **Secrets.** Jira, GitLab, and GitHub tokens stay in the server process. The model key is covered above.
- **Lifetime.** The step time limit, silence longer than `IDLE_TIMEOUT_MS`, or a token ceiling kills the container. It never outlives its step.
- **Git.** The agent does not commit and does not push. The server does, after the reviewers pass.

### 🗂 One history, nothing lost

`data/swarmloop.sqlite` is the record of every run. It keeps the prompt, each document a step wrote, each model request and response, each loop back to implementation, and each call to Jira or the git host. An identical document is stored once.

The `data/` folder holds secrets: the Codex login, the session files and the history database. Never share it and never serve it. The dashboard mounts no host folder and reads step logs only through the API (`/runs/:key/steps/:step/log`).

**All history** on a run opens all of it: documents, prompts and responses, tokens by model, CPU and memory, loops, and HTTP calls. A step that crashed can resume the same agent chat. Anyone who can open the panel can open any run and see how the task was done.

### 🔀 Cursor, Claude, or Codex

- Each role names its agents as `runtime:model` pairs, with `runtime` one of `cursor`, `claude` or `codex`: `AGENTS_PLAN`, `AGENTS_IMPLEMENT`, and `AGENTS_REVIEW`. Change the lists and restart the server: the next step uses that agent. A step whose agent runs on another runtime than its stored chat opens a new chat with the full brief.
- An agent can add how hard it works, `runtime:model:effort`, with `effort` one of `low`, `medium`, `high`, `xhigh` or `max`, the same words for every runtime. Without it the agent runs at its runtime's default; a level the runtime or model does not support is refused at start-up or in Settings.
- When a plan splits into subtasks, only the parent's planning (its second plan improve pass, its answers to subtasks, its merge request text) goes up to `EPIC_EFFORT` by itself (never down), and the second pass runs only when that raises the effort. Implement and review keep their own lists' effort, and the step header says so.
- Dollars come from the vendor's published price list, cached for a day.
- Another agent is the same three pieces: a sandbox image under `docker/sandbox`, its API hosts and key, and the code that reads its output. The pipeline, the history, and the panel stay as they are.
- For contributors building from a checkout, `docker/sandbox/build.sh` builds the three agent images and the `swarmloop-egress` proxy image (`compose.override.yml` builds them too). Run it again after you update swarmloop. Docker reuses its cache, so to get newer CLIs and certificates run `docker/sandbox/build.sh --fresh`, every few months is enough. Each image keeps its whole CLI under `/opt/swarmloop`, together with a CA certificate bundle (the public root list of Debian's `ca-certificates` package) and, for Codex, `rg`. swarmloop can therefore mount the CLI into another image.
- `scripts/agent-env-probe.sh <image>...` shows whether each CLI starts in a given image, for example `scripts/agent-env-probe.sh node:22-bookworm-slim php:8.3-cli`. Claude and Cursor need a glibc image with `bash`, so Debian or Ubuntu based. Alpine images do not work for them. Codex is one static binary and starts anywhere.

### 🎫 Jira, Confluence, and Google Drive

Put a Jira key in the prompt, or use it as the run id. swarmloop pulls the description, acceptance criteria, comments, attachments, the epic, linked issues, and one level of subtasks. Confluence pages on the same site, and Google Drive documents, sheets, slides, and files, are copied into the requirements record. The agent gets a brief of that record, not raw JSON.

A prompt without a ticket number never calls Jira. Jira is the tracker that ships. Another tracker implements the same `IssueTracker` interface in `server/src/integrations/issue-tracker`.

### 🌿 GitHub and GitLab

- One run can span several repositories. Research decides which ones get a feature branch.
- The server matches each checkout's `origin` with `GITHUB_BASE_URL` or `GITLAB_BASE_URL`. Point `GITLAB_BASE_URL` at a self-hosted GitLab and it works the same way.
- With **ci** ticked, the server commits by itself once the reviewers pass. It refuses `main` and `master`. With **ci** unticked, the run stops at commit and shows the file list, and nothing is committed or pushed.
- A pull request or merge request is opened, or the existing one is updated.
- The server watches the pipeline on that branch. A red job's log goes back to implementation.
- A checkout with no `origin` still gets the full review. CI is skipped, and the panel says why.

### 📐 One flow, shared rules

```mermaid
flowchart LR
  P["🧭 Planning<br/>requirements · prepare · research<br/>plan · plan-improve"] --> I["🔨 Implementation<br/>branch · implement<br/>implement-improve"]
  I --> K{"✔ Checks<br/>every command of .swarmloop.json"}
  K -- pass --> C{"🔍 Code review<br/>5 reviewers + report"}
  K -. return .-> I
  C -- ok --> D["🚢 CI<br/>commit · merge-request<br/>pipeline"]
  C -. return .-> I
  D -. red .-> I
  D -- green --> E(("✅ done"))
```

The panel shows the same five phases: planning, implementation, checks, code review and CI. **New run** lets you switch phases off. Planning, which holds requirements, always runs.

A person is asked where it matters:

- Research and plan stop on open questions until someone answers in the panel.
- Plan improve checks that the checklist covers everything the task asks for.
- With **ci** unticked, commit waits for you and shows the file list.

With **ci** ticked there is no click between the plan and the merge request. Your time comes last: you open it when the reviewers and your pipeline are green.

The instructions for every step are Markdown files in `skills/`. Edit one, rebuild the server, and every run after that follows it, for everyone on the server. The rules live in the repo and get reviewed like code. They are not a setting on someone's machine.

Every agent step ends its answer with one JSON block, and that block is all the server reads from it. The server checks the block against the step's schema. A missing or wrong block gets up to two follow-ups in the same chat, each listing every error, and then the step fails with those errors. The prose before the block is for people and is never read.

A project tailors swarmloop with `.swarmloop.json` and `skills/`, and puts its own rules in `AGENTS.md` at the repository root. Every step of every runtime gets that file, for every repository of a run.

### 🔍 Five reviewers, and they can say no

Requirements, quality, regressions, security, and performance review the diff at the same time, on a read-only mount. A report sums them up. Each reviewer ends with `decision: ok` or `decision: return`. A return sends the run back to implementation with the finding. A red pipeline does the same, on its own counter. `defaults.env` allows 10 review returns and 6 pipeline returns.

A diff that was already reviewed is not returned a second time.

Before code review, implement improve reads the change again on the same model and fixes what it finds.

Passing review and CI is a minimum bar, not proof that the change is right. The reviewers run on the same family of models as the author, and green tests only show what the tests cover. You still read the diff. You just read one that already passed its own checks.

### 🔄 Rebase in one click

**Rebase** works on a run that is done, failed, or waiting. The branch is squashed to one commit on the fresh base and force-pushed with lease, and a conflict goes to implement once.

1. The server fetches the base branch from the remote (`main`, `master`, or the one the prompt names) and rebases every feature worktree onto it.
2. Edits that may ship are committed first. A denied path such as `.env` stays out. If it blocks the rebase, the rebase stops and says so.
3. A conflict goes back to the agent, which resolves it. Code review then runs on the new diff.
4. A clean rebase of a finished run reruns code review and CI on the new base and keeps the existing merge request.
5. A failed or waiting run continues from its step. A run whose checklist was not finished goes back to implementation.

When CI does not start and GitHub or GitLab confirms a merge conflict for the published SHA, Swarmloop automatically invokes the same Rebase action as the button, with the same repositories, base selection and continuation. Automatic invocation requires unchanged, clean worktrees, is attempted once per source SHA, and counts toward `MAX_PIPELINE_RETURNS`. Ordinary CI failures and unknown mergeability do not trigger it.

### 💰 Limits on money, tokens, and time

| Setting | What it limits | `defaults.env` |
| --- | --- | --- |
| `MAX_RUN_USD` | Dollars per run, the run's one budget. Once reached, the next automatic start does not start; a Resume runs past it. | `100` |
| `RETAIN_DONE_DAYS` | Days a done run keeps worktrees, agent state and outputs. `0` keeps all. | `3` |
| `MIN_FREE_GB` | Free disk below which old runs are cleaned and then steps are blocked (`DISK_LOW`). | `10` |
| `DOCKER_PRUNE` | Daily removal of dangling images and build cache older than 24 h. | `true` |
| `STEP_TOKEN_MAX` | Tokens per step. Kills the step. | off |
| `MAX_RETURNS` | Review returns to implementation | `10` |
| `MAX_PIPELINE_RETURNS` | Red pipelines sent back | `6` |
| `CHECKS_PARALLEL` | Check commands that run at once on the whole server | `3` |
| `AGENTS_PARALLEL` | Agent containers that run at once on the whole server | `4` |
| `BACKLOG_PARALLEL` | Backlog tasks started and not merged at once on the whole server | `3` |
| `RESERVE_MEMORY_GB` | Memory in GB of the Docker host kept free for the server and the dashboard; every sandbox container may take at most the memory Docker has minus this reserve | `2` |
| `MAX_LAUNCHES` | Launches of one agent visit before it fails | `3` |
| `LIMIT_COOLDOWN_MIN` | Minutes a runtime stays out of use after a provider usage limit whose text names no reset time | `60` |
| `STOP_GRACE_S` | Seconds a container gets to stop on Stop before it is killed | `10` |
| `RECONCILE_MS` | How often the server looks for runs whose owner died | `60000` |
| `MERGE_WATCH_MIN` | Minutes between looks at done runs for a merged or closed merge request | `5` |
| `RECOVER_WAIT_MS` | How long a run waits for a container left by a dead server to exit before it is killed | `600000` |
| `IDLE_TIMEOUT_MS` | Silence before the agent is killed | 15 minutes |
| `LOOP_REPEAT` | The same failing command this many times in a row gets one hint; that many more end the step | `4` |
| `SANDBOX_EGRESS` | `proxy`: all traffic goes through the egress proxy. `open`: per-host networks without the proxy, for debugging only. | `proxy` |
| `SANDBOX_DOCKER_RUNTIME` | Docker runtime of the sandboxes, such as `runsc` for gVisor | Docker's default |
| `PROJECT_HOSTS_ALLOW` | Comma-separated host names a project's `hosts` (`.swarmloop.json` or `customizations.swarmloop`) may name. A host outside it is refused. Code hosts, model API hosts, local addresses and IPs are always refused. | Empty: every host under that ceiling |
| `*_TIMEOUT_MS` | Wall time per step | 3 to 30 minutes |

### 📊 Statistics for every step

- Each step visit stores the model, duration, input and output tokens, dollars, and CPU and memory as an average and a peak.
- CPU and memory are sampled every 5 seconds and drawn as a chart under the step.
- **All history** totals tokens by model and lists every call to Jira and the git host: method, URL without credentials, status, and duration. The `Authorization` header is never stored.
- The run header shows the running totals. The sidebar shows the cost and duration of every run.

### 🖥 Panel and CLI

- **Panel** at [http://127.0.0.1:3921](http://127.0.0.1:3921). A live board over a websocket, a filter by key, and light, dark, and system themes.
- **CLI.** `bin/swarmloop run KEY --prompt "…"`, `bin/swarmloop step NAME KEY`, and `bin/swarmloop fetch PROJ-123`. Review any local folder with `bin/swarmloop step code-review KEY --path /absolute/dir`. The CLI runs the same pipeline in its own process and writes the same history. The panel shows a CLI run after a reload, not live. `run` and `step` need `SWARMLOOP_TOKEN`. The machine token is gone: an old `SWARMLOOP_TOKEN` becomes the first admin's token.

**Run again** replays a step, and you choose which later phases run. A replay never moves a run that is further ahead back. The same dialog adds another repository to an open run. Removing a run deletes its rows, its worktrees, and its files.

`KEY` is a Jira key (`PROJ-123`) or a slug (`vendor-api`).

The CLI on the host needs a build:

```sh
npm ci --prefix server
npm run build --prefix server
bin/swarmloop run PROJ-123 --prompt "what this ticket is"
```

## 🔧 Settings

| Variable | Values |
| --- | --- |
| `AGENTS_PLAN` | Agents of the `plan` role (research, plan, plan improve, the merge request text), `runtime:model[:effort]`, comma-separated. The first is used, the rest are the fallback order. The default is `high`. Each person can override it in Settings. |
| `AGENTS_IMPLEMENT` | Agents of the `implement` role (implement, implement improve, rebase conflicts). The default is `high`. Each person can override it in Settings. |
| `AGENTS_REVIEW` | Agents of the `review` role (every code reviewer and the review report). The default is `high`. Each person can override it in Settings. |
| `AGENTS_SUBTASK_PLAN`, `AGENTS_SUBTASK_IMPLEMENT`, `AGENTS_SUBTASK_REVIEW` | The same for a run with a parent; the default is `medium`. Empty: the main role. Each person can override it in Settings. |
| `AGENTS_BACKLOG_PLAN` | Agents of the backlog planner (plan role only), `runtime:model[:effort]`, comma-separated; the default is `high`. Empty: `AGENTS_PLAN`. Each person can override it in Settings. |
| `AGENTS_READ` | The reader list: agents that read for another agent, read only, `runtime:model[:effort]`, comma-separated. An agent uses the first entry of its own runtime. Empty: no reader anywhere. The default is `claude:claude-haiku-5-5:medium`. |
| `READ_ROLES` | The roles that read through the reader list, comma-separated: `backlog`, `research`, `plan`, `plan-improve`, `plan-answers` (the planner's answers to its runs), `code-review`, `code-review-report`, `implement`, `implement-improve`. The default is every planner (`backlog,research,plan,plan-improve,plan-answers`); add the reviewers and implement to turn them on. Empty: no role. The reader's requests count in the run's cost. |
| `BACKLOG_PLAN_TIMEOUT_MS` | Time limit of one backlog planner turn in milliseconds; the default is `3600000`. |
| `BACKLOG_CHAT_CONTEXT_SHARE` | Share of the model's context, from 0 to 1, past which a backlog planner chat starts anew from the state brief; the default is `0.5`. |
| `EPIC_EFFORT` | The effort that lifts only the planning of the parent of a split run: `low`, `medium`, `high`, `xhigh` or `max`. It only raises an agent's own effort. Default `high`; empty turns it off. |
| `EPIC_REPLAN_EVERY_MERGE` | `true`: after every merged task the parent's planner looks at it before the tasks that depend on it start. `false`: only when the task differs from its plan. Default `true`. |
| `SPLIT` | `auto`: the planner may split a big task into subtasks, `off`: it never does; set per server, not per run in the dashboard. Default `auto`. |
| `ISSUE_TRACKER` | `jira` |
| `REQUIREMENTS_VIA` | `agent` or `direct`. Both build the requirements record in the server. The model does not rewrite it. |
| `SWARMLOOP_REPOS` | Names of the clones in the `swarmloop-checkouts` volume, comma-separated. Empty: every repository there. |
| `SWARMLOOP_PUBLIC_URL` | The address of the dashboard. The API and the dashboard answer only to `127.0.0.1`, `localhost`, this host and the compose names (anything else gets 421). Default `http://127.0.0.1:3921`. |
| `TICK_MS` | How often a running pipeline is polled. `defaults.env` uses `15000`. |
| `SWARMLOOP_API_HOST`, `SWARMLOOP_API_PORT` | Where the API listens. `defaults.env` uses `127.0.0.1:3920`. Without a login provider the server refuses to start on another address. |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITLAB_OAUTH_CLIENT_ID`, `GITLAB_OAUTH_CLIENT_SECRET` | Login with GitHub or GitLab. See [Login](#login). |
| `SWARMLOOP_ALLOW` | Who may log in: `github:<user>`, `github-org:<org>`, `gitlab:<user>`, `gitlab-group:<group>`. Empty: a person who can push to a repository this server works on, or the first person to log in on the server's own machine while nobody is connected; a plain GitHub OAuth App from `.env` keeps the owner of `GITHUB_TOKEN`. |
| `SWARMLOOP_TOKEN` | A personal token from Settings → API tokens, for the CLI and scripts. The queue runner's token must be an admin's. |

Spend, tokens, retries, and timeouts are in [Limits](#-limits-on-money-tokens-and-time). A missing model key does not stop the start: readiness names the runtime and links to its card. To change a setting, copy its line from `defaults.env` into `.env` next to `compose.yml`, or set it in the shell.

## 👥 For a team

Put it on one machine. Everyone who can open the panel sees the same runs, the same plans, and the same bill.

The flow is the same for every ticket. The rules live in `skills/` in this repo, so a change to a review or a plan rule reaches the whole team at the next server rebuild. Spend, tokens, and how many times a review may send work back are server settings, not a choice the agent makes.

### Login

The panel has a login with GitHub and with GitLab. Nothing acts without a session or a personal API token. People are members or admins, and the first person is an admin; an admin can make another person one, or take it back, as long as one admin stays.

1. **GitLab, with a personal access token** (the first way, no application to make): on the login page, click **Create a token** or open `<GITLAB_BASE_URL>/-/user_settings/personal_access_tokens` (`https://gitlab.com/-/user_settings/personal_access_tokens` on gitlab.com), make a token with the scopes `read_user`, `api` and `write_repository`, and paste it. A self-hosted GitLab is the one at `GITLAB_BASE_URL`.
   **GitLab, with an application** (for a team that wants OAuth): open `<GITLAB_BASE_URL>/-/user_settings/applications`, add an application with the callback `SWARMLOOP_PUBLIC_URL` plus `/auth/gitlab/callback`, the scopes `read_user`, `api` and `write_repository` (the scopes the authorize request asks for) and **Confidential** on, then paste its Application ID and Secret into the first-run form. Saving checks the application with GitLab and refuses a wrong one, naming the field to check. A stored application that GitLab rejects can be replaced with **Replace application**, on the login problem page and in Connections.
   **GitHub:** create an OAuth App on GitHub. Its callback is `SWARMLOOP_PUBLIC_URL` plus `/auth/github/callback`.
2. Put the id and secret in `.env`: `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`, `GITLAB_OAUTH_CLIENT_ID` and `GITLAB_OAUTH_CLIENT_SECRET`. The login page shows a button for each provider that has both.
3. Say who may log in with `SWARMLOOP_ALLOW`, comma-separated: `github:<user>`, `github-org:<org>`, `gitlab:<user>`, `gitlab-group:<group>`. Empty means a person whose own token can push to at least one repository this server works on (the clones in `swarmloop-checkouts`, narrowed by `SWARMLOOP_REPOS`), on the host they log in with; read access is not enough, and a refusal says `<host>:<login> can't push to any repository this server works on`. A plain GitHub OAuth App from `.env` keeps the owner of `GITHUB_TOKEN` as the default. A non-empty list works as written and only narrows or names people. Membership is checked once, at login, with the person's own token, which is not kept. A refused login names the account and the reason.

The GitHub App made from the dashboard is private and belongs to the account that owns the repositories. A private app can be installed only on its owner, and only that account or the members of the owning organization can sign in to it. People outside the organization (outside collaborators) cannot sign in to a private organization app: add them to the organization instead. An install started on GitHub's own page returns to swarmloop with `Installed on <account>` and a Log in button. Connections has **Replace app** for the person who made the app and for admins, with a confirm that names who gets disconnected. It starts the same manifest flow as first run, and the old app keeps working until GitHub returns the new one; only then are the connections made through the old app removed, and their runs wait with `GIT_AUTH` until those people log in again. Cancelling on GitHub changes nothing. The app on GitHub stays, and Connections links to its settings for deleting it.

The Settings page lets each person choose the agents per role and tier for their own runs. The `AGENTS_*` values (set in `defaults.env`, overridden by `.env` or the shell) are the server default. The choice is read when a run starts and kept on the run.

A session lasts 14 days, or until Logout. Every run records who started it, and the run page shows it. The CLI and scripts send a personal token from Settings → API tokens as `Authorization: Bearer <token>`; it acts as the person who made it, with their keys and settings. Pausing the server is for admins, so the queue runner's token must be an admin's.

Without a provider the server answers only on loopback and the panel works for one person on this machine, as before. A server that listens on another address without a provider refuses to start and says which variables to set. The compose file publishes the ports on `127.0.0.1`: to reach them from other machines, set a provider and `SWARMLOOP_PUBLIC_URL`, then publish the ports on an address your team can reach. Do not put this on the public internet.

The server mounts the Docker socket, so whoever controls the server controls the host. Only let in people you would give that. A personal subscription (Claude, ChatGPT or Cursor plan) is for personal use: do not share one plan across a team.

## 📜 License

swarmloop is licensed under the [Apache License 2.0](LICENSE).
