# Full Visual Procedure

Read only for `design_scope: full` with `design_timing: current_iteration`.

## Screen contract

For every screen define stable id/name/route, user goal and entry points, one primary action, secondary actions, ordered information regions, required states, success exit, responsive rules, and accessibility requirements.

Every text-bearing screen includes explicitly named `content-stress-<case>` states covering applicable extremes: realistically longest string, empty or one-character value, maximum supported list length, and longest expected locale string. These are approval surfaces, not optional fixture examples.

Define cross-screen semantic tokens, components, required viewports/states, and accessibility standard.

## Candidate production

1. Inspect the draft spec and existing local design tokens/components.
2. Ask only for high-impact missing visual direction and recommend a default when possible.
3. Invoke the read-only `p2a-visual-designer` with the complete screen contract.
4. Produce two materially different passive offline HTML/CSS candidates by default. One is allowed only for constrained reuse. Text-bearing candidates must differ in at least one stress treatment.
5. The harness owner writes each candidate under `gate-b-spec/visual-design/VD-<n>/` with `index.html`, `styles.css`, optional non-stress state documents, and `prototype.json`.

Candidates are passive, self-contained, offline, and use fixture data, semantic HTML, local assets, anchor navigation, and responsive CSS. Executable JavaScript, event handlers, external navigation, application APIs, and remote services are forbidden.

Every HTML file declares this restrictive CSP (directive order is irrelevant):

```text
default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'
```

## State and hash binding

Place each content-stress state in an anchor section of the candidate's existing `index.html`. Give it a stable `state-content-stress-<case>` id, make it reachable from the entrypoint, and map it in `prototype.json.state_artifacts` as an HTML fragment. The rendered state must exercise the extreme value.

The owner hashes every candidate file and writes `p2a.visual_prototype.v1`. Declare every reachable HTML/CSS/media/font dependency with correct media type and candidate-relative path. Record per-screen coverage and ensure every mapped state is passively reachable.

Write `gate-b-spec/experience-spec.json` as `p2a.visual_experience.v1`, using canonical `source_spec_ref: "spec.json"`, exact candidate manifest references/hashes, and `approval: draft`.

## Selection and approval

Present entrypoint links, summaries, trade-offs, and explicit long-content treatment differences. Ask the user to select, request changes, or reject; never infer approval.

After explicit approval:

- approve only the selected prototype and record its audit;
- set `selected_candidate` and approve the experience with its audit;
- recompute hashes after any approved-byte change;
- store the experience SHA-256 in `spec_json.visual_experience`;
- include `gate-b-spec/experience-spec.json` in Gate B approved artifacts.

Gate B approves the product/implementation spec and selected visual direction together.
