# 1차 마일스톤 — 에이전트와 Slack으로 소통하기 (완료)

- 완료: 2026-10-10
- 범위: Claude 에이전트 1명이 자기 맥 앞에서 Slack 메시지를 받고(귀), 화면을 보고 마우스·키보드로 답하는(손) 것까지
- 코드: 이 맥의 `~/Agent/slack-agent-org` (사용자의 `boilerplate` 레포 철학을 따름)
- 계획서: `ai-agent-slack-org-plan.md` — 이 문서의 결정 중 계획서와 달라진 부분은 계획서에도 반영함

## 1. 결과 요약

사람이 휴대폰에서 에이전트 계정으로 DM을 보내면, 에이전트가 맥 화면에서 Slack을 띄워 그 DM에 답장을 쳐서 보낸다.
첫 실전에서 확인된 것:

- 사용자 대신 구독한 이벤트로 DM이 Socket Mode를 통해 실제로 들어온다.
- 에이전트가 Dock에서 Slack을 띄우고, 입력창을 찾아 답장하고, 스크린샷으로 게시를 확인한다. 자기 메시지는 다시 일감으로 받지 않는다.
- 답장 중 다른 메시지가 도착하자 🔔 알림을 보고 안전한 지점에서 `inbox_peek` → `inbox_take`로 같은 턴에 처리했다(협조적 인터럽트).
- 오타(첫 글자 누락)를 스스로 발견하고 Slack에서 메시지를 수정했다.
- 같은 DM은 같은 엔진 세션으로 이어져 이전 대화를 기억한다.
- launchd 서비스로 상시 실행된다. 화면 권한이 없을 때는 턴을 멈추고 메시지를 대기열에 둔다.
- 답장 한 번: 약 16초, 도구 왕복 10회(입력 문제 수정 후 기준).

## 2. 구조

```
           Slack (워크스페이스 "집")
   ┌─────────────┴──────────────┐
   │ Socket Mode (아웃바운드 WS)  │ ← 사람과 같은 방식: 화면에서 클릭·입력
   ▼                            │
 귀 src/slack ──▶ src/inbox ──▶ src/agent (한 번에 한 턴)
 (수신·읽기 전용)  주소 판별·대기열      │ 대화마다 엔진 세션 하나
                    ▲                ▼
                    │         두뇌 src/engine (claude -p)
                    │                │ MCP over localhost (토큰)
                    └── 알림 ──  src/tools ──▶ 손 src/desk ──▶ 화면·마우스·키보드
```

| 부분 | 역할 | 구현 |
| --- | --- | --- |
| 귀 | Slack 메시지 수신, 이름 조회 | Socket Mode(Bun 내장 WebSocket 직접 구현) + 읽기 전용 Web API |
| 대기열 | 나에게 온 말인지 판별, 루프 정지, 알림 | `src/inbox` |
| 손 | 스크린샷·클릭·입력 | `screencapture`/`sips` + Swift 도우미(`native/desk-helper.swift`, CGEvent) |
| 책상(도구) | 손과 대기열을 엔진에게 제공 | localhost MCP 서버(bearer 토큰), 엔진 무관 |
| 두뇌 | 판단·조작 | Claude Code CLI `claude -p` (맥에 로그인된 Claude 계정) |
| 런타임 | 턴 순서, 일시정지·재개, 상태 저장 | `src/agent`, `data/state.json` |
| 운영 | 상시 실행, 점검 | launchd LaunchAgent, `bun run doctor` |

보일러플레이트 철학 적용: 부팅 시 검증되는 설정(`src/config.ts`), 컴포지션 루트와 드라이버 교체(`src/container.ts`),
검증 파사드(zod는 `src/validation`에서만), ESLint로 강제하는 경계, `bun run check` 게이트(prettier → eslint → tsc → knip → test),
사람용 README와 에이전트용 CLAUDE.md 분리. 테스트 71개는 Slack·화면·Claude 없이 돈다.

## 3. 확정된 설계 결정

### 수신: 봇 이벤트가 아니라 "사용자 대신" 구독 (계획서 변경)

에이전트는 봇이 아니라 정식 멤버 계정이다. 사람이 에이전트에게 보낸 DM은 사람 ↔ 에이전트 계정 사이의 대화라서
**봇 이벤트로는 받을 수 없다.** 그래서:

- Slack 앱에 봇 scope 없이 **User Token Scopes**(읽기만): `im:history`, `mpim:history`, `channels:history`, `groups:history`,
  `users:read`, `channels:read`, `groups:read`, `im:read`, `mpim:read`
