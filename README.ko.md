# BuildLore

[English](README.md) | [한국어](README.ko.md)

BuildLore는 코드 저장소를 검토 가능한 개발 위키로 변환하는 로컬 우선,
Git 기반 도구입니다. v0.1은 재사용 가능한 TypeScript CLI와 명확한 아키텍처
경계를 제공하며, 데이터베이스나 상시 실행 서버가 필요하지 않습니다.

## 핵심 흐름

1. 프로젝터가 하나의 `project-id`에 속하는 저장소 콘텐츠를 선택합니다.
2. 새니타이저가 비밀정보와 안전하지 않은 소스를 컴파일 전에 거부합니다.
3. 컴파일러 어댑터가 언어 중립적인 위키 산출물을 생성합니다.
4. 검색 계층이 커밋된 지식 파일을 로컬 에이전트에 제공합니다.
5. Git 검토와 이력이 협업 및 출처 추적의 기준으로 유지됩니다.

각 소스 저장소는 코드와 이식 가능한 문서 선택 매니페스트를 소유합니다. 별도의
BuildLore 허브는 `knowledge/`에 Git 서브모듈로 연결된 하나의 지식 저장소와
머신 로컬 소스 바인딩을 소유합니다. **Mode A**에서는 한 허브가 여러 독립 소스
체크아웃을 연결하고, 각 컴파일러 작업공간을
`knowledge/projects/<project-id>/` 아래에 격리합니다. 최상위 `knowledge/`
디렉터리는 레지스트리와 Git 경계일 뿐이며 컴파일러 작업공간으로 사용하지
않습니다.

`source`는 코드 저장소에서 선택한 입력을 의미합니다. `wiki`는 정제 및
컴파일된 지식 산출물을 의미합니다. `project-id`는 입력과 출력을 연결하고
격리하는 안정적인 키입니다.

## 로컬 설치 및 실행

- Node.js 24 이상(Node.js 24 LTS가 기준 런타임)
- npm 11(저장소에 선언된 정확한 버전은 `npm@11.19.0`)
- Git과 기존 지식 저장소에 대한 접근 권한

새로 복제한 저장소에서 다음을 실행합니다.

```sh
npm ci --ignore-scripts
npm run build
node dist/cli/bin.js --help
```

등록·수집·컴파일·승인 명령은 BuildLore 허브 루트에서 실행합니다. 아래 예시는
`node dist/cli/bin.js`를 사용합니다. 패키지 실행 파일을 링크하거나 설치했다면
이를 `buildlore`로 바꿔 사용할 수 있습니다.

잠금 파일과 모든 직접 의존성은 정확한 버전으로 고정되어 있습니다.
`llm-wiki-compiler@1.1.0`은 교체 가능한 `src/compiler` 패키지 루트 어댑터를
통해서만 사용합니다. BuildLore는 이 패키지를 포크하거나 내부 모듈을 직접
가져오지 않습니다.


### 패키지 설치와 소스 폴더에서 조회

M1의 기준 환경은 Linux x64, Node.js 24.19.0, npm 11.19.0, Git 2.53.0입니다.
다른 OS의 검증 완료를 의미하지 않습니다. 현재 패키지는 `private: true`이며
레지스트리에 게시하지 않고 로컬 tarball을 설치합니다.

```sh
# BuildLore 개발 체크아웃에서, npm@11.19.0 사용
npm ci --ignore-scripts
npm run build
npm pack --pack-destination /tmp
# 개발 체크아웃 밖에 실행 패키지와 런타임 의존성 설치
npm install --prefix "$HOME/.local/buildlore" --omit=dev /tmp/buildlore-0.1.1-rc.1.tgz
export PATH="$HOME/.local/buildlore/node_modules/.bin:$PATH"

buildlore setup --hub /work/wiki-hub --knowledge-repo https://example.org/team/knowledge.git
cd /work/my-source
buildlore connect --hub /work/wiki-hub --project my-project
buildlore connection status --json
buildlore wiki list --json
buildlore search --query "설계 결정" --json
# list/search/memory 응답의 readContext.generation 값을 그대로 사용
buildlore wiki read --page overview --expect-generation sha256:<64자리-해시> --json
buildlore wiki memory --task "설계 결정 확인" --progressive --json
```

새 점진 조회는 같은 페이지·섹션 안에서 원문, 표현 상태와 근거 fact 집합이 모두 같은
반복 항목을 뒤로 보내고 서로 다른 정보를 먼저 반환합니다. 원문 항목을 삭제하거나
병합하지 않으며, 이어 읽으면 반복 항목도 조회할 수 있습니다. 새 `pwm2` cursor와
기존 `pwm1` cursor는 각각의 조회 순서를 유지합니다. 새 순서를 사용하려면 cursor 없이
시작하고, cursor의 버전 문자열을 직접 바꾸지 마세요.

`setup`은 비어 있는 별도 허브를 만들거나 같은 지식 저장소의 기존 허브를 등록합니다.
`connect` 전에 해당 프로젝트가 지식 저장소에 등록되어 있어야 합니다. 등록·수집·승인·활성화는
아래 허브 명령으로 수행합니다. 승인 Wiki가 없으면 연결은 가능하지만 `readable: false`입니다.
소스 Git origin이 없으면 최초 연결 때 `--source-repo <등록된 저장소 식별자>`도 지정합니다.
동일 프로젝트의 다른 clone/worktree도 각각 연결할 수 있습니다.

연결 후 소스 루트와 하위 폴더에서는 읽기 명령의 `--project`를 생략합니다. 명시하면 연결된
프로젝트와 같아야 합니다. `read`, `citations`, `lookup`은 `--expect-generation`이 필수이고,
`list`, `search`, `memory`는 선택입니다. 세대가 변경되면 본문 없이 실패하므로 새 목록이나
메모리를 받아 다시 조회합니다. 연결 조회는 승인된 project-knowledge 또는 hierarchical
출력만 사용하며 검색은 lexical입니다. Hierarchical 출력은 목록·검색·본문·인용을 지원하고,
메모리·lookup·reader view는 지원하지 않습니다. 기존 허브 명령은 v1 JSON 출력을 유지하며
연결 조회는 `buildlore.cli-envelope.v2`의 `readContext`에 세대와 저장소 digest를 제공합니다.

공유 가능한 `.buildlore/connection.json`에는 저장소 식별자·digest와 project ID만 저장합니다.
절대 경로는 PC 전용 `connections.json`에 저장하며, `BUILDLORE_CONFIG_DIR` 절대 경로,
`$XDG_CONFIG_HOME/buildlore`, `$HOME/.config/buildlore` 순서로 위치를 선택합니다.
수집용 `local-projects.json`과 `sources.json`은 연결 명령이 수정하지 않습니다.
`buildlore disconnect`는 PC 바인딩만 해제하고, `--remove-shared`를 함께 지정하면 공유 연결도
제거합니다. 부분 연결 실패는 같은 `connect`를 재실행하여 복구합니다. 변경된 저장소는 먼저
연결을 해제하고 올바른 설정으로 다시 연결합니다.

`connection status`와 `doctor`는 승인·핀·dirty 상태와 복구 명령을 읽기만 합니다.
dirty는 연결된 프로젝트의 지식 파일 범위이며 다른 프로젝트 본문을 열지 않습니다.
원격 최신 여부는 `not_checked`입니다. 소스 revision 비교는 기록된 Git HEAD 메타데이터의 비교이며 작업 파일 일치 보증이 아닙니다. 핀 불일치는 허브에서 기존 `knowledge status` 및
핀 계획/커밋 절차로 해결합니다. 읽기에서는 모델·인덱스 생성·네트워크·임시 파일 쓰기를
수행하지 않습니다. 이력 검증은 메모리를 일정하게 유지하기 위해 읽기만으로 반복 순회하므로
긴 이력의 최초 조회는 느릴 수 있습니다. MCP 클라이언트 연결은 아래 AI 클라이언트 안내를 사용합니다. 자동 업데이트는 제공하지 않습니다.

개발 검증에는 `npm run verify:installed-read`를 사용합니다. `strace`, `bwrap`,
사용자 네임스페이스 실행 권한과 npm 11.19.0이 필요하며, 도구가 없으면 검증은 실패합니다.
패키지 설치에는 네트워크를 사용하고, 이후 조회는 읽기 전용 마운트·네트워크 격리에서 실행합니다.

### 선택적인 로컬 의미 검색 런타임

새 소비자 환경에 tarball을 `--omit=dev`로 설치하면 로컬 임베딩 런타임은 제외됩니다.
현재 AI 세션을 통한 Wiki 작성, lexical 검색, 연결된 Wiki 조회와 MCP에는 이 런타임이
필요하지 않습니다. 개발용 `npm ci`는 테스트를 위해 런타임을 포함합니다.

Linux x64에서 로컬 semantic/hybrid 검색을 사용하려면 **BuildLore와 같은 설치 위치**에
정확한 버전의 런타임을 추가합니다.

```sh
npm install --prefix "$HOME/.local/buildlore" --omit=dev --save-exact @huggingface/transformers@4.2.0
```

별도 전역 설치만으로는 이 설치 위치에 런타임이 제공되지 않습니다. 모델 파일은 별도이며,
허브에서 기존 `model bind`, `model verify`, `index rebuild` 절차를 사용합니다. 런타임
설치가 모델을 다운로드하거나 인덱스를 생성하지는 않습니다. 사용 가능한 런타임이 없으면
의미 검색 작업은 기존 구조화된 사용 불가 오류를 반환하며, hybrid는 지원하는 경로에서
명시적인 검색 전환을 유지합니다. 연결된 프로젝트의 검색은 계속 lexical입니다.
사용자가 명시적으로 추가 설치한 런타임은 BuildLore 업데이트 후에도 유지됩니다.

`optionalDependencies`는 기본 설치에 포함되므로, BuildLore는 자동 설치되지 않는
선택적 peer 의존성을 사용합니다. 기본 설치에는 다른 컴파일러 의존성이 남으며,
특정 설치 용량이나 취약점 건수를 보장하지 않습니다.

개발자는 transformers 4.2.0을 필수 의존성으로 포함했던 이전 tarball과 준비된 로컬
`multilingual-e5-small` 모델 디렉터리를 지정해 업데이트 전환까지 검증할 수 있습니다.

```sh
BUILDLORE_EMBEDDING_BASELINE_TARBALL=/path/previous-buildlore.tgz \
BUILDLORE_EMBEDDING_MODEL_DIR=/path/multilingual-e5-small \
npm run verify:installed-read
```

폐기 가능한 설치에서 런타임 제거·복구·명시 설치 후 보존과 실제 로컬 semantic/hybrid
검색을 확인합니다. 모델은 테스트용으로 복사하며 유료 AI 호출은 없습니다.
앞서 설명한 npm 버전과 격리 도구가 필요합니다.

## 빠른 시작

### 1. 중앙 허브 생성

BuildLore가 `/d`에 설치되어 있고 독립 Git 프로젝트가 `/a`, `/b`, `/c`에
체크아웃되어 있다고 가정합니다. 모든 BuildLore 명령은 `/d`에서 실행합니다.
Mode A는 하나의 지식 저장소를 `/d/knowledge`에 연결합니다. 지식 저장소가 미리
존재해야 하며 사용자의 Git credential helper 또는 SSH agent로 접근할 수 있어야
합니다.

```sh
cd /d
node dist/cli/bin.js init \
  --knowledge-repo https://github.com/acme/example-knowledge.git \
  --branch main
node dist/cli/bin.js knowledge status
```

초기화는 허브 로컬 `.buildlore/local-projects.json` 레지스트리를 생성합니다.
머신별 절대 체크아웃 경로가 들어 있으므로 이 파일은 Git에서 제외됩니다. 이식
가능한 프로젝트 식별자는 지식 저장소에 남습니다.

### 2. 각 소스 프로젝트에서 수집 문서 선언

각 소스 프로젝트는 `.buildlore/sources.json`을 소유하고 Git에 커밋합니다.
허브는 선언된 프로젝트 루트 기준 상대 경로의 일반 파일만 읽습니다. 예를 들어
`/a/.buildlore/sources.json`은 Markdown 문서와 승인된 Plan2Agent 계획 문서를
다음처럼 선택할 수 있습니다.

```json
{
  "projectId": "a",
  "schemaVersion": "buildlore.sources.v1",
  "sourceRepository": "https://github.com/acme/a.git",
  "sources": [
    {
      "documentKind": "markdown",
      "id": "docs",
      "path": "docs",
      "pathType": "directory",
      "recursive": true
    },
    {
      "documentKind": "p2a-planning",
      "id": "planning",
      "path": ".plan2agent",
      "pathType": "directory",
      "recursive": true
    }
  ]
}
```

`/b`, `/c`에도 각자의 `projectId`, 저장소 식별자와 선택 범위를 가진 매니페스트를
만듭니다. BuildLore는 선언되지 않은 디렉터리를 크롤링하지 않으며 계획 문서만
선택한 경우 `.plan2agent/runs`와 `run-index.json`을 읽지 않습니다.

이 매니페스트는 허용되는 바이트 형태가 하나뿐입니다. BOM 없는 UTF-8, 2칸
들여쓰기, LF 줄바꿈을 사용하고 파일 끝에는 LF를 정확히 하나 둡니다. 최상위 필드는
`projectId`, `schemaVersion`, `sourceRepository`, `sources` 순서로 작성합니다. 파일
선언은 `documentKind`, `id`, `path`, `pathType` 순서이며, 디렉터리 선언은 마지막에
`recursive`를 추가할 수 있습니다. `sources`는 중복 없는 ASCII `id` 오름차순으로
정렬합니다. 내용의 의미가 같아도 필드·선언 순서, 들여쓰기 또는 줄바꿈 바이트가
다르면 BuildLore가 거부합니다.

