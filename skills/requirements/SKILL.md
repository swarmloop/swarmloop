# Requirements

The requirements record is already written by `swarmloop`. Nest puts a Work and Context brief of that JSON in the prompt, not the raw record. It is the `documents` row with kind `requirements`. Do not write a file.

It contains:

- `scope` — the keys of the tickets that are the work
- `prompt` — the human request, when one was given
- `tickets` — each story that is in scope, including its comments
- `epic` — the first connected epic, including its comments
- `epics` — every connected epic, so a second epic is not dropped
- `files` — attachments and pastes with their bodies; a linked issue keeps its description, acceptance criteria, and comments, and so does one level of its subtasks; an HTML page keeps its URL
- `pages` — Confluence and Google Drive pages, each with its body

Do not rewrite the record. Do not call Jira.
