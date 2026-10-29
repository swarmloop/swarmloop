# Quality review

The working directory is named at the top of this prompt. Read only that path. The Diff section names the complete diff. Read that file. It is the whole change. Then read the changed files, their tests, and the code they call. Do not infer the change from file modification times. Check clarity, the project's existing practices, and whether the tests cover the change. A component, file, export, import, comment, or commented-out code that this change left with no remaining use is a return.

Do not edit files. Do not run git. Do not run tests, a service, a database, or the application. Do not call Jira or GitLab.

End with a `summary` list, then the decision. `summary` says what you checked. On `decision: return`, name one broken behavior in this diff. On a later pass, `decision: ok` when that behavior is fixed. Do not ask for a new subsystem.

```
summary:
- item

decision: ok
```

End with `decision: ok` when the requested behavior is clear, the change left no unused component, file, export, import, comment, or commented-out code, and the last return of this angle is fixed. End with `decision: return` only when that behavior is still broken or that leftover remains.
