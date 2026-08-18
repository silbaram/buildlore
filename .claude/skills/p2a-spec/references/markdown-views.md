# Optional Markdown Views

Read only when a human-readable product or implementation view is requested or required for review.

Generate Markdown from `spec_json`; do not maintain a second hand-authored contract. Use narrative prose first and tables only as supporting structure. Render labels in the user's language while preserving the English JSON field mapping.

For a baseline-aware iteration, the view may be delta-first: list changed `product.*` and `implementation.*` refs and state that unchanged fields remain in canonical `spec.json`.

`product-spec.md` follows this order:

1. problem
2. target_users
3. goals
4. must_preserve
5. non_goals
6. core_flows
7. screens_or_interfaces
8. data_model_draft
9. external_integrations
10. success_criteria
11. constraints

Suggested Korean labels: 문제 정의, 대상 사용자, 목표, 보존 조건, 비목표, 핵심 흐름, 인터페이스, 데이터 모델, 외부 연동, 성공 기준, 제약.

`implementation-plan.md` follows this order:

1. architecture
2. interfaces
3. data_flow
4. dependencies
5. edge_cases
6. verification

Suggested Korean labels: 아키텍처, 인터페이스, 데이터 흐름, 의존성, 엣지 케이스, 검증.
