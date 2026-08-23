# ADR 0003: Knowledge tracking policy v1

Status: accepted for the v11 implementation

## Decision

BuildLore publishes knowledge files through the canonical
`buildlore.knowledge-tracking-policy.v1` contract. Every repository-relative path must
match exactly one ordered entry and therefore exactly one of `always-track`,
`policy-track`, or `always-ignore`. Zero matches fail with
`TRACKING_PATH_UNCLASSIFIED`; multiple matches fail with `TRACKING_PATH_AMBIGUOUS`.
Neither failure expands the allowlist. `policy-track` is excluded unless the reviewed
publish input explicitly enables it; the flag is part of the later publish-plan digest.

The policy is bound to `llm-wiki-compiler` version `1.1.0`, npm integrity
`sha512-LJslVmSt8tng8n3t0tw1QEqZJKKD0ualJ/WupdZMCtCzmCNarkP999k6hiNIg5ezvE8B/JQ1C1bUi6eY88Q79A==`,
and upstream commit `6963a7f8374282de5d4084a324be69b50f62a32d`. The checked-in executable
inventory fixture records each public operation family and the package source file that
establishes it. Its canonical digest is embedded in the policy; package, version,
integrity, commit, inventory, or policy digest drift fails closed.

Patterns below are knowledge-repository-relative. `*` matches one path segment and
`**` matches zero or more segments. `sources/` remains flat by contract.

## Always-track inventory

| Family | Canonical pattern | Reason |
| --- | --- | --- |
| Repository safety | `.gitignore` | Reviewable ignore boundary required by every clone. |
| Registry | `manifest.json` | Canonical project registry; registration changes require their separate proof. |
| Project descriptor | `projects/*/project.json` | Portable project and lineage binding. |
| Security policy | `projects/*/security-policy.json` | Project classification and egress contract. |
| Lifecycle source | `projects/*/profile.json` | Canonical language-neutral profile. |
| Sanitized source | `projects/*/sources/*.md` | Authoritative compiler input; nested source directories remain invalid. |
| Materialized profile/config/schema | `projects/*/.llmwiki/profile.json`, `projects/*/.llmwiki/config.json`, `projects/*/.llmwiki/schema.json` | Applied, reviewable compiler contracts. |
| Incremental state | `projects/*/.llmwiki/state.json`, `projects/*/.llmwiki/rule-state.json` | Required to continue incremental work without recompiling all sources. |
| Template identity | `projects/*/.llmwiki/template-lock.json` | Applied template provenance and continuity. |
| Safe embedding lineage | `projects/*/.llmwiki/buildlore-embedding-identity.json` | Credential-free compatibility identity; it never proves cache presence. |
| Compiled pages | `projects/*/wiki/*/*.md` | Portable generated or trusted typed pages, including concepts and saved queries. |
| Generated navigation | `projects/*/wiki/index.md`, `projects/*/wiki/MOC.md` | Portable deterministic compiler output. |
| Workflow projection | `projects/*/wiki/outputs/workflows/**/*.md` | Derived portable projection, not workflow authority. |
| Relation graph | `projects/*/wiki/graph/relations.jsonl` | Portable typed relation state. |
| Declared artifacts | `projects/*/artifacts/*/*/*` | Hash-bound profile artifacts and sidecars. |
| Evaluation config | `projects/*/.llmwiki/eval/thresholds.yaml` | Applied quality threshold contract. |
| Activity lineage | `projects/*/log.md` | Bounded operation lineage; staged bytes still pass the production sanitizer. |

## Policy-track inventory

| Family | Canonical pattern | Excluded-by-default reason |
| --- | --- | --- |
| Review candidates | `projects/*/.llmwiki/candidates/*.json` | Pending generated material requires explicit review. |
| Candidate archive | `projects/*/.llmwiki/candidates/archive/*.json` | Rejected material is audit history, not live knowledge. |
| Rule candidates | `projects/*/.llmwiki/rule-candidates/*.json` | Pending rule extraction requires explicit review. |
| Rule archive | `projects/*/.llmwiki/rule-candidates/archive/*.json` | Rejected rule history is optional audit material. |
| Workflow runs | `projects/*/.llmwiki/workflows/runs/*.json` | Run inputs/events can be noisy and conflict-prone. |
| Evaluation history | `projects/*/.llmwiki/eval/history.jsonl` | Historical samples are optional and merge-prone. |
| Event audit pair | `projects/*/wiki/graph/events.jsonl` plus `projects/*/.llmwiki/events.head` | The append-only event log and sealed head must be reviewed and selected together. |

The later publication planner must reject a plan that selects only one member of the
event audit pair.

## Always-ignore inventory

| Family | Canonical pattern | Exclusion reason |
| --- | --- | --- |
| Environment | `**/.env*` | May hold credentials or endpoints. |
| Credential/private authority names | `**/*credential*`, `**/*.key`, `**/*.pem` | Secret or signing authority must never enter knowledge Git. |
| Compiler, registry, and other writer locks | `projects/*/.llmwiki/lock`, `**/*.lock` | Machine ownership state is ephemeral. |
| Mutation journal | `projects/*/.llmwiki/journal/*.json`, `projects/*/.llmwiki/journal/quarantine/*.json` | Crash-recovery state is machine-local and must not be merged. |
| Workflow run key | `projects/*/.llmwiki/workflows/.runkey` | Private integrity authority. |
| Embedding cache and pending marker | `projects/*/.llmwiki/embeddings.json`, `projects/*/.llmwiki/embeddings/**`, `projects/*/.llmwiki/pending-embeddings.json` | Provider/model-bound cache and incomplete-refresh state are safely regenerated. |
| Lint/evaluation cache | `projects/*/.llmwiki/last-lint.json`, `projects/*/.llmwiki/eval/citation-cache.jsonl` | Machine-local derived results. |
| Connector rate cache | `projects/*/.llmwiki/connectors/*.last-fetch.json` | Machine-local request timing state. |
| Export output | `projects/*/dist/exports/**` | On-demand output regenerated from tracked state. |
| Atomic temporary/backup | `**/*.tmp`, `**/*.bak` | Incomplete or recovery bytes are not durable contracts. |

An already tracked or staged always-ignore path is a policy violation. Publication does
not automatically remove, reset, or untrack it.

## Fresh-clone and semantic-cache behavior

A default-tracked clone contains sanitized sources, portable Wiki output, profile/config,
incremental state, and safe lineage. It can compare new sources with the tracked
`.llmwiki/state.json`, compile only the delta, and recreate `.llmwiki/embeddings.json`.
The embedding identity marker remains tracked because it is safe review metadata, but a
marker without the ignored cache is `embedding-cache-missing`, never compatible semantic
state. Retrieval must use its existing explicit unavailable/outdated behavior until a
successful compile rebuilds the cache.

## Evidence and consequences

`test/fixtures/tracking-policy/llm-wiki-compiler-1.1.0-inventory.json` is the canonical
executable inventory. Tests validate every fixture path against exactly one policy entry,
check the installed package/lock integrity, reject unknown/ambiguous/canonical-byte drift,
and perform an offline fake-provider incremental compile from a default-tracked snapshot.

No runtime dependency, compiler fork, copied upstream implementation, private/deep import,
server, database, or daemon is introduced. Upstream source-map paths are recorded only as
bounded package-relative evidence strings; production code consumes only the package-root
public SDK elsewhere in the existing compiler adapter.
