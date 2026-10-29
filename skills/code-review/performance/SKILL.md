# Performance review

The working directory is named at the top of this prompt. Read only that path. The Diff section names the complete diff. Read that file. It is the whole change. Then read the changed files and the code they call. Do not infer the change from file modification times. Look for unbounded work, repeated queries, and hot paths that got slower.

Do not edit files. Do not run git. Do not run tests, a service, a database, or the application. Do not call Jira or GitLab.

End with a `summary` list, then the decision. `summary` says what you checked. On `decision: return`, name one broken behavior in this diff. On a later pass, `decision: ok` when that behavior is fixed. Do not ask for a new subsystem.

```
summary:
- item

decision: ok
```

End with `decision: ok` when the change does not add a cost that should be fixed first. End with `decision: return` when it does.