#### 범용 JSON과 JSON knowledge adapter

JSON을 생산자와 무관한 일반 source로 수집하려면 `buildlore.sources.v2`를
사용합니다. 디렉터리를 선언하면 파일을 하나씩 나열할 필요 없이 선언한 경로 아래의
일반 `.json` 파일을 모두 선택할 수 있습니다.

```json
{
  "projectId": "a",
  "schemaVersion": "buildlore.sources.v2",
  "sourceRepository": "https://github.com/acme/a.git",
  "sources": [
    {
      "adapterId": "buildlore.json",
      "adapterVersion": 1,
      "id": "run-data",
      "kind": "json",
      "path": "artifacts/runs",
      "pathType": "directory",
      "recursive": true
    }
  ]
}
```

프로젝트의 `profile-binding.json`은 `buildlore.profile-binding.v2`를 사용하고 정확한
adapter registration digest를 결속해야 합니다. digest를 임의로 만들지 말고 공개
API `createProfileBindingV2(...)`로 계약을 생성합니다. 기존 v1 binding도 계속 읽지만
의도적으로 기존 adapter만 허용합니다. v2 binding을 설치한 뒤에는
`source add --kind json`으로 내장 JSON 선언을 추가할 수 있습니다.

내장 JSON adapter는 strict UTF-8/JSON parsing을 수행하고 중복 key와 자원 상한
위반을 거부하며, 객체 key를 canonical 순서로 정렬해 결정적인 Markdown evidence
source를 만듭니다. `SourceDocument` v3는 생성된 모든 범위를 원본 `sourceRef`, RFC
6901 JSON Pointer, 입력 hash 및 원본 위치에 연결합니다. 이 pointer는 compile,
activation, semantic indexing, query와 citation 조회까지 보존됩니다.

코드 없이 형식을 구체화하려면 선언의 `buildlore.json-metadata.v1` metadata values에
정렬된 `profiles`와 선택적인 `profileRequired`를 둡니다. 공개
`json-extraction-profile.schema.json` 계약은 exact match, include/exclude, title,
section, array, display label 및 sort 규칙을 정의합니다. 여러 profile이 동시에
일치하거나 required profile이 일치하지 않는 경우, pointer나 규칙이 잘못된 경우에는
fail-closed 처리하며 도메인 의미를 추측하지 않습니다.

신뢰하는 host는 `registerJsonKnowledgeAdapter(...)`로 versioned local adapter를
등록하고 그 registration을 `createProfileBindingV2(...)`에 추가한 다음 sync, source
management, compiler, activation 및 Wiki read service의 `jsonKnowledgeAdapters` 생성
옵션으로 주입할 수 있고 Wiki read에는 같은 definition을
`sourceAdapterRegistrations`로 전달합니다. Adapter는 BuildLore가 프로젝트 안에서
읽고 deep freeze한 parsed document와 provenance만 받습니다. writer, filesystem, network,
environment, clock 또는 process capability는 받지 않으며, 결과 draft도 공통
sanitizer와 atomic writer 전에 BuildLore가 상한과 결속을 검증합니다.

`p2aRunJsonKnowledgeAdapter()`는 같은 공개 계약 위에 구현한 선택적 reference
adapter입니다. 공식 CLI에는 미리 등록되어 있지만, 프로젝트가 exact profile binding과
명시적인 source 선언을 모두 갖춘 경우에만 활성화됩니다. 다른 신뢰하는 host는 이를
직접 등록·주입해야 합니다. P2A의 정확한 `runs/run-index.json` 파일을 adapter ID
`buildlore.p2a-run`으로 선언해야 하며 재귀 디렉터리 선언은 거부됩니다. BuildLore는
index에 등록된 run과 그 run이 참조하는 task graph, current/effective spec, execution
envelope, gate, current development contract만 프로젝트 경계 안에서 결정적인 폐쇄
집합으로 구성합니다. Index에 없는 과거 JSON은 읽지 않습니다. 지원하는
`p2a.run.v2`와 `p2a.run_index.v1`은 모든 reference, schema, digest, task contract 및
index summary가 정확히 일치할 때만 처리하며, 연결된 구현 run과 final verification을
병합하고 실패 후 성공 이력을 보존하며 중복 검증을 제거합니다. 폐쇄 집합 입력이
누락되거나 모호하거나 지원되지 않거나 불일치하면 collection 전에 selection이
fail-closed 됩니다.

먼저 `sync --dry-run`을 실행합니다. JSON parse/profile/adapter 실패와 quarantine은
값을 포함하지 않는 reason code로 보고되므로 source, binding, profile 또는 index를
수정한 뒤 다시 preview합니다. Sanitizer는 투영 결과에서 제외한 필드까지 선택된
JSON의 모든 필드를 검사하므로 extraction 규칙으로 의심되는 secret을 숨겨도 통과할
수 없습니다. P2A reference adapter는 폐쇄 집합 검증 후 schema의 정확한 기술
metadata만 정규화하고 구조화된 path/taxonomy는 각 구성 요소가 계속 검사되도록
분리합니다. Workspace 경로는 공통 sanitizer가 redaction할 수 있지만 의심되는
credential, 알 수 없는 고엔트로피 구성 요소 및 안전하지 않은 trace 내용은 계속
fail-closed 처리합니다.
Preview 또는 sync 실패 시 일부 source를 기록하지 않으며 정상 Wiki와 semantic index
authority도 교체하지 않습니다.

### 3. 허브에서 프로젝트 등록 및 바인딩

모든 작업은 프로젝트 ID를 명시적으로 사용합니다. BuildLore는 기본 프로젝트를
자동으로 추론하지 않습니다.

```sh
node dist/cli/bin.js project add \
  --id a \
  --name "Project A" \
  --source-repo https://github.com/acme/a.git \
  --source-root /a
node dist/cli/bin.js project add \
  --id b \
  --source-repo https://github.com/acme/b.git \
  --source-root /b
node dist/cli/bin.js project add \
  --id c \
  --source-repo https://github.com/acme/c.git \
  --source-root /c
node dist/cli/bin.js project list
node dist/cli/bin.js project show --project a
```

이 명령은 `knowledge/projects/a/`, `b/`, `c/`에 격리된 컴파일러 작업공간을
생성합니다. 저장소 위치에는 내장 자격증명, 쿼리 문자열, 프래그먼트, 사용자
정의 원격 helper 또는 개인 환경의 절대 경로를 포함할 수 없습니다.
`--source-root` 값은 검증 후 Git에서 제외된 로컬 레지스트리에만 저장되며 list,
show, JSON 출력, 오류 및 지식 파일에는 노출되지 않습니다.

이전 BuildLore 버전이 만든 이식 가능한 프로젝트에 바인딩이 없거나 체크아웃을
옮겼다면 로컬 바인딩만 마이그레이션합니다.

```sh
node dist/cli/bin.js project bind --project a --source-root /a
```

`project bind`는 기존의 이식 가능한 저장소 식별자와 소스 매니페스트를 검증합니다.
체크아웃을 추측하거나 소스 프로젝트를 다시 쓰지 않습니다.

### 4. 미리보기, 동기화, 명시적 컴파일

`sync`는 선택한 로컬 바인딩을 해석하고 해당 프로젝트가 선언한 파일만 읽어
정제한 뒤, 승인된 canonical 소스 문서를 일치하는 지식 작업공간에 기록합니다.
실제 기록 전에 전체 선택 및 보안 경로를 미리 확인합니다.

```sh
node dist/cli/bin.js sync --project a --dry-run
node dist/cli/bin.js sync --project a
node dist/cli/bin.js compile --project a
```

동기화는 컴파일, 게시 또는 제공자 호출을 자동 실행하지 않습니다. 컴파일은 별도의
명시적인 프로젝트 범위 작업입니다. 프로젝트 A를 선택하면 두 명령 모두 프로젝트
B나 C를 읽거나 변경하지 않습니다.

BuildLore는 소스 체크아웃을 읽기 전용으로 취급합니다. traversal, 심볼릭 링크,
일반 파일이 아닌 입력, 식별자 불일치, 크기·개수 제한, drift 및 의심되는 비밀은
저장 전에 fail-closed로 거부됩니다. 거부된 값과 절대 소스 루트는 출력하지
않습니다. 정제 소스, 위키 및 컴파일러 상태는
`/d/knowledge/projects/<project-id>/` 안에만 저장됩니다.

### 5. 필요한 경우 모델 제공자 접근 설정

로컬 프로젝트 관리, 동기화, 검사 및 lexical 검색에는 모델 제공자가 필요하지
않습니다. 컴파일과 질의에는 제공자가 필요합니다. semantic 또는 hybrid 검색과
context는 요청된 작업에 임베딩이나 모델 처리가 필요한 경우에만 제공자를
사용합니다.

제공자 자격증명은 프로세스 환경에만 두고 코드 또는 지식 저장소에 기록하지
않습니다. 예를 들어 OpenAI 호환 제공자는 다음처럼 설정합니다.

```sh
export LLMWIKI_PROVIDER=openai
export OPENAI_API_KEY=<value-from-your-secret-manager>
```

제공자 접근은 지식 저장소 안의
`projects/<project-id>/security-policy.json`으로도 제어합니다. 현재 배치에서는
`knowledge/projects/example/security-policy.json`입니다. 새로 등록된 프로젝트는
`restricted` 분류와 빈 egress 규칙을 가진
fail-closed 상태입니다. 데이터 분류를 검토한 후 외부로 전송할 수 있는
`public` 또는 `internal` 분류와 필요한 기능만 명시적으로 허용해야 합니다.
`restricted` 데이터의 외부 전송은 어떤 경우에도 허용되지 않습니다.

예를 들어 투영된 모든 입력이 `internal` 제공자 처리에 적합함을 확인했다면,
검토된 정책에서 실제 사용하는 작업만 다음처럼 허용할 수 있습니다.

```json
{
  "schemaVersion": "buildlore.security-policy.v1",
  "projectId": "example",
  "defaultClassification": "internal",
  "classificationRules": [],
  "egressRules": [
    {
      "allowedClassifications": ["internal", "public"],
      "capability": "compile"
    },
    {
      "allowedClassifications": ["internal", "public"],
      "capability": "context"
    },
    {
      "allowedClassifications": ["internal", "public"],
      "capability": "query"
    },
    {
      "allowedClassifications": ["internal", "public"],
      "capability": "search"
    }
  ],
  "overrides": []
}
```

정책 파일도 `sources.json`과 같이 BOM 없는 UTF-8, 2칸 들여쓰기, LF, 파일 끝의
LF 정확히 하나를 사용합니다. 최상위 필드는 `schemaVersion`, `projectId`,
`defaultClassification`, `classificationRules`, `egressRules`, `overrides` 순서입니다.
선택 필드 `sourceSecretHandling`은 `overrides` 뒤에 둡니다. `"mask"`로 설정하면
소스 수집에서 탐지된 자격증명과 고엔트로피 의심 구간만 마스킹한 뒤 전체를 재검사합니다.
원본 파일은 수정하지 않고, 통과한 파생본만 동기화·컴파일에 사용합니다. 생략하거나
`"reject"`로 설정하면 기존 보안 동작을 유지합니다. 정책 변경 후에는 다시 동기화하고
Wiki 생성 작업을 새로 준비해야 합니다.

마스킹은 AI가 작성한 사실·리뷰·평가나 외부 전송 권한에는 적용되지 않습니다.
비밀키, 프롬프트 주입, 불명확한 중첩, 검사 한도 초과, 재검사 실패 및 위험한 인용
메타데이터는 계속 차단합니다. `<REDACTED:CREDENTIAL>` / `<REDACTED:SECRET>`는
값을 알 수 없다는 표시이며, 해당 행은 새 지식 스냅샷의 사실 근거에서 제외합니다.
이 기능은 탐지된 위험을 처리하는 방식이지, 모든 비밀정보의 탐지를 보장하지는 않습니다.

분류 규칙은 `sourceKind`와 선택적인 `sourceIdentitySha256` 순서로 정렬합니다. Egress
규칙은 `capability` 순서로 정렬하고 `allowedClassifications`는 `internal`, `public`
순서로 둡니다. Override는 `sourceIdentitySha256`,
`sourceRevisionOrContentSha256`, `ruleId` 순서로 정렬합니다. Override 내부 필드는
선택적인 `auditRef`가 먼저이고, `reasonCode`, `ruleId`, `sourceIdentitySha256`,
`sourceRevisionOrContentSha256` 순서입니다.

Override는 와일드카드가 아닙니다. 예외 허용 가능한 규칙이 정확한 소스 식별자와
정확한 소스 revision/content digest에 모두 일치할 때만 적용됩니다. 선택된 내용이
바뀌면 이전 override는 더 이상 일치하지 않습니다. 일치한 값이나 비밀값을 override
또는 `auditRef`에 넣지 마세요. 프로젝트에서 사용하지 않는 egress 규칙은
제외합니다.

### 6. 위키 컴파일 및 검증

검토 모드는 생성된 페이지를 실제 위키에 반영하지 않고 컴파일러 후보 큐에
기록합니다. 일반 컴파일은 실제 컴파일 결과와 증분 상태를 기록합니다.

```sh
node dist/cli/bin.js compile --project example --review
node dist/cli/bin.js compile --project example
node dist/cli/bin.js check --project example
```

