# BuildLore 설치·프로젝트별 Wiki 접근 개발계획

작성일: 2026-09-14 · 상태: 후속 개발계획 초안 · 기준 코드: `461664a9118c387d3fd4a90aa42b1ea0c75ae470` 및 현재 미커밋 작업 트리

입력: [방향성 리포트](../install-project-wiki-access-research-2026-09-14/REPORT.md), [조사 출처 기록](../install-project-wiki-access-research-2026-09-14/provenance.json). 개발계획 작성 요청: “plans 디렉토리에 뱡향성 리포트가 하나 있는데 확인하고 개발계획 정리해”.

## 1. 개발 목표와 권장 순서

**BuildLore를 PC에 한 번 설치하고, 각 소스 프로젝트에서는 연결 정보만 설정해 자기 프로젝트의 승인 Wiki를 CLI 또는 MCP로 읽게 한다.** 한 PC의 여러 프로젝트가 하나의 로컬 Git 지식 허브를 공유한다는 조사 결정을 따른다.

첫 사용 가능한 결과는 새 소비자 환경에서 배포 패키지를 설치하고, 별도 허브에 등록된 프로젝트를 연결한 뒤, 소스 프로젝트 하위 폴더에서 `--project`를 반복 입력하지 않고 Wiki 본문과 근거를 읽는 흐름이다. 이후 같은 읽기 서비스를 MCP에 연결하고 반복 사용·업데이트·복구까지 검증한다.

| 순서 | 결과물 | 완료 판단 |
|---|---|---|
| 준비 | 연결·읽기·배포 계약의 Gate 검토 입력 | Mode A 해석, 프로젝트 선택 규칙, 승인 Wiki 읽기 정책, 첫 지원 환경 확정 |
| M1: 설치와 CLI 연결 | 실제 배포물, 허브 setup, 프로젝트 connect, 공통 조회 서비스, 연결 진단 | 제품 소스와 P2A가 없는 환경에서 프로젝트 A의 본문·근거 조회 성공 |
| M2: AI 독자 연결 | 짧은 CLI 안내, 프로젝트가 고정된 stdio MCP, 클라이언트 설정 지원 | 서로 다른 실제 에이전트 클라이언트가 A/B의 본문·근거를 각각 읽고 답함 |
| M3: 반복 사용과 배포 준비 | 재연결·연결 해제·업데이트 안내, 경로·동시 실행·실패 복구 검증 | 설치부터 제거까지 지식 보존 및 전체 수용 기준 충족 |

M1을 첫 구현 iteration으로 제안한다. M2와 M3는 각각 후속 iteration으로 나누어 검토할 수 있다. 전체 개선 완료는 M1~M3의 결과로 판단한다. 담당 인원·지원 환경·실제 설치 비용이 정해지지 않았으므로 달력 일정은 확정하지 않는다.

목표 사용자 흐름은 다음과 같다. `setup`, `connect`, 연결 기반 `--project` 생략, `mcp`는 모두 제안이다. 패키지명·버전·명령 형식은 Gate에서 확정하며 이 예시는 현재 실행 안내가 아니다.

```sh
# PC에서 한 번: 고정 버전 제품 설치 후, 별도 허브 생성 또는 기존 허브 등록
buildlore setup --hub <hub-path> --knowledge-repo <knowledge-git-url>

# 허브에 등록된 project-a와 승인 Wiki가 있다는 전제에서 소스 프로젝트 연결
buildlore connect --hub <hub-path> --project project-a

# 같은 소스 프로젝트의 루트/하위 폴더에서 이후 반복 사용
buildlore wiki memory --task "인증 설계와 주의사항" --progressive --json
buildlore wiki read --page architecture --view reader --json
buildlore wiki lookup --kind evidence --id <evidence-id> --expect-generation <generation-digest> --json

# MCP 클라이언트가 프로젝트별로 실행
buildlore mcp --project-dir <absolute-source-root> --read-only
```

