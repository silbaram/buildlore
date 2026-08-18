# Monitor gate

Read this reference only for a run already started with `--require-monitor`. `reviewPasses.monitor: opt_in` uses that flag as the activation signal; `off` prevents new opt-ins.

Invoke `p2a-performance-monitor` as a separated read-only pass. Pass the task id, acceptance criteria, latest run log, complete `.monitor-gate.json`, every changed file, and the complete approved rule source bound by `ruleContract.ref` and `ruleContract.sha256`—normally `.plan2agent/constitution.json` or the legacy `.plan2agent/style.md`.

Write `<runId>.monitor-verdict.json` beside the run with this shape:

```json
{
  "verdict": "confirm_done",
  "rules_reviewed": [],
  "rule_concerns": [],
  "unmet_acceptance": [],
  "verification_concerns": [],
  "scope_concerns": [],
  "needs_user_decision": [],
  "note": ""
}
```

`rules_reviewed` must include every `ruleContract.ruleIds` value. Use `block` and the relevant concern arrays when acceptance should fail. Architecture/stack/prohibition/style conflicts belong in `rule_concerns` with rule IDs and changed-file locations. Advisory-only prohibitions may be noted without blocking.

Failure mapping priority is `rule_concerns` → `scope_concerns` → `verification_concerns` → `unmet_acceptance` → `needs_user_decision`. Finish seals the exact verdict bytes in `monitorVerdictEvidenceSha256`; never edit a sealed verdict. When blocked, finish the run with monitor-sourced structured failure metadata and do not mark the task done.
