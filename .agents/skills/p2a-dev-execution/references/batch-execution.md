## Supervised Batch Owner Procedure

Batch mode wraps the single-work-item lifecycle; it does not create a batch run, change schemas, or delegate lifecycle ownership. Each work item keeps its own run id, worktree, Gate-derived execution envelope, verification evidence, and finish. Monitor evidence and retrospective handling remain conditional on their normal activation rules.

### 1. Freeze one ready snapshot and select a bounded batch

Run `p2a tasks ready` once and freeze that result as the current ready snapshot. Select at most the user-approved concurrency limit and never add tasks that become ready while the batch is running. Because ready tasks already have every declared dependency in `done`, no selected task can directly depend on another selected task.

Before starting, inspect task descriptions, target areas, acceptance criteria, and known implementation surfaces. Remove tasks from the batch, or reduce concurrency to one, when they are likely to overlap on the same files, shared configuration, database schema, generated artifacts, API contracts, or another integration-sensitive resource. Worktrees isolate edits; they do not eliminate integration conflicts or hidden semantic dependencies.

Establish a committed `batchBase`, a user-approved canonical integration branch/worktree, and a fresh owner-only integration-candidate worktree/branch strategy. Do not use a dirty user checkout as either integration target. The canonical integration branch is the only base that may open the next dependency batch; a task worktree or integration candidate by itself is never canonical.

### 2. Start every run serially

The main dev-execution owner calls `p2a execute start` once per selected task, one at a time. Use a fresh worktree and branch for each task and pass the same committed `--base-ref <batch-base>`:

```bash
p2a execute start \
  --artifacts <dir> \
  --task <task-id> \
  --agent-tool codex \
  --isolation worktree \
  --worktree <fresh-task-worktree> \
  --base-ref <batch-base> \
  --create-isolation
```

Maintain an owner-side mapping for `taskId`, `runId`, `branch`, `worktree`, `baseRef`, and implementer. Do not spawn an implementer when its start failed. A failed start does not require canceling runs that were already started for other independent tasks.

Only the main owner may call `p2a execute start`, `p2a runs record|verify|finish`, `p2a execute finish`, or `p2a tasks done|block`. This remains true even when lifecycle CLIs are internally lock-safe.

### 3. Spawn implementations in parallel

After the selected runs have started, spawn one `p2a-implementer` per task inside its assigned worktree, up to the available confined concurrency limit. Pass each implementer its Gate-derived execution envelope, current work-item boundary, constitution, run identity, and worktree boundary.

Each implementer performs scoped file edits and optional local self-checks only. It must return changed files, checks, results, and blockers to the main owner. It must not edit planning artifacts, harness files, another worktree, the canonical integration worktree, or lifecycle state. Agent completion order does not control harvest order.

### 4. Harvest and integrate one task at a time

The main owner harvests one completed result at a time:

1. Inspect the task worktree diff and reject scope drift or boundary violations.
2. Freeze the task-specific changed-file list before creating a commit or patch. Do not attribute the cumulative integration worktree status to one task.
3. Materialize a reproducible task-scoped commit or patch under main-owner control.
4. Apply it to an integration candidate based on the latest canonical integration head. Do not auto-resolve conflicts and do not advance the canonical integration branch yet.
5. Run configured or explicit verification against the integrated candidate. Task-worktree self-checks do not replace integrated-state verification.
6. Record the exact task changed files and an `INTEGRATION:` run note containing the candidate base, integrated commit or patch identity, and verification workspace. When verification runs outside the original task worktree, pass `--workspace <integration-candidate>` explicitly.
7. Run the single monitor gate against the work-item evidence and integrated candidate when it applies; it owns constitution architecture, stack, prohibition, and style review.
8. Advance the canonical integration branch only after the candidate is conflict-free, required verification passed, and required monitor evidence accepts it.
9. Only after the canonical integration branch contains the accepted task result, call `p2a execute finish` and allow the task to transition to `done`.

In batch mode, do not rely on `--collect-git` from the cumulative integration worktree for task attribution. Record the frozen task-specific changed files explicitly. A clean integration worktree after committing is valid when the run already contains the correct changed-file evidence.

If spawn, scope review, integration, verification, or a required monitor gate fails, do not advance the canonical integration branch for that task and do not mark it `done`. Close it through the existing structured `failed` or `blocked` contract when the cause is known, or keep it active when user input is required before a truthful close. Other independent task results may continue through serial harvest.

### 5. Recompute ready only after the batch harvest

After every selected task has been harvested or given a truthful non-done disposition, run `p2a tasks ready` again. Start the next batch from the latest canonical integration head. A dependent task must not start from its predecessor's isolated task branch or from the old batch base.

Do not produce new style or milestone sidecars. Historical sidecars remain readable, while integrated verification plus any activated acceptance or required visual contract provide the active completion evidence.

### 6. Preserve recoverability and clean up safely

Never force-remove a dirty, unmerged, failed, or blocked task or integration-candidate worktree. An accepted task or integration-candidate worktree becomes a cleanup candidate only after its task result is durably present on the canonical integration branch and its run evidence contains the recovery references. A failed or blocked integration candidate remains recoverable until the user explicitly chooses a cleanup path. Cleanup still requires explicit user confirmation or an already approved project cleanup policy.

Do not use destructive reset, forced branch movement, automatic conflict resolution, remote push, PR creation, or remote merge as part of this batch procedure.
