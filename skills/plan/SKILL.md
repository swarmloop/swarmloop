# Plan

The requirements record is already in the prompt. The task is the Work tickets together with the Instructions. The Instructions add to the tickets. They do not replace them. A behavior in the tickets stays in scope unless an instruction explicitly leaves it out. Linked tickets are context. They can change how the task is done. They are not a reason to drop a behavior the task requires, and they are not work to implement. Every checklist item must still be this task. Do not add an item that belongs only to another ticket. The working directory is named at the top of this prompt, including whether it has source files. Read only that path, and only when it has source files. Do not search anywhere else.

Split the task into checklist items a later step can execute. When the requirement leaves a detail open, write one ordinary choice into the checklist. Do not search for it and do not ask.

Each item is the smallest change that does the work. Keep to the structure and patterns already in the tree, and keep it clean, simple, and straightforward: DRY, KISS, SOLID. Favor clear, well-factored code over clever or cramped code: each function, module, and layer has one clear responsibility. Reach for an abstraction when it makes the code clearer and matches how the tree is already organized; do not add a file, helper, or layer that does not earn its place or that the task does not need. When a change leaves a component, file, export, import, comment, or commented-out code with no remaining use, remove that leftover in the same change. Keep the behavior complete and reliable: the cases the requirement names work, and errors are handled the way the tree already handles them. Cover the change with tests in the style the tree already uses.

Before writing the checklist, find the size and complexity limits the project sets (its rules, its lint config). For each file the checklist changes, compare its current size with the limit. When the change would take a file past the limit or within about 15% of it, the first item that touches the file splits it by responsibility in a move-only change (no logic change), and later items add the new code to the file that now owns it.

A checklist never has an item like "stop and report if X is missing". A result that a sibling task makes and that is not merged yet is not missing: a subtask of a split run sends `needs`, one entry per sibling task id with what it needs from that task, and no plan. The server makes the task wait and runs this step again when that sibling is merged. A run that is not a subtask sends no `needs`.

Each checklist item is one entry of the plan and ends with `files:` (the paths it changes) and `proof:` (the test or check that shows it is done), for example `add X to Y - files: src/billing/invoice - proof: the invoice total test`.

The prompt may hold an `Impact` section: the capabilities the task touches, one `- <capability> | <file> | <status>` line each. Every `kept` capability that the checklist touches gets an item `keep: <capability> - files: <paths> - proof: <test>`.

A capability marked `removed` or `unreachable` that the requirements do not name in a `Removes` or `Behavior change` section, and that no answer confirmed, is not planned around silently. Stop and send `questions` in place of the plan, one entry `This change makes <capability> <unreachable|go away>. Is that intended?` per capability. Dead code that nothing relies on is not a capability and raises no question.

The checklist goes in the result block, and only there. A later pass replaces the plan with its own. Do not edit source files. Do not run git. Do not implement the items. `summary` says why this checklist.

## Split

This section applies only because this run may split into subtasks.

Split by the amount of work, not by a count of tasks. Split only when the whole change is clearly more than one normal run of work, so that one implement pass would not finish it well, and it has parts that can each be built, reviewed and tested on their own. Each task is about one normal run of work. Do not split a change that one run can do, and do not cut a task so small that it is only one step of another. When you do not split, send a plan as above.

When you split, leave the plan empty and fill in `contract`, `keep` and `tasks`. The server writes the plan from `tasks`.

An id is a short slug. `depends` lists the ids of the tasks that must be done first. A task has at least one proof. Do not make a cycle and do not name a task that is not in the list. `files` lists every file the task will change, including its tests and the shared test helpers and fixtures they need; a task that changes a file another task lists depends on that task (the server adds the dependency when the planner forgets). Two tasks that can run at the same time must not change the same file unless one depends on the other. A file where tasks each add an entry (a registry or list such as module imports, the migrations index, route or step lists, `.env.example`, a README table) is shared: give the tasks that touch it a dependency between them. A task that adds to a file the plan splits depends on the task that splits it.

Tasks are only work that changes the tree. A capability that only needs its existing test rerun is a `keep` entry, never a task: one entry per kept capability. The server puts each entry into the prompt of every task it names and into the final review, and never makes a run from it. Every task has at least one file to change. When the proof test of a `keep` entry does not exist yet, its proof says `new <test>`, and writing that test goes into the `proof` of the first task the entry names.
