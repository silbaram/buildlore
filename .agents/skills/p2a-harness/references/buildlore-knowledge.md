## BuildLore Knowledge Retrieval

BuildLore is an optional local-first, Git-backed knowledge source. Use it when `.plan2agent/project.config.json` has `buildlore.enabled: true`, a knowledge workspace or legacy repository is configured for the same project, and prior knowledge is material to the current Gate.

Read bounded, project-scoped memory:

```bash
p2a buildlore memory \
  --project <project_id> \
  --task "<current planning question>" \
  --progressive \
  --json
```

Use `p2a buildlore lookup --project <project_id> --kind evidence --id <canonical-id> --expect-generation <returned-generation> --json` for a needed source from the returned registry. Short aliases are not canonical IDs. Keep subsequent reads in the same generation. Connected search supports lexical mode; do not force the legacy hybrid default. Do not scan other project workspaces to emulate cross-project recall.

Inspect relevant matches instead of treating retrieval as approval or fact. When BuildLore affects a decision, record the query, requested and effective mode, fallback, knowledge revision, source reference, and concrete planning effect as `LOCAL-n` evidence.

BuildLore synchronization is a separate explicit operation. Planning may recommend `p2a buildlore sync --dry-run`, but must not apply sync, compile, commit, push, or parent-submodule pin operations without authority for that write. Missing BuildLore, provider fallback, or an empty result does not block Gate A/B unless the user explicitly requires historical knowledge.

`iteration close` does not automatically synchronize or publish BuildLore.
