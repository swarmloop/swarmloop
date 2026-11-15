# Project base

A repository with no CI starts from its base. The base is the best of what swarmloop does in its own repository, said without a language or a tool: each point names what a piece does, and the stack's usual tool fills it.

The one principle: the base changes no existing code, and every check it adds passes on the code as it is.

Defaults: a product file has at most 400 counted lines (blank lines and comments do not count); a function has complexity 20 at most; a folder holds at most 12 product files; a subfolder holds at least 3; a file is split before it passes about 85% of its limit. These numbers are written into the project's own `AGENTS.md` and checks. From then on those two files hold them, and the project may change them there.

When the requirements name no stack, the plan picks one and says why.

## (a) Files

- The project, initialised for the stack the requirements name, when the repository has none yet.
- `.gitignore`.
- `.env.example` naming every setting with its meaning and no real value. The defaults of the settings are in one place, never scattered through the code. A real `.env` is never committed.
- `README.md`: what the project is, how to set it up and run it, and the commands of the checks.
- `CHANGELOG.md` with an `Unreleased` section.
- `.swarmloop.json` with the image or Dockerfile, the setup, the caches and the checks, each check its own command. A minimal example with placeholders:

```json
{
  "version": 1,
  "image": "<image>",
  "setup": "<setup command>",
  "cache": ["/home/sandbox/.cache/<tool>"],
  "checks": ["<format check command>", "<lint command>", "<type check command>", "<test command>"]
}
```

- One CI workflow for the repository's code host. It runs on every push to every branch, with no path filter and no branch filter, and it runs exactly the commands of the checks in `.swarmloop.json`, in the same order.
- `AGENTS.md` (part c).

## (b) Checks

Each check is its own command.

- Format: a check that the files are formatted.
- Lint: the stack's strictest standard preset, with unhandled async results and untyped values as errors where the stack can see them.
- Type check, when the stack has one.
- Tests: at least one from the first commit, run in random order where the runner supports it.
- Size: a product file has at most 400 counted lines (blank lines and comments do not count); a function has complexity 20 at most.
- Structure: a folder holds at most 12 product files (tests and fixtures do not count) and otherwise is split into subfolders by responsibility; a subfolder holds at least 3; a file name does not repeat its folder; no grab-bag folder named `utils`, `helpers`, `misc` or `common`.
- No import cycles, and no unused files or exports, where the stack has a tool for each.
- When the project has more than one layer, the rule of which layer may import which.
- The build, when the project builds.
- When the project ships a runnable service, a smoke check that starts it the way a user will and checks that it answers.

## (c) AGENTS.md rules

Rules for every change. Each is checked by a check or by a reviewer reading the diff.

- Size and shape: before a file passes about 85% of its limit, split it by responsibility in a move-only change. Never squeeze code under a limit. A new responsibility goes in its own file, named for it, in the folder of that responsibility. Search for an existing helper before writing one. Remove what a change leaves unused.
- Tests: a test fails when the change is reverted. It checks behavior through the public interface, with no private calls, no mock call counts, no large snapshots, and fake time instead of sleeping. Product code never imports a test library. Never loosen, skip or delete a test, or raise a timeout or a retry count, to make a check pass.
- Changes: the smallest change that does the task. Fix the cause, not the symptom. One general rule, no special case for one input or one name. A capability goes away only when the task says so. No new dependency unless the task needs it.
- Code: an external service sits behind an interface of its kind. Time, configuration and logs each go through one place. No value that belongs in the settings is written in the code. A secret is never logged, put in a URL or sent to a client.
- Database changes are migrations, and a migration never edits an older one.
- Code, comments and commit messages are in one language, English unless the requirements say otherwise.

Every task after the base adds its own tests on top of it.
