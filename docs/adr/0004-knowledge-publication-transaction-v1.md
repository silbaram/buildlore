# ADR 0004: Knowledge publication transaction v1

Status: accepted for the v11 implementation

## Decision

Knowledge publication is four explicit local-first operations: a mutation-free project
plan, a plan-digest-bound local knowledge commit, a separate non-force remote push, and
an iteration-close parent gitlink pin. No command combines commit, push, or parent pin,
and intermediate plan, commit, and push operations leave the parent repository unchanged.

The plan binds the selected project paths, clean index, knowledge HEAD, source and code
revisions, tracking policy, compiler/profile/model/prompt/embedding identity digests, and
foreign-change summary. Commit obtains the repository writer lease, recomputes the exact
plan, stages only literal reviewed paths, validates the cached diff and staged blobs,
then uses `write-tree`, `commit-tree`, and compare-and-swap `update-ref`. A dirty or
foreign staged index is a repository conflict and returns `PUBLISH_DIRTY_INDEX`; it is
never downgraded to a policy error.

Push obtains the same common-directory lease independently, proves the configured live
remote branch relation, and invokes one exact non-force ref update. It does not create a
missing branch or run pull, merge, rebase, stash, force, or force-with-lease. A rejected
push preserves both the local commit and prior remote revision for inspection.

Parent pin obtains parent and knowledge leases in canonical Git common-directory order,
revalidates reachability and lineage without fetching during plan, and commits exactly
the mode-160000 `knowledge` entry. It never pushes the parent repository. An already
pinned target is an idempotent no-op after locked revalidation.

Compiler `.llmwiki/lock`, registry `manifest.json.lock`, and repository writer lease are
independent authorities. A stale repository lease is inspection evidence and is never
automatically removed or taken over.

## Security and recovery

Public plans, results, CLI envelopes, recovery commands, and commit metadata contain
only bounded project-relative paths, object identifiers, canonical digests, counts, and
stable codes. They exclude credentials, remote locators, private paths, source bodies,
raw Git output, lock tokens, and stack traces. Plan and result codecs are strict,
versioned, canonical UTF-8 JSON with exactly one final line feed.

Before the first mutation, failures leave HEAD, index, worktree, remote, and parent
gitlink unchanged. After exact staging, BuildLore does not reset, stash, checkout, or
delete user state; partial results preserve the staged allowlist and provide
inspection-only recovery. After a ref update, post-verification failure reports the
resulting commit for safe reconciliation.

## Executable evidence

The complete requirement mapping is checked in at
`docs/acceptance/v11-knowledge-publication.md`. Its locators are validated by
`test/knowledge-publication-acceptance.test.ts`; local bare-remote, fault, codec,
presentation, security, and static-boundary behavior remains executable rather than a
planned-only checklist.