현재 Claude Code 또는 Codex 세션이 생성 작업을 맡을 때는 제공자가 필요 없는 별도
plan/apply 경계를 사용합니다.

```sh
node dist/cli/bin.js compile plan --project example --json
node dist/cli/bin.js compile apply \
  --project example \
  --page proposals/session-concept.json \
  --page proposals/session-decision.json \
  --json
```

`compile plan`은 정제된 소스 본문, 결정론적인 작업과 병합 후보, 원본 파일의 정확한
인용 위치, plan digest를 반환합니다. BuildLore는 이 plan을 저장하지 않으며 Claude나
Codex 실행 파일, agent SDK, 백그라운드 agent 또는 agent/provider 하위 프로세스를 실행하지
않습니다. 현재 호출 세션이 기존 skill과 subagent를 사용해 정규
`buildlore.compile-proposal.v1` 파일을 작성합니다. `compile apply`는 현재 plan을
다시 생성하고 모든 제안을 한 배치로 검증하며 생성 내용도 다시 검사한 뒤, public
SDK의 신뢰하지 않는 OKF import로만 결과를 편입합니다. 결과는 항상 보류된 검토
후보이며 실제 페이지로 승격하거나 기록하지 않습니다. 공개 JSON 계약은
`schemas/compile-*.schema.json`과
`schemas/session-compile-provenance.schema.json`에서 제공합니다.

제안 파일은 proposal schema에 표시된 필드 순서, 2칸 JSON 들여쓰기, LF 줄바꿈과
파일 끝의 LF 정확히 하나를 사용합니다. `proposalDigest`는 `proposalDigest` 필드만
제외한 canonical bytes의 소문자 SHA-256 앞에 `sha256:`을 붙인 값입니다.
`callerHarness.compatibilityDigest`는 `{ contractDigest, kind,
proposalSchemaVersion, version }`을 이 순서로 같은 canonical JSON으로 직렬화해
계산합니다. contract digest는 plan에서 가져오며 proposal schema version은
`buildlore.compile-proposal.v1`입니다. 하나라도 맞지 않으면 public compiler SDK를
호출하기 전에 거부합니다.

기본 profile의 `concept`, `query` 제안에는 `profileFields`를 넣지 않습니다. Custom
profile 제안은 검토 후보의 초기 상태만 사용합니다. `decision`은 `status: active`,
`failure`는 `failureClass`와 `status: open`, `verification`은
`verificationKind`, 하나 이상의 `evidenceRefs`, `status: recorded`가 필요합니다.
Kind별 조건과 필드 상한의 정본은 `compile-proposal.schema.json`이며, 이후 lifecycle
전이는 검토 단계가 소유하므로 `compile apply`로 요청할 수 없습니다.

격리된 프로젝트 작업공간에는 `sources/` 아래의 평탄화된 정제 소스,
`wiki/` 아래의 생성 페이지, `.llmwiki/` 아래의 컴파일러 상태와 적용된 언어
중립적 생명주기 프로필이 저장됩니다.

#### 프로젝트 지식 모드 (명시적 선택, 1단계)

범용 Markdown/JSON에서 프로젝트 사실을 정리하고 개요·구조·결정 문서 세 개를
만드는 모드입니다. P2A는 선택 가능한 소스 어댑터이며 지식 모델의 필수 조건이
아닙니다. 현재 개발 중인 opt-in 기능으로, 저장·갱신 테스트 통과가 독립 AI의
프로젝트 이해도 검증 통과를 뜻하지는 않습니다.

작성 전에 대상 프로젝트의 질문과 필요한 근거를 정하고, 기존 `compile hierarchy start` 명령에
다음 purpose 파일을 전달합니다.

```json
{
  "schemaVersion": "buildlore.hierarchical-workflow-purpose-input.v3",
  "projectId": "example",
  "generationModel": "project-knowledge-v1",
  "outputLanguage": "ko",
  "authoringQuestions": [{
    "id": "storage", "role": "architecture",
    "question": "어떤 저장 방식이 설정되어 있고 무엇을 제어하는가?",
    "requirements": [{ "id": "storage-value", "sourceRef": "settings.json",
      "jsonPointer": "/storage", "contentKind": "json-value" }]
  }]
}
```

반환된 `exchange`에는 정제된 근거와 이전 지식이 있습니다. 현재 대화 중인 AI가
전체 후보를 작성합니다. `compiler.createProposedKnowledgeRecord`로 사실 ID를,
`compiler.createKnowledgeProposal`로 제출용 정본 JSON을 만들 수 있습니다.
문장·제목·섹션마다 실제 근거에 연결해야 합니다.
[지식 계약](schemas/project-knowledge.schema.json)과
[워크플로 계약](schemas/project-knowledge-workflow.schema.json)을 참고하세요.

purpose v3은 범용 프로젝트 작성 지침과 고정된 질문이 있는 exchange v2를 반환합니다.
제출 입력은 `{ schemaVersion: "buildlore.knowledge-question-submission.v1", projectId,
proposal, questionAnswers: [{ id: "storage", claimIds: ["storage-setting"] }] }`입니다.
지정한 claim은 질문의 페이지에 있어야 하며 필요한 근거를 인용해야 합니다. start/status의
`sourceCoverage`에서 원문 포함 여부를, submit/review의 `questionCoverage`에서 답변 연결을
확인합니다. 누락된 질문, 잘못된 페이지, 인용하지 않은 필수 근거는 제출을 차단합니다.
질문과 답변 연결은 실행에 저장되어 재개·최종화·승인 시 재검사됩니다. 시작 후 purpose 파일을
수정해도 기존 실행의 요구는 바뀌지 않습니다. `reviewViewDigest`는 답변 연결까지 결속합니다.
검토자는 질문별로 실제 설명이 충분한지 판단해야 하며, 구조 검사의 `covered`는 의미상 합격을
보증하지 않습니다. purpose v2와 과거 실행은 재현성을 위해 원래 입력·exchange를 유지합니다.

purpose v3 실행에서는 작성 전에 질문별 코드·설정·테스트 근거를 읽을 수 있습니다.

```sh
node dist/cli/bin.js compile hierarchy inspect --project example --run <run-id> --input inspection.json --expect-exchange <exchange-digest> --json
```

```json
{
  "schemaVersion": "buildlore.knowledge-authoring-inspection-request.v1",
  "projectId": "example",
  "questionId": "storage",
  "operation": "find",
  "contains": "storage"
}
```

start/status의 `inspectionArgs`에 `--input <요청.json>`을 붙여도 됩니다. `sources`는 선택된
파일 목록을 반환하고 선택적 `contains`로 경로를 찾습니다. `find`는 근거 본문에서 대소문자를
구분하는 문자열 찾기이며 선택적 `sourceRef`로 파일을 한정합니다. `read`와 `sourceRef`는
해당 파일의 근거를 순서대로 읽습니다. 쓰지 않는 `sourceRef`, `contains`, `cursor`는 생략하거나
`null`로 지정합니다. `read`의 경로와 `find`의 검색 문자열은 여전히 필수입니다. 공개 SDK의
`compiler.parseKnowledgeAuthoringInspectionRequest` 결과를 `session.inspect`에 바로 전달하거나
JSON으로 저장해 CLI 입력에 사용할 수 있습니다. 현재 AI가 진입점,
호출되는 이름과 호출 위치, 설정, 오류 처리, 관련 테스트를 필요한 만큼 따라가며 확인합니다.
언어별 AST·호출 그래프 분석기나 의미검색·코드 실행 기능은 아닙니다.

실행의 스냅샷과 일치하는 기존 선택·정제 소스만 제공합니다. 미선택 경로, 다른 프로젝트,
알 수 없는 질문, 소스·authority 변경은 실행 상태를 바꾸지 않고 거절합니다. 추가 파일이
필요하면 수집 범위를 명시적으로 바꾸고 재동기화 후 새 문서 작성 실행을 시작해야 합니다.
조회 결과의 근거 ID·내용 digest·위치를 보존합니다. 줄 번호는 명시적인 origin 정보가 없는 한
정제된 투영 기준이지 원본 코드 파일의 줄 번호가 아닙니다. 코드 열람이나 테스트 정의는
실행 또는 현재 테스트 통과의 증거가 아닙니다.

현재 AI는 문서의 의도와 실제 구현을 대조해 역할·동작·차이·미확인을 설명하고 proposal의
facts와 `questionAnswers`에 근거를 연결합니다. 코드·설정·테스트 인용이 필수인 질문은 시작
전에 해당 소스를 requirements에 포함합니다. 조회 결과 자체는 의미상 승인이 아니므로
별도 검토자가 설명의 충분함과 문서·구현 불일치의 양쪽 근거를 판단해야 합니다. 코드에 없는
결정 이유를 만들어 넣지 않습니다. 조회는 최종화 전에 사용하며 exchange를 변경하거나
도구 호출 기록 제출을 강제하지 않습니다.

`cursor`, `limit`(1–50, 기본 10), `maxBytes`(8,192–1,048,576, 기본 65,536)로 나눠 읽습니다.
바이트 한도는 CLI envelope·들여쓰기를 제외한 compact JSON 조회 결과 기준입니다. 근거를
자르거나 건너뛰지 않습니다. 하나가 너무 크면 `item-too-large`, 빈 페이지, 재시도 cursor와
`minimumRequiredBytes`를 반환하므로 `maxBytes`를 늘려 다시 읽습니다. cursor는 스냅샷·질문·
작업·필터에 결속되어 필터를 바꿀 때는 처음부터 조회해야 합니다.
질문·응답 메타데이터 자체가 한도를 넘으면 CLI는 `KNOWLEDGE_INSPECTION_BUDGET_EXCEEDED`와
작은 오류 `data`를 반환합니다. SDK는 공개된 `compiler.KnowledgeAuthoringInspectionBudgetError`의
`details`로 같은 정보를 제공합니다. `byteBudget`, `minimumRequiredBytes`, `maximumBytes`,
`retryable`을 확인하고, 재시도가 가능하면 같은 요청·cursor의 `maxBytes`를 `minimumRequiredBytes`로
바꿔 다시 호출합니다. `retryable: false`면 지원 상한 안에 질문 전체를 담을 수 없으므로 질문 묶음을
조정한 새 작성 실행이 필요합니다. 필수 근거나 내용을 몰래 줄이지 않으며 보안 검사는 유지합니다.
오류 데이터는 `buildlore.knowledge-authoring-inspection-budget.v1`이고 정상 응답 계약은 그대로입니다.
스키마는 패키지의 `buildlore/schemas/project-knowledge-inspection.schema.json`으로도 불러올 수 있습니다.
[조회 계약](schemas/project-knowledge-inspection.schema.json)을 참고하세요.


### Wiki 갱신 전에 변경 영향 확인하기

검증된 이전 승인 generation이 있어야 합니다. 변경된 소스를 명시적으로 선택한 뒤 `sync`와
새 작성 실행의 `start`를 수행하고 `status`를 확인합니다. 갱신 전에 이전 `wiki memory`의
스냅샷 식별자를 보관하세요. 요청에는 이전 generation·snapshot digest와 새 exchange·snapshot
 digest가 필요합니다. 기준선이 없는 첫 작성 실행은 `KNOWLEDGE_INVALID`로 거절합니다.

```json
{
  "schemaVersion": "buildlore.knowledge-change-impact-request.v1",
  "operation": "change-impact",
  "projectId": "example",
  "expectExchangeDigest": "<새 exchange.exchangeDigest>",
  "expectSnapshotDigest": "<새 exchange.snapshot.snapshotDigest>",
  "expectBaselineGenerationDigest": "<이전 generationDigest>",
  "expectBaselineSnapshotDigest": "<이전 snapshotDigest>",
  "limit": 10,
  "maxBytes": 65536
}
```

자리표시자를 완전한 `sha256:…` digest로 바꾸고 `impact.json`으로 저장합니다.

```sh
buildlore compile hierarchy inspect --project example --run <run-id> --input impact.json --expect-exchange <새-exchange-digest> --json
```

SDK는 `session.inspectChangeImpact(request, session.exchange.exchangeDigest)`를 사용합니다.
`compiler.parseKnowledgeChangeImpactRequest`가 원시 JSON 입력을 검증하고 기본값을 채웁니다.
질문 없는 기존 작성 실행에도 사용할 수 있으며 `awaiting-proposal`, `review-ready` 상태에서
기존 exchange·status·run 저장 형식을 보존합니다. 별도 스키마는 패키지의
`buildlore/schemas/project-knowledge-change-impact.schema.json`으로 제공됩니다.

보고서는 바뀐 근거를 이전 current 사실과 이전 Wiki 문장 위치에 연결하며, 같은 사실의 일치하는
근거도 모두 보존합니다. 근거 일부만 달라져도 기존 reconciliation에서 그 사실은 새 제안·검토가
없으면 stale 대상입니다. `summary`는 페이지와 무관한 전체 비교 수치이며 근거 연결 수는 이전
current 사실 기준입니다. historical·superseded·stale 사실은 각각 제외 수치로 표시합니다.

`revision-metadata-changed`는 대응하는 발췌·소스 내용은 같고 식별자나 버전 정보가 다른 경우입니다.
`same-excerpt-source-changed`는 발췌가 같아도 소스 bytes나 위치가 바뀐 경우를 구분합니다.
둘 다 의미상 동일함이나 테스트 통과를 증명하지 않습니다. `content-changed`는 구조적으로 대응한
발췌의 변화이며 새 사실의 승인이 아닙니다. `source-unselected`, `aligned-evidence-unavailable`은
현재 선택 범위의 미확인이며 삭제의 증거가 아닙니다. 구조 후보가 여러 개면 모호함을 그대로
표시합니다. 문자열·의미 유사도, 이름 변경 추정이나 checkout 전체 탐색을 수행하지 않습니다.

