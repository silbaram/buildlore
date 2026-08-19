---
source_type: github_issue
source_url: https://github.com/silbaram/buildlore/issues/2
repository: silbaram/buildlore
issue_number: 2
issue_state: open
source_created_at: 2026-08-18T13:01:49Z
source_updated_at: 2026-08-18T13:48:46Z
snapshot_fetched_at: 2026-08-18T22:03:03Z
source_content_sha256: 1330ee23748a865a777526b1ad54c772341c88586460083f01b8f5ade84e9c8f
---

# [Step 1] 저장소 기반과 제품 아키텍처 경계 정의

## 배경

BuildLore는 기존 `plan2agent-memory`의 서버·PostgreSQL 중심 구조를 확장하는 프로젝트가 아니라, local-first 파일과 Git을 중심으로 새로 시작하는 제품이다. 초기에 기술 및 제품 경계를 명확히 해야 서버 기능이 다시 유입되는 것을 막을 수 있다.

Node.js 24+와 TypeScript는 제품의 영구 제약이 아니라 `llm-wiki-compiler`의 공식 런타임·SDK와 가장 낮은 비용으로 결합하기 위한 v0.1 reference implementation 결정이다. knowledge format과 제품 계약은 특정 언어에 종속시키지 않는다.

## 목표

Node.js 24+와 TypeScript 기반의 재사용 가능한 CLI 프로젝트 골격을 만들고 BuildLore의 아키텍처 원칙, 개발자 진입 절차 및 비목표를 문서화한다.

## 착수 전 Gate 결정

- 라이선스: MIT를 기본 제안으로 검토하고 Gate에서 하나로 확정한다.
- package manager: upstream과 동일한 npm + `package-lock.json`을 기본 제안으로 검토한다.
- test/lint 도구: Vitest와 TypeScript-aware lint 구성을 기본 제안으로 검토하고 명령 이름을 고정한다.
- 위 선택은 승인된 ADR에 기록하며 구현 세션이 임의로 바꾸지 않는다.

## 범위

- README에 제품 설명, 핵심 사용 흐름, 용어를 작성한다.
- 확정된 프로젝트 라이선스를 파일로 추가한다.
- Node.js 24+ / TypeScript / exact package lock을 설정한다.
- `build`, `test`, `lint`, `typecheck` 명령을 제공한다.
- `src/cli`, `src/projector`, `src/sanitizer`, `src/compiler`, `src/retrieval`, `src/knowledge`, `test/fixtures`의 기본 경계를 만든다.
- root `AGENTS.md`에 P2A 진입점, 검증 명령, Mode A 경계, no-required-server, no-fork 및 secret fail-closed 규칙을 기록한다.
- `docs/entries/`에 GitHub issue snapshot을 P2A entry로 저장하는 규칙과 원본 issue URL/hash 기록 방법을 문서화한다.
- fresh clone에서 `p2a init --target .`로 local harness state를 복원하고 `p2a next --entry <path>`로 시작하는 절차를 README/PLAN2AGENT에 기록한다.
- `.plan2agent/`가 Git 비추적 local state라는 점과 다른 환경으로 이어갈 때 Memory 또는 explicit export가 필요하다는 점을 기록한다.
- ADR에 local-first, no-required-server, Git-backed, compile-first, language-neutral-contract 원칙을 기록한다.
- 중앙 DB, 상시 API 서버, 실시간 협업 편집을 v0.1 비목표로 명시한다.

## 완료 조건

- [ ] 깨끗한 clone에서 문서화된 Node 버전과 package manager로 설치할 수 있다.
- [ ] `build`, `test`, `lint`, `typecheck`가 통과한다.
- [ ] `p2a doctor --target . --dev`가 verification command 경고 없이 통과한다.
- [ ] CLI 도움말이 실행된다.
- [ ] README, root `AGENTS.md`, ADR만 읽어도 코드 저장소와 knowledge 저장소의 역할 및 새 작업 시작 방법을 구분할 수 있다.
- [ ] GitHub issue snapshot 한 건을 entry로 검증하는 예제가 존재한다.
- [ ] `llm-wiki-compiler`를 fork하지 않고 exact-pinned dependency와 교체 가능한 adapter로 시작한다는 정책이 기록되어 있다.

## 선행 조건

없음.
