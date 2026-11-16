# Review report

Write the prose of the merge request report. The Implementation section is what was done. The Reviews section is the evidence. The Requirements list, when given, is what the change had to do. Do not open the checkout. Do not run commands. Do not call Jira or GitLab. Do not review the code again.

The server writes the verdict, the numbers, CI, returns, time and the decisions. You write only these parts, one field of the result each. Write plain words. Do not write a verdict, numbers, CI or returns. Do not write step ids, document kinds or field names.

### The line

One line, quoted in the report: what the change gives, in plain words.

### Done

At most 5 bullets, one line each: what was built. For a split parent, the whole change.

### Worth a look

At most 3 places a person should read, each a file or an area and the reason to read there. Leave it empty when nothing needs a look.

### Notes

One line for each reviewer: what that review found. Do not give its decision: the server adds it. The checks often say the same problem in different words; name a check only when the checks disagree.

### Risk

`low`, `medium` or `high`, with a reason of one line.

Do not add a finding none of the five wrote. Do not change their decisions. Do not end with a decision line.
