# Execution Preparation and Lifecycle

Read the relevant section when preparing Direct/Planned execution or starting/resuming a single-owner run.

## Adaptive preparation

When `--prepare-mode` is present and Gate C is absent, inspect the approved Gate B envelope, repository topology, existing verification commands, external boundaries, and likely recovery surface. Select the mode as an implementation decision:

- `direct`: one owner, localized change, low uncertainty, no risky external side effect, and one bounded verification cycle.
- `planned`: one owner, but two to five ordered, resume-safe checkpoints materially improve recovery.
- `orchestrated`: independent owners, meaningful parallelism, high coordination or isolation needs, or a dependency graph materially improves recovery.

`--prepare-mode direct|planned` fixes the permitted mode. `--prepare-mode adaptive` allows all three. Record a concise evidence-based rationale.

Direct preparation:

```bash
p2a execute prepare --artifacts <dir> --mode direct \
  --selection-rationale '<why one bounded work item is sufficient>'
```

Planned preparation declares two to five ordered checkpoints with observable outcomes and executable commands:

```bash
p2a execute prepare --artifacts <dir> --mode planned \
  --selection-rationale '<why ordered checkpoints improve recovery>' \
  --milestone 'milestone-1|<observable outcome>|<verification command>' \
  --milestone 'milestone-2|<observable outcome>|<verification command>'
```

The CLI writes one synthetic compatibility work item and validates Gate C readiness. Do not add another human Gate C approval. If adaptive inspection selects `orchestrated`, continue with `p2a-task-author --artifacts <dir>` for an active iteration, or the `p2a-task-breakdown --artifacts <dir>` compatibility entry for a flat root. Continue execution only after that owner persists and validates the graph.

## Inspect readiness and retry evidence

Use the same ready snapshot and read the Gate-derived execution envelope before task prose:

```bash
p2a tasks ready --artifacts <dir>
```

The envelope source hash, objective, scope, `mustPreserve`, non-goals, `iterationConstraints`, acceptance, verification, authority, and visual contract are canonical. Apply the current iteration's architecture, interface, and dependency constraints even when the project has no constitution. The work item is only an ownership and recovery boundary.

For a retry whose latest run is `failed` or `blocked`, inspect that local run's failure class, localization, and verification evidence before starting. Relevant project memory may supplement that evidence, not replace it; apply only a clearly similar mitigation and keep its inspected source reference in existing run notes.

## Optional project memory

When `buildlore.enabled` is true in project configuration and memory is relevant to the task, a first attempt may read it too. At start, resume, or a meaningful direction change, make one bounded `p2a buildlore memory --task '<current goal>' --progressive --json` query. Reuse what was already read. For a needed source, use `p2a buildlore lookup --kind evidence --id <canonical-id> --expect-generation <returned-generation> --json`; use the canonical ID from the memory registry, not its short alias. Do not repeatedly poll for more knowledge during ordinary edits.

Keep retrieval within the current project. Check the returned project, generation, and available source digests; do not mix generations or quietly replace the active execution baseline when newer memory arrives. `sourceRevision` identifies source evidence, `codeRevision` identifies the recorded verification target, and `repositoryRevision` is an observed repository HEAD. Source revision or HEAD alone does not prove code was verified. Missing verification targets, revision mismatches, and dirty working-tree changes mean historical or unconfirmed evidence, not proof of current behavior.

Missing configuration, unavailable/offline storage, empty results, stale generations, or timeouts are advisory fallback outcomes: continue from current code, the latest user request, and the approved contract. If historical knowledge is explicitly required by that contract, report the unmet requirement through the existing boundary. Retrieval never implicitly authorizes synchronization, AI generation, compilation, approval, commit, publication, or other knowledge writes. A past Wiki decision does not grant new execution authority.

## Progress and direction advice

Explain the current goal and immediate next action when starting or resuming needs context. Update the user when a usable outcome is implemented or verified, a consequential design choice or new fact appears, failures repeat, scope grows, or the user asks about status. Usually two to four sentences and one important concern are enough. Follow the host's progress-update cadence without creating a report for every edit or tool call.