새 프로젝트 등록과 최초 Wiki 생성·승인은 기존 허브 운영 흐름의 선행 작업이다. connect가 그 작업을 자동으로 실행하지 않는다. memory 및 reader view 예시는 해당 형식을 지원하는 project-knowledge Wiki를 전제로 한다.

## 2. 현재 구현에서 확인한 사실

아래는 소스 확인 결과다. 이번 계획 작성에서 제품 테스트를 실행하거나 기존 미커밋 변경의 정확성을 검증한 것은 아니다.

| 영역 | 현재 상태와 근거 | 개발계획에 반영할 점 |
|---|---|---|
| 패키지 | [package.json](../../../package.json)에 bin, dist/schemas/profiles 배포 목록, Node `>=24`, npm `>=11 <12`가 있고 `private: true` | 새 실행 엔진보다 실제 패키지 배포 경로·소비자 설치 검증부터 보완 |
| 설치 테스트 | [installed-cli.test.ts](../../../test/installed-cli.test.ts)는 테스트 중 TypeScript를 빌드하고 파일 복사 및 bin 링크로 패키지 형태를 구성 | 실제 `npm pack` 산출물의 독립 설치 검증을 추가. 기존 테스트 성공을 신규 사용자 설치 성공으로 간주하지 않음 |
| 허브 운영 | [knowledge/git.ts](../../../src/knowledge/git.ts), [knowledge/index.ts](../../../src/knowledge/index.ts)에 Git worktree 탐색, 지식 clone/init, Mode A 초기화 서비스가 있음 | 허브 setup은 기존 도메인 서비스를 조합. Git 처리와 오류 복구를 CLI에 중복 구현하지 않음 |
| 프로젝트 선택 | [parser.ts](../../../src/cli/parser.ts)는 Wiki 읽기에도 `--project`를 요구. [run-cli.ts](../../../src/cli/run-cli.ts)는 `runtime.cwd/knowledge` 및 허브 상태를 사용 | 프로젝트 폴더에서 명시적 연결을 해석하는 별도 진입점 필요. 허브 운영 명령은 기존 선택 계약 유지 |
| 소스 수집 바인딩 | [local-project-registry.ts](../../../src/knowledge/local-project-registry.ts)는 project ID별 sourceRoot 하나와 저장소 digest를 관리 | 새 읽기 연결은 별도 레지스트리로 관리. 다른 clone/worktree 연결 때문에 기존 수집 경로를 교체하지 않음 |
| 조회 | [project-knowledge-reader.ts](../../../src/retrieval/project-knowledge-reader.ts)에 list/read/search/memory/lookup/citations와 generation 검증이 있음 | 기존 기능 재사용. 연결·도메인 조회·전송 계층만 분리 |
| 형식별 분기 | [run-cli.ts](../../../src/cli/run-cli.ts)의 list/read/search/citations는 project-knowledge, hierarchy, legacy 경로를 분기 | 공통 서비스에 형식 선택과 오류 계약을 모으고 CLI와 MCP가 함께 호출 |
| 현재 사용자 계약 | [README.ko.md](../../../README.ko.md)는 기본 프로젝트를 자동 추론하지 않는다고 안내 | 저장된 연결의 검증된 ID 사용을 명시적으로 허용하는 Gate 계약 및 문서 보완 필요 |

현재 미커밋 변경에는 메모리 projection과 reader routing 관련 코드·테스트가 있다. M1 착수 때 해당 변경의 최종 기준선을 확인하고 그 결과를 재사용한다. 이 계획을 이유로 기존 변경을 덮어쓰거나 동일 기능을 다시 작성하지 않는다.

## 3. 범위와 구조

기본 범위는 로컬 패키지 설치, 하나의 로컬 허브, 여러 소스 체크아웃의 개별 읽기 연결, CLI와 클라이언트가 실행하는 stdio MCP다. 생성·수집·승인·게시 기능은 기존 허브 운영 흐름을 사용한다.

