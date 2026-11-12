# Plan

The requirements record is already in the prompt. The task is the Work tickets together with the Instructions. The Instructions add to the tickets. They do not replace them. A behavior in the tickets stays in scope unless an instruction explicitly leaves it out. Linked tickets are context. They can change how the task is done. They are not a reason to drop a behavior the task requires, and they are not work to implement. Every checklist item must still be this task. Do not add an item that belongs only to another ticket. The working directory is named at the top of this prompt, including whether it has source files. Read only that path, and only when it has source files. Do not search anywhere else.

Split the task into checklist items a later step can execute. When the requirement leaves a detail open, write one ordinary choice into the checklist. Do not search for it and do not ask.

Each item is the smallest change that does the work. Keep to the structure and patterns already in the tree, and keep it clean, simple, and straightforward: DRY, KISS, SOLID. Favor clear, well-factored code over clever or cramped code: each function, module, and layer has one clear responsibility. Reach for an abstraction when it makes the code clearer and matches how the tree is already organized; do not add a file, helper, or layer that does not earn its place or that the task does not need. When a change leaves a component, file, export, import, comment, or commented-out code with no remaining use, remove that leftover in the same change. Keep the behavior complete and reliable: the cases the requirement names work, and errors are handled the way the tree already handles them. Cover the change with tests in the style the tree already uses.

Each checklist item stays one `- item` line and ends with `files:` (the paths it changes) and `proof:` (the test or check that shows it is done), for example `- add X to Y - files: src/billing/invoice - proof: the invoice total test`.

The prompt may hold an `Impact` section: the capabilities the task touches, one `- <capability> | <file> | <status>` line each. Every `kept` capability that the checklist touches gets an item `- keep: <capability> - files: <paths> - proof: <test>`.

A capability marked `removed` or `unreachable` that the requirements do not name in a `Removes` or `Behavior change` section, and that no answer confirmed, is not planned around silently. Stop and end with a `questions:` section in place of `plan:`, one line `- This change makes <capability> <unreachable|go away>. Is that intended?` per capability, then `summary:`. Dead code that nothing relies on is not a capability and raises no question.

[plan tool] Write the checklist with the plan tool. That is how a later pass replaces the plan. Do not edit source files. Do not run git. Do not implement the items.
[no plan tool] Write the checklist in the `plan:` section of your answer. That is what the server reads, and a later pass replaces the plan with its own `plan:` section. Do not edit source files. Do not run git. Do not implement the items.

[plan tool] End the answer with these two sections and nothing after them. One item per line. The plan items match the plan tool. `summary` says why this checklist.
[no plan tool] End the answer with these two sections and nothing after them. One item per line. `summary` says why this checklist.

```
plan:
- item

summary:
- why
```

## Split

This section applies only because this run may split into subtasks.

Split by the amount of work, not by a count of tasks. Split only when the whole change is clearly more than one normal run of work, so that one implement pass would not finish it well, and it has parts that can each be built, reviewed and tested on their own. Each task is about one normal run of work. Do not split a change that one run can do, and do not cut a task so small that it is only one step of another. When you do not split, answer with `plan:` as above.

When you split, do not write `plan:`. The server writes it from `tasks:`. End the answer with these three sections and nothing after them:

```
contract:
- a decision every subtask follows: names, interfaces, data shapes, files that one task creates and others use

tasks:
- <id> | <title> | depends: <ids or none> | files: <paths> | proof: <test or check>
  what the task does, on an indented line

summary:
- why
```

An id is a short slug. `depends:` lists the ids of the tasks that must be done first, separated by commas, or `none`. A task has at least one proof. Do not make a cycle and do not name a task that is not in the list. Two tasks that can run at the same time must not change the same file unless one depends on the other. A file where tasks each add an entry (a registry or list such as module imports, the migrations index, route or step lists, `.env.example`, a README table) is shared: give the tasks that touch it a dependency between them.
