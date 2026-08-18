# Verification and Closeout

Read this reference when the implementation outcome is ready for executable verification and run closeout.

## Executed verification

Use configured or explicit commands and record their real exit codes:

```bash
p2a runs verify --run-id <id> --artifacts <dir> --test --lint --typecheck
```

When config is empty and a real check is required, pass `--test-command`, `--lint-command`, or `--typecheck-command`. Supplemental checks use only `test`, `lint`, `typecheck`, or `custom`:

```bash
p2a runs verify --run-id <id> --artifacts <dir> \
  --verify-command 'custom:git diff --check'
```

Do not invent verification labels or use `source: manual`/`exitCode: null` as a substitute for execution. A failed or unavailable verification record is immutable; correct the problem and use a new retry run.

Shell composition must propagate every evidence-producing command's status. Avoid pipelines or command substitutions that can turn an unavailable command into a false pass. Preflight absolute executables with `test -x`, use a status-preserving wrapper, and inspect non-empty `stderrTail` before finish.

## Planned checkpoints

Verify declared milestones in order after their outcomes exist:

```bash
p2a runs checkpoint --run-id <id> --artifacts <dir> --milestone <milestone-id>
```

`p2a execute resume` reports the next pending checkpoint. A failed or unavailable checkpoint is immutable: finish that run as failed or blocked and start a retry instead of rerunning the milestone in the same run.

## Conditional reviews

- For UI/mixed work or an envelope with `visualContract`, follow `visual-evidence.md`.
- For acceptance policy `on`, explicit opt-in, or an already-started acceptance run, follow `acceptance-review.md` after non-visual work is integrated. A required visual contract replaces this non-visual review path.
- When the run was started with `--require-monitor`, follow `monitor-gate.md`. Ordinary runs do not load or invoke monitor protocol.

## Finish

Finish through the execution lifecycle and collect only attributable changes:

```bash
p2a execute finish --run-id <id> --artifacts <dir> \
  --status finished|failed|blocked --collect-git
```

Verification flags and explicit commands may be passed to `finish` instead of a separate verify call.

For `failed` or `blocked`, include a supported `--failure-class` and structured detail: at least one reproduction step or command, localization or file, and guard or guard note. Supported classes are `verification_failed`, `test_flake`, `scope_violation`, `missing_dependency`, `environment_failure`, `implementation_incomplete`, and `other`. Use `other` only with a note explaining why no specific class applies. Use `test_flake` only when the same check passes without code or environment changes.

If a monitor blocks the run, finish with monitor-sourced structured failure evidence; do not mark the task done directly.

## Output

Return:

- implemented change summary;
- exact `changedFiles`;
- verification commands and outcomes;
- recommended status: `done`, `blocked`, or keep active;
- for batch work, ready snapshot, task/run/worktree mapping, harvest disposition, and canonical integration ref.

## Retrospective

Run a retrospective only after a failed/blocked run, retry, explicit user correction, or repeated process defect. Report a reusable candidate, but write no proposal without separate approval. After approval, prefer `p2a proposals mine`. Proposal review and any patch remain separate, human-approved work.