```text
PC에 설치된 BuildLore 실행 파일
          │
소스 A ─ connection(A) ─┐
소스 B ─ connection(B) ─┼─ PC 로컬 레지스트리 ─ Git 허브
A worktree ─ conn(A) ──┘                       └─ knowledge/ [Git submodule]
                                                  └─ projects/A, projects/B

CLI / 프로젝트별 MCP 세션
  → 연결 해석·검증
  → 하나의 허브·project ID로 제한된 공통 읽기 서비스
  → 기존 sanitizer 검사와 승인 authority 검증
  → 선택한 프로젝트의 본문·메모리·근거
```

- Mode A의 지식 submodule은 허브 Git 저장소가 소유한다. 각 소스 프로젝트에 제품 소스·node_modules·지식 submodule을 반복 설치하지 않는다. 이 허브 배치 해석은 Gate A에 명시한다.
- 지식 내용은 계속 `knowledge/projects/<project-id>/`에 둔다. 여러 연결을 지원해도 프로젝트 간 검색·목록·근거 공유는 허용하지 않는다.
- `projector → sanitizer → compiler → knowledge/retrieval` 경계를 유지한다. 조회 응답·오류에도 검증되지 않은 원문 또는 의심되는 secret을 포함하지 않는다.
- 새 공개 설정은 버전이 있는 언어 중립 JSON 계약으로 정의한다. Node/TypeScript 구현을 포맷 요건으로 만들지 않는다.
- 같은 OS 계정의 임의 파일 접근까지 차단하는 ACL은 제공하지 않는다. 지원 AI 환경이 허브 경로를 읽을 수 있는지는 실제 설치 검증에 포함한다.

이번 기본 릴리스에는 중앙 DB, HTTP 서비스·인증, 상시 daemon, 원격 웹 AI 연결, 여러 프로젝트를 합친 조회, 별도 Wiki 복사본을 넣지 않는다. 다른 PC의 Git 동기화와 전용 refresh, Homebrew/winget·런타임 포함 배포, MCP Resources, 임베딩 의존성 분리는 후속 범위로 남긴다.

## 4. Gate에서 확정할 제안 계약

아래 파일명·필드·명령·오류 이름은 설계 제안이며 아직 구현된 인터페이스가 아니다.

### 4.1 공유 연결과 PC 로컬 매핑

| 위치 | 내용 | 규칙 |
|---|---|---|
| 소스 루트의 `.buildlore/connection.json` | schemaVersion, 지식 저장소 식별자, projectId | Git 공유 가능한 정보만 저장. 절대 경로·토큰·사용자별 클라이언트 설정 제외 |
| 사용자별 BuildLore 설정 디렉터리 | 지식 식별자→허브 절대 경로, 실제 승인한 소스 worktree 루트→읽기 연결 | OS별 설정 위치를 명세. 다중 clone/worktree를 허용하되 연결 없는 프로젝트로 fallback하지 않음 |
| 기존 허브 `.buildlore/local-projects.json` | 소스 수집용 projectId/sourceRoot 바인딩 | connect/disconnect가 수정하지 않음 |

지식 저장소 식별자는 자격증명이 없는 명시적 repository locator와 검증된 digest를 사용하는 안을 우선 검토한다. 기존 manifest 및 저장소 정규화 함수의 재사용 가능성을 확인하고, URL 별칭·이동·remote 변경을 자동으로 같은 저장소라고 간주하지 않는다. 식별자 형식과 정규화 규칙은 T01에서 확정한다.

connect는 지정한 허브·기존 project ID·소스 저장소 신원을 검사한다. `sources.json`이 있으면 project ID 및 저장소 연결과의 정합성을 검사하지만, 읽기 연결을 위해 파일을 생성하거나 수집 범위를 변경하지 않는다. 허브에 project ID가 없으면 등록 방법을 안내하고 실패한다. 프로젝트는 있으나 승인 Wiki가 없으면 연결은 가능하고 조회 가능 상태는 별도로 표시한다.

공유 파일과 로컬 레지스트리의 쓰기는 잠금·원자적 교체·기대 digest 검증으로 보호한다. 부분 실패 후 완료된 연결로 표시하지 않는다. 재실행은 동일 연결이면 변경 없이 성공하고 다른 연결이면 명시적 재연결 절차로 보낸다.

