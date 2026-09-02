## Observed issue

1. 실행, 재시도, 대체 실행의 의미가 집계에서 분리되지 않았다.
   - Evidence: 회고 후보는 재시도 45건을 보고하지만, 보존된 인덱스에서 확인되는 것은 실행 45건(완료 26건, 실패 8건, 중단 11건)이며 실행 간 재시도 관계는 남아 있지 않다.
2. 실행 기록 축약 후 실패 원인을 재구성할 정보가 부족하다.
   - Evidence: 45개 실행 중 상세 기록은 12개만 남았고 33개(73.3%)는 상세 원인이 보존되지 않았다. 축약된 45개 사유는 모두 `superseded`이며, 명시적 사용자 교정 1건의 영향 범위도 남은 기록에서 확인할 수 없다.
3. 제품 검증 실패와 실행환경에서 시작할 수 없었던 검증이 충분히 구분되지 않았다.
   - Evidence: 검증 312건 중 282건은 통과, 4건은 실패, 26건은 unavailable이었다. 보존된 근거로 확인 가능한 일반 제품 결함은 수정 후 통과한 fixture 불일치 1건이고, 별도로 제한된 sandbox 밖에서 통과한 설치 CLI·loopback 검사 1건이 있다.
4. 같은 작업공간 상태에서 전체 검증이 반복되어 실행 비용이 커졌다.
   - Evidence: 기록된 검증 누적 시간은 5,885,497ms(약 98분)였으며 build, test, lint, typecheck, 평가와 diff 검사가 같은 작업공간 revision에서 반복 실행된 사례가 있다.

## User impact

1. 실행 횟수가 재시도 횟수로 보이면 실제 개발 마찰이 과장되고 개선 우선순위가 왜곡된다.
2. 실패 8건과 중단 11건의 반복 원인을 사후 분석할 수 없어 같은 문제가 다시 발생해도 예방 규칙을 설계하기 어렵다.
3. sandbox·권한·도구 문제를 제품 결함처럼 취급하거나, 이미 정상인 제품 검증을 불필요하게 다시 실행할 수 있다.
4. 작은 수정과 인수 증거 보강에도 전체 검증 시간이 반복 지출되어 개발 주기가 길어진다.

## Suggested improvement

1. 각 실행에 `attemptId`, `retryOfRunId`, `retryCause`를 기록하고 run, retry, supersession 수를 별도로 표시한다.
2. 기록 축약 후에도 task, 최종 status, bounded reason code, 실패 명령과 민감정보 없는 요약을 보존한다. 사용자 교정은 영향 task와 전후 contract identity를 함께 남긴다.
3. unavailable을 `sandbox_denied`, `missing_tool`, `external_asset`, `permission`처럼 분류하고 제품 실패와 분리된 환경 재실행 경로를 제공한다.
4. command와 workspace digest가 같은 성공 증거는 재사용하고, 변경 범위 검증 후 최종 full validation은 한 번만 실행하도록 closeout을 구성한다.
