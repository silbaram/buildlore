## Observed issue

The first planned checkpoint could not spawn `/bin/sh` in the workspace sandbox, even though the same focused test command passed when run directly. Because checkpoint failures are immutable, the run had to be ended and retried with the required permission.

## User impact

One failed execution run and one full-scope retry added workflow delay without revealing a product defect. The retried checkpoints and the final build, test, lint, typecheck, doctor, and entry validation all passed.

## Suggested improvement

Preflight checkpoint command execution under the active sandbox before recording the first checkpoint. If shell spawning is restricted, request the necessary permission before starting the immutable checkpoint attempt.