`cursor`, `limit`(1–50), `maxBytes`(8,192–1,048,576)로 사실 단위로 나눠 읽습니다.
`item-too-large`는 사실을 자르지 않고 같은 위치의 cursor를 반환합니다. `retryable: true`이면
그 cursor와 `maxBytes: minimumRequiredBytes`로 재시도하며 페이지 크기도 바꿀 수 있습니다.
false이면 사실 전체가 지원 상한을 초과한 것으로 이 조회에서 건너뛸 수 없습니다.
용량은 `resultDigest`를 포함한 compact UTF-8 보고서 JSON 기준이며 CLI envelope·들여쓰기·마지막
줄바꿈은 제외합니다. 메타데이터 한도 초과는 원문을 담지 않는
`KNOWLEDGE_CHANGE_IMPACT_BUDGET_EXCEEDED` 오류를 사용합니다. SDK에서는
`compiler.KnowledgeChangeImpactBudgetError.details`로 확인합니다. expected 식별자나 cursor가
현재 입력과 맞지 않으면 `KNOWLEDGE_DRIFT`로 실패합니다.

기존 exchange·작성용 inspection과 정본 fact/evidence lookup으로 실제 정제 근거를 읽고,
근거 있는 새 사실과 범위가 명시된 supersession/conflict를 작성합니다. 이후 `submit` → 독립
`review`·`finalize` → 명시적 `approve` → `activationArgs` 순서로 갱신합니다.
보고서 자체는 지식을 수정하거나 승인하지 않습니다. 일반 `wiki memory`는 새 generation을
승인·활성화하기 전까지 마지막 승인 스냅샷을 설명합니다.

이 모드의 순서는 `sync` → `start` → 질문별 `inspect`·작성 → `submit` → `review` → `finalize` → `approve`
→ 반환된 `activationArgs`입니다. `submit`에는 `exchange.exchangeDigest`를,
`finalize`에는 `reviewViewDigest`와 독립적으로 작성한
`buildlore.knowledge-semantic-review.v1`을 전달합니다. 작성자와 다른 검토 세션이나
명시적인 사람 검토자가 모든 `reviewTargets`의 의미·범위·현재성·근거를 판단해야
합니다. 해시는 그 판단을 고정할 뿐 참임을 증명하지 않습니다.
주장 ID에는 `sha256:`, `title:`, `section:`, `supersession:`, `conflict:` 예약 접두사를
사용할 수 없고, 검토 대상과 판정 ID는 중복될 수 없습니다. 최종화 전 수정은
전체 `submit`으로 합니다. 기존 페이지별 `resubmit`/`child-review`는 이 모드에
적용되지 않으며 BuildLore가 AI를 자동 실행하지도 않습니다.

명시적으로 활성화한 결과는
`knowledge/projects/example/wiki/buildlore-hierarchy/`에 있습니다.
`overview.md`, `architecture.md`, `decisions.md`, `knowledge.json`, `evidence.json`,
`manifest.json` 여섯 파일입니다. Markdown과 JSON은 한 정본
`.llmwiki/buildlore-hierarchy/approved-authority.json`에서 재생성하는 투영입니다.
기존 Wiki를 처음 전환하기 전에는 같은 정본 저장소의
`archives/<authority-digest>.json`에 이전 authority를 보존합니다. 백업은 현재
검색 대상에 섞이지 않습니다.

새 프로젝트 지식 승인은 `buildlore.approved-wiki-authority.v3`와
`knowledge-authority-extension.v2`의 이력 참조를 사용합니다. 각 세대는 선택한
프로젝트의 `.llmwiki/buildlore-hierarchy/knowledge-history/objects/<generation-digest>.json`에
불변 파일로 저장됩니다. 작은 참조가 최초·최신 세대와 십진 문자열 개수를 결속하므로
이 경로에는 누적 16MiB·64세대 제한이 없습니다. 개별 세대의 16MiB·구조 제한은
유지합니다. 전체 검증은 세대별 파일과 digest만 담은 임시 spool을 사용하며,
보존 이력에 따라 디스크 사용량과 검증 시간은 증가할 수 있습니다.

승인은 검사된 불변 파일을 준비하고 후보 하나·정확한 이전 상태·승인 증명을 담은
activation-input v2를 생성합니다. 활성화는 별도 명령입니다. 기존 v1/v2 정본은
읽기만으로 변환하지 않습니다. 명시적인 v2→v3 교체 시 원래 정본 record의 바이트를
`archives/<record-digest>.record.json`에 그대로 보관합니다. 정본 교체 전 실패에는
기존 위키를 유지하고, 게시 journal을 통해 재시도합니다. 의미검색 인덱스는 별도로
`index rebuild`를 실행해야 갱신됩니다.

캐시가 있어도 매번 활성 정본과 참조된 모든 이력의 실제 바이트·파일 경계를 확인합니다.
과거 근거의 의미 검증과 현재 정책 보안 검사를 저장된 해시나 통과 표시로 대체하지 않습니다.
읽기는 이력 전환·삭제·embedding·인덱스 재생성을 수행하지 않습니다. 누락·변조·프로젝트
이탈은 원문 값을 포함하지 않는 구조화된 오류로 거절합니다.

SDK는 `CurrentApprovedWikiAuthority`를 비동기 publication reader 또는
`prepareCurrentApprovedWikiPublication`으로 검증한 뒤 `latestKnowledgeGeneration`과
`knowledgeAuthorityHistory`로 접근합니다. 기존 동기 parser는 미해결 v3 참조를 거절합니다.
작성에는 `previousHistory`, 답변 평가에는 `history`를 전달할 수 있으며, 기존 세대 배열과
동시에 지정하거나 JSON으로 검증 capability를 재구성할 수 없습니다.

재생성은 보존된 전체 generation chain을 재현 검증한 뒤 모든 텍스트와 metadata를
현재 보안 정책으로 재검사합니다. 현재 Wiki에 표시되지 않는 과거 source snapshot과
검토 이유도 포함합니다. 검사할 때 실제 줄바꿈과 필드 경계를 유지하여 JSON 직렬화가
서로 무관한 필드를 하나의 지시문처럼 만들지 않도록 합니다. 개별 값을 통과시키기 위해
자르거나 마스킹하거나 분할하지 않으며, 거절되면 새 생성을 막고 활성 Wiki를 유지합니다.

```sh
node dist/cli/bin.js wiki read --project example --page overview --json
node dist/cli/bin.js wiki citations --project example --page decisions --json
node dist/cli/bin.js search --project example --query "저장 방식 결정" --mode lexical
```

프로젝트 지식 검색은 `buildlore.project-knowledge-search.v2`와
`supportScope: "matched-section"`을 반환합니다. 각 결과에는 일치한 섹션의 주장·사실·근거만
포함하고, 자식 요약의 근거는 실제 요약이 있는 overview 첫 섹션에만 붙입니다.
`wiki read`/`citations`는 전체 페이지를 제공합니다. 활성화 후 `index rebuild --project <id>`를
실행하면 semantic/hybrid 검색은 해당 프로젝트의 현재 Wiki와 일치하는 로컬 인덱스를 사용합니다.
인덱스나 모델이 없거나 호환되지 않으면 semantic은 원인과 복구 방법을 포함한 오류를 반환하고,
hybrid는 이유를 표시하며 키워드·그래프 검색으로 전환합니다.

프로젝트 지식 검색은 `semanticRelevancePolicy`를 표시하고 순위 통합 전에 저관련성 의미검색
후보를 제외합니다. 고정된 multilingual-e5-small 모델의 기준은 같은/미확인 문자권 0.820646121668,
서로 다른 문자권 0.765124142709의 cosine 점수입니다(V2, calibration version 2). 혼합 기술 문서는 Latin 식별자 속 비Latin 본문도
인식합니다. 이는 주제 관련성의 경험적 기준이지 정답 존재 판정이나 정확도 확률은 아닙니다.
두 범용 프로젝트의 한국어·영어 질문으로 검증했으며 다른 언어·분야에는 추가 평가가 필요합니다.
모든 의미 후보가 제외되면 fallback 없이 빈 결과를 반환합니다. hybrid의 키워드·그래프 후보와
기존 계층형 검색은 유지합니다. 읽기 객체는 매번 경로와 전체 파일 bytes의 해시를 확인한 뒤
변경되지 않은 승인 데이터의 검증 결과를 재사용합니다. 정본이나 보안 정책 변경은 다시 검사하며,
새 CLI 프로세스에는 최초 승인 검증·모델 준비 비용이 남습니다.

원문 값의 관찰(`observed`), 문서의 선언(`declared`), 추론(`inferred`)을 구분합니다.
검토된 `accepted` + `current`만 현재 설명으로 쓰고, 과거·대체·근거 소실·분쟁
상태는 따로 표시합니다. JSON의 `passed`/`done`은 현재 코드의 검증 증거가 아닙니다.
저장소 HEAD·Git 추적 여부와 실제 증명된 소스/코드 revision도 구분하며, 모르는
revision은 `null`입니다. 근거 소실을 기능 제거로, 수집 범위 축소를 파일 삭제로
추측하지 않습니다. 필수 입력을 읽지 못하면 새 생성은 차단됩니다.
이미 대체된 사실을 다시 제안해 현재로 되살리거나 대체 관계를 지울 수 없습니다.
과거 사실을 재검토해도 기존 대체 관계는 보존하며, 후속 변경은 대체 이력을 이어갑니다.

새 작성 실행은 `knowledge-markdown-v2`를 사용합니다. 인용된 원문의 정확한 발췌문을
이스케이프하여 표시하고 원래 위치와 `heading` / `json-value` / `text`를 구분합니다.
원문 주장은 `[evidence:sha256:<64자리 hex>]`, 기록된 지식 상태는 `[fact:sha256:<64자리 hex>]`로
인용합니다. 상태 설명에는 대체 사실 ID와 해당 snapshot에 남아 있거나 없는 근거 ID를 표시합니다.
이는 기록의 출처·이력이며 실제 코드 동작이나 원문이 사라진 원인을 증명하지 않습니다.
기존 v1 정본·진행 중 v1 실행·v1 평가 기록은 원래 렌더러와 바이트를 유지합니다.
v2 표시를 적용하려면 새 generation을 검토하고 명시적으로 활성화해야 합니다.
패키지 갱신이나 기존 문서 읽기만으로 활성 Wiki를 교체하지 않습니다.

작성 전에 `compiler.createKnowledgeEvidenceCoverage(snapshot, requirements, projectId)`로 필요한
근거가 전달되었는지 확인할 수 있습니다. 각 요구는 `{ id, sourceRef, jsonPointer, contentKind }`이며
`jsonPointer: null`은 파일 전체, `contentKind`는 `any`, `json-value`, `text` 중 하나입니다.
결과는 `available` / `heading-only` / `unavailable`과 일치하는 근거 ID입니다. 누락된 필드를 빈 배열로
간주하지 않으며 누락 원문을 추가 수집하거나 어댑터를 바꾸는 기능은 아닙니다. 예를 들어
`{ id: "storage", sourceRef: "settings.json", jsonPointer: "/storage", contentKind: "json-value" }`는
제목이 아닌 실제 값을 요구합니다. `compiler.inspectKnowledgeProposalGrounding(snapshot, proposal,
projectId, previousGenerations?)`는 최종화 전 claim별 기존 단어 겹침 검사의 점수를 보여줍니다.
검사 기준을 낮추거나 의미 검토를 대체하지 않습니다. 점수를 맞추려고 무관한 문구·근거를 추가하지 마세요.
두 함수는 정제·저장을 하지 않는 순수 변환이므로 세션이 제공한 정제 snapshot을 사용해야 합니다.
특정 문서 생산 도구의 필드를 하드코딩하지 않는 범용 기능입니다.

질문별 누락은 `compiler.inspectKnowledgeQuestionCoverage(snapshot, proposal, questions,
projectId, previousGenerations?)`로 확인합니다. 각 질문은 `{ id, claimIds, requirements }`이고
`requirements`에는 위의 소스 요구를 넣습니다. `unavailable` / `heading-only`는 필요한 원문이
없거나 제목만 있다는 뜻이며, `uncited`는 원문은 있지만 그 질문에 연결한 문장에서 인용하지
않았다는 뜻입니다. 다른 질문에 달린 인용으로 누락을 채울 수 없습니다. `covered`는 연결 확인이며
문장이 필요한 내용을 의미상 설명하는지는 독립 검토가 판단합니다. 결과는 snapshot·proposal·요구
digest에 결속됩니다. SDK의 `session.submit(proposal, exchangeDigest, questions)`는 불완전한
연결을 제출 전에 거절합니다. 기존 SDK 진단과 purpose v2는 계속 지원하며, 실제 CLI 수명주기에서
질문 요구를 고정·강제하려면 위의 purpose v3을 사용합니다. 작성 요구와 숨겨진
평가 정답은 구분하며, 평가 정답을 reader에게 전달하지 않습니다.

