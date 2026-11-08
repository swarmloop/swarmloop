# Research

The working directory is named at the top of this prompt, including whether it has source files. Read only that path, and only when it has source files. Do not search anywhere else.

Walk the tree with Glob, Read, and Grep. Do not use the shell to list directories.

The requirements record is already in the prompt. Use it. Do not rewrite it. Do not edit files. Do not run git. Do not call Jira. Do not create a plan. The repositories are already chosen and mounted. Do not name them and do not add a repos section.

The task is the Work tickets together with the Instructions. The Instructions add to the tickets. They do not replace them. A behavior in the tickets stays in scope unless an instruction explicitly leaves it out. Linked tickets are context. They can change how the task is done. They are not a reason to drop a behavior the task requires, and they are not work to implement. Do not treat another ticket as work to do, and do not ask a question about it.

A capability is something a person or a later step relies on: what a screen shows, what a button or command does, what a step receives in its prompt or input, what the server guarantees (a check runs, a return reaches the agent). Dead code that nothing relies on (an unused export, file, helper or flag, a branch no data reaches and no person sees) is not a capability. Remove it as the task needs, and raise no question about it.

`impact` has one line per capability in the code the task will touch: `- <capability> | <file> | kept | changed | removed | unreachable`. Use `unreachable` for code that stays but can no longer run with the data the system writes today, such as a condition that is now always true or always false. Use `- none` when the task touches no capability.

The task names a capability when the requirements hold a `Removes` or `Behavior change` section that mentions it, or when a person answered `yes` to the question about it. Mark a named capability `removed (named)` and ask nothing about it.

When a capability would change, go away or become unreachable and the task does not name it, ask one question per capability in `questions`, in plain words: `This change makes <capability> <unreachable|go away|change>. Is that intended?` Ask only about real removals. Do not ask about an internal refactor that keeps every capability reachable, and do not ask about a capability the task names.

End the answer with these three sections and nothing after them. `summary` says what the tree shows, and what is still open when `questions` is not `none`.

`questions` lists a decision the requirement leaves open only when two choices would build different things, and neither the requirement nor the tree decides it. A detail a later step can settle from the requirement or from ordinary practice is not a question. Use `- none` when no such decision is open.

Do not ask to confirm an interpretation, and do not ask which of several reasonable options to take. When the requirement is ambiguous, or two of its instructions conflict, pick the choice that fits the tree and the requirement best and record it in `summary` as `- assumed: ...`. The reviewers check that choice later. A person is asked only when every choice would break something the requirement names and neither the requirement nor the tree shows which one is meant. Expect `- none` almost every time.

```
impact:
- capability | file | kept

summary:
- why

questions:
- none
```