### 4.2 연결 탐색과 프로젝트 격리

1. 실행 위치의 실제 Git worktree 루트를 확인한다. 그 경계 안에서 루트의 명시적 연결을 찾으며 중첩 Git 저장소의 바깥 연결은 물려받지 않는다.
2. 공유 연결, PC 로컬 매핑, 실제 sourceRoot, 허브의 지식 저장소 식별자, project ID를 모두 대조한다. 폴더명·최근 사용 프로젝트·첫 등록 항목으로 추정하지 않는다.
3. 하위 폴더·worktree를 지원한다. 심볼릭 링크는 실제 경로가 등록된 같은 경계로 귀결되는 경우만 허용하는 안을 검토하고, 경계 이탈·설정 파일 바꿔치기는 거절한다.
4. 소스 연결에서 넘긴 `--project`가 저장된 ID와 다르면 오류로 반환한다. 연결이 없는 위치에서 `--project`만 주었다고 전역 허브를 선택하지 않는다.
5. 기존 허브 위치의 `--project` 운영 흐름은 유지한다. 연결 기반 ID 생략은 읽기 허용 목록에만 적용하고 sync/compile/approve/publish에는 전파하지 않는다.
6. 데이터 로드 전 범위를 제한한다. 커서·page ID·근거 ID·캐시 키는 허브/지식 식별자·project ID·generation에 결속한다. 다른 프로젝트에 동일한 page ID가 있어도 혼용하지 않는다.

### 4.3 공통 읽기 서비스와 호환성

공통 서비스는 검증된 읽기 context를 입력으로 받아 status/list/search/read/memory/lookup/citations를 제공한다. `src/application/wiki-read-service.ts` 같은 조합 계층을 제안하며, Git·레지스트리 처리는 해당 도메인 포트에서 수행한다. CLI stdout을 MCP가 실행·파싱하는 구조를 만들지 않는다.

현재 허브 CLI의 형식별 동작은 회귀 검증으로 보존한다. 새 연결의 기본 읽기 정책은 **승인이 검증된 Wiki만 조회**로 제안한다. 현재 CLI에는 승인 projection이 없을 때 legacy로 이어지는 경로가 있으므로 이를 그대로 독자 연결에 전달하지 않는다. 호환 조회 정책과 승인 전용 정책을 서비스 입력에서 구분하고 실제 허용 형식은 Gate B에서 확정한다.

memory/lookup을 지원하지 않는 구형 형식은 `기능을 지원하지 않는 형식`으로 반환하고, `Wiki 없음`, `승인 없음`, `검증 실패`와 구분한다. 검증 실패를 legacy fallback으로 숨기지 않는다. 기존 공개 data schema를 통째로 새 형식으로 바꾸지 않고 공통 결과·오류 매핑을 정의한다.

새 독자 경로의 기본 검색은 lexical로 제안한다. 모델 로드·다운로드가 필요 없는 경로를 먼저 완성한다. semantic/hybrid는 기본 독자 계약에 포함하지 않고, 기존 허브 기능은 유지한다. 이후 추가할 때 로컬 모델·인덱스 존재 조건과 쓰기 없는 실행을 별도로 검증한다.

응답은 project ID, 지식 revision, 해당 형식의 generation 식별자, 읽기 정책을 제공한다. generation에 종속된 후속 조회는 기대 generation을 검사하고 변경 시 재시작 오류를 반환한다. 한 응답에 다른 generation의 본문·근거를 섞지 않는다. 기존 memory data 바이트 예산은 유지하며 MCP envelope와 안내 문구의 크기는 별도로 측정한다.

### 4.4 진단과 읽기 부작용

연결 status 또는 제품 `doctor`는 연결 여부, 허브 도달 가능 여부, 선택된 프로젝트, 로컬 지식 revision, 승인 generation, pin/dirty 상태, 읽기 정책, 소스와 근거 revision의 차이, 복구 단계를 구분한다. 원격 확인 이력이 없으면 `확인하지 않음`으로 표시한다. 소스 revision을 비교할 근거가 없으면 불일치로 추측하지 않고 `비교 불가`로 표시한다.