요약 어댑터가 필요한 JSON 필드를 생략한다면 해당 파일에 기존 `buildlore.json`과 사용자 추출
프로필을 선택할 수 있습니다. [실행 검증된 세부값 프로필 예시](test/fixtures/project-knowledge/source-details-example.json)는
일반 JSON Pointer로 검증 배열·작업 상태·명세 승인을 보존합니다. 필드 이름은 사용자 설정에
있으며 지식 코어가 P2A를 해석하지 않습니다. 같은 파일을 요약 어댑터의 입력 묶음과 범용 선언에
동시에 넣으면 중복으로 거절되므로 수집 방식을 하나 선택해야 합니다. `required` Pointer는 없는
필드를 거절하고, 실제 빈 배열은 원래 Pointer와 함께 `_Empty array._`라는 `text` 근거로 전달됩니다.
프로필에서 제외한 필드까지 포함한 원본 전체 보안 검사는 그대로 적용됩니다.

읽기·근거 응답은 같은 generation의 사실과 근거를 반환합니다. 의미검색에도 동일한
generation의 인덱스만 사용하며 옛 캐시를 혼합하지 않습니다. 사용할 수 없는 인덱스는
semantic에서 오류, hybrid에서 명시적인 키워드·그래프 검색 전환으로 처리합니다.
기존 검색 intent도 적용하고 상위 검색 결과의 하위 문서 인용을 별도로
표시합니다. 검색 순위에는 인용된 섹션별 검토된 사실 상태와 하위 요약 상태를 전달하되
저장된 검색 자료나 기존 순위 계산 규칙은 바꾸지 않습니다. 같은 근거를 인용해도 다른
섹션의 현재성이 섞이지 않습니다. 최초 활성화는 대상 디렉터리가 없거나 비어 있어야 하며,
기존 정본에 연결되지 않은 파일은 생성 파일과 이름이 같더라도 덮어쓰지 않습니다.
관리 Markdown을 직접 수정하면 drift로 덮어쓰기를 차단합니다.
Git/백업에서 검토된 원래 파일을 복구한 뒤 재시도하세요. 정본을 임의로 수정하거나
해시를 다시 계산하여 복구하지 마세요. 새 clone의 기존 지식 읽기에는 작성 당시의
로컬 run/key가 필요 없지만 새 작성에는 소스 바인딩이 필요합니다.

SDK에는 [AI 답변 평가 기록 계약](schemas/project-knowledge-answers.schema.json)도 있습니다.
문서 작성 전에 독립 검토한 질문·판정 기준을 `compiler.createAnswerEvaluationContract`로 고정합니다.
`compiler.createKnowledgeAnswerEvaluationService({ knowledgeRoot }).prepare`에 계약과 동일 프로젝트의
generation 이력, 선택적 `runtimeContext`를 전달합니다. 정제 검사를 거쳐 작성 안내·질문 5개·실제
Markdown 3개를 독해용으로 제공하며, 정답 기준과 작성 대화는 포함하지 않습니다.
`session.lookup(questionId, evidenceIds)`는 해당 generation의 정제 근거만 반환하고, 중복 조회도
포함하여 최대 10회·누적 16,384 UTF-8 바이트를 제한합니다. v2 generation에서는
`session.lookupFacts(questionId, factIds)`로 사실 기록·generation 이력·현재 snapshot의 근거 포함 여부도
동일한 공용 예산 안에서 조회합니다. `retrieval.createKnowledgeWikiReader`의
`fact(projectId, expectedGenerationDigest, factId)`도 정제 검사 후 활성 generation의 상태를 반환합니다.
v2 답변 claim의 `evidenceIds`와 `factIds`는 별도 배열이며 답변 본문에 실제로 적힌 구분 인용과 일치해야
합니다. 사실 ID를 원문 근거 ID로 대신 사용할 수 없고 추가 조회는 한 번에 한 종류만 요청합니다.
질문 5개와 바이트 한도는 그대로이며 v1 평가는 기존 인용 규칙을 유지합니다.
`session.serializeReport(input)`는 실제
조회 이력과 평가 입력을 검증·정제한 감사 JSON을 반환합니다. 로컬 평가 파일 저장은 호출자가
담당합니다. 새 CLI 명령이나 AI 자동 실행 기능이 아닌 SDK 인터페이스입니다.

새 평가에는 같은 입력으로 `compiler.createReaderAnswerEvaluationContract`를 명시적으로 선택하고
문서 작성 전에 고정할 수 있습니다. 별도 계약 해시(`knowledge-answer-contract.v2`,
`contextFormat: "knowledge-reader-v1"`)가 생성되며 `knowledge-markdown-v2` generation이 필요합니다.
초기 입력은 작성된 Wiki 본문 전체·사실 범위/상태·구분 인용 ID를 유지하고, 긴 원문 근거와 전체 사실
출처 정보는 필요할 때 조회합니다. 저장된 Wiki Markdown과 기존 계약·평가 기록은 바뀌지 않습니다.
기존 평가의 계약을 뒤늦게 바꾼 뒤 원래 기준에 합격했다고 취급하지 마세요.
이 계약에서 `session.lookup`은 `knowledge-evidence-context.v1` 형식으로 정확한 근거와 동일한 정제
snapshot의 상위 Markdown 제목(ATX/Setext)을 반환합니다. 코드 블록의 제목 예시는 제외하며,
현재 snapshot에 없는 과거 원문의 문맥이나 마스킹된 제목은 복원하지 않고 미제공/부분 제공으로
표시합니다. 주변 문단 전체나 의미상 지지의 증명은 아닙니다. 제목·메타데이터를 포함한 응답 전체가
공용 조회 예산에 포함됩니다. 해당 질문 또는 앞선 질문에서 원문을 조회하지 않은 근거 인용은
평가 실패이며, ID가 보이거나 사실 상태를 조회했다는 것만으로 원문을 읽은 것으로 인정하지 않습니다.

### 개발 에이전트용 프로젝트 메모리

`buildlore wiki memory --project example --json`은 승인된 프로젝트의 Wiki 본문,
사실 상태, 출처와 revision 정보를 `buildlore.knowledge-development-memory.v1`으로 반환합니다.
SDK는 `retrieval.createKnowledgeWikiReader(knowledgeRoot).readMemory('example')`입니다.
임베딩이나 모델 호출, 재색인, 지식 쓰기 없이 동작합니다. 상세 사실과 원문은 기존
`wiki lookup --expect-generation`으로 읽으며, 근거 ID를 받았다는 사실은 원문 열람을 뜻하지 않습니다.
개발 안내는 호스트가 허용한 코드 조사·수정·테스트를 지원하고 과거 결과와 현재 검증을 구분합니다.
도구 권한을 부여하거나 소스를 자동 수집하지 않습니다.

문서 작성에는 `compiler.createDevelopmentMemoryQuestions`로 다섯 지식 항목을 명시할 수 있습니다.

```js
import { compiler } from 'buildlore';

const authoringQuestions = compiler.createDevelopmentMemoryQuestions({
  purpose: [{ id: 'purpose-source', sourceRef: 'docs/README.md', jsonPointer: null, contentKind: 'text' }],
  architecture: [],
  decisions: [],
  'current-state': [],
  'failures-open-work': [],
});
```

결과를 기존 purpose v3 입력에 넣습니다. 선택한 소스에 맞게 빈 목록에 요구사항을 추가합니다.
각 질문에는 `development-memory-v1` 표시가 붙습니다. 요구를 지정하지 않은 항목은 **미점검**이며
답변의 claimIds도 비워야 합니다. 해당 지식이 프로젝트에 없다는 뜻은 아닙니다.
선택한 항목은 필요한 소스 근거와 문장 연결을 모두 충족해야 합니다. 미점검 항목의
source-coverage에는 `coverage: null`이 표시됩니다.

제출·검토 결과의 `developmentMemoryInspection`은 다섯 항목과 정확한 페이지·문장 위치,
사실·근거 연결을 보여줍니다. 점검 digest는 재개 후에도 기존 검토 view에 결속됩니다.
SDK에는 `inspectDevelopmentMemoryContent`와 검증된 history를 받는 대응 함수도 있습니다.
이는 명시한 구조의 점검이며 `semanticReviewRequired`는 항상 true입니다. 정확성과 충분성은
근거 검토와 별도의 문서·개발 과제 평가로 판단해야 합니다. 점검 결과는 작성·검토 흐름에 두며
과거 generation의 항목을 추측해서 채우지 않습니다. 기존 일반 질문과 평가 packet, generation의
동작과 형식은 유지합니다.

### 개발 인수인계 질문과 실제 CLI 읽기 평가

`compiler.createDevelopmentHandoffQuestions(requirements)`는 목적(`purpose`), 구조(`architecture`),
현재 상태(`current-state`), 결정 이유(`decisions`), 변경 이력(`changes`)의 질문 5개를 만듭니다.
이 다섯 키에 각각 기존 `{ id, sourceRef, jsonPointer, contentKind }` 근거 요구 배열을 지정하고,
결과를 purpose v3의 `authoringQuestions`에 넣습니다. 자료 선택은 호출자가 소유하며 특정 언어나
P2A를 요구하지 않습니다. 직접 작성한 질문도 계속 사용할 수 있습니다.

새 인수인계 질문은 해당 답변 안의 작성 주체·전달/저장 전 검사, 변경된 동작과 유지된 정상/오류 응답,
버전별 검증 범위를 함께 요구합니다. 조회 지침은 독립 검토자가 선택된 근거로 이 내용을 확인하도록
안내하지만 의미상 충족을 자동 인증하지는 않습니다. 새 factory 호출부터 보강된 문구를 사용하며,
이미 저장된 질문·exchange 지침/해시와 호출자가 직접 작성한 질문은 다시 쓰지 않습니다.
질문별 주제 점검은 실행 기능뿐 아니라 근거가 있는 문서·작성 지침·개발 절차 변경도 포함합니다.
관련 주제를 먼저 목록화하고 해당 답변의 인용 문장과 대조해 제출 전에 누락을 확인합니다.
다른 답변에만 언급한 것은 충족으로 보지 않으며, 이 지침 자체가 의미상 합격을 자동 인증하지는 않습니다.

작성 전 기존 inspect 요청에 `operation: "coverage"`와 질문 ID를 지정합니다(`sourceRef`, `contains` 생략).
요구별로 `available`(근거 있음), `heading-only`(제목만 있음), `source-not-selected`(현재 수집 범위 밖),
`detail-unavailable`(수집 자료 안에서 요구한 상세 근거를 찾지 못함)을 페이지 단위로 반환합니다.
원본에 내용이 없는지, 필터링·마스킹으로 빠졌는지까지 추측하지 않습니다. 근거의 의미상 지지나 실제
열람 여부도 증명하지 않습니다. 제출 후에는 기존 `questionCoverage`가 필수 근거의 인용 누락을 확인합니다.
조회 지침은 개발 주제별 이전/현재 상태·이유·영향·검증·남은 일을 연결하고 관련 코드의 입출력,
호출 관계·실패 처리·테스트를 확인하도록 안내합니다. 필요한 추가 근거는 선택된 소스 안에서 조회합니다.
정직하게 미확인이라고 썼더라도, 자료에 있는 필수 답을 누락했다면 정보 충족도는 미달입니다.
보안 검사와 기존 제출 조건은 그대로 유지합니다.

```sh
node dist/cli/bin.js wiki read --project example --page architecture --view reader --json
node dist/cli/bin.js wiki lookup --project example --kind evidence --id <evidence-digest> --expect-generation <generation-digest> --json
node dist/cli/bin.js wiki lookup --project example --kind fact --id <fact-digest> --expect-generation <generation-digest> --json
```

`--view reader`는 작성된 본문 전체·사실 범위/상태·조회 ID를 제공하고 긴 근거 원문의 중복을 줄입니다.
기본값과 `--view full`은 기존 전체 응답을 유지합니다. reader 모드는 활성 project-knowledge generation이
필요하며 legacy 페이지로 몰래 대체하지 않습니다. lookup은 한 ID의 원문·제목 문맥 또는 전체 사실 상태를
반환하고, 읽는 사이 generation이 바뀌면 거절합니다. 읽기 명령은 동기화·재생성·활성화를 수행하지 않습니다.

새 평가는 `compiler.createCliReaderAnswerEvaluationContract`로
`contextFormat: "knowledge-cli-reader-v1"`을 고정할 수 있습니다. 초기 Wiki와 추가 조회는 실제 CLI의
동일한 `data` 객체 전체를 canonical JSON으로 제공하며 generation 메타데이터도 바이트에 포함합니다.
질문·예산·실제 근거 열람 검사·독립 판정 조건은 유지합니다. CLI/도구 외곽 응답과 알려진 세션 안내는
`runtimeContext`에 따로 집계하며, 누락한 상태로 전체 입력량을 측정했다고 주장하지 않습니다.
기존 평가 형식과 해시는 유지됩니다. 프로토콜 테스트 통과는 실제 Wiki 품질 합격이 아닙니다.
[읽기 응답 계약](schemas/project-knowledge-reader.schema.json)을 참고하세요.

`compiler.createKnowledgeAnswerEvaluationService({ knowledgeRoot }).inspect`는 `prepare`와 같은 입력으로
정제 검사 후 항목별 바이트·확인된 초기 입력량·추가 문맥 확인 여부·한도·`exceedsBudget`를 반환하며
내용은 내보내지 않습니다. 입력 초과 상황도 진단할 수 있지만 `prepare`는 자르지 않고 거절합니다.
이는 입력량 진단이지 품질 판정이 아닙니다. 32,768바이트는 고정 비교 예산이며 모델 문맥 한도,
토큰 수 또는 저장 Wiki 전체의 크기 제한이 아닙니다. 실제 AI 답변에 적합한지는 독립 평가가 필요합니다.

