## Planning Memory Recall

For an iterative artifact root with at least one closed iteration, use Memory recall only when `.plan2agent/project.config.json` has `memory.enabled: true` and the configured server URL or `serverUrlEnv` value is available. Do not read `.env` files to discover connection values. Record recall state as `not_configured`, `pending`, `succeeded`, `fallback`, `failed`, or `skipped` in `iteration.json`; Memory being optional never permits a false claim that history was checked.

Before writing the Gate A analysis:

1. Run one same-project hybrid search using the change idea and save the report under the new iteration:

   ```bash
   p2a memory search \
     --project <project_id> \
     --mode hybrid \
     --query "<change idea>" \
     --output .plan2agent/artifacts/<project_id>/iterations/<iteration_id>/gate-a-intake/memory-recall.json
   ```

2. If the idea touches a reusable architecture, protocol, migration, authentication/security, external integration, data/storage, queue, performance, reliability, incident, or failure-handling concern, run a second cross-project search. Exclude the current project and persist a separate report:

   ```bash
   p2a memory search \
     --global \
     --exclude-project <project_id> \
     --mode hybrid \
     --query "<change idea>" \
     --output .plan2agent/artifacts/<project_id>/iterations/<iteration_id>/gate-a-intake/memory-recall-cross-project.json
   ```

   Skip this layer for ordinary project-local wording; do not run global recall mechanically.
3. Inspect relevant matches instead of treating retrieval as approval or fact. When a result identifies a decision natural key, use project-scoped `memory precedent`, `memory impact`, or `memory trace` to inspect its downstream outcomes and lineage.
4. Consume the saved reports before drafting Gate A/B. Add each consumed report as `LOCAL-n` evidence and record the query, requested/effective mode, fallback, and actual source path, source reference, or natural key in `used_for`. A report may be retained as `context` without adopting its recommendation.

Before Gate B technology reconnaissance, run one additional targeted hybrid search only when architecture, dependencies, protocols, or external integrations need historical grounding and the Gate A report does not already answer the question. Preserve the same report-and-citation contract; do not repeat an equivalent query merely to satisfy the procedure.

Treat Memory as optional supporting evidence:

- If semantic or hybrid retrieval falls back to keyword successfully, continue and record the fallback shown in the report.
- If the configured Memory server is unavailable and keyword fallback also fails, preserve the failure report, tell the user that historical Memory evidence was not consulted, and continue without claiming that no prior history exists.
- If a pending report was not produced before drafting, record `skipped` rather than silently treating recall as successful.
- Stop for recovery only when the user explicitly requires Memory history before planning. On resume, restart at recall and preserve already-written upstream artifacts instead of regenerating them.

`iteration close` automatically runs a bounded, read-only `memory status --output <closed-iteration>/memory-status.json` check when Memory is configured. Preserve archive completion if the server is unavailable, but emit a prominent warning that sync was not verified, persist `unavailable`, and never claim historical coverage. Also present a non-mutating `memory push --dry-run` preview. Actual push remains an explicit external write requiring user approval and `--yes`; after an approved push, rerun the recorded status command. On the next `iteration open`, carry `fresh`, `stale`, `unavailable`, or `unchecked` into `planning_memory.baseline_freshness`.

