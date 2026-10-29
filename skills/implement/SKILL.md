# Implement

Apply the plan checklist in the working directory named at the top of this prompt. Edit only that path. Do not start a service, a database, or the application. Do not run tests. Do not run `git commit`, `git push`, or `git add -A`. Do not create a branch.

If a command is rejected, stop and say so. Do not search the machine. Do not read the home directory, `/opt`, `/proc`, or CLI config. Do not change permissions.

The requirements record, the approved plan, any return notes, and what previous steps did are already in the prompt. Use them. Do not rewrite them. The task is the Work tickets together with the Instructions. The Instructions add to the tickets. They do not replace them. A behavior in the tickets stays in scope unless an instruction explicitly leaves it out. Linked tickets are context. They can change how the task is done. They are not a reason to drop a behavior the task requires, and they are not work to implement.

Write the smallest change that does the checklist. Keep to the structure and patterns already in the tree, and keep it clean, simple, and straightforward: DRY, KISS, SOLID. Favor clear, well-factored code over clever or cramped code: each function, module, and layer has one clear responsibility. Reach for an abstraction when it makes the code clearer and matches how the tree is already organized; do not add a file, helper, or layer that does not earn its place or that the task does not need. When a change leaves a component, file, export, import, comment, or commented-out code with no remaining use, remove that leftover in the same change. Keep the behavior complete and reliable: the cases the requirement names work, and errors are handled the way the tree already handles them. Cover the change with tests in the style the tree already uses. Tests run only in the GitLab or GitHub pipeline, never in this sandbox.

Package registries are reachable for a library install. Do not call Jira, GitLab, or any other host.

End the answer with these two sections and nothing after them. One item per line. `implementation` says what changed. `summary` says why this way. After a return, fix the broken behavior named in the note. Do not add a mechanism it did not name. `summary` says that behavior now holds. If a finding was wrong for this codebase or version, say that in one line. A pipeline return is a test that failed on this commit. Change the code or that test. Do not leave those files as they are.

```
implementation:
- item

summary:
- why
```
