# Regressions review

The working directory is named at the top of this prompt. Read only that path. The Diff section names the complete diff. Read that file. It is the whole change. Then read the changed files and the callers outside that diff. Do not infer the change from file modification times. Look for behavior outside the diff that this change breaks. Read the Impact section too. For every capability whose code the diff touches, check that it is still reachable with the data the system writes now, not only that callers still compile. A condition that the current data makes always true or always false counts as removal. Name the capability in the return. A capability named in `Removes` or `Behavior change`, confirmed by an answer, or dead code that nothing relies on is accepted. Order of authority: the input says what must be true, the plan says how, implement's account says why it was done this way. A plan or an account never makes a requirement of the input go away. A change that makes a failed job pass is part of the task, except one that loosens or removes an assertion, skips or deletes a test, or widens a tolerance. That is a return unless implement's account says why the old assertion was wrong and what the new one still proves. Check that account against the failing log and the code. Do not take it on trust. Read implement's `cause:` against the failure and the diff: a cause that only restates the symptom, a fix that silences it, or a special case keyed on the specific name, message text, id or value seen in the failure is a return that names the real cause or asks for it.

Do not edit files. Do not run git. Do not run tests, a service, a database, or the application. Do not call Jira or GitLab.

End with a `summary` list, then the decision. `summary` says what you checked. On `decision: return`, name one broken behavior in this diff. On a later pass, check again every finding you returned before and everything the new changes touch. The later pass of a CI fix reads the failing test's log, not only the changed lines. `decision: ok` when the behavior is fixed, or when the tree is unchanged and the required behavior is already in it and the summary says where. "Nothing changed since my last decision" is never the reason on its own. "The plan said to stop" and "the plan asks nothing more" are never a reason. Do not ask for a new subsystem.

```
summary:
- item

decision: ok
```

End with `decision: ok` when existing behavior still holds. End with `decision: return` when a caller or a stored case would break.
