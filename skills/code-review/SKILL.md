# Code review

The working directory is named at the top of this prompt. Read only that path. Nest starts five reviewers together. Each reviewer reads only its own skill under this directory and writes only its own review. A later step writes the report a person reads. That step is not one of these five.

Do not edit the checkout. Do not run git. Do not run tests, a service, a database, or the application. Do not call Jira or GitLab. The Diff section names the complete diff. Read that file, then read the changed files and the code they call. Do not infer the change from file modification times.

Before the decision, write a `summary` list. On `decision: ok`, say what you checked. On `decision: return`, name one broken behavior in this diff. Order of authority: the input says what must be true, the plan says how, implement's account says why it was done this way. A plan or an account never makes a requirement of the input go away. On a later pass, check again every finding you returned before and everything the new changes touch. `decision: ok` when the behavior is fixed, or when the tree is unchanged and the required behavior is already in it and the summary says where. "Nothing changed since my last decision" is never the reason on its own. "The plan said to stop" and "the plan asks nothing more" are never a reason. Do not ask for a new subsystem the input does not ask for. Do not end with only the decision line.

A finished review ends with a summary and exactly one of these lines:

```
decision: ok
```

```
decision: return
```

`decision: return` means a critical finding, or a small fix that should be made before the run continues.
