# V11 knowledge publication acceptance evidence

This mapping names executable repository evidence. A locator uses the checked-in test
file and its exact test title; none of the entries below is a placeholder or a future
plan.

## Product criteria and primary verification

| Product | Verification | Executable evidence locator |
| --- | --- | --- |
| V11-P-01 | V11-V-01 | `test/knowledge-tracking-policy.test.ts :: [V11-V-01][V11-P-01] binds the executable 1.1.0 inventory to exact package evidence` |
| V11-P-02 | V11-V-02 | `test/knowledge-tracking-fresh-clone.test.ts :: [V11-V-02][V11-P-02] continues incremental compile and regenerates ignored caches` |
| V11-P-03 | V11-V-03 | `test/knowledge-publication.test.ts :: blocks a foreign staged entry before publisher mutation`; `test/knowledge-publication.test.ts :: preserves foreign unstaged and untracked bytes, index entries, and status across commit` |
| V11-P-04 | V11-V-04 | `test/knowledge-publication.test.ts :: accepts only one canonical same-project registration manifest delta`; `test/knowledge-publication-push.test.ts :: rejects a forged registration delta that also changes another project entry` |
| V11-P-05 | V11-V-05 | `test/knowledge-publication.test.ts :: blocks a foreign staged entry before publisher mutation`; `test/knowledge-publication.test.ts :: revalidates %s drift after beforeAdd and performs zero add calls` |
| V11-P-06 | V11-V-06 | `test/knowledge-publication.test.ts :: rejects symlink leaves without leaking their target`; `test/knowledge-publication.test.ts :: rejects an injected cached mode %s before tree or commit creation`; `test/knowledge-publication.test.ts :: rejects an unexpected staged path injected after add without writing a commit` |
| V11-P-07 | V11-V-07 | `test/cli-workflow.test.ts :: runs the credential-free empty non-Git workflow, proves sync dry-run byte and Git invariance without compiler or provider calls, and completes init through query`; `test/knowledge-parent-pin.test.ts :: keeps plan mutation-free and durably commits exactly one knowledge gitlink` |
| V11-P-08 | V11-V-08 | `test/knowledge-publication.test.ts :: [V11-V-08][V11-P-08] returns a bounded busy loser while one publisher owns the common-dir lease` |
| V11-P-09 | V11-V-09 | `test/repository-writer-lease.test.ts :: keeps compiler, manifest, and repository mutation locks independent` |
| V11-P-10 | V11-V-10 | `test/compiler-capabilities.test.ts :: serializes operations for the same project across adapter instances`; `test/compiler-capabilities.test.ts :: does not serialize independent project workspaces`; `test/compiler-language-isolation.test.ts :: serializes ko, en, and legacy default operations across compiler instances`; `test/repository-writer-lease.test.ts :: allows independent common directories to hold Git mutation leases concurrently` |
| V11-P-11 | V11-V-11 | `test/knowledge-publication.test.ts :: is deterministic and mutation-free while separating stable foreign changes`; `test/knowledge-publication.test.ts :: creates one local plumbing commit without push or parent pin side effects` |
| V11-P-12 | V11-V-12 | `test/knowledge-publication-push.test.ts :: blocks remote-ahead and diverged histories before push`; `test/knowledge-publication-push.test.ts :: detects a remote preflight race before invoking a branch-changing push`; `test/knowledge-publication-push.test.ts :: returns a recoverable push-failed result after receive rejection` |
| V11-P-13 | V11-V-13 | `test/knowledge-parent-pin.test.ts :: keeps plan mutation-free and durably commits exactly one knowledge gitlink`; `test/knowledge-parent-pin.test.ts :: revalidates an idempotent no-op under canonical dual locks with zero Git mutation` |
| V11-P-14 | V11-V-14 | `test/knowledge-parent-pin.test.ts :: keeps plan mutation-free and durably commits exactly one knowledge gitlink`; `test/cli-publication-lineage.test.ts :: binds parent HEAD, configured profile/embedding, and ordered unique compile-time stamps` |
| V11-P-15 | V11-V-15 | `test/knowledge-parent-pin.test.ts :: [V11-V-15] keeps private byte sentinels out of every publication evidence surface`; `test/knowledge-publication.test.ts :: uses the production sanitizer to block a synthetic staged credential without reflecting it`; `test/cli-publication-lineage.test.ts :: fails closed for empty, missing, or unsafe stamps without reflecting them`; `test/repository-writer-lease.test.ts :: never takes over a stale lease and does not expose its path or contents` |
| V11-P-16 | V11-V-16 | Task-007 closeout command record below; `test/package-contract.test.ts :: pins the approved runtime and development toolchain exactly`; `test/installed-cli.test.ts :: executes through a package-style bin link` |

## Additional verification criteria

| Verification | Executable evidence locator |
| --- | --- |
| V11-V-17 | `test/knowledge-publication-acceptance.test.ts :: [V11-V-17] maps every V11 product and verification criterion to executable evidence` |
| V11-V-18 | `test/knowledge-tracking-policy.test.ts :: [V11-V-18] rejects duplicate/unknown keys, version/digest drift, order, and canonical byte drift`; `test/knowledge-publication-codec.test.ts :: [V11-V-18] rejects version, OID, digest, bounds, BOM, UTF-8, and LF drift in publish plans`; `test/knowledge-parent-pin-codec.test.ts :: rejects unknown, duplicate, shuffled, wrong-version, bounds, OID, and LF negatives` |
| V11-V-19 | `test/git-machine.test.ts :: preserves hostile paths and consumes rename records by NUL ordering`; `test/git-machine.test.ts :: uses exact Buffer pathspecs and plumbing for hostile paths without shell interpretation`; `test/git-machine.test.ts :: rejects NUL pathspec framing without invoking a partial add` |
| V11-V-20 | `test/knowledge-publication.test.ts :: records bounded recovery semantics for a %s phase fault` |
| V11-V-21 | `test/knowledge-parent-pin.test.ts :: preserves a single staged gitlink after %s failure`; `test/knowledge-parent-pin.test.ts :: reports ref-updated post-verification failure without parent push or cleanup` |
| V11-V-22 | `test/cli-workflow.test.ts :: binds explicit publish and pin commands and presents canonical outcomes with stable exits`; `test/cli-presentation.test.ts :: renders the fixed JSON envelope and one trailing LF` |
| V11-V-23 | `test/package-contract.test.ts :: [V11-V-23] forbids Git authority, unsafe commands, services, and dependency expansion outside knowledge` |
| V11-V-24 | `test/knowledge-publication-acceptance.test.ts :: [V11-V-24] keeps Git publication fixtures local, isolated, and provider-free` |

## Task-007 closeout command record

Run `run-2026-08-22T10-04-48-445Z-task-007` executed the repository-required local
verification set against the task-007 workspace. The owner records the same commands in
the Plan2Agent verification lifecycle before finish.

| Command | Local result |
| --- | --- |
| `npm run build` | pass |
| `npm test` | pass, 51 files and 411 tests outside the restricted listener sandbox |
| `npm run lint` | pass, zero warnings |
| `npm run typecheck` | pass |
| `p2a doctor --target . --dev` | pass, 23 checks |
| `p2a validate --entry plans/entries/github-issue-11.md` | pass |
| `git diff --check` | pass |
