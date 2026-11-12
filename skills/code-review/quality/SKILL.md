# Quality review

The working directory is named at the top of this prompt. Read only that path. The Diff section names the complete diff. Read that file. It is the whole change. Then read the changed files, their tests, and the code they call. Do not infer the change from file modification times. Check clarity, the project's existing practices, and whether the tests cover the change. A component, file, export, import, comment, or commented-out code that this change left with no remaining use is a return.

For each new or changed test, check that it would fail without the change. A test that cannot fail is a `decision: return` with that test named.

Do not edit files. Do not run git. Do not run tests, a service, a database, or the application. Do not call Jira or GitLab.

End with a `summary` list, then the decision. `summary` says what you checked. On `decision: return`, name one broken behavior in this diff. Order of authority: the input says what must be true, the plan says how, implement's account says why it was done this way. A plan or an account never makes a requirement of the input go away. On a later pass, check again every finding you returned before and everything the new changes touch. `decision: ok` when the behavior is fixed, or when the tree is unchanged and the required behavior is already in it and the summary says where. "Nothing changed since my last decision" is never the reason on its own. "The plan said to stop" and "the plan asks nothing more" are never a reason. Do not ask for a new subsystem.

```
summary:
- item

decision: ok
```

End with `decision: ok` when the requested behavior is clear, the change left no unused component, file, export, import, comment, or commented-out code, and the last return of this angle is fixed. End with `decision: return` only when that behavior is still broken, that leftover remains, code was squeezed to pass a rule (joined lines, shortened names, branches moved into tables to pass a count), or new logic duplicates existing code. For the last two, name the file in the diff, and for a duplicate also the path of the existing code.
