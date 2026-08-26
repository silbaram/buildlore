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

The CLI writes one synthetic compatibility work item and validates Gate C readiness. Do not add another human Gate C approval. If adaptive inspection selects `orchestrated`, invoke `p2a-task-breakdown` and continue from its validated graph.

## Inspect readiness and retry evidence

Use the same ready snapshot and read the Gate-derived execution envelope before task prose:

```bash
p2a tasks ready --artifacts <dir>
```

The envelope source hash, objective, scope, `mustPreserve`, non-goals, acceptance, verification, authority, and visual contract are canonical. The work item is only an ownership and recovery boundary.

For a retry whose latest run is `failed` or `blocked`, inspect that local run's failure class, localization, and verification evidence before starting. If already-committed BuildLore knowledge is materially relevant, one explicit same-project search may supplement that evidence; apply only a clearly similar mitigation and cite the inspected knowledge source in the run notes. Do not synchronize, compile, commit, or publish BuildLore as an implicit retry step.

Do not query BuildLore for a normal first attempt. Unavailable, empty, or fallback retrieval is not a blocker unless the approved contract explicitly requires historical knowledge.

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

Before editing, inventory the source baseline and unrelated user changes. If pre-existing untracked files make `--collect-git` ambiguous, record the inventory and pass exact task-owned `--changed-file` values at finish.

The current owner implements Direct and ordinary single-owner Planned work. Spawn `p2a-implementer` only when an independently confined owner materially helps Orchestrated/batch work or explicit context isolation. A spawned implementer edits only its scope and may run local checks, but lifecycle verification and finish remain with the owner.

Own the envelope objective, inspect the repository, choose internal structure, implement, run checks, and correct ordinary code/test/UI drift without asking the user to choose implementation details. Return to Gate B only when the objective requires changing product meaning, acceptance, approved scope, constitution, or an external authorization boundary.