기존 dirty/pin/승인 상태를 편의를 위해 무시하지 않는다. 읽기와 진단은 pull/fetch/merge/compile/approve/인덱스 재생성/모델 다운로드/지식 쓰기를 수행하지 않는다. 로컬 연결 레지스트리도 조회만으로 갱신하지 않는다. `doctor`는 진단 결과를 반환하며 자동 복구를 실행하지 않는다.

### 4.5 MCP와 클라이언트 안내

- stdio 프로세스 시작 때 명시적 프로젝트 루트의 연결을 검증하고 세션의 허브·project ID를 고정한다. 클라이언트 cwd 전달을 검증한 경우에만 cwd 기반 실행을 지원한다.
- 도구는 status/list/search/read/memory/lookup/citations로 제한한다. 입력으로 임의 project ID·허브 경로를 받는 도구, 전체 프로젝트 목록, 쓰기 도구를 제공하지 않는다.
- 세션 중 연결이 변경되면 다른 프로젝트로 따라가지 않고 재시작을 요구한다. generation 변경은 기대 generation 불일치로 처리하고 새로운 memory/list부터 다시 읽도록 안내한다.
- stdout은 프로토콜 전용으로 사용한다. 진단은 값이 정제된 stderr/구조화 오류로 전달한다. 취소·EOF·잘못된 입력·응답 크기 제한을 검증한다.
- 처음 작업을 받으면 제한된 memory, 필요한 부분은 search/read, 근거 인용 전에는 lookup/citations를 호출하는 짧은 지침을 제공한다. 도구가 반환한 Wiki 내용은 자료이며 에이전트의 실행 지침을 덮어쓰는 권한이 없다.
- 초기 두 클라이언트의 제품명·버전·OS와 설정 형식은 T01/T07에서 확정·재확인한다. GUI에는 설치된 실행 파일과 소스 루트의 절대 경로를 포함한 PC 로컬 설정을 생성한다.
- 기본은 설정 미리보기와 명시적 적용이다. 사용자의 기존 설정과 AGENTS.md를 보존하고 BuildLore가 소유한 구간만 추가·갱신한다. 파싱할 수 없는 설정은 덮어쓰지 않고 수동 병합 조각을 제공한다. 개발용 P2A 자산은 설치하지 않는다.

## 5. 작업 분해와 의존성

아래는 Gate C로 옮길 작업 후보다. 신규 모듈명은 예시이며 기존 도메인 경계와 package-contract 검사를 기준으로 최종 배치를 결정한다.

