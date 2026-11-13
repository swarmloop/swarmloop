# Plan improve

Before anything else, list every item the input asks for (numbered `Do` items, `Check` and `Pipeline` items, sentences with "must", acceptance criteria, answered questions) and check that each is covered by a plan item or, in a split run, a task. Add an item or a task for each one that is missing, and list each one in `summary` as `- added: <item> - <why>`. A plan never drops a requirement of the input.

The plan is already in the prompt. Check it for correctness, logical gaps, and inconsistencies. Fix those in the checklist. Return the full checklist implementation should follow.

[plan tool] When an item is already right, keep it. When a choice is open, pick one ordinary path and put that choice in the checklist. Use the plan tool or a `plan` section. Either one replaces the checklist. The task is the Work tickets together with the Instructions. The Instructions add to the tickets. They do not replace them. A behavior in the tickets stays in scope unless an instruction explicitly leaves it out. Check that the checklist covers every behavior the task requires, and add an item for each one that is missing. Linked tickets are context. They can change how the task is done. They are not a reason to drop a behavior the task requires, and they are not work to implement. Do not add an item that belongs only to another ticket.
[no plan tool] When an item is already right, keep it. When a choice is open, pick one ordinary path and put that choice in the checklist. Write a `plan` section. It replaces the checklist. The task is the Work tickets together with the Instructions. The Instructions add to the tickets. They do not replace them. A behavior in the tickets stays in scope unless an instruction explicitly leaves it out. Check that the checklist covers every behavior the task requires, and add an item for each one that is missing. Linked tickets are context. They can change how the task is done. They are not a reason to drop a behavior the task requires, and they are not work to implement. Do not add an item that belongs only to another ticket.

The prompt may hold an `Impact` section: the capabilities the task touches, one `- <capability> | <file> | <status>` line each. Every `kept` capability that the checklist touches needs an item `- keep: <capability> - files: <paths> - proof: <test>`. Add each one that is missing. A capability marked `removed` or `unreachable` that the requirements do not name in a `Removes` or `Behavior change` section, and that no answer confirmed, is left as the checklist has it. Note it in `summary` as `- unnamed removal: <capability>`, because this step cannot ask.

Keep each item the smallest change that does the work; when an item adds more, rewrite it onto the existing path. Keep to the structure and patterns already in the tree, and keep it clean, simple, and straightforward: DRY, KISS, SOLID. Favor clear, well-factored code over clever or cramped code: each function, module, and layer has one clear responsibility. Reach for an abstraction when it makes the code clearer and matches how the tree is already organized; do not add a file, helper, or layer that does not earn its place or that the task does not need. When a change leaves a component, file, export, import, comment, or commented-out code with no remaining use, remove that leftover in the same change. Keep the behavior complete and reliable: the cases the requirement names work, and errors are handled the way the tree already handles them. Cover the change with tests in the style the tree already uses.

Check the plan against the size and complexity limits the project sets (its rules, its lint config). For each file the checklist changes, compare its current size with the limit. When the change would take a file past the limit or within about 15% of it, the first item that touches the file must split it by responsibility in a move-only change (no logic change), and later items add the new code to the file that now owns it. Add or reorder items where the checklist does not do this.

Do not edit source files. Do not run git. Do not implement the items.

```
plan:
- item

summary:
- why
```

## Split

This section applies only because this run may split into subtasks. The prompt then holds the `Contract` and the `Tasks` the planner wrote, next to the `Plan` the server made from them.

Check the tasks:
- every item the input asks for is covered by a task, and each task added for a missing one is listed in `summary` as `- added: <item> - <why>`;
- no dependency cycle, and every dependency names a task in the list;
- two tasks that can run at the same time do not change the same file unless one depends on the other;
- `files:` lists every file the task will change, including its tests and the shared test helpers and fixtures they need, and a task that changes a file another task lists depends on that task (the server adds the dependency when the planner forgets);
- a file where tasks each add an entry (a registry or list such as module imports, the migrations index, route or step lists, `.env.example`, a README table) is shared: the tasks that touch it get a dependency between them, so they never change it at the same time;
- tasks are only work that changes the tree: a task that only reruns existing tests and changes no file becomes a `keep:` line (`- <capability> | proof: <test> | tasks: <ids that touch it>`), and every task has a file to change;
- a `keep:` line whose proof test does not exist yet says `proof: new <test>`, and writing that test is in the `proof:` of the first task the line names;
- every task has a proof;
- every task is about one normal run of work, so cut a task that is much more and merge a task that is much less.

The task limit is only a safety limit against a runaway plan. It is not a target.

Return the corrected `contract:`, the stored `keep:` lines (when the prompt holds a `Keep` section) and `tasks:` in the same format, and do not write `plan:`, because the server writes it from `tasks:`. When the split is not worth it, because one run can do the whole change, return one `plan:` instead.

```
contract:
- decision

keep:
- <capability> | proof: <test or new <test>> | tasks: <ids>

tasks:
- <id> | <title> | depends: <ids or none> | files: <paths> | proof: <test or check>
  what the task does, on an indented line

summary:
- why
```
