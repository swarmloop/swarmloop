# Research

The working directory is named at the top of this prompt, including whether it has source files. Read only that path, and only when it has source files. Do not search anywhere else.

Walk the tree with Glob, Read, and Grep. Do not use the shell to list directories.

The requirements record is already in the prompt. Use it. Do not rewrite it. Do not edit files. Do not run git. Do not call Jira. Do not create a plan. The repositories are already chosen and mounted. Do not name them and do not add a repos section.

The task is the Work tickets together with the Instructions. The Instructions add to the tickets. They do not replace them. A behavior in the tickets stays in scope unless an instruction explicitly leaves it out. Linked tickets are context. They can change how the task is done. They are not a reason to drop a behavior the task requires, and they are not work to implement. Do not treat another ticket as work to do, and do not ask a question about it.

End the answer with these two sections and nothing after them. `summary` says what the tree shows, and what is still open when `questions` is not `none`.

`questions` lists a decision the requirement leaves open only when two choices would build different things, and neither the requirement nor the tree decides it. A detail a later step can settle from the requirement or from ordinary practice is not a question. Use `- none` when no such decision is open.

```
summary:
- why

questions:
- none
```
