---
name: buildlore-authoring
description: Create or update project Wiki knowledge using the locally installed BuildLore CLI, including resumable authoring and independent review. Use in the knowledge repository when Wiki writing is requested.
---

# BuildLore authoring

Targets BuildLore 0.1.1-rc.1 with explicit knowledge-workspace support. Run from the knowledge Git checkout containing `.buildlore/workspace.json`, or an existing legacy hub. Use the installed `node node_modules/buildlore/dist/cli/bin.js` (an absolute bin path when needed). Check `--version` and `--help`; do not silently download an absent CLI or clone product source into the knowledge repository.

1. In a direct knowledge workspace, first run `workspace guide --project <id>` to identify missing configuration and the next command. It is read-only and does not infer approval or AI client readiness. New projects default to restricted classification with no external compilation permission; review the project security policy explicitly before authoring. Confirm the user-selected project using `project show --project <id> --json`. A missing binding needs an explicit source root and source manifest; never infer the project from a directory name. `workspace init` is for a cloned knowledge repository; it does not migrate an old hub.
2. Use `sync --project <id> --dry-run --json`, then apply the selected input with `sync --project <id> --json` when within the user's request. Suspected secrets stop the operation; do not copy rejected source into output or work around the sanitizer.
3. Start `compile hierarchy start --project <id> --purpose <relative-json-file> --json`. Prepare purpose input against the installed `buildlore/schemas/project-knowledge-workflow.schema.json`. Reuse an existing run with `compile hierarchy status --project <id> --run <id> --json` when resuming.
4. Read the returned exchange and follow its actual phase. Build proposals from the supplied sanitized evidence; retain unknowns, conflicts and history. Use `inspect` for bounded missing detail. Submit with the returned `exchangeDigest` as `--expect-exchange`, then request independent review. Reviewer identity must represent a real independent reviewer; changing an actor string is not independent review.
5. For completeness authoring, read [completeness.md](references/completeness.md). For other authoring modes, use `submit`/`resubmit` and `review`/`finalize` with the actual output digest. Published schemas are available through the installed package exports; use them instead of inventing JSON shapes.
6. Stop at a reviewed, finalized result ready for the user's approval. Follow [activation](../buildlore-activation/SKILL.md) when approval and activation are requested.

Keep the `--project` and run ID explicit. Parse JSON output and transfer the exact returned digest to the next command. Do not guess or recompute exchange, stage, review or ledger digests. After a stale-state error, re-read status and preserve the rejected attempt. Local inputs/run files belong in ignored `.buildlore/` state, not in the source repository or Git history. MCP is the reading interface; this skill does not add MCP writes or replace the server's reader guidance.
