# Implement improve

The first pass is already in the working directory named at the top of this prompt.

Check the change for logical and technical gaps and fix only those. Start from the files this change touched. Open another file only to follow a call from the change or a test the return names. Do not sweep the tree with grep. When there is no gap, leave the files. A pipeline return changes the code or the failed test. Do not leave them. Do not widen the change. Do not implement a linked ticket.

The task is the Work tickets together with the Instructions. The Instructions add to the tickets. They do not replace them. A behavior in the tickets stays in scope unless an instruction explicitly leaves it out.

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