- Event Subscriptions → **Subscribe to events on behalf of users**: `message.im`, `message.mpim`, `message.channels`, `message.groups`
- 앱 설치·승인은 **에이전트 계정으로** (앱 Collaborator로 추가 후 에이전트 계정으로 Install)
- 토큰: `SLACK_APP_TOKEN`(xapp-, `connections:write`) + `SLACK_READ_TOKEN`(에이전트의 xoxp-, 이름 조회용)

### 발신 금지를 코드와 토큰 양쪽에서 강제

- 읽기 토큰에 `*:write` scope가 하나라도 있으면 부팅을 거부한다.
- ESLint: Slack SDK는 `src/slack`에서만 import, 그 안에서도 `chat`·`files`·`reactions`·`apiCall` 접근 금지.
- 엔진에게는 데스크 도구만 준다(`--tools ""`, `--strict-mcp-config`, `--permission-mode dontAsk`). 셸·파일 능력 없음.

### Socket Mode 클라이언트 직접 구현 (계획서의 `@slack/bolt`에서 변경)

`@slack/socket-mode`(bolt가 내부에서 사용)는 연결 유지 ping에 Node 전용 `undici.ping`을 써서 **Bun에서는 연결 2초마다 끊김**.
Bun 내장 WebSocket으로 직접 구현했다(hello / ack / disconnect 재연결 / 지수 백오프). 같은 앱 토큰으로 다른 연결이 있으면 경고한다.

### 협조적 인터럽트 구현

- 턴은 한 번에 하나, 밖에서 끊지 않는다(ESLint가 `.interrupt(` 호출 금지).
- 작업 중 새 메시지는 도구 결과 끝의 한 줄 알림(🔔 새 Slack 메시지 N건)으로만 보인다.
- 에이전트가 안전한 지점에서 선택: `inbox_peek`(보기) / `inbox_take`(이번 턴에 처리) / `inbox_yield`(메모 남기고 일시정지 → 대기 메시지 처리 후 재개).
- 턴 순서: 가장 오래 기다린 대화 → 대기 없으면 가장 최근 멈춘 일 → 대기.
- 종료(SIGTERM)도 현재 턴이 끝나길 기다린다. 대기열·일시정지 목록은 재시작해도 남는다.

### 대화 = 엔진 세션

채널이나 DM 하나(스레드 포함)가 대화 하나이고, 대화마다 `claude --resume` 세션 하나를 이어 쓴다.

### 주소 판별과 루프 정지

- 받는 것: DM·그룹 DM, 에이전트를 멘션한 채널 메시지, 에이전트가 말했거나 시작한 스레드의 답글.
- 안 받는 것: 자기 메시지, 봇·시스템 메시지, 중복.
- 루프 정지: 한 채널에서 사람이 끼지 않은 채 에이전트가 `MAX_AGENT_EXCHANGES`(기본 4)번 말하면, 사람이 말할 때까지 사람에게만 답한다.

### 권한은 사람이 준다

에이전트는 macOS 권한 창·보안 설정을 누르지 않는다(첫 서비스 실행 때 에이전트 스스로 이렇게 판단했고, 규칙으로 고정).
권한이 없으면 런타임은 턴을 시작하지 않고 메시지를 대기열에 두며 30초마다 `desk not ready`를 로그에 남긴다.

## 4. 이 맥(첫 에이전트 장비) 세팅

| 항목 | 값 |
| --- | --- |
| 장비 | MacBook Pro, 화면 1728×1117pt (에이전트는 축소 스크린샷을 봄) |
| 에이전트 | `에이전트1`, Slack 멤버 ID `U0C6F59TRNW`, 워크스페이스 "집" |
| 사람 | Jonghyun Park, `U0BP73A4RDE` (`HUMAN_SLACK_USER_IDS`) |
| 런타임 | Homebrew bun 1.4.2 (`brew pin bun` 권장), Claude Code CLI 2.1.295 |
| Slack 클라이언트 | 데스크톱 앱 (에이전트 계정 로그인) |
| 상시 실행 | `~/Library/LaunchAgents/com.slack-agent-org.agent.plist`, 로그 `data/logs/agent.log` |
| 권한 | 손쉬운 사용 + 화면 녹음: 터미널, `/opt/homebrew/Cellar/bun/1.4.2/bin/bun` |

세팅 절차 전체는 저장소의 `docs/mac-setup.md`.

## 5. 겪은 문제와 해결

