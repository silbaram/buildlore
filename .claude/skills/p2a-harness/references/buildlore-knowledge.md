## BuildLore Knowledge Retrieval

BuildLore is an optional local-first, Git-backed knowledge source. Use it only when `.plan2agent/project.config.json` has `buildlore.enabled: true`, the project is registered in the attached `knowledge/` repository, and prior project knowledge is material to the current Gate.

Search remains explicit and project-scoped:

```bash
p2a buildlore search \
  --project <project_id> \
  --query "<current planning question>" \
  --mode hybrid \
  --json
```

Use `p2a buildlore context --project <project_id> --prompt "<planning task>" --json` when bounded implementation context is more useful than search results. Do not scan other project workspaces to emulate cross-project recall.

Inspect relevant matches instead of treating retrieval as approval or fact. When BuildLore affects a decision, record the query, requested and effective mode, fallback, knowledge revision, source reference, and concrete planning effect as `LOCAL-n` evidence.

BuildLore synchronization is a separate explicit operation. Planning may recommend `p2a buildlore sync --dry-run`, but must not apply sync, compile, commit, push, or parent-submodule pin operations without authority for that write. Missing BuildLore, provider fallback, or an empty result does not block Gate A/B unless the user explicitly requires historical knowledge.

`iteration close` does not automatically synchronize or publish BuildLore.
