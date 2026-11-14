/** What the agent runs before it hands over; the one copy of this rule. */
export const NEAR_TESTS_RULE =
  "Run the tests closest to the change: the spec files of the changed code and the ones that import it. Before ending the turn, let the project's formatter fix the files you changed (for example prettier --write on those files). Do not run the project's check commands: the checks step runs all of them right after. The one exception is a command that came back red: run it again until it passes.";

/** The skill line that stands for the rule. */
export const NEAR_TESTS_MARK = '[near tests rule]';