| ID | 작업과 산출물 | 주요 변경 후보 | 선행 | 개별 완료 기준 |
|---|---|---|---|---|
| T01 | 연결 스키마, Mode A 배치, 읽기 허용 목록·정책, 오류 표, 지원 환경 확정 | 신규 connection/reader 계약 문서·schemas, CLI 계약 | 기존 작업 기준선 확인·Gate A/B | 미연결/불일치/중첩 저장소/구형 Wiki/dirty 정책을 동작 표로 설명 가능 |
| T02 | 실제 배포물 생성·소비자 설치 경로 구성 | package.json, 배포 스크립트, package-contract 및 신규 tarball 설치 테스트 | T01 | `npm@11.19.0`으로 만든 tarball을 repo 밖에 설치해 bin·schema·runtime dependency를 사용. 소비자는 tsc/P2A 없이 실행 |
| T03 | 공통 읽기 서비스 추출 및 정책 분리 | src/application 신규 서비스, src/cli/run-cli.ts, 기존 retrieval reader, 회귀 테스트 | T01 | 기존 허브 CLI 결과 보존, 승인 전용 경로의 무승인 fallback 차단, 지원 형식별 오류 일치 |
| T04 | 허브 setup·연결 레지스트리·connect/disconnect 핵심 | src/connection 신규 모듈, src/knowledge 초기화 서비스 재사용, schemas | T01 | 별도 Git 허브 생성 또는 등록, 다중 읽기 worktree 연결, 수집 바인딩 보존, 부분 실패 복구 |
| T05 | 프로젝트 cwd에서 CLI 읽기·진단·도움말 | src/cli/parser.ts, run-cli.ts, help.ts, error-map.ts, presentation.ts, README 한·영 | T02~T04 | 실제 설치물로 source 하위 폴더에서 본문·근거 조회. 충돌한 `--project`와 쓰기 명령 자동 선택 거절. **M1 완료** |
| T06 | 프로젝트별 읽기 전용 stdio MCP | src/mcp 신규 adapter, CLI 진입점, protocol 테스트, package-lock.json | T03~T05 | 프로토콜 client로 handshake/list/call/오류/종료 검증, CLI와 동일한 data·generation·도메인 오류 |
| T07 | 클라이언트 설정과 짧은 에이전트 지침 | src/integrations 신규 adapter, 설정 fixture, 사용자 문서 | T05~T06 | 초기 두 클라이언트 설정 미리보기·적용·재실행·해제 시 기존 사용자 내용 보존 |
| T08 | 두 실제 에이전트의 프로젝트별 전체 조회 평가 | 독립 설치·허브·A/B fixture, 실행 증거·평가 보고서 | T06~T07 | 두 클라이언트에서 동시 조회하며 각각 본문·실제 근거를 읽고 올바른 프로젝트로 답함. **M2 완료** |
| T09 | 반복 사용과 프로그램 수명주기 정리 | 연결 재설정·해제 서비스, 패키지 업데이트/제거 문서, 통합 테스트 | T04~T07 | clone/worktree 재연결, 허브 이동, 업데이트·구버전 재설치, 설정 제거 후에도 Git 지식 보존 |
| T10 | 실패·격리·OS 회귀 및 설치 비용 측정 | 연결/reader/MCP/tarball 통합 테스트, CI 지원 환경, 측정 산출물 | T05~T09 | 6절 수용 기준 통과, 읽기 부작용 없음, 실제 경로·설치·응답량 측정 결과 확보 |
| T11 | 릴리스 후보와 설치 안내 확정 | package metadata, 한·영 README, 릴리스 검증 기록 | T02·T08~T10 | 전체 필수 검사와 지원 환경 증거 통과, exact version 설치 안내 및 복구 절차 완성. **M3 완료** |

핵심 경로는 `T01 → T02/T03/T04 → T05 → T06/T07 → T08 → T10 → T11`이다. T09는 기본 disconnect를 새로 미루는 작업이 아니라 T04의 연결 수명주기를 여러 실제 환경에서 완성하는 작업이다.

T02에서 패키지 이름·레지스트리 소유권·배포 버전을 확인한다. `private: true` 해제는 릴리스 준비 작업이며 레지스트리 게시와 구분한다. MCP 의존성은 T06 착수 때 공식 명세와 SDK를 확인해 정확한 버전으로 고정하고 lockfile은 `npm@11.19.0`으로 갱신한다. `llm-wiki-compiler`는 기존 adapter와 exact pin을 유지한다.

## 6. 수용 기준과 검증 방법

