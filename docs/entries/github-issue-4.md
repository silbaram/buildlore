---
source_type: github_issue
source_url: https://github.com/silbaram/buildlore/issues/4
repository: silbaram/buildlore
issue_number: 4
issue_state: open
source_created_at: 2026-08-18T13:01:56Z
source_updated_at: 2026-08-18T13:48:46Z
snapshot_fetched_at: 2026-08-19T10:09:09Z
source_content_sha256: b2634675a901852149b53014060f5a33160a8ecc90228875773958bc617e7bec
---

# [Step 3] llm-wiki-compiler dependency adapter 구현

## 배경

BuildLore는 `llm-wiki-compiler`의 compile-first, citation, freshness, lint 기능을 활용한다. 내부 코드를 복사하면 upstream 변경을 따라가기 어려우므로 exact-pinned dependency와 얇은 adapter부터 시작한다.

Mode A에서는 각 `knowledge/projects/<project-id>/`가 독립된 llmwiki workspace다. adapter가 이 경계를 강제하지 않으면 서로 다른 프로젝트의 page, state, embedding이 섞일 수 있다.

2026-08-18 reconnaissance 기준 baseline candidate는 `llm-wiki-compiler@1.1.0`과 public TypeScript SDK `createWiki({ root })`다. 착수 시 현재 버전과 API를 다시 확인하고 contract test가 통과한 정확한 버전을 lockfile에 고정한다.

## 목표

BuildLore 내부에서 `llm-wiki-compiler`를 안전하고 교체 가능하게 호출하고, 모든 동작을 선택한 프로젝트 workspace에 한정하는 compiler adapter를 구현한다.

## 연동 결정

- v0.1 기본 표면은 in-process TypeScript SDK다.
- `createWiki({ root })`에 registry가 해석한 project root만 전달한다.
- SDK가 제공하지 않는 기능만 argument-array 기반 subprocess fallback을 허용하며 CLI stdout scraping을 기본 계약으로 삼지 않는다.
- upstream fork는 별도 승인이 없는 한 허용하지 않는다.
- exact dependency version, package integrity와 reconnaissance commit SHA를 ADR/lockfile에 기록한다.

## 범위

- compile, status, lint, fast/full eval, search, query, context 실행 capability matrix를 작성한다.
- 각 capability의 provider 필요 여부, write 여부, 예상 output 및 warning/error mapping을 고정한다.
- adapter 입력으로 `projectId`를 받고 registry를 통해서만 workspace root를 해석한다.
- 해석된 `knowledge/projects/<project-id>/`를 compiler root로 전달한다.
- 최상위 `knowledge/`를 compiler root로 사용하거나 registry 밖 경로를 직접 전달하는 동작을 금지한다.
- source scan, Wiki output, `.llmwiki` state, embedding 및 검색을 모두 선택 프로젝트에 한정한다.
- provider와 embedding 설정은 환경변수 또는 외부 secret으로만 주입하고 구조화된 결과에 값을 포함하지 않는다.
- source/page가 외부 provider로 전송되는 data-egress 경계를 문서화한다.
- SDK result, thrown error, warning, 변경 page와 `projectId`를 BuildLore result/error envelope로 변환한다.
- compile timeout, user cancellation, process signal 및 중간 progress callback 부재 처리 정책을 정의한다.
- fake provider 또는 사전 생성 fixture로 네트워크 없는 smoke/contract test를 만든다.
- upstream minor/patch upgrade 시 SDK type, source scan, state/lock, language 및 retrieval contract test를 실행한다.

## 완료 조건

- [ ] exact-pinned upstream version과 reconnaissance 근거가 lockfile/ADR에 기록된다.
- [ ] fixture source를 지정 프로젝트의 Wiki로 SDK를 통해 컴파일하는 통합 테스트가 통과한다.
- [ ] 같은 입력을 두 번 컴파일하면 두 번째 실행은 변경 없음이며 LLM 호출 count가 증가하지 않는다.
- [ ] 동일한 page slug를 가진 두 프로젝트가 충돌하지 않는다.
- [ ] 한 프로젝트의 compile/search/query가 다른 프로젝트의 파일과 `.llmwiki` state를 읽거나 변경하지 않는다.
- [ ] 미등록 project ID와 workspace 경계 이탈을 provider 호출 전에 명확한 오류로 거부한다.
- [ ] timeout/cancellation/compiler 실패가 성공으로 기록되지 않는다.
- [ ] provider credential과 source 본문이 로그 또는 error envelope에 남지 않는다.
- [ ] dependency 교체가 projector, retrieval 및 Git 계층에 영향을 주지 않는 인터페이스가 존재한다.

## 선행 조건

- Step 1 저장소 기반과 제품 경계 정의
- Step 2 단일 knowledge repository와 프로젝트 workspace 계약
