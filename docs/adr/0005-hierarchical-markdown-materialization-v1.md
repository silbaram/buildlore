# ADR 0005: Hierarchical Markdown materialization v1

Status: accepted for the v22 maintenance implementation

## 결정

계층형 Wiki의 유일한 승인 정본은 계속
`projects/<project-id>/.llmwiki/buildlore-hierarchy/approved-authority.json`이다.
사람과 코딩 에이전트가 일반 문서 도구로 읽는 Markdown은 이 정본을 해석하거나
역으로 승인하는 입력이 아니라, 검증된 retrieval projection에서만 만드는 결정적 파생물이다.

명시적 `compile activate`는 모델이나 provider를 호출하지 않고 다음 세대를
`projects/<project-id>/wiki/buildlore-hierarchy/`에 완전 materialize한다.

- `index.md`: root에서 모든 active page로 이동할 수 있는 계층 탐색 문서
- `page-<64-lowercase-hex>.md`: title, summary, parent/children/related navigation,
  ordered section, 상대 page link와 citation footnote를 포함하는 page 문서
- `manifest.json`: authority, projection, corpus, Wiki generation, sanitizer policy,
  renderer와 각 Markdown 파일의 byte digest를 결속하는 세대 manifest

파일명에는 변경 가능한 제목을 쓰지 않고 안정된 page ID만 쓴다. 같은 authority,
policy와 renderer contract는 NFC, LF, final newline, canonical order와 timestamp 없는
출력으로 항상 같은 byte를 만든다. Markdown을 직접 수정해도 JSON authority, Wiki read,
lexical/graph 검색 또는 semantic chunk 입력으로 채택되지 않는다.

## 발행과 복구

BuildLore는 모든 최종 Markdown 및 manifest byte를 persistence 전에 sanitizer로 다시
검사한다. 전용 `.llmwiki/buildlore-hierarchy/` 아래에 완전한 임시 세대를 만든 뒤
파일 종류, symlink/hardlink, confinement, count와 digest를 재검증한다. 실제 교체는
knowledge repository writer lease와 hierarchy lineage lock 아래에서 durable journal,
previous-generation backup, staged-generation move, authority commit 순으로 진행한다.

authority commit 전 오류는 이전 authority/Markdown 조합으로 되돌린다. authority가
commit된 뒤의 정리 오류는 이미 완료된 새 조합을 실패로 오인하지 않으며, 다음
activation이 journal을 roll-forward하고 임시 세대를 정리한다. 알 수 없는 파일,
unsafe path나 foreign collision은 자동 삭제하지 않고 `invalid`로 거부한다.
검사 결과는 `none | ready | missing | drifted | invalid`이며 `index status`의
`materialization` 필드에서도 확인할 수 있다.

## 의미 인덱스

Semantic index는 Markdown을 읽지 않고 같은 승인 JSON에서 검증된 retrieval corpus만
chunk한다. Activation과 index rebuild는 계속 별도 명령이며, activation은 embedding을
암묵 실행하지 않는다.

긴 full/incremental/resume/import 작업이 끝나도 새 generation을 즉시 active로 만들지
않는다. `active.json`을 바꾸기 직전에 repository writer lease와 hierarchy lineage lock을
유지한 채 authority record, projection, corpus/Wiki generation, sanitizer policy,
chunker와 embedding identity를 다시 읽고 build snapshot과 비교한다. 하나라도 다르면
staged generation은 활성화하지 않고 이전 healthy active pointer를 보존한다. 동일 corpus의
`unchanged` 성공도 같은 최종 검사를 거친다.

## Git 및 운영 경계

Authority, `index.md`, page Markdown과 `manifest.json`만 항상 추적 대상이다. Journal,
lock, staging, backup, semantic generation, vector와 model byte는 Git에서 제외한다.
Activation은 Git commit/push나 code repository submodule pin을 수행하지 않는다.

일반 운영 순서는 다음과 같다.

```sh
node dist/cli/bin.js compile activate \
  --project <project-id> \
  --input <approved-wiki.json> \
  --confirm-approval sha256:<approval-digest> \
  --json

node dist/cli/bin.js index status --project <project-id> --json
node dist/cli/bin.js index rebuild --project <project-id> --json
```

첫 명령 직후 Markdown과 model-free Wiki read/lexical/graph는 사용할 수 있다. Semantic 및
hybrid의 semantic channel은 준비된 로컬 모델로 두 번째 명령 상태를 확인하고 세 번째
명령을 명시적으로 실행한 뒤에만 새 generation을 사용한다.