| ID | 시나리오 | 통과 기준 | 시점 |
|---|---|---|---|
| AC01 | 깨끗한 소비자 설치 | repo 밖 임시 환경에 실제 tarball과 runtime dependencies만 설치. 제품 소스 checkout·devDependencies·P2A 없이 bin 실행 및 첫 본문 읽기 | M1 |
| AC02 | A/B 프로젝트 연결 | 두 프로젝트에 실행 파일·Wiki를 복사하지 않고 같은 허브를 연결. 루트·하위 폴더 조회가 각자 올바른 project ID를 반환 | M1 |
| AC03 | 명시적 선택과 경계 | 연결 누락·중복 매핑·다른 저장소·중첩 Git·탈출 symlink·source manifest 불일치·잘못된 `--project`가 정해진 오류로 실패 | M1 |
| AC04 | 기존 수집 기능 보존 | 같은 project ID의 clone/worktree 연결·해제 전후 기존 수집 registry digest 동일. 허브 CLI와 sync/compile의 명시적 project 요구 유지 | M1 |
| AC05 | 승인·generation 검증 | 승인 없는 Wiki, 지원하지 않는 형식, 손상 authority, 과거 커서, 다른 generation 근거를 구분. 검증 실패 후 legacy로 우회하지 않음 | M1·M2 |
| AC06 | 프로젝트 격리 | 두 프로젝트에 겹치는 page 이름·별도 근거를 두고 다른 project/page/cursor/lookup 입력 거절. 공통 store 계측으로 다른 프로젝트의 내용 파일을 읽지 않음을 확인 | M1·M2 |
| AC07 | 읽기 부작용 없음 | 준비 이후 네트워크 차단·모델 캐시 부재에서 기본 조회 성공. 네트워크/모델 호출 계측 0, 지식·승인·인덱스·연결 레지스트리의 전후 내용 digest 동일 | M1·M2 |
| AC08 | 상태와 복구 | 허브 없음, 승인 Wiki 없음, dirty, pin 불일치, 충돌, 근거 revision 차이를 올바르게 안내. 원격 미확인 상태에서 최신이라고 표시하지 않음 | M1·M3 |
| AC09 | CLI/MCP 일치 | 같은 fixture·정책·generation에서 정규화한 data 및 도메인 오류 일치. MCP 프레이밍·오류 envelope는 별도 검사 | M2 |
| AC10 | 실제 AI 사용 | 서로 다른 두 클라이언트가 A/B를 각각 찾아 memory→필요 본문→실제 근거를 읽고 답함. 근거 ID만 반환받거나 도구 목록만 확인한 실행은 성공으로 세지 않음 | M2 |
| AC11 | 동시성·세션 변경 | A/B 동시 호출에 상태 섞임 없음. 연결 파일 변경 시 기존 MCP 세션이 다른 프로젝트로 전환되지 않음. generation 변경은 재시작 가능한 오류 | M2·M3 |
| AC12 | 설정 보존·제거 | 기존 MCP 설정·AGENTS.md 사용자 내용 보존, 반복 적용 중복 없음, 중간 실패 시 복구, disconnect/제거 후 지식 Git 파일 보존 | M2·M3 |
| AC13 | OS·경로 | 지원 대상으로 승인된 OS에서 실제 설치·bin 실행. Windows drive/공백/한글 경로와 worktree·symlink 정책을 해당 OS에서 검사 | M3 |
| AC14 | 오류·출력 안전성 | 잘못된 connection·명령 인수·Wiki 자료의 안전하지 않은 값은 값 노출 없는 오류로 종료. raw source·로컬 절대 경로·타 프로젝트 내용이 응답/설정 공유 파일에 섞이지 않음 | 전체 |

OS 테스트가 실행되지 않은 플랫폼은 지원 완료로 표시하지 않는다. 초기 클라이언트 두 개를 실행할 수 없는 환경에서는 T08을 프로토콜 테스트만으로 통과 처리하지 않는다.

설치 평가에는 준비된 개발 환경 대신 빈 소비자 디렉터리/격리 환경을 사용하고 상위 repo의 node_modules를 우연히 참조하지 않는지 검사한다. 네트워크가 필요한 설치 단계와 오프라인 읽기 단계를 구분한다. 승인 Wiki fixture 준비는 조회 측정 전에 끝낸다.

각 구현 iteration 완료 전 저장소 필수 검사는 다음과 같다.

```sh
npm run build
npm test
npm run lint
npm run typecheck
p2a doctor --target . --dev
```

설치·MCP·실제 클라이언트 검증은 이 기본 검사에 추가한다. 제품 `buildlore doctor` 제안과 개발 harness의 `p2a doctor`는 별개다.

이번 문서 작업은 아래 entry 검사, 출처 SHA-256, 문서 링크와 변경 범위를 확인한다. 제품 구현 완료를 선언하지 않으므로 이번에 제품 전체 테스트를 실행한 것으로 기록하지 않는다.

