# Implementation Feedback and Final Review

Read when an approved visual contract affects task authoring, implementation feedback, or iteration closeout.

## Feedback classification

Classify a visual correction by whether it changes what Gate B approved:

- `drift`: implementation does not follow the approved experience/prototype. Correct inside the open implementation run; no Gate B reapproval.
- `contract`: the approved visual direction itself changes. Return affected visual artifacts to draft, revise contract and candidate states, update all hashes, and obtain explicit Gate B reapproval before finish.

Never mask a contract change as drift; final visual review must block an inconsistent implementation.

## Task impact

When `validation.visual_review_required` is true, every task declares `workKind: ui | non_ui | mixed`. UI/mixed tasks contain lightweight `visualImpact.screenStates`; non-UI tasks omit it. Overlap is allowed because impact is routing metadata, not exclusive review ownership.

## Final review

Ordinary implementation owners repeatedly inspect and correct drift, but those task runs do not create visual-review evidence. After all visual implementation is integrated, run one canonical:

```bash
p2a execute review --artifacts <artifact-root>
```

The final run derives the complete screen/state/viewport/accessibility contract from Gate B, captures the application once, and seals the confirming sidecar in `visualReviewEvidenceSha256`. `devExecution.reviewPasses.visual` controls whether an independent reviewer is separated; it cannot disable the approved visual contract or owner evidence.

Close-ready validation and portable handoff reject missing, stale, or changed final-review evidence.
