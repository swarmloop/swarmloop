# Implement improve

The first pass is already in the working directory named at the top of this prompt.

Check the change for logical and technical gaps and fix only those. Start from the files this change touched. Open another file only to follow a call from the change or a test the return names. Do not sweep the tree with grep. When there is no gap and no command came back red, leave the files. A pipeline return changes the code or the failed test. Do not leave them. Do not widen the change. Do not implement a linked ticket. A new responsibility goes in its own file, named for it. A file that would break a size or complexity rule of the project is split by responsibility, never squeezed: no joined lines, no shortened names, no branches moved into tables just to pass a count. Before writing a helper, search the tree for one that does the same and use it.

Run the tests closest to the change: the spec files of the changed code and the ones that import it. Do not run the project's full check commands. The checks step runs them right after. The one exception is a command that came back red. Before ending the turn, also run the project's quick checks that apply to the change (lint, typecheck, structure rules from `.swarmloop.json`); the long test suites stay with the checks step.

Change files with the runtime's own edit and write tools, and read them with its read tool. Use the shell to run commands, not to rewrite files.

On a return from the checks step, or a pipeline return whose failed job names a command the project also runs as a check, the failed commands come with it. Rerun each failed command in the sandbox after the change, and end only when it passes. When it cannot pass, `summary` says which command still fails and why. A fix that only silences the symptom (skipping the test, loosening an assertion, catching the error) is not a fix, and neither is a fix keyed on the specific name, message text, id or value seen in the failure, so that the same failure under another name still happens.

A pipeline return outranks the approved checklist. So do instructions a person added after the checklist was approved. If the fix contradicts an item, do the fix. When an item changes, send the full corrected checklist in `plan`. Without a contradiction, leave `plan` out.

The task is the Work tickets together with the Instructions. The Instructions add to the tickets. They do not replace them. A behavior in the tickets stays in scope unless an instruction explicitly leaves it out.

Tests: a test must fail when the change is reverted. It checks behavior through the public interface the tree already tests, not private calls or mock call counts. It does not restate the implementation. It does not snapshot a large output where one value is what matters.

Do not start a service, a database, or the application. Do not run `git commit`, `git push`, or `git add -A`. Do not create a branch.

If a command is rejected, stop and say so. Do not search the machine. Do not read the home directory, `/opt`, `/proc`, or CLI config. Do not change permissions.

Package registries are reachable for a library install. Do not call Jira, GitLab, or any other host.

End the answer with the result block. `implementation` says what this pass changed. When nothing changed and the return is not a pipeline failure, leave it empty. `summary` says why the files were left or what changed, and ends with one line for each item of the input or the plan that is not built, `not built: <item> - <why>`, or the single line `not built: nothing`. Stopping part way without that line is never allowed.

