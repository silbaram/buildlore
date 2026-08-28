# Observed issue

- Plan2Agent detected three failed runs and six retry attempts during the issue #31 iteration.
- One directly observed final-verification attempt recorded `unavailable` evidence after the restricted sandbox returned `EPERM` before `npm test`, lint, or typecheck started. Because run evidence is immutable, the later successful execution could not repair that run and a fresh remediation and final-verification cycle was required.
- Product verification ultimately passed: the independent acceptance review confirmed all 50 criteria, and the fresh final run passed 62 test files and 654 tests plus lint and typecheck.

# User impact

- An environment-only launcher failure looked like a failed development run even though no product code correction was needed.
- Repeating the five milestone checks and final verification increased turnaround time and made it harder to distinguish product defects from Plan2Agent execution-environment failures.

# Suggested improvement

- Before creating immutable milestone or final-verification evidence, preflight whether the configured launcher can start a minimal child process with the required authority.
- Classify a command that never started as an environment preflight failure and route directly to a fresh evidence run without reopening the completed implementation task when the workspace revision is unchanged.
- Include the concrete failed run identifiers in retrospective candidates so aggregate failure and retry counts can be traced without manually reconstructing run history.
