---
source_type: github_issue
source_url: https://github.com/silbaram/buildlore/issues/3
repository: silbaram/buildlore
issue_number: 3
issue_state: open
source_created_at: 2026-08-18T13:01:52Z
source_updated_at: 2026-08-18T13:48:47Z
snapshot_fetched_at: 2026-08-19T01:13:03Z
source_content_sha256: 3b82512df3c33eb0a15299e8c93dbf1e76f4d737bd8ed367f59d853468ea80b4
---

# [Step 2] 단일 Knowledge repository와 프로젝트 workspace 계약 구현

## 배경

BuildLore 코드와 실제 개발 지식은 변경 주기, 접근 권한, 저장량이 다르다. 실제 문서는 하나의 별도 Git 저장소로 관리하고 BuildLore 코드 저장소에서는 `knowledge/` submodule로 연결한다.

여러 프로젝트를 담되 llmwiki의 검색·상태 경계가 섞이지 않도록 **Mode A: 단일 knowledge repository + 프로젝트별 독립 workspace**를 v0.1 계약으로 확정한다.

## 목표

단일 knowledge 저장소의 versioned project registry, 디렉터리 경계, Git 연결, revision pinning 및 초기화 계약을 정의하고 로컬 fixture로 검증한다.

## 디렉터리 계약

```text
knowledge/
├─ manifest.json
└─ projects/
   ├─ <project-id>/
   │  ├─ project.json
   │  ├─ sources/
   │  │  ├─ planning--<stable-id>.md
   │  │  ├─ decision--<stable-id>.md
   │  │  └─ execution--<stable-id>.md
   │  ├─ wiki/
   │  ├─ .llmwiki/
   │  └─ log.md
   └─ <another-project-id>/
      └─ ...동일한 독립 workspace 구조
```

- `llm-wiki-compiler`의 non-recursive source scan 계약 때문에 source Markdown은 `sources/` 바로 아래에만 둔다.
- source 종류는 filename prefix와 `buildlore.sourceKind` frontmatter로 구분한다.
- `knowledge/manifest.json`은 `schemaVersion: "buildlore.knowledge.v1"`을 가진 project registry의 단일 기준이다.
- registry 항목은 최소한 `projectId`, `displayName`, `path`, `sourceRepository`를 가진다.
- `projectId`는 생성 후 바뀌지 않는 1~64자 lowercase kebab-case 식별자다.
- `path`는 knowledge root 상대경로이고 항상 `projects/` 아래를 가리키며 registry 밖 임의 workspace를 허용하지 않는다.
- 각 프로젝트의 `project.json`은 `schemaVersion: "buildlore.project.v1"`, `projectId`, source repository identity 및 profile version을 기록한다.
- 각 `projects/<project-id>/`는 자체 `sources/`, `wiki/`, `.llmwiki/`, `log.md`를 가진 완전한 llmwiki workspace root다.
- 최상위 `knowledge/`는 registry와 Git 경계이며 compiler workspace root로 사용하지 않는다.

## 범위

- `knowledge/` Git submodule 연결 방식을 정의한다.
- 공개 코드 저장소와 비공개 knowledge 저장소 조합을 지원한다.
- 저장소 URL, 로컬 경로, branch, pinned commit을 다루는 설정 contract를 정의한다.
- 프로젝트 add/list/show와 registry validation contract를 구현한다.
- registry update는 temp file + atomic rename으로 적용하고 부분 기록을 남기지 않는다.
- 중복 ID·중복 경로, reserved ID, 절대 경로, `..` traversal, registry 밖의 프로젝트 경로를 거부한다.
- path confinement는 lexical check만 사용하지 않고 기존 경로의 realpath와 symlink/junction 이탈을 검사한다.
- clone/init/status 동작과 미초기화·권한 오류를 명확히 처리한다.
- `.llmwiki` 파일별 Git tracking matrix의 초안을 만들고 Step 10에서 publish 정책으로 고정한다.
- `.env`, credential, embedding cache, lock, journal, 임시 파일을 추적하지 않는 기본 ignore 정책을 제공한다.
- 실제 네트워크 없이 local bare Git fixture로 submodule 수명주기를 테스트한다.
- 두 개 이상의 프로젝트 fixture로 workspace 격리를 검증한다.

## v0.1 비범위

- 프로젝트별 Git repository 또는 중첩 submodule
- 프로젝트별 ACL·credential 분리 — v0.1은 knowledge 저장소 단위 권한을 사용한다.
- `shared/` 공통 지식 계층과 프로젝트 간 자동 링크
- cross-project compile 및 통합 검색
- `sources/` 하위의 planning/decision/execution 디렉터리

## 완료 조건

- [ ] 새 BuildLore 저장소에서 하나의 knowledge 저장소를 submodule로 연결할 수 있다.
- [ ] registry에 두 개 이상의 프로젝트를 등록·조회하고 각각의 workspace를 초기화할 수 있다.
- [ ] 생성된 source fixture가 `sources/*.md`에 위치하고 실제 compiler change detection에 포함된다.
- [ ] 초기화되지 않은 submodule과 등록되지 않은 project ID를 진단하고 복구 명령을 안내한다.
- [ ] 현재 knowledge commit SHA와 선택한 `projectId`, workspace 경로를 구조화된 결과로 반환한다.
- [ ] 한 프로젝트 작업이 다른 프로젝트의 `sources/`, `wiki/`, `.llmwiki/`, `log.md`를 읽거나 변경하지 않는다.
- [ ] private repository credential을 설정 파일이나 Git history에 기록하지 않는다.
- [ ] `..`, absolute path, symlink/junction을 이용한 디렉터리 경계 이탈을 거부한다.
- [ ] registry crash/partial-write fixture에서 기존 유효 manifest가 보존된다.

## 선행 조건

- Step 1 저장소 기반과 제품 경계 정의
