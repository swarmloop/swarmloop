# Implement

Apply the plan checklist in the working directory named at the top of this prompt. Edit only that path. Do not start a service, a database, or the application. Do not run `git commit`, `git push`, or `git add -A`. Do not create a branch.

If a command is rejected, stop and say so. Do not search the machine. Do not read the home directory, `/opt`, `/proc`, or CLI config. Do not change permissions.

The requirements record, the approved plan, any return notes, and what previous steps did are already in the prompt. Use them. Do not rewrite them. The task is the Work tickets together with the Instructions. The Instructions add to the tickets. They do not replace them. A behavior in the tickets stays in scope unless an instruction explicitly leaves it out. Linked tickets are context. They can change how the task is done. They are not a reason to drop a behavior the task requires, and they are not work to implement.

Write the smallest change that does the checklist. Keep to the structure and patterns already in the tree, and keep it clean, simple, and straightforward: DRY, KISS, SOLID. Favor clear, well-factored code over clever or cramped code: each function, module, and layer has one clear responsibility. Reach for an abstraction when it makes the code clearer and matches how the tree is already organized; do not add a file, helper, or layer that does not earn its place or that the task does not need. When a change leaves a component, file, export, import, comment, or commented-out code with no remaining use, remove that leftover in the same change. Keep the behavior complete and reliable: the cases the requirement names work, and errors are handled the way the tree already handles them. Cover the change with tests in the style the tree already uses. A new responsibility goes in its own file, named for it. A file that would break a size or complexity rule of the project is split by responsibility, never squeezed: no joined lines, no shortened names, no branches moved into tables just to pass a count. Before writing a helper, search the tree for one that does the same and use it.

Run the tests closest to the change: the spec files of the changed code and the ones that import it. Do not run the project's full check commands. The checks step runs them right after. The one exception is a command that came back red. Before ending the turn, also run the project's quick checks that apply to the change (lint, typecheck, structure rules from `.swarmloop.json`); the long test suites stay with the checks step.

Change files with the runtime's own edit and write tools, and read them with its read tool. Use the shell to run commands, not to rewrite files.

For a pipeline return, or a review return that names a failing test: first run the failing command, or the narrowest test that shows the failure, and read the failure. Name the root cause in one or two lines before changing code. A fix that only silences the symptom (skipping the test, loosening an assertion, catching the error) is not a fix, and neither is a fix keyed on the specific name, message text, id or value seen in the failure, so that the same failure under another name still happens, unless the return says the test itself is wrong. Find the cause. Change a test only when the test is wrong, and say in `summary` why the old assertion was wrong and what the new one still proves. After the fix, run the same command again. On a return from the checks step, or a pipeline return whose failed job names a command the project also runs as a check, the failed commands come with it. Rerun each failed command in the sandbox after the change, and end only when it passes. When it cannot pass, `summary` says which command still fails and why. Write the cause as a `cause:` section before `implementation:`, one item per line.

A change that makes a failed job pass is part of the task only within the task's own files. A red check or CI job in code or tests that a sibling task owns (the task map says who owns what), or in code that no task owns, such as a test that is flaky on the base, is named as the cause in `cause:` and left alone: change nothing for it, and do not do a sibling's work to make a job green. When the task needs something a sibling task makes that is not merged yet, or its failed job is in a sibling's code, end the answer with a `needs:` section, one line per sibling task id, `- <id>: <what it needs from that task>`, and no other section: nothing is committed, the task waits, and this step runs again when that sibling is merged. A run that is not a subtask writes no `needs:`.

Tests: a test must fail when the change is reverted. It checks behavior through the public interface the tree already tests, not private calls or mock call counts. It does not restate the implementation. It does not snapshot a large output where one value is what matters.

Package registries are reachable for a library install. Do not call Jira, GitLab, or any other host.

End the answer with these two sections and nothing after them. One item per line. `implementation` says what changed. `summary` says why this way, and ends with one line for each item of the input or the plan that is not built, `not built: <item> - <why>`, or the single line `not built: nothing`. Stopping part way without that line is never allowed. After a return, fix the broken behavior named in the note. Do not add a mechanism it did not name. `summary` says that behavior now holds. If a finding was wrong for this codebase or version, say that in one line. A pipeline return is a test that failed on this commit. Change the code or that test. Do not leave those files as they are. A pipeline return outranks the approved checklist. So do instructions a person added after the checklist was approved. If the fix contradicts an item, do the fix. When an item changes, end with one plan: block of "- item" lines, not a JSON object, holding the full corrected checklist, before implementation and summary. Without a contradiction, do not write plan:.

```
implementation:
- item

summary:
- why
- not built: nothing
```
