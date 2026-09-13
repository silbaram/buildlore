# Review, Retrospective, and Iteration Close

Read only when handling a closeout choice or an explicit review/retrospective/report/issue request. Follow the selected outcome without loading implementation verification or checkpoint instructions.

## Optional product review

Review is read-only. Inspect the diff, code, tests, and current verification evidence; run targeted non-mutating diagnostics only when needed to investigate a finding, not a full suite merely because review was selected. Report findings without changing code or run state unless the user requested fixes. An explicit “review and fix” request already provides that authority.

For an authorized correction in an open iteration, fill the returned `p2a execute remediate` placeholders with the owning completed task and concrete finding. The linked run preserves reviewed evidence and returns through normal verification; do not substitute maintenance. A clean review reports its result and stops without a close prompt or repeated menu. Leave the iteration open unless the user explicitly requested close.

## Retrospective

Keep product review, P2A process retrospective, and iteration close separate. Retrospective is optional and skipping it never blocks close. After the final maintenance task, use the same policy with the report path printed by `p2a execute finish`; finishing maintenance needs no new close state.

Summarize detected signals or the user's observations. If neither exists, ask once about process friction; when they report none, create nothing. Distinguish product verification failures from P2A routing, delay, or unnecessary steps, and do not infer missing facts.

Match the requested outcome without repeating approval questions:

- “Summarize the retrospective”: report the observed issue, impact, and suggested improvement in the conversation.
- “Write the retrospective”: create one short report at the returned path with exactly four H2 sections: `Observed issue`, `User impact`, `Suggested improvement`, `Evidence`. Do not overwrite an existing report without an explicit update request or copy raw logs/private details.
- “Register the retrospective as a GitHub issue”: use the identified report, or write the same minimal report when summarizing the supplied observations is part of that request. Preview and publish directly through the existing commands below; no proposal mining, curation, or patch draft is required. The explicit issue request authorizes publication, not product changes.

```bash
p2a proposals issue-preview --retrospective <report-path>
p2a proposals publish-issue --retrospective <report-path> --yes
```

Run these commands from the target project with a project-relative `docs/retrospective/*.md` path, converting the returned report path if it is absolute. They target the public `silbaram/plan2agent` repository. Inspect the preview for private project details and respect validation or redaction blockers before publication. Report the created or existing issue URL; the CLI handles duplicate detection. A report request alone does not authorize publication. Use `proposals mine` only when the user specifically requests the separate local proposal workflow.

## Iteration close

The user's explicit close choice authorizes the returned close command. Neither a clean review nor a retrospective authorizes closing the iteration.
