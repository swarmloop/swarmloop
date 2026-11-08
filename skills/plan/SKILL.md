# Plan

The requirements record is already in the prompt. The task is the Work tickets together with the Instructions. The Instructions add to the tickets. They do not replace them. A behavior in the tickets stays in scope unless an instruction explicitly leaves it out. Linked tickets are context. They can change how the task is done. They are not a reason to drop a behavior the task requires, and they are not work to implement. Every checklist item must still be this task. Do not add an item that belongs only to another ticket. The working directory is named at the top of this prompt, including whether it has source files. Read only that path, and only when it has source files. Do not search anywhere else.

Split the task into checklist items a later step can execute. When the requirement leaves a detail open, write one ordinary choice into the checklist. Do not search for it and do not ask.

Each item is the smallest change that does the work. Keep to the structure and patterns already in the tree, and keep it clean, simple, and straightforward: DRY, KISS, SOLID. Favor clear, well-factored code over clever or cramped code: each function, module, and layer has one clear responsibility. Reach for an abstraction when it makes the code clearer and matches how the tree is already organized; do not add a file, helper, or layer that does not earn its place or that the task does not need. When a change leaves a component, file, export, import, comment, or commented-out code with no remaining use, remove that leftover in the same change. Keep the behavior complete and reliable: the cases the requirement names work, and errors are handled the way the tree already handles them. Cover the change with tests in the style the tree already uses.

Each checklist item stays one `- item` line and ends with `files:` (the paths it changes) and `proof:` (the test or check that shows it is done), for example `- add X to Y - files: server/src/a.ts - proof: a.spec.ts "adds X"`.

The prompt may hold an `Impact` section: the capabilities the task touches, one `- <capability> | <file> | <status>` line each. Every `kept` capability that the checklist touches gets an item `- keep: <capability> - files: <paths> - proof: <test>`.

A capability marked `removed` or `unreachable` that the requirements do not name in a `Removes` or `Behavior change` section, and that no answer confirmed, is not planned around silently. Stop and end with a `questions:` section in place of `plan:`, one line `- This change makes <capability> <unreachable|go away>. Is that intended?` per capability, then `summary:`. Dead code that nothing relies on is not a capability and raises no question.

Write the checklist with the plan tool. That is how a later pass replaces the plan. Do not edit source files. Do not run git. Do not implement the items.

End the answer with these two sections and nothing after them. One item per line. The plan items match the plan tool. `summary` says why this checklist.

```
plan:
- item

summary:
- why
```