보관된 이력은 구조·재생성 검증 후 AI 전달 문맥과 별도로 보안 검사합니다. 모든 스냅샷·검토·메타데이터와
JSON 소스의 디코딩된 키·값을 검사 대상에 유지합니다. 동일 필드의 중복 검사를 줄이고 한정된 묶음으로
검사하되, 탐지나 크기 제한을 피하려고 개별 값을 자르지 않습니다. 검사 한 번당 8MiB 제한과 기존 구조
제한은 그대로이며 실제 초기 문맥·추가 조회·평가 보고서도 각각 보안 검사를 거칩니다.
원문 없는 오류 코드로 `KNOWLEDGE_SECURITY_INPUT_TOO_LARGE`(검사 크기 초과),
`KNOWLEDGE_SECURITY_BLOCKED`(보안 거절), `KNOWLEDGE_CONTEXT_BUDGET_EXCEEDED`(독자 예산 초과)를
구분합니다. 잘못된 구조나 구조 상한 초과는 `KNOWLEDGE_INVALID`이며 보안 실패 시 부분 문맥이나
크기 진단도 반환하지 않습니다.

답변 전체를 UTF-8 바이트 구간별 claim 판정에 연결하고, 모든 기대 기준도 독립 검토해야 합니다.
근거 ID가 유효하다는 검사와 의미상 지지 여부는 별개입니다. 초기 문맥은 32,768바이트,
질문별 답변은 8,192바이트이며 답변 초과분을 몰래 자르지 않고 실패로 기록합니다.
`runtimeContext`는 알려진 추가 세션 안내·문맥을 집계합니다. 이를 제공받지 못하면 전체 초기
문맥량은 `null`, 제공한 분량은 별도로 기록하고 실제 평가는 미완료입니다. 이 값을 채우려고
비공개 시스템 지침을 내보내지 마세요. 토큰 수는 실제 계측값 또는 `null`과 미제공 사유로
구분하며 바이트에서 추정하지 않습니다. `recorded-pass`는 입력된 판정·세션 확인 기록의 요약일 뿐,
실제로 독립 AI 평가를 수행했다는 증명이 아닙니다. `fixture-only`는 실제 품질 합격으로 취급하지
않습니다. 최초 두 표본의 독립 AI 평가에서는 인용·정보 누락 문제가 확인되었습니다.
v2 개선 코드의 새로운 독립 AI 품질 평가는 아직 통과하지 않았으며 코드 테스트를 품질 합격으로
간주하지 않습니다.

#### 기존 계층형 모드의 권장 CLI 흐름

현재 Codex 또는 Claude 세션이 계층형 위키를 작성할 때는 CLI가 권장 제품
흐름입니다. 모든 handoff 경로는 BuildLore 허브 기준 상대 경로이며, digest 인자는
직전 명령의 결과에서 정확히 복사해야 합니다.

```sh
# 정제된 프로젝트 corpus를 갱신한 뒤 로컬 run을 만들고 상태를 확인합니다.
node dist/cli/bin.js sync --project example
node dist/cli/bin.js compile hierarchy start \
  --project example \
  --purpose handoffs/wiki-purpose.json \
  --json
node dist/cli/bin.js compile hierarchy status \
  --project example \
  --run run-<소문자-16진수-64자리> \
  --json

# 반환된 exchange를 이미 실행 중인 agent 세션에 전달하고 그 JSON 응답을 제출합니다.
node dist/cli/bin.js compile hierarchy submit \
  --project example \
  --run run-<소문자-16진수-64자리> \
  --input handoffs/page-submission.json \
  --expect-exchange sha256:<exchange-digest> \
  --json

# page hard-quality 실패는 run을 폐기하지 않습니다. status가 반환한 새 exchange로
# 해당 page만 고치며 page별 재제출은 최대 세 번입니다.
node dist/cli/bin.js compile hierarchy resubmit \
  --project example \
  --run run-<소문자-16진수-64자리> \
  --page page-<소문자-16진수-64자리> \
  --input handoffs/corrected-page-submission.json \
  --expect-exchange sha256:<새-exchange-digest> \
  --json

# child synthesis를 명시적으로 검토한 뒤 통합 콘텐츠 diff와 품질을 검토합니다.
node dist/cli/bin.js compile hierarchy child-review \
  --project example \
  --run run-<소문자-16진수-64자리> \
  --input handoffs/child-review.json \
  --expect-review sha256:<child-review-digest> \
  --json
node dist/cli/bin.js compile hierarchy review \
  --project example \
  --run run-<소문자-16진수-64자리> \
  --json

# 검토된 surface를 최종화하고 별도의 명시적 사람 승인을 기록합니다.
node dist/cli/bin.js compile hierarchy finalize \
  --project example \
  --run run-<소문자-16진수-64자리> \
  --input handoffs/final-review.json \
  --expect-review sha256:<integrated-review-digest> \
  --json
node dist/cli/bin.js compile hierarchy approve \
  --project example \
  --run run-<소문자-16진수-64자리> \
  --expect-ledger sha256:<ledger-digest> \
  --confirm-approval \
  --json

# 승인은 활성화가 아닙니다. approve가 반환한 bundle 경로와 digest를 별도 명령에 제시합니다.
node dist/cli/bin.js compile activate \
  --project example \
  --input .buildlore/hierarchy-runs/example/run-<소문자-16진수-64자리>/approved-wiki.json \
  --confirm-approval sha256:<approval-digest> \
  --json
node dist/cli/bin.js compile hierarchy status \
  --project example \
  --run run-<소문자-16진수-64자리> \
  --json

# clean/active 상태가 되면 일반 위키 및 검색 명령으로 읽습니다.
node dist/cli/bin.js wiki list --project example --json
node dist/cli/bin.js wiki curate --project example --json
node dist/cli/bin.js wiki read --project example --page page-<소문자-16진수-64자리> --json
node dist/cli/bin.js wiki citations --project example --page page-<소문자-16진수-64자리> --json
node dist/cli/bin.js search --project example --query "검토된 활성화 계보" --mode graph
```

각 명령은 서로 다른 OS process에서 실행해도 됩니다. BuildLore는 프로젝트에 격리된
run을 Git에서 제외된 로컬 `.buildlore/hierarchy-runs/`에 보관하고, 다음 단계로
진행하기 전에 정제된 입력, exchange, generation receipt, review 및 ledger binding을
결정론적으로 재생합니다. `review` 결과는 통합 콘텐츠 diff와 결정론적 품질 보고서를
보여줄 뿐 candidate를 승인하지 않습니다. `approve`는 명시적인 사람의 결정을
기록하지만 활성화, Git 게시 또는 암묵적 승인을 수행하지 않습니다.
이전 계층 계약에서 생성된 미완료 run은 현재 계약으로 변환하지 않습니다. `status`는
`policy-outdated`와 `start-new-run` 복구 동작을 반환합니다. 반면 이전 계약에서 이미
활성화된 authority는 계속 읽을 수 있고 Markdown을 다시 materialize할 수 있습니다.

이 흐름에서 BuildLore는 Codex, Claude, 모델 provider, agent SDK 또는 agent/provider
하위 process를 실행하지 않습니다. Proposal을 직접 작성하거나 review를 자동 수락하거나 암묵적으로
활성화하거나 Git에 자동 게시하지도 않습니다. 이미 실행 중인 호출 세션이 proposal
작성을 소유하고 선언된 JSON handoff만 BuildLore에 돌려줍니다.

#### 라이브러리 API

purpose의 선택적 `wikiTitle`은 루트 위키 제목이 되며, 생략하면 등록된 프로젝트 표시
이름을 사용합니다. 제품 수준 라이브러리 경계는
`createHierarchicalWorkflowService({ hubRoot, knowledgeRoot })`입니다.
`start/status/submit/resubmit/childReview/review/finalize/approve` 메서드는 CLI와 같은 흐름을
제공하면서 Git에서 제외된 프로젝트 격리 로컬 run을 저장하고 재생합니다. `approve`는
정확한 `activationBundlePath`, approval digest와 `activationArgs`를 반환합니다. 사람이
검토된 generation을 활성화하려는 경우에만 이 값을 별도 activation service에
전달합니다.

하위 수준에서 계층형 위키는 이미 실행 중인 agent 세션을 import 가능한
`createCurrentSessionGenerationService({ knowledgeRoot })` API로 연결할 수 있습니다.
`prepare(...)`는 작성 목적, 정제된 evidence, 검토된 하위 문서 요약, 작성 지침과
정확한 proposal 계약을 하나의 bounded JSON exchange로 반환합니다. 현재 agent에는
이 exchange만 전달하고, agent가 반환한 versioned
`buildlore.current-session-proposal-submission.v2` 응답을 `session.submit(...)`에
전달합니다. `prepare(...)`에는 같은 process에서 `createEvidencePack(...)`이 반환한
원본 `EvidencePackV1`만 사용할 수 있으며, prepare 전에 pack을 JSON round-trip하면
거부됩니다. Leaf부터 parent까지 하나의 service instance를 재사용해야 검증된 하위
문서 증명이 parent 합성에 유지됩니다. BuildLore는 프로젝트·페이지·exchange·요청·
snapshot·현재 sanitizer 정책 binding을 다시 검사하고 생성 문장도 재검사한 뒤
claim/proposal digest를 직접 계산합니다. 결과는
게시 문서가 아니라 검토할 candidate와 generation receipt입니다. 공개 JSON 계약은
`schemas/hierarchical-current-session.schema.json`입니다.
Exchange v2는 실제 적용되는 rule code와 required/optional section guide를 제공합니다.
응답은 모든 required section을 포함해야 하고 고유한 optional section은 최대 8개까지
추가할 수 있으며 각 section에 사람이 읽는 `title`을 둘 수 있습니다. 실질적인 각
문단은 citation을 포함하거나 선언된 grounded claim을 담아야 하며, claim·독립 요약·
비범용 제목은 공통 의미 token 정책으로 검사됩니다.

`createIntegratedWikiReviewSurface(...)`는 검증된 `{ exchange, result }` handoff만
실제 outline, planning inventory, 링크 reconciliation, 결정론적 의미 품질 보고서,
정확한 citation anchor 및 section 단위 콘텐츠 diff와 결합합니다. 생성 순서의
연속된 prefix까지만 완료된 실행은 누락 상태가 보이는 승인 불가 surface로 반환하고,
중복·교환·중간 순서 건너뛰기는 실패로 처리합니다. `baselineGenerationDigest`가
`null`이면 이전 baseline이 없으므로 baseline proposal 목록도 비어 있어야 합니다.
null이 아닌 값은 이전 authoritative generation의 식별자이며, 전체 baseline 본문은
surface digest에 결속됩니다. 승인 단계는 이 식별자를 실제 활성 state와 재생
비교하고 baseline page/proposal 집합의 정확한 일치를 요구합니다. 새 outline에서
사라진 baseline page도 정제된 proposal 전체를 삭제 검토용으로 유지하며, 명시적인
삭제 결정이 생기기 전에는 승인을 막습니다.

승인 review는 `createIntegratedWikiReviewSurface(...)`가 방금 생성했거나
`verifyIntegratedWikiReviewSurface(...)`가 원본 입력에서 다시 만든 surface에만
발급됩니다. JSON에서 자체 digest만 다시 계산해 만든 surface는 승인 권한을 얻지
못합니다.

이 경로에서 BuildLore는 provider, agent SDK, 실행 파일, 네트워크 client 또는 하위
프로세스를 새로 실행하지 않습니다. `buildloreInitiatedEgress: "none"`은 이 경계를
뜻하며, exchange를 받은 현재 agent 세션에 정제된 evidence가 공개되지 않았다는
뜻은 아닙니다. 검토, 품질 승인, 최종화, 활성화와 Git 게시는 계속 별도 단계입니다.
`finalizeCompileRun`은 이제 모든 generation handoff를 재생하고 정확한 receipt 집합,
통합 review surface, 승인된 page review와 검토된 child-summary 집합을 필수로
요구합니다. 이들의 canonical digest는 integrity report, 최종 ledger, ownership
graph, 사람의 활성화 승인, active state와 authoritative check까지 이어집니다.
자체 digest만 다시 계산한 receipt, review, approval 또는 오래된 baseline은 원본
입력을 대신할 수 없습니다.

`createHumanActivationApproval(...)`은 최종 ledger, ownership graph, receipt/review
digest와 이전 활성 generation에 결속된 명시적 로컬 확인을 기록합니다. 이 객체는
암호학적인 사람 신원을 증명한다고 주장하지 않으며, 승인 불가능한 ledger에는
발급되지 않습니다. 활성화할 때는 BuildLore가 live source를 읽거나 승인 projection을
바꾸기 전에 호출자가 같은 approval digest를 다시 제시해야 합니다.

```sh
node dist/cli/bin.js compile activate \
  --project example \
  --confirm-approval sha256:<approval-digest> \
  --json
```

승인 확인이 없거나, 일치하지 않거나, 이전 generation이 오래된 경우 기존 projection은
그대로 유지됩니다. 성공한 활성화는 사람이 읽고 Git으로 검토할 결정적 파생 문서도
`knowledge/projects/<project-id>/wiki/buildlore-hierarchy/` 아래에 생성합니다. 여기에는
하나의 `index.md`, active page마다 안정된 `page-<소문자-16진수-64자리>.md`, 그리고
`manifest.json`이 있습니다. 승인 JSON만 유일한 정본이며 Markdown 직접 수정은
materialization drift로만 보고되고 검색이나 semantic index 입력으로 채택되지 않습니다.
활성화는 LLM 호출, embedding 실행, index 재구축, Git commit/push 또는 knowledge
submodule pin을 수행하지 않습니다.

