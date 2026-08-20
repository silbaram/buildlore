# ADR 0001: BuildLore Lifecycle Profile v1

Status: accepted by Plan2Agent Gate B for `v7-lifecycle-profile`

BuildLore v0.1 promotes only `decision`, `failure`, and `verification` to first-class Wiki entities. `project`, `feature`, `task`, `run`, and `artifact` remain project workspace or SourceDocument lineage metadata because the approved fixtures do not demonstrate independent page-level retrieval value.

The only typed relations are directed `supersedes` (`decisions` → `decisions`) and `verified-by` (`decisions|failures` → `verifications`). Both are declared as `0..n` on each endpoint because llm-wiki-compiler 1.1.0 does not express global maximum cardinality. Lifecycle entry requirements enforce the supported minimum counts. `failed-by` is excluded because a failed verification already has an immutable `failed` state and evidence; adding a second relation would duplicate that fact. `implements` and `produced` lack approved first-class endpoints, while `belongs-to` duplicates the project workspace boundary.

Decision lifecycle is `active → superseded|archived` and `superseded → archived`. Failure lifecycle is `open → resolved → archived`. Verification lifecycle is `recorded → passed|failed → archived`; a rerun creates a new verification identity instead of mutating `failed` to `passed`.

Review holds use union semantics for missing or `< 0.5` confidence, contradiction, schema violation, and provenance violation. Stale and orphaned are freshness classifications, not lifecycle states. Archived pages remain historical and are excluded from active retrieval.

The project-local `profile.json` is the canonical language-neutral contract. `.llmwiki/profile.json` and `.llmwiki/config.json` are deterministic projections. Output language is limited to `en` and `ko`; language-sensitive upstream operations are serialized process-wide while the upstream SDK relies on `LLMWIKI_OUTPUT_LANG`.

Deferred: generic workflows/actions, artifacts, connectors, templates, arbitrary ontology editing, maximum-cardinality enforcement, process isolation, cross-project relations, and automatic migration/recompile/Git publication.
