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

모든 명령은 BuildLore 허브 루트에서 실행합니다. 아래 예시는
`node dist/cli/bin.js`를 사용합니다. 패키지 실행 파일을 링크하거나 설치했다면
이를 `buildlore`로 바꿔 사용할 수 있습니다.

잠금 파일과 모든 직접 의존성은 정확한 버전으로 고정되어 있습니다.
`llm-wiki-compiler@1.1.0`은 교체 가능한 `src/compiler` 패키지 루트 어댑터를
통해서만 사용합니다. BuildLore는 이 패키지를 포크하거나 내부 모듈을 직접
가져오지 않습니다.

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

제공자 접근은 `knowledge/projects/example/security-policy.json`으로도
제어합니다. 새로 등록된 프로젝트는 `restricted` 분류와 빈 egress 규칙을 가진
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

정책 파일은 canonical JSON입니다. 필드와 규칙의 순서를 유지하고, 프로젝트에서
사용하지 않는 egress 규칙은 제외합니다.

### 6. 위키 컴파일 및 검증

검토 모드는 생성된 페이지를 실제 위키에 반영하지 않고 컴파일러 후보 큐에
기록합니다. 일반 컴파일은 실제 컴파일 결과와 증분 상태를 기록합니다.

```sh
node dist/cli/bin.js compile --project example --review
node dist/cli/bin.js compile --project example
node dist/cli/bin.js check --project example
```

격리된 프로젝트 작업공간에는 `sources/` 아래의 평탄화된 정제 소스,
`wiki/` 아래의 생성 페이지, `.llmwiki/` 아래의 컴파일러 상태와 적용된 언어
중립적 생명주기 프로필이 저장됩니다.

## 지식 검색 및 활용

Lexical 검색은 결정론적으로 동작하며 자격증명이 필요하지 않습니다.

```sh
node dist/cli/bin.js search \
  --project example \
  --query "실패 원인" \
  --mode lexical
```

Semantic 및 hybrid 검색은 설정된 임베딩 제공자를 사용할 수 있습니다. 호환되는
임베딩 상태나 제공자 접근이 없다면 자동으로 인덱스를 재구축하지 않고 lexical
fallback 또는 복구 작업을 결과에 명시합니다.

```sh
node dist/cli/bin.js search --project example --query "authentication decision" --mode hybrid
node dist/cli/bin.js query --project example --question "Why was this design selected?"
node dist/cli/bin.js context --project example --prompt "Prepare an implementation plan"
```

`query`는 항상 `save: false`를 요청하지만, 상위 컴파일러는 선택 프로젝트의
`log.md`에 질의 활동을 추가합니다. 임베딩 또는 제공자 접근을 사용할 수 없으면
context가 로컬 lexical 경로로 명시적으로 fallback할 수 있습니다. 자동화에
사용할 하나의 결정론적 `buildlore.cli-envelope.v1` 객체가 필요하면 어떤
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