| 증상 | 원인 | 해결 |
| --- | --- | --- |
| 연결 후 2초마다 끊기고 재연결 반복 | `@slack/socket-mode`가 Bun에 없는 `undici.ping` 사용 | Socket Mode를 Bun 내장 WebSocket으로 직접 구현 |
| Ctrl+C 한 번에 강제 종료 | `bun run`이 SIGINT를 한 번 더 전달 | 1초 안의 중복 신호는 같은 입력으로 처리 |
| 시스템 설정에 "손쉬운 사용" 항목이 안 보임 | 왼쪽 메뉴의 접근성 화면과 혼동, 권한 요청 전이라 목록에 없음 | 도우미가 macOS 권한 창을 띄우도록(`request`), 바로 여는 URL 안내 |
| 답장 첫 글자 누락, `cmd+a` 뒤 입력 무시 | 수식키 해제 신호 미전송, 클릭 직후 포커스 전 입력 | 수식키를 실제 키처럼 눌렀다 뗌, 입력 전 0.15초 대기, 글자에 수식키 상속 금지 |
| Spotlight 첫 실행 안내 창에 막힘 | macOS 첫 사용 안내 | Slack은 Dock 아이콘으로 띄우도록 지침 변경 |
| 서비스 첫 실행에서 화면이 검게 보임 | launchd로 돌면 터미널이 아니라 bun 자체에 권한 필요, macOS 허용 창 | 사람이 허용, 권한 없으면 턴 보류 + 메시지 대기 |
| 서비스 재시작 후 DM이 안 들어오는 것처럼 보임 | 보내는 휴대폰이 오프라인이라 Slack에 도달하지 않음 | `conversations.history`로 메시지 도착 여부부터 확인하는 절차를 문서화 |
| 원격으로 보낸 파일이 맥에 반영 안 됨(작업 과정) | 같은 경로로 재전송 시 이전 내용이 쓰임 | 매번 새 경로로 보내고 해시로 대조 |

## 6. 운영 메모

```bash
bun run doctor              # 화면·권한·Claude 로그인·Slack 토큰·Socket Mode(5초 유지) 점검
bun run start               # 포그라운드 실행 (Ctrl+C 한 번: 턴 마치고 종료)
bun run service:install     # 상시 실행
bun run service:restart     # 코드·설정 변경 후 (턴 마치고 재시작)
bun run service:uninstall   # 완전히 끄기
tail -f data/logs/agent.log
pgrep -fl "src/index.ts"    # 에이전트 프로세스는 하나여야 함
```

- 터미널 실행과 서비스를 동시에 띄우지 않는다(Slack이 이벤트를 연결 하나에만 보냄, 마우스 충돌).
- 사용량: 맥의 Claude 구독으로 돌아 별도 청구는 없지만 사용량 한도에 포함. 줄이려면 `.env`에 `CLAUDE_MODEL=sonnet`.
- 로그의 `costUsd`는 이어 쓰는 세션의 누적치로 보인다(미확인).
- macOS가 화면 접근 허용 창을 주기적으로 다시 띄울 수 있음(macOS 27에서 주기 미확인). 뜨면 `desk not ready` → 사람이 허용.

## 7. 남은 일

**바로 할 것**
- 저장소를 git에 첫 커밋 (아직 커밋 없음). `.husky/pre-push`가 맥에 없으면 추가(원격 도구로 쓸 수 없는 경로).
- 덮개·자동 로그인·잠자기 해제 등 상시 운영 조건 점검 (`docs/mac-setup.md` 2단계).

**아직 실전 검증하지 않은 것**
- 채널(`#team`) 멘션과 스레드 답글 흐름
- 에이전트끼리의 대화와 루프 정지(두 번째 에이전트가 생긴 뒤)
- `inbox_yield`로 긴 작업을 멈췄다가 재개하는 흐름 (테스트로만 검증)

**계획서의 미정 사항 (조직 차원)**
- GPT 에이전트: OpenAI 엔진 드라이버 + 두 번째 장비 (책상·귀·인터럽트 규칙은 그대로 재사용)
- 각 에이전트의 이름·캐릭터·직함, 업무 도메인 배정
- 작업 권한과 안전장치 — 정해지기 전까지 에이전트는 Slack 대화만 할 수 있음
- 장애 대응: 실패한 턴의 메시지 재시도(지금은 로그만 남김), 토큰 만료 알림

**기술 부채**
- 여러 디스플레이 지원(지금은 주 디스플레이만), Linux(라즈베리파이) 데스크 드라이버
