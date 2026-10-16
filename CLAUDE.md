# CLAUDE.md

이 저장소에서 작업하는 AI 에이전트용 고정 전제입니다. 사람을 위한 설명은 [README.md](README.md)에 있습니다.

## 검증

- 변경 후에는 `bun run check`를 돌립니다 (prettier → eslint → tsc → knip → test, CI와 동일).
- 테스트는 Slack·화면·Claude CLI 없이 돕니다(memory 드라이버). 실제 장비 점검은 `bun run doctor`입니다.

## 조직 원칙 — 확정된 전제 (질문·재검토·대안 제시 금지)

- **사람과 같은 방식으로 일한다.** 에이전트는 사람과 똑같이 화면을 보고 마우스·키보드로 일합니다.
  에이전트에게 편한 방식(API 직접 호출)을 더하지 않습니다.
- **발신은 GUI로만.** 메시지는 Slack 클라이언트 화면에서 클릭·입력으로 보냅니다(`src/desk`, `src/tools`).
  - `chat.postMessage` 등 Slack API로 보내는 코드를 만들지 않습니다. ESLint가 `src/slack` 밖의
    `@slack/*` import와 `src/slack` 안의 발신 네임스페이스(`chat`, `files`, `reactions`, `apiCall` …) 접근을 막습니다.
  - 쓰기 scope가 있는 토큰은 부팅 시 거부합니다(`assertReadOnly`). 이 검사를 완화하지 않습니다.
  - 데스크톱 앱과 웹앱은 원칙상 차이가 없습니다(`SLACK_CLIENT`).
- **수신은 Socket Mode.** 집 네트워크에 인바운드 포트를 열지 않습니다. 클라이언트는 Bun 내장 WebSocket으로 직접 구현한
  `src/slack/socket.ts`입니다. `@slack/socket-mode`(와 그것을 쓰는 `@slack/bolt`)는 Bun에서 연결이 계속 끊기므로 다시 들이지 않습니다.
- **수신 구독은 "사용자 대신"(on behalf of users).** 에이전트는 봇이 아니라 멤버 계정이라 봇 이벤트로는 사람이 에이전트에게 보낸
  DM을 받을 수 없습니다. 앱은 에이전트 계정이 승인하고, 읽기 토큰은 그 사용자 토큰(`xoxp-`, 읽기 scope만)입니다.
- **인터럽트는 협조적으로만.** 진행 중인 턴을 밖에서 끊지 않습니다(`interrupt()`·kill 금지, ESLint가 `.interrupt(` 호출을 막음).
  새 메시지는 도구 결과의 알림으로만 알리고, 에이전트가 안전한 지점에서 `inbox_peek`/`inbox_take`/`inbox_yield`로 스스로 결정합니다.
  종료(SIGTERM)도 현재 턴이 끝나기를 기다립니다.
- **에이전트당 장비 1:1.** 한 장비 = 한 프로세스 = 한 에이전트이며 턴은 한 번에 하나입니다.
  한 프로세스에서 여러 에이전트나 병렬 턴을 돌리는 구조를 만들지 않습니다.
- **에이전트 간 대화에는 정지 규칙이 있습니다.** `MAX_AGENT_EXCHANGES`(사람이 끼지 않은 연속 발언 수)를 없애지 않습니다.
- **채널 판단(triage)은 턴이 아닙니다.** 멘션 없는 채널 글에 답할지는 도구 없는 판단 호출(`Judge`)이 정하고,
  화면을 쓰지 않으므로 턴과 별개로 돕니다. 판단에 데스크 도구나 다른 능력을 주지 않고, 판단이 직접 답장하게 하지 않습니다.
  "답한다"는 판단은 대기열에 넣는 것까지이고, 답장은 언제나 턴에서 화면으로 합니다. 애매하거나 실패하면 답하지 않습니다.
- **에이전트는 자기 권한을 스스로 주지 않습니다.** macOS 권한 창·보안 설정은 사람이 처리합니다. 데스크가 준비되지 않으면
  (`Desk.problem()`) 런타임은 턴을 시작하지 않고 메시지를 대기열에 둡니다.

## 구조 규칙

- 엔진(두뇌)은 드라이버입니다. 새 엔진은 `src/engine/<name>.ts`에 `Engine`을 구현하고
  `ENGINE_DRIVER` enum과 `src/container.ts`의 switch에 한 줄을 더합니다. 귀·손·인터럽트 규칙은 엔진과 무관하게 공통입니다.
- 엔진은 데스크 도구 외의 능력을 갖지 않습니다(`claude -p`: `--tools ""`, `--strict-mcp-config`, `dontAsk`).
  에이전트에게 셸·파일 같은 능력을 주는 일은 "작업 권한과 안전장치" 결정이 내려진 뒤에만 합니다 — 스스로 정하지 않습니다.
- 모든 설정은 `src/config.ts`에서 부팅 시 검증합니다. 새 값은 `.env.example`에도 설명과 함께 추가합니다.
- `zod`는 `src/validation`, MCP SDK는 `src/tools`, Slack SDK는 `src/slack` 안에서만 import합니다.
- 코드 주석·로그는 영어, 사람과 에이전트가 읽는 문서와 에이전트 프롬프트는 한국어입니다.
- `native/desk-helper.swift`의 키 이름은 `src/desk/keys.ts`와 같아야 합니다. 한쪽을 바꾸면 다른 쪽도 바꿉니다.
