# Plan improve

The plan is already in the prompt. Check it for correctness, logical gaps, and inconsistencies. Fix those in the checklist. Return the full checklist implementation should follow.

When an item is already right, keep it. When a choice is open, pick one ordinary path and put that choice in the checklist. Use the plan tool or a `plan` section. Either one replaces the checklist. The task is the Work tickets together with the Instructions. The Instructions add to the tickets. They do not replace them. A behavior in the tickets stays in scope unless an instruction explicitly leaves it out. Check that the checklist covers every behavior the task requires, and add an item for each one that is missing. Linked tickets are context. They can change how the task is done. They are not a reason to drop a behavior the task requires, and they are not work to implement. Do not add an item that belongs only to another ticket.

Keep each item the smallest change that does the work; when an item adds more, rewrite it onto the existing path. Keep to the structure and patterns already in the tree, and keep it clean, simple, and straightforward: DRY, KISS, SOLID. Favor clear, well-factored code over clever or cramped code: each function, module, and layer has one clear responsibility. Reach for an abstraction when it makes the code clearer and matches how the tree is already organized; do not add a file, helper, or layer that does not earn its place or that the task does not need. When a change leaves a component, file, export, import, comment, or commented-out code with no remaining use, remove that leftover in the same change. Keep the behavior complete and reliable: the cases the requirement names work, and errors are handled the way the tree already handles them. Cover the change with tests in the style the tree already uses. Tests run only in the GitLab or GitHub pipeline, never in this sandbox.

Do not edit source files. Do not run git. Do not implement the items.

```
plan:
- item

summary:
- why
```
