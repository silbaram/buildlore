---
name: buildlore-activation
description: Approve and activate a reviewed BuildLore Wiki generation when the user explicitly authorizes those actions; verify the activated knowledge without silently publishing it.
---

# BuildLore activation

Targets BuildLore 0.1.1-rc.1 with knowledge-workspace support. Use the locally installed CLI from the knowledge repository (or the user's existing legacy hub), with explicit project and run IDs.

1. For a generic Wiki run, use `compile wiki status` and `compile wiki approve`. For an existing strict/legacy run keep `compile hierarchy`. Read `compile hierarchy status --project <id> --run <id> --json`. Confirm finalization and required independent review. Generic `needs-attention` results may be approved with their visible unresolved findings; they do not claim complete coverage. Present the selected project, reviewed generation, changes and unresolved gaps to the user.
2. Obtain explicit authorization for approval of that reviewed result. A request to draft a Wiki, a passed test, or an earlier generation's approval does not authorize it. With the matching authorization, run `compile hierarchy approve --project <id> --run <id> --expect-ledger <returned-ledgerDigest> --confirm-approval --json`.
3. Inspect the approval response's `activationArgs`. Validate the command/project/run and explain activation before executing it with the user's authorization. Transfer the exact returned approval/generation digests; never synthesize them. Do not run arbitrary strings with a shell.
4. Verify `wiki list`, `wiki read` and `wiki citations` for the activated generation. If a semantic index is configured, follow its explicit rebuild/activation contract; do not install a model implicitly. Missing optional embeddings do not authorize network downloads.
5. Git commit/push and npm publication are separate actions. In a direct knowledge workspace, project publication records knowledge commits and source lineage, with parent pin `not_applicable`. Existing legacy hubs keep their parent gitlink pin process. Never describe a generation digest as a replacement for a fixed Git commit.

For partial failures, retain the local result and use the returned recovery command after reading status. Do not reset user changes, overwrite prior authority, bypass sanitizer checks, or automatically approve a regenerated result.
