# Verification and Closeout

Read this reference when the implementation outcome is ready for executable verification and run closeout.

## Executed verification

Use configured or explicit commands and record their real exit codes. With no flags, the CLI runs only the test/lint/typecheck commands actually configured for the project:

```bash
p2a runs verify --run-id <id> --artifacts <dir>
```

For code work, completion requires a current pass from every configured test/lint/typecheck command even when low-level lifecycle commands are used. Docs/metadata work instead requires one current relevant executed check.

When config is empty and a real check is required, pass `--test-command`, `--lint-command`, or `--typecheck-command`. Supplemental checks use only `test`, `lint`, `typecheck`, or `custom`:

```bash
p2a runs verify --run-id <id> --artifacts <dir> \
  --verify-command 'custom:git diff --check'
```

Do not invent verification labels or use `source: manual`/`exitCode: null` as a substitute for execution. Every attempt is append-only. After correcting code or the environment at the same revision, rerun the same check in the same started run; its latest decisive result controls completion while the earlier failure remains visible. After the workspace revision changes, an older failed command remains history but is not a current obligation unless that command is still configured or fails again at the current revision.

When a final verification or review command cannot start and the run cannot remain open for an immediate retry, finish that final run as `environment_failure`. The implementation task remains done and only final evidence is retried. Reopen implementation only when executed product behavior fails or the review finds a product defect.

A child-process spawn error is an environment failure even if the runtime reports exit status zero. Conversely, an executed verification recorded as `failed` always reopens implementation and must not be hidden by an `environment_failure` label.

A validated blocking visual or acceptance review is also a product failure and takes precedence over unrelated unavailable command evidence.

Shell composition must propagate every evidence-producing command's status. Avoid pipelines or command substitutions that can turn an unavailable command into a false pass. Preflight absolute executables with `test -x`, use a status-preserving wrapper, and inspect non-empty `stderrTail` before finish.

## Planned checkpoints

Verify declared milestones in order after their outcomes exist:

```bash
p2a runs checkpoint --run-id <id> --artifacts <dir> --milestone <milestone-id>
```

`p2a execute resume` reports the next pending checkpoint. A failed or unavailable attempt stays in evidence, but after correction the same milestone may be rerun in the same started run. The milestone becomes verified only when every declared command's latest current-revision attempt passes.

## Conditional reviews

- Optional closeout product review is read-only. Inspect the completed diff, code, tests, and existing current required verification evidence; do not rerun product commands solely because review was selected. A clean review asks once to close instead of repeating the choice menu. Remediation edits return through normal verification.
- For UI/mixed work or an envelope with `visualContract`, follow `visual-evidence.md`.
- For acceptance policy `on` with current-iteration behavior criteria, explicit opt-in, or an already-started acceptance run, follow `acceptance-review.md` after non-visual work is integrated. A valid current-iteration contract with no new behavior criteria skips this review, and a required visual contract replaces it.
- When the run was started with `--require-monitor`, follow `monitor-gate.md`. Ordinary runs do not load or invoke monitor protocol.

## Finish

Finish through the execution lifecycle and collect only attributable changes:

```bash
p2a execute finish --run-id <id> --artifacts <dir> \
  --status finished|failed|blocked --collect-git
```

Verification flags and explicit commands may be passed to `finish` instead of a separate verify call.

For `failed` or `blocked`, include a supported `--failure-class` and only that class's required detail. `verification_failed`, `scope_violation`, `implementation_incomplete`, and `other` require reproduction, localization, and a guard. `test_flake`, `missing_dependency`, and `environment_failure` require reproduction and a retry guard; command errors and retry conditions are collected automatically when evidence provides them. Supported classes are `verification_failed`, `test_flake`, `scope_violation`, `missing_dependency`, `environment_failure`, `implementation_incomplete`, and `other`. Use `other` only when no specific class applies. Use `test_flake` only when the same check passes without code or environment changes.

Iteration close evaluates two independent obligations. `product_full` is bound to the current product revision: isolated code may reuse a canonical implementation pass, while high-risk or multi-task/worktree integration requires a canonical final full run. `workspace_relevant` is bound to the current workspace revision. A full pass at that same workspace satisfies both; if only docs/metadata changes afterward, keep the product pass and run only `p2a execute verify-final --scope relevant --artifacts <dir>`. That relevant run must record an actually executed `scope: related` command. Use structured project `relatedVerification` when configured; otherwise P2A runs its packaged UTF-8/JSON/readability integrity check against the selected files. Any later product-file change invalidates the product pass and requires full verification again.

If a monitor blocks the run, finish with monitor-sourced structured failure evidence; do not mark the task done directly.

## Output

Return:

- implemented change summary;
- exact `changedFiles`;
- verification commands and outcomes;
- recommended status: `done`, `blocked`, or keep active;
- for batch work, ready snapshot, task/run/worktree mapping, harvest disposition, and canonical integration ref.

## Retrospective

Offer the retrospective after completion without making it mandatory. Detected failed/blocked runs, retries, explicit user corrections, or repeated process defects provide automatic candidates. When no candidate exists, continue only if the user explicitly selects retrospective and reports P2A delay, errors, wrong routing, or unnecessary steps; create nothing when they report none. Write no report or proposal without its separate approval. After proposal approval, prefer `p2a proposals mine`. Proposal review and any patch remain separate, human-approved work.