기존 materialization이 변조되지 않았지만 status가 `renderer-outdated`를 보고하면 이미
검증된 authority에서 파생 Markdown만 다시 생성할 수 있습니다. generation, review,
approval 또는 semantic indexing을 반복하지 않으며 authority identity도 바꾸지 않습니다.

```sh
node dist/cli/bin.js compile activate --project example --rematerialize --json
```

## 지식 검색 및 활용

Lexical 검색은 결정론적으로 동작하며 자격증명이 필요하지 않습니다.

```sh
node dist/cli/bin.js search \
  --project example \
  --query "실패 원인" \
  --mode lexical
```

`wiki curate --project <project-id>`도 모델 없이 완전히 동작합니다. clean/active로
승인된 Wiki만 읽어 중복 가능성, 근거 없는 claim, 끊어진 link, 약한 연결에 대한 제한된
검토 제안을 반환합니다. 제안 identity와 evidence locator는 결정론적이며 경로를 포함하지
않습니다. 이 명령은 page를 수정·병합·승인·삭제하지 않고, stale 또는 유효하지 않은
저장 authority에서는 닫힌 상태로 실패합니다. Curate는 활성 projection 범위에서만
동작하며 source checkout을 독립적으로 다시 스캔하지 않습니다. source drift는 sync와
compile authority check로 확인한 뒤 새 결과를 명시적으로 활성화해야 합니다.

`index status`는 승인 projection, Markdown materialization과 semantic generation을
서로 구분해 표시합니다. Semantic 및 hybrid 검색은 설정된 로컬 임베딩 제공자를 사용할
수 있습니다. 호환되는 임베딩 상태나 제공자 접근이 없다면 자동으로 인덱스를 재구축하지
않고 lexical fallback 또는 복구 작업을 결과에 명시합니다. 명시적 rebuild도 semantic
active pointer를 바꾸기 직전에 authority, corpus generation, sanitizer policy, chunker와
embedding identity를 다시 검사합니다. build 중 drift가 생기면 이전 정상 index를
유지합니다.

```sh
node dist/cli/bin.js index status --project example --json
node dist/cli/bin.js index rebuild --project example --json
node dist/cli/bin.js search --project example --query "관련 결정" --mode graph
node dist/cli/bin.js search --project example --query "인증 결정" --mode hybrid --intent current
node dist/cli/bin.js search --project example --query "Gate B 결정" --mode hybrid --intent historical
node dist/cli/bin.js query --project example --question "Why was this design selected?"
node dist/cli/bin.js context --project example --prompt "Prepare an implementation plan"
```

`--intent`는 `auto`(기본값), `current`, `historical`, `neutral`을 받습니다. Auto는
제한된 Gate·iteration/version·과거 표지만 사용하며 분류 모델을 호출하지 않습니다.
검색 결과 v3는 각 hit의 실제 intent, 원래 점수와 조정 점수, 제한된
authority/lifecycle/evidence 조정, diversification 이유와 ranking policy digest를
반환합니다. 의미 metadata가 없는 legacy source는 `unknown/unknown/other` 중립값으로
계속 검색되지만 boost를 받지 않고 `legacy-default-neutral`로 기록됩니다.

Source adapter 또는 manifest는 `values.retrievalMeaning`에 authority, lifecycle,
evidence kind, revision ordinal, topic/iteration group과 supersession ref를 각각 선언할 수
있습니다. 잘못된 명시 metadata는 닫힌 상태로 실패합니다. Semantic index v2는 정해진
renderer·machine provenance 노이즈를 제거한 `semanticText`만 임베딩하며, 검토용 원문
body와 citation locator는 보존합니다. Metadata나 projection policy가 바뀌면 파생
index를 명시적으로 rebuild해야 합니다.

`context`는 먼저 활성화된 승인 계층형 Wiki를 읽습니다. 섹션의 semantic text와 함께
page, section, source, citation의 구조화 locator를 반환하며 hybrid에서 로컬 경로로
전환되면 그 fallback을 명시합니다. 승인 projection이 없을 때만 기존 compiler context
경로를 사용합니다. `query`는 항상 `save: false`를 요청하지만, 상위 컴파일러는 선택
프로젝트의 `log.md`에 질의 활동을 추가합니다. 자동화에 사용할 하나의 결정론적
`buildlore.cli-envelope.v1` 객체가 필요하면 어떤
명령에든 `--json`을 추가합니다.

## Git으로 지식 게시

게시 과정은 검토 가능한 개별 작업으로 분리되어 있습니다. 먼저
`git rev-parse HEAD`로 전체 소스 리비전을 확인하고, 선택 프로젝트에 허용된
지식 경로만 계획하고 커밋합니다.

```sh
node dist/cli/bin.js publish plan \
  --project example \
  --source-revision <full-source-git-oid> \
  --json

node dist/cli/bin.js publish commit \
  --project example \
  --source-revision <same-full-source-git-oid> \
  --expect-plan <plan-digest-from-the-plan-result> \
  --json
```

반환된 지식 리비전을 명시적인 non-force push에 사용한 뒤, 상위 저장소의
서브모듈 pin을 계획하고 커밋합니다.

```sh
node dist/cli/bin.js publish push \
  --project example \
  --knowledge-revision <full-knowledge-git-oid>

node dist/cli/bin.js knowledge pin plan \
  --knowledge-revision <same-full-knowledge-git-oid> \
  --iteration <iteration-id> \
  --intent iteration-close \
  --json

node dist/cli/bin.js knowledge pin commit \
  --knowledge-revision <same-full-knowledge-git-oid> \
  --iteration <same-iteration-id> \
  --intent iteration-close \
  --expect-plan <pin-plan-digest> \
  --json
```

계획 단계는 어떤 파일도 변경하지 않습니다. 지식 커밋, 원격 push, 상위 저장소
pin은 서로 분리된 트랜잭션이며 하나의 명령이 세 작업을 모두 수행하지 않습니다.
pin 명령은 로컬 상위 저장소 커밋만 생성하고 코드 저장소를 push하지 않습니다.
검토된 게시 내용에 새 프로젝트 레지스트리 항목이 포함되면 `--registration`을,
검토 후보나 그 밖의 policy-track 산출물을 포함해야 할 때만
`--include-policy-track`을 사용합니다.

## 명령 요약

```text
init -> project add -> sync --dry-run -> sync -> compile -> check
                                         |                    |
                                         +-> compile plan -> 현재 세션 -> compile apply -> review
                                         +-> search/query/context
                                         +-> publish plan -> commit -> push -> knowledge pin
```

`knowledge clone`, `knowledge init`, `knowledge status`, `project validate` 호환
별칭도 계속 사용할 수 있습니다.

컴파일러 작업은 등록된 `projectId`만 허용합니다. 제공자 기반 compile, 전체
평가, search, query 및 semantic context는 프로젝트 보안 정책이 해당 기능과
모든 입력 분류를 허용할 때만 외부 전송을 수행합니다. `topChunks: 0`인 context는
로컬에서 처리되며 제공자 허가가 필요하지 않습니다.

상위 SDK에는 활성 취소, 전체 제한 시간 또는 진행률 callback이 없습니다.
따라서 BuildLore도 이러한 동작을 보장하지 않습니다. 호스트는 프로세스 신호를
어댑터의 `AbortSignal`로 변환할 수 있지만, 어댑터 자체는 전역 handler를
설치하지 않습니다.

`knowledge/manifest.json`은 `buildlore.knowledge.v1`을 사용하고 각 프로젝트
설명자는 `buildlore.project.v1`을 사용합니다. 프로젝트 경로는 항상
`projects/<project-id>`이며, 소스 Markdown은 컴파일러가 요구하는 `title`,
`source`, `ingestedAt` frontmatter와 `buildlore.sourceKind`를 포함해
`sources/` 바로 아래에 저장됩니다.

## 개발 명령

```sh
npm run build
npm test
npm run lint
npm run typecheck
npm run eval:retrieval
```

`eval:retrieval`은 네트워크나 제공자 자격증명 없이 고정된 한국어, 영어 및 코드
심볼 corpus를 실행합니다. 이 명령은 Recall@5, MRR, 선택된 검색 전략 ID, 기록된
semantic fixture ID, canonical 입력 hash, 인덱스 byte 크기 및 환경 조건이 포함된
latency를 담은 `buildlore.retrieval-eval.v1` 보고서를 생성합니다. Runtime 검색은
동일한 버전의 Unicode 단어 및 한글 bigram/trigram 전략을 사용합니다. Semantic
및 hybrid 모드는 임베딩 호환성을 공개하며, 프로젝트 marker가 없거나 오래된
경우 명시적인 컴파일 복구 작업과 함께 로컬 lexical 결과로 fallback합니다.

초기 모듈 경계는 다음과 같습니다.

- `src/cli`: 명령행 인터페이스와 프로세스 입출력
- `src/projector`: 소스 선택 및 프로젝트 격리
- `src/sanitizer`: 비밀정보 및 안전하지 않은 콘텐츠 거부
- `src/compiler`: 교체 가능한 컴파일러 통합
- `src/retrieval`: 로컬 지식 검색
- `src/knowledge`: 언어 중립적인 지식 계약
- `test/fixtures`: 결정론적이며 비밀정보가 없는 테스트 입력

정제 과정은 fail-closed입니다. 불확실하거나 비밀정보를 포함한 입력은 컴파일러나
지식 저장소에 도달하기 전에 거부됩니다. 자격증명은 fixture, 생성 결과, 로그
또는 CLI 오류 출력에 절대 포함해서는 안 됩니다.

## Plan2Agent 진입점

P2A 진입점 snapshot은 Git에서 제외된 `plans/entries/` 디렉터리에 로컬 작업
지식으로 저장합니다. 새로 복제한 저장소에서는 로컬 harness 상태를 초기화하고,
원본 이슈로부터 출처가 연결된 snapshot을 만든 다음 이를 검증하고 진입합니다.

```sh
npm run p2a:init
p2a validate --entry plans/entries/github-issue-<n>.md
p2a next --entry plans/entries/github-issue-<n>.md
```

`p2a:init`은 checkout 외부에서 `p2a init`을 준비하고 Git에서 제외된 로컬
상태만 다시 복사합니다. 이를 통해 저장소가 관리하는 P2A 에이전트 자산과
`PLAN2AGENT.md`를 덮어쓰지 않습니다. 성공하기 전 manifest가 관리하는 모든
자산의 SHA-256을 검증하고 `p2a doctor`를 실행합니다. 다시 실행할 때도 동일한
방식으로 기존 로컬 상태를 검증합니다.

그 이후에는 `p2a next`가 반환하는 하나의 상태 기반 다음 작업만 수행합니다.
`.plan2agent/`와 `plans/`는 Git에서 제외된 로컬 상태입니다. 다른 환경에서 같은
이력을 이어가려면 Plan2Agent Memory, 명시적인 export 또는 별도의 지식 저장소를
사용합니다. 자세한 내용은 [PLAN2AGENT.md](PLAN2AGENT.md)를 참고하세요.

## v0.1 범위에서 제외된 기능

- 중앙 데이터베이스 또는 필수 API 서버
- 실시간 공동 편집
- `llm-wiki-compiler` 포크
- 특정 언어에 종속된 지식 계약
- 프로젝트 간 읽기 또는 쓰기

진행 중인 아키텍처 결정과 장단점은 프로젝트 지식 저장소로 투영하기 전에
Git에서 제외된 로컬 `plans/adr/` 디렉터리에 보관할 수 있습니다.

### 전체 독자 자료 묶음

`buildlore wiki packet --project <id> --json`은 선택적으로 사용하는 `buildlore.knowledge-reader-packet.v1` 자료를 반환합니다. Wiki의 전체 설명과 사실의 범위·상태를 유지하고 중복 참조를 모읍니다. 표시용 별칭은 목록에서 정식 ID로 바꾼 뒤 조회·인용합니다. 각 항목은 끝 개행을 포함한 compact UTF-8 JSON 기준의 단일 ID 전체 조회 비용을 표시합니다. 목록에 있는 출처는 아직 읽은 출처가 아닙니다. 기존 `wiki read`와 `wiki lookup --expect-generation` 출력은 그대로입니다.

SDK는 `readPacket(projectId)`와 `createPacketAnswerEvaluationContract`를 제공합니다. 새 answer contract v3는 `knowledge-reader-packet-v1`을 사용하며 초기 자료 32,768바이트, 누적 조회 16,384바이트·10회, 답변당 8,192바이트 한도를 유지합니다. 전체 data 객체와 질문이 예산에 포함됩니다. 출처 인용에는 같은 질문 또는 이전 질문에서 실제 수행한 조회가 필요합니다. 측정하지 못한 runtime 부가는 미확인으로 남기며 내용 완전성과 전체 실행 인증을 구분합니다. 이전 계약·보고서 인코딩은 유지되며 새 자료 형식은 `knowledge-markdown-v2` 세대를 요구합니다.

고정 로컬 임베딩 모델은 버전이 있는 주제 관련성 기준을 적용하며 검색 결과의 `semanticRelevancePolicy`에 이를 표시합니다. V2 기준은 동결한 교정 자료와 알려진 회귀 사례에서 문자권별 필수 관련 점수의 최솟값과 무관 점수의 최댓값 사이 중간값으로 정했습니다. 점수는 정답 확률이 아닙니다. 독립 평가 결과는 별도로 보고하며 분리 가능한 구간이 없거나 평가가 실패하면 실패한 시도로 보존합니다. 질문의 판정을 바꾸어 통과시키지 않습니다. 교정 자료와 정책 출처는 `test/fixtures/semantic-relevance-*-v2.json`에 있고, 오프라인 `calibrateSemanticRelevance` 함수는 표본 누락·잘못된 점수·겹치는 구간을 거절합니다.