```sh
p2a validate --entry plans/entries/install-project-wiki-access-development-2026-09-14/entry.md
```

## 7. 측정과 미결정 사항

측정값은 설치 시작→첫 유효 본문·근거 조회 시간, 수동 단계 수, 실패 후 복구 호출 수, 패키지/의존성 설치 용량·시간, 실제 읽은 본문·근거, 도구 호출 수, 누적 data 바이트 및 MCP 전체 응답 바이트다. 사전 다운로드·모델·기존 설정 여부와 OS/Node/npm/클라이언트 버전을 함께 기록한다.

현재 리포트에는 설치 시간·실제 에이전트 성공률 벤치마크가 없다. 일정 또는 성능 개선율을 사실처럼 제시하지 않는다. 통과 기준은 우선 AC01~AC14의 동작 조건으로 고정하고, 성능·사용성 수치 목표는 T02의 설치 기준선과 T08의 반복 실행 결과를 근거로 정한다.

| 결정 | 권장안 | 확정 시점 |
|---|---|---|
| 첫 구현 범위 | M1 설치·명시적 연결·CLI 읽기. 기존 승인 작업 완료 후 후속 범위로 채택 | Gate A |
| Mode A 및 프로젝트 선택 | 허브가 submodule 소유, 소스는 명시적 읽기 연결. 쓰기에는 기존 명시적 project 규칙 유지 | Gate A |
| 식별자·설정 위치·원자성 | Git 공유 식별자와 PC 경로 분리, 수집 registry와 읽기 registry 분리 | Gate B/T01 |
| 승인 전용과 형식 호환 | 새 독자 연결은 승인 검증 필수, 허브의 기존 조회 정책은 별도 유지, unsupported 명시 | Gate B/T01 |
| 배포 이름·버전·소유권 | 기존 패키지 구조 활용, 실제 registry 확인 후 정확한 버전 고정 | T02 |
| 첫 두 클라이언트와 OS | 사용자가 실제 쓰는 두 클라이언트를 우선 선정. Windows를 지원 표에 넣으려면 Windows 실행 증거 필수 | Gate B/T01, 설정 세부 T07 |
| 모델 의존성 설치 비용 | 첫 릴리스는 기존 의존성 구성 측정. 크기·설치 문제가 입증되면 분리를 별도 범위로 제안 | T02/T10 |
| 다른 PC 동기화·refresh | 기본 릴리스에서 제외. 향후 fetch/check/apply와 hub pin 갱신을 명시적 계약으로 설계 | 후속 Gate |

## 8. 현재 상태와 다음 개발 입력

`p2a next --entry`는 기존 승인 개발에 활성 작업이 있어 이번 entry를 `entry_deferred`로 반환했다. 이 문서는 기존 scope를 교체하거나 구현을 시작한 기록이 아니다. 요청된 개발계획 정리는 로컬 문서로 완료하며 기존 작업과 신규 계획의 승인을 섞지 않는다.

후속 구현 지시가 들어오면 이 계획을 출처로 하는 **구현 요청 entry**를 만들고, 당시의 `p2a next` 결과에 따라 M1 범위를 Gate A/B/C에 구체화한다. 이번 entry는 계획 작성 요청이므로 구현 승인으로 재해석하지 않는다. 기존 작업을 닫거나 교체하는 판단은 별도 lifecycle 절차에서 처리한다.

계획 작성 시점에는 새 계획과 출처 사본을 Git-ignored `plans/entries/`에 보관했다. 이후 사용자의 “개발계획서 푸시해” 지시에 따라 이 개발계획서 한 파일을 문서 전용 커밋으로 게시한다. 출처 링크는 기존에 게시된 조사 문서를 사용하고 이번 entry·출처 사본·provenance는 로컬에 보관한다. 기본 `plans/` ignore 규칙은 유지하며 제품 코드·지식 저장소·클라이언트 설정은 이번 게시에 포함하지 않는다.
