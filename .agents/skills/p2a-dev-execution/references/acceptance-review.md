# Functional acceptance review

Read this reference only when `reviewPasses.acceptance` is `on`, when an independent acceptance pass was explicitly requested under `opt_in`, or when resuming an existing acceptance run. Do not use it for an envelope with a required visual contract.

After all iteration work is done and integrated, run `p2a execute accept --artifacts <artifact-root> --agent-tool <reviewer>`. This creates one `final_acceptance_review` run in the canonical workspace with `isolation.mode: none`, no changed files, and criteria derived from Gate B `product.core_flows` and `product.success_criteria`.

The owner executes behavior commands with `p2a runs verify --run-id <id> --artifacts <root> --verify-command 'custom:<command>'`. Invoke `p2a-acceptance-reviewer` only for this activated pass and save its `p2a.acceptance_review.v1` sidecar as `<runId>.acceptance-review.json`. Every case must copy an executed command, `source: command|config`, integer `exitCode`, and `stdoutTail` from the run. Manual or unexecuted evidence is invalid, and exit zero with empty or irrelevant output does not prove behavior.

Finish requires complete coverage and `confirm_behavior`, then seals the sidecar and canonical workspace hashes. Later workspace changes require a new review. A blocked review reopens its remediation owner.