### 완전성 작성과 지식의 한계

명시적으로 선택하는 `completeness-v1`은 검토된 필수 목록을 정확한 Wiki 문장에 연결하고, 근거·현재성 검토와 누락 검토를 모두 요구합니다. 근거 있는 미확인 사항은 연결된 본문에 설명해야 합니다. 출처 인용이나 목록의 unknown 표시만으로는 충족되지 않습니다.

“선택된 근거로는 운영 환경의 성능을 확인할 수 없다”는 현재 근거가 지원하는 문장이므로 `current`로 표현합니다. 측정 결과는 모르더라도 근거의 한계는 확인된 사실입니다. `uncertainty`는 미확인 상태의 사실을 참조할 때 사용하며, 이 표시를 위해 오래되거나 논쟁 중인 사실을 만들어서는 안 됩니다. 단계별 조회에서 이 안내를 제공하고 기존 exchange의 결속은 유지합니다.

선언된 필수 자료가 없으면 최종 확정을 계속 차단합니다. 선택된 자료로 확인되는 범위 한계는 근거 있는 미확인 사항으로 기록할 수 있습니다. 모든 범주를 검토하되 전체 프로젝트 이력을 상상해 채우거나 같은 질문·범주에서 동일 명제를 반복하지 않습니다. 이 안내와 자동 검증만으로 문서·독자 점수 향상이 입증되지는 않으며 독립 평가가 필요합니다.

해당 질문의 본문에 기록된 설계 이유, 버전별 변경, 기본값·예외·호환성 조건을 함께 설명합니다. 생성된 출력, 구현된 동작, 실제 실행한 검증을 구분하고, 누락 검토자는 항목 ID나 인용의 존재뿐 아니라 필요한 조건이 본문에 쓰였는지 판단합니다.

본문 제출 후 작성자와 누락 검토자의 단계별 조회에는 질문·필수 항목·정확한 현재 문장·사실·근거의 공통 목록를 묶은 읽기 전용 `material.reviewPacket`이 제공될 수 있습니다. proposal·inventory·mapping 결속을 포함하지만 통과 판정이나 승인 권한은 부여하지 않으며, 근거·현재성 검토자에게는 노출하지 않습니다. 공백 들여쓰기 없는 JSON 묶음이 256 KiB를 넘거나 기존 단계 조회 한도를 초과하면 묶음 전체를 생략하고 원래의 개별 자료 조회를 유지합니다. 조회로 저장된 실행이나 이력을 바꾸지 않습니다.

목록 검증 오류는 기존 `KNOWLEDGE_INVALID` 코드와 함께 0부터 시작하는 질문·분류·항목 위치, 고정된 위반 규칙, 전체 초안 digest를 반환합니다. 요구사항 연결에는 해당 현재 소스의 근거가 필요하며 과거 근거만으로 충족할 수 없습니다. `compiler.repairKnowledgeCompletenessInventoryDraft(draft, exchange, role, { draftDigest, questionIndex, categoryIndex, itemIndex, replacement })`로 작성자가 가진 초안의 한 항목을 교체하면 항목 식별자를 유지하고 전체 결과를 다시 검증합니다. 결과는 기존 shadow/inventory 명령과 현재 stage digest로 제출합니다. 이 함수는 세션을 저장하거나 확정 목록을 수정하지 않습니다. 역할 안내에는 기존 coverage 검사 요청 형식도 포함됩니다.

## AI 클라이언트에서 프로젝트 Wiki 읽기

소스 프로젝트를 연결한 뒤 설정 변경안을 먼저 확인합니다.

```sh
buildlore client configure --client codex --project-dir /absolute/source --json
# 대상 클라이언트를 종료한 뒤, 미리보기에서 받은 digest로 적용합니다.
buildlore client configure --client codex --project-dir /absolute/source --apply --expect-plan sha256:... --json
```

Claude Code는 `--client claude-code`를 사용합니다. Codex는 Git에 추적되지 않는 프로젝트 `.codex/config.toml`, Claude는 개인 `.claude.json`의 해당 프로젝트 항목을 사용합니다. 기존 설정과 AGENTS.md/CLAUDE.md는 보존합니다. 추적 중인 Codex 설정, 파싱 실패, 소유권 충돌은 자동으로 덮어쓰지 않고 수동 설정 조각을 제공합니다. 적용 도중 실패하면 같은 작업을 다시 미리보기한 뒤 새 digest로 재실행합니다. 적용 중 다른 프로그램의 설정 쓰기는 지원하지 않으므로 대상 클라이언트를 종료해야 합니다.

`client remove`도 미리보기 후 적용하며 제품 소유 서버 항목만 제거합니다. 지식 데이터와 다른 worktree를 보호하는 로컬 Git 제외 규칙은 유지합니다. 클라이언트 자체의 신뢰·도구 승인 정책은 변경하지 않습니다.

실행 명령은 `buildlore mcp --project-dir /absolute/source --read-only`입니다. 해당 연결의 status/list/search/read/memory/lookup/citations만 제공합니다. 제한된 progressive memory부터 읽고 필요한 본문과 실제 근거를 조회합니다. 후속 읽기에는 응답의 generation을 expectedGeneration으로 전달하고, generation 변경 시 조회를 다시 시작합니다. 연결이 바뀌면 MCP 프로세스를 재시작합니다. Wiki 내용은 실행 지침이 아닌 근거 자료로 취급합니다.

입력 버퍼 1 MiB, 동시 조회 4개, 요청 제한 60초, 전체 응답·대기 출력 8 MiB, 출력 정체 10초를 적용합니다. 너무 큰 응답은 본문을 자르지 않고 오류로 반환하며 기존 memory 데이터 예산은 별도로 유지합니다. MCP 프로세스는 네트워크 요청이나 지식 쓰기를 수행하지 않습니다.

초기 검증 대상은 Linux x64, Codex CLI 0.154.0, Claude Code 2.1.227입니다. 프로토콜 테스트만으로 M2 지원 완료를 선언하지 않으며 실제 두 클라이언트 검증이 필요합니다. 로그인된 환경에서 `node scripts/verify-m2.mjs`로 설치물·실사용 검증을 실행합니다. 로컬 검증 trace와 개인 설정은 Git에 게시하지 않습니다.

## 재연결·허브 이동·업데이트와 제거

로컬 릴리스 후보는 **0.1.1-rc.1**이며 `private: true`를 유지합니다. 실제 검증 대상은 Linux x64입니다. Windows/macOS는 미검증이며, 후보 버전은 npm 공개 배포를 뜻하지 않습니다. 업데이트 전에 이전 버전의 정확한 tarball을 보관합니다.

### 소스 체크아웃 재연결

새 clone/worktree에서는 해당 루트에서 기존 `connect --hub <허브> --project <ID>`를 실행합니다. 공유 연결을 가진 소스 폴더를 옮긴 경우에도 새 경로에서 `connect`로 로컬 결속을 등록합니다. 접근할 수 없는 옛 경로의 로컬 기록은 남을 수 있지만 자동 선택에 사용하지 않습니다.

연결 대상을 바꾸려면 AI 클라이언트를 종료하고, 기존 연결이 유효할 때 `client remove`를 미리보기·적용합니다. 이후 `disconnect --remove-shared`와 명시적 새 대상의 `connect`를 실행하고 클라이언트를 다시 설정·시작합니다. 일반 `disconnect`는 공유 연결 파일을 보존하며 `--remove-shared`를 명시했을 때만 삭제합니다. 두 방식 모두 지식과 수집 설정은 삭제하지 않습니다. 같은 경로의 checkout을 교체했다면 기존 로컬 결속을 disconnect한 후 다시 연결합니다.

### 허브를 옮긴 뒤 경로 복구

Git checkout과 초기화된 submodule 구조는 사용자가 먼저 이동·복원합니다. portable 지식 저장소 locator는 유지해야 하며, 상대 locator는 새 위치에서도 올바르게 해석되어야 합니다. Git worktree/submodule 내부 경로가 깨졌다면 먼저 Git 구조를 복구합니다.

```sh
# 미리보기만 수행합니다. 이전 경로가 사라졌어도 되며 두 경로는 절대 경로입니다.
buildlore connection relocate-hub --from /work/old-hub --to /work/new-hub \
  --knowledge-repo https://example.org/team/knowledge.git --json

# 미리보기의 planDigest를 복사하고 나머지 인수는 동일하게 유지합니다.
buildlore connection relocate-hub --from /work/old-hub --to /work/new-hub \
  --knowledge-repo https://example.org/team/knowledge.git \
  --apply --expect-plan sha256:<미리보기-digest> --json
```

알려진 지식 저장소의 로컬 허브 경로만 바뀝니다. 해당 허브의 소스 연결들은 새 경로를 사용하며 각 프로젝트 신원과 공유 파일은 유지됩니다. 미리보기는 다른 프로젝트 목록 대신 영향받는 연결 개수를 반환합니다. 저장된 연결이나 대상 허브가 바뀌면 오래된 미리보기의 적용을 거절합니다. 중단 후에는 다시 미리보기합니다. 이미 적용됐다면 `changed: false`입니다. 해당 허브를 사용하는 모든 MCP 세션을 재시작해야 하며 조회·진단은 자동 복구를 수행하지 않습니다.

`CONNECTION_BUSY`는 연결 작업이 실행 중이거나 남은 잠금이 있다는 뜻입니다. 수동 복구 전 모든 BuildLore 프로세스를 종료하고 개인 설정 디렉터리를 백업합니다. 위치는 `BUILDLORE_CONFIG_DIR`, 없으면 `$XDG_CONFIG_HOME/buildlore` 또는 `~/.config/buildlore`입니다. `locks` 안에서 중단된 작업의 일반 잠금 파일임을 확인한 항목만 제거한 뒤 다시 미리보기합니다. `connections.json`, 사용 중인 잠금, 지식 데이터는 삭제하지 않습니다. 자동 잠금 탈취는 하지 않습니다.

### 업데이트·이전 버전 복구·제거

클라이언트를 종료하고 같은 설치 위치에 정확한 tarball을 설치합니다.

**임베딩 런타임을 기본 제공하던 버전에서 업데이트할 때:** 이전에 자동 설치된 런타임은
업데이트로 제거됩니다. 기존 semantic/hybrid 검색을 계속 사용하려면 **업데이트 전에**
같은 설치 위치에 아래 명령으로 명시적으로 설치합니다. 업데이트 후에도 이 명령으로 복구할 수 있습니다.

```sh
npm install --prefix "$HOME/.local/buildlore" --omit=dev --save-exact @huggingface/transformers@4.2.0
```

이 명령은 설치 위치에 사용자의 선택을 기록하므로 이후 업데이트에서도 런타임을 유지합니다.
lexical 검색만 사용하는 경량 설치라면 생략합니다. 모델 파일과 기존 인덱스는 유지되며,
`model verify`는 모델 파일만 검사하고 런타임을 설치하지 않습니다. 의미 검색을 사용한다면
업데이트 후 허브에서 semantic 검색을 실행해 복구를 확인합니다.

```sh
npm install --prefix "$HOME/.local/buildlore" --omit=dev /path/buildlore-0.1.1-rc.1.tgz
buildlore --version
buildlore doctor --json
buildlore wiki list --json
```

반환된 generation으로 본문과 실제 근거를 읽어 확인합니다. Node나 제품 설치 경로가 바뀌었다면 `client configure`를 다시 미리보기·적용하고 클라이언트를 재시작합니다. 이전 버전으로 복구하려면 보관한 `buildlore-0.1.0.tgz`를 같은 prefix에 설치하고 조회를 반복합니다. v1 연결 형식은 유지됩니다. `relocate-hub`와 `--version`은 후보 버전의 새 기능이며, 이전 버전 확인에는 `npm ls --prefix "$HOME/.local/buildlore" buildlore`를 사용합니다.

제거할 때는 설정한 클라이언트마다 `client remove`를 먼저 미리보기·적용하고, 원하는 소스 checkout을 disconnect한 뒤 `npm uninstall --prefix "$HOME/.local/buildlore" buildlore`를 실행합니다. 지식 저장소·소스 문서·다른 클라이언트 설정·다른 worktree 연결은 남습니다. 프로그램을 먼저 제거했다면 같은 버전을 재설치해 설정 제거를 진행합니다. 허브를 먼저 옮겼다면 경로 복구 후 클라이언트 설정을 제거합니다.

개발 검증은 `bwrap`과 `strace`가 준비된 환경에서 `npx --yes --package=npm@11.19.0 --call 'node scripts/verify-m3.mjs'`로 실행합니다. 폐기 가능한 설치에서 0.1.0 → 후보 → 0.1.0 → 후보 → 제거와 CLI/MCP 격리 조회·설정 보존을 검사하고, tarball·해시·설치 시간/용량·결과를 로컬 증거 디렉터리에 보관합니다. 측정은 해당 npm 캐시 조건의 Linux 단일 실행이며 빈 캐시 설치 성능을 보장하지 않습니다. M3 검증은 AI 클라이언트를 호출하지 않습니다. Claude 유료 실사용은 사용자 결정으로 제외·미검증이며, 연동 기능과 기존 M2 테스트 경로는 차후 실행할 수 있도록 유지합니다.