Distinguish four inputs instead of blending them into certainty:

- Current intent: the latest user request and choices, interpreted with the active execution contract.
- Current facts: inspected code and diff, commands actually run, their results, and what is still unchecked.
- Previous memory: recorded decisions, constraints, failed approaches, and their historical verification scope.
- Advice: inferred impact and a recommended next action, with uncertainty when evidence is incomplete.

Ask whether the change helps solve the current user problem. Unnecessary structure or dependencies, repeated fixes without testing the cause, or tests unlike real usage may justify a concern; file count, a revised plan, or disagreement with old Wiki prose alone does not establish drift. Explain **observation → impact on the goal → advice → next authorized action**. Advice alone does not mark work blocked or failed, create a new approval gate, start another reviewer, or require a report. Continue authorized development without waiting for a response; preserve real scope, verification, and external-authority boundaries.

Reflect the user's changed direction through the existing contract-update path when needed. If the user defers advice or chooses differently, remember that choice and do not repeat the same recommendation without new evidence or changed impact. Keep only resume-critical intent, deferred advice, and next action in existing notes, not additional progress/review/summary documents.

Describe progress in user-visible capabilities and verified scope, not percentages guessed from file or task counts. Test definitions are not executed evidence. At completion, separate implemented outcomes, actual verification, and unresolved issues; mention knowledge handoff or cleanup only when actually performed.

## Start or resume the run

Start through the execution lifecycle so run creation and task ownership change atomically:

```bash
p2a execute start --artifacts <dir> --task <id> --agent-tool codex
```

Preserve one run id across start retries. With `task-sequence`, omit `--run-id` only on the first start; if isolation setup fails, use the printed retry command with the same explicit id. Do not consume a new implicit attempt id.

Read `devExecution.reviewPasses.monitor` before start. Pass `--require-monitor` only when policy or the approved contract requires it. Let `runTracking.defaultIsolation` select the default. For a justified worktree use:

```bash
p2a execute start --artifacts <dir> --task <id> --agent-tool codex \
  --isolation worktree --worktree <fresh-worktree-path> --create-isolation
```

Use `p2a execute resume` for an existing open run. Resume, verify, checkpoint, and finish revalidate the recorded Gate B/Gate C contract. If the source changed or disappeared, restore an accidental change or close the stale run with structured failure evidence before approving replacement work.

## Implement

Use CLI-provided evidence paths first. Additional run reports belong in `<artifact-root>/evidence/<iteration-id>/<run-id>/report.md`, with optional `logs/` and `attachments/`; maintenance uses `maintenance`. Do not add topic/date folders at the artifact root. Keep one run across ordinary corrections and use unused attempt filenames such as `logs/test-02.log` to preserve earlier evidence.

Create temporary installs, source copies and package archives with unique task-owned directories under `.plan2agent/tmp/` inside the permitted workspace, or reuse an existing tool's OS-temp lifecycle. When copying sources, exclude the destination and `.plan2agent` to avoid recursive copies, and omit unneeded `.git`, `node_modules`, and build output. Temporary paths must not be the sole source of completion evidence.

Before editing, inventory the source baseline and unrelated user changes. If pre-existing untracked files make `--collect-git` ambiguous, record the inventory and pass exact task-owned `--changed-file` values at finish.

The current owner implements Direct and ordinary single-owner Planned work. Spawn `p2a-implementer` only when an independently confined owner materially helps Orchestrated/batch work or explicit context isolation. A spawned implementer edits only its scope and may run local checks, but lifecycle verification and finish remain with the owner.

Own the envelope objective, inspect the repository, choose internal structure, implement, run checks, and correct ordinary code/test/UI drift without asking the user to choose implementation details. Before finish, compare the implementation and changed dependencies/interfaces with `iterationConstraints`; a conflict is not a successful implementation even when commands pass. Return to Gate B only when the objective requires changing product meaning, acceptance, approved scope, an approved iteration constraint, or constitution. Handle external authorization through `provider-confinement.md` without product reapproval.
