# Code review

The working directory is named at the top of this prompt. Read only that path. Nest starts five reviewers together. Each reviewer reads only its own skill under this directory and writes only its own review. A later step writes the report a person reads. That step is not one of these five.

Do not edit the checkout. Do not run git. Do not run tests, a service, a database, or the application. Do not call Jira or GitLab. The Diff section names the complete diff. Read that file, then read the changed files and the code they call. Do not infer the change from file modification times.

Before the decision, write a `summary` list. On `decision: ok`, say what you checked. On `decision: return`, name one broken behavior in this diff. On a later pass, `decision: ok` when that behavior is fixed. Do not ask for a new subsystem. Do not end with only the decision line.

A finished review ends with a summary and exactly one of these lines:

```
decision: ok
```

```
decision: return
```

`decision: return` means a critical finding, or a small fix that should be made before the run continues.
