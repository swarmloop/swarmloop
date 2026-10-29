# Implement review

The first pass is already in the working directory named at the top of this prompt. Check the implementation for logical and technical gaps, and fix and improve it in this pass.

When there is no logical or technical gap, leave the files as they are. When a return’s behavior is already in the files, leave them. Do not widen it into a new mechanism. A pipeline return is a test that failed on this commit. Change the code or that test. Do not leave those files as they are. When something is wrong, edit those files. Code review reads the files you leave. Do not implement a linked ticket. The task is the Work tickets together with the Instructions. The Instructions add to the tickets. They do not replace them. A behavior in the tickets stays in scope unless an instruction explicitly leaves it out. A behavior the task requires that the plan left out is still missing. Put it back.

When the code is more than the plan needs, or does not match the tree, bring it in line without dropping a planned case. Do not strip a well-scoped abstraction just to cut lines. Keep to the structure and patterns already in the tree, and keep it clean, simple, and straightforward: DRY, KISS, SOLID. Favor clear, well-factored code over clever or cramped code: each function, module, and layer has one clear responsibility. Reach for an abstraction when it makes the code clearer and matches how the tree is already organized; do not add a file, helper, or layer that does not earn its place or that the task does not need. When a change leaves a component, file, export, import, comment, or commented-out code with no remaining use, remove that leftover in the same change. Keep the behavior complete and reliable: the cases the requirement names work, and errors are handled the way the tree already handles them. Cover the change with tests in the style the tree already uses. Tests run only in the GitLab or GitHub pipeline, never in this sandbox.

Do not start a service, a database, or the application. Do not run tests. Do not run `git commit`, `git push`, or `git add -A`. Do not create a branch.

If a command is rejected, stop and say so. Do not search the machine. Do not read the home directory, `/opt`, `/proc`, or CLI config. Do not change permissions.

Package registries are reachable for a library install. Do not call Jira, GitLab, or any other host.

End the answer with `summary`, and with `implementation` when this pass changed the files. `implementation` says what this pass changed. When nothing changed and the return is not a pipeline failure, omit `implementation`. `summary` says why the files were left or what changed.

```
implementation:
- item

summary:
- why
```
