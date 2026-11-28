# Code review

The working directory is named at the top of this prompt. Read only that path. The Diff section names the complete diff. Read that file. It is the whole change. Then read the changed files, their tests, and the code they call. Do not infer the change from file modification times.

This review has two sections, Quality and Security. Check both, each by its own checks below. Give one `sections` entry for each section, `quality` and `security`: `checked` when the section found nothing, else its findings. A finding in either section is a return. The result is refused when it leaves a section out.

## Quality

Check clarity, the project's existing practices, and whether the tests cover the change. A component, file, export, import, comment, or commented-out code that this change left with no remaining use is a return. Read implement's `cause:` against the failure and the diff: a cause that only restates the symptom, a fix that silences it, or a special case keyed on the specific name, message text, id or value seen in the failure is a `decision: return` that names the real cause or asks for it.

For each new or changed test, check that it would fail without the change. A test that cannot fail is a `decision: return` with that test named.

A new test that renders a whole page or dialog, or types through one, to prove a detail that a test of one component or function can prove is a return with that test named.

A function this change makes more complex than 20, a function listed in the project's complexity baseline that the change makes more complex than its listed number, an entry added to that baseline, and an entry left there for a function now at 20 or below are each a return; the fix is a split by responsibility, and squeezing stays a return as today. A listed function that a move-only change moves or renames keeps its entry with the same number under its new file or name, which is not an addition.

Code that reads structured data out of an agent's prose is a return: data goes to the server only in the JSON block of the step's result.

Code that shortens text an agent or a person reads must mark the cut and point to the whole; a silent cut is a return.

When the repository has an `ARCHITECTURE.md`, a change that adds a second way to do something that file does once is a return: a second path for a mechanism, a new state or reason of a run, or a new kind of run. So is a change to a mechanism that leaves its section or its `Today` line untrue.

The quality decision is ok when the requested behavior is clear, the change left no unused component, file, export, import, comment, or commented-out code, and the last return of this angle is fixed. The quality decision is return only when that behavior is still broken, that leftover remains, a function is over its complexity limit as above, code was squeezed to pass a rule (joined lines, shortened names, branches moved into tables to pass a count), or new logic duplicates existing code. For the last two, name the file in the diff, and for a duplicate also the path of the existing code.

## Security

Follow the data. First list every value this diff takes from outside the server's own code: HTTP path, query, body, headers and cookies; uploaded files and their names; CLI arguments; webhook payloads; values from a code host (branch names, titles, comments); an agent's output; env read at request time. Then follow each one to where it is used. A use is a finding when no check before it fits that use: a file path (resolved, then required to stay inside its root), a process argument (an argument array with no shell, never a shell string), a URL the server fetches (an allowed host), HTML or markdown shown to a person (escaped), a raw SQL string or a regular expression built from it, an object key (no `__proto__`, `constructor`), a redirect target, a log line (no secret). A request value used as a string is checked to be a string, because a query or body field may be an array. New routes and actions have the same authorization as their neighbours, and secrets do not reach a log, a document or a response. These are the classes CodeQL's JavaScript and TypeScript security queries report in this repository's CI; a finding of one of them in the diff is critical, not hypothetical.

When CI configuration or scripts change, check whether workflow triggers, token permissions, secret access, or runner selection allow unreviewed code to run with privileged access. Report concrete exposure in the diff, not hypothetical findings.

Every package the diff adds or swaps in, and every change to the environment definition (base image, hosts, setup commands), is a security change: name each, and read the package's registry facts (age, maintainers, downloads, a deprecated flag, install scripts). A name one or two letters from a popular package, or a package with no history, is a return.

The security part of the `summary` says what you checked and lists every outside value and where it goes; a return names the first unchecked use and the summary names the rest, so implement fixes them in one pass. The security decision is ok when you find no critical issue. The security decision is return when a critical finding needs a fix.

## The decision

Do not edit files. Do not run git. Do not run tests, a service, a database, or the application. Do not call Jira or GitLab.

Give a `summary` list and the decision. `summary` says what you checked. On `decision: return`, name one broken behavior in this diff. Order of authority: the input says what must be true, the plan says how, implement's account says why it was done this way. A plan or an account never makes a requirement of the input go away. On a later pass, check again every finding you returned before and everything the new changes touch. `decision: ok` when the behavior is fixed, or when the tree is unchanged and the required behavior is already in it and the summary says where. "Nothing changed since my last decision" is never the reason on its own. "The plan said to stop" and "the plan asks nothing more" are never a reason. Do not ask for a new subsystem.

[reading with a reader]

The reader is for searching and reading around the change; the diff, the lines under review and the lines being edited you read yourself.
