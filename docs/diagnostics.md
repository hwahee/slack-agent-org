# 진단 기록 (diagnostics) — 계약 v1

에이전트는 실행 중에 무슨 일이 있었는지를 **기계가 읽는 파일**로 남깁니다. 프로세스 밖의 관찰자(테스트베드 대시보드 등)는
이 파일만 읽습니다. 사람용 로그(`agent.log`, `agent.err.log`)의 문구는 계약이 아닙니다.

- 코드상의 원본: `src/diag/events.ts` (스키마). 이 문서는 사람이 읽는 사본입니다. 둘이 다르면 코드가 맞고, 이 문서를 고칩니다.
- 설정: `DIAG`(`on`/`off`, 기본 `on`), `DIAG_SNAPSHOT_SEC`(기본 5), `DIAG_RETENTION_DAYS`(기본 7).

## 1. 원칙 — 관찰만 한다

1. **동작을 바꾸지 않습니다.** 연결, 재연결 시점과 백오프, ack, 폴링, 따라잡기, 턴 순서는 진단이 있든 없든 같습니다.
   `DIAG=off`면 진단은 아무것도 하지 않는 구현(`noopDiagnostics`)으로 바뀌고, 그 밖의 차이는 없습니다.
2. **보내지 않습니다.** WebSocket에 아무것도 새로 쓰지 않고(클라이언트 ping 없음), 새 Slack API·네트워크 호출이 없고,
   새로 여는 포트도 없습니다.
3. **실패해도 에이전트는 계속됩니다.** 기록·스냅샷·파일 정리가 실패하면 `status.json`의 `diag.writeErrors`가 늘고,
   사람용 로그에 warn이 가끔(처음, 그리고 100번마다) 남을 뿐입니다. 디스크가 멈춰 쓰기가 5,000건 넘게 밀리면 새 기록은 버리고 셉니다.
4. **담지 않는 것:** 메시지 본문, 사람·채널 이름, 토큰, Socket Mode WebSocket URL(일회용 티켓 포함), 엔진 프롬프트·요약·도구 입력,
   채널 판단의 이유 문장. Slack ID(`U…`, `C…`, `D…`, `ts`)는 담습니다. 스키마의 객체는 모두 strict라서, 목록에 없는 필드가
   끼면 테스트가 실패합니다.

ESLint가 경계를 강제합니다: `src/diag`는 `src/lib`와 validation 파사드 외에는 에이전트의 어떤 모듈도 import하지 못합니다.

## 2. 파일

| 파일                                    | 내용                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `<DATA_DIR>/diag/diag-YYYY-MM-DD.jsonl` | 기록. 한 줄에 한 건, 추가만 함. 날짜는 **UTC** 기준(한국 시각 오전 9시에 파일이 바뀜) |
| `<DATA_DIR>/diag/status.json`           | 지금 상태 스냅샷. `DIAG_SNAPSHOT_SEC`마다 `status.json.tmp`에 쓴 뒤 rename으로 교체   |

- `DIAG_RETENTION_DAYS`보다 오래된 `diag-*.jsonl`은 부팅 후 첫 기록 때와 UTC 날짜가 바뀔 때 지웁니다. 다른 파일은 건드리지 않습니다.
- 줄 순서 = 쓴 순서. 한 부팅 안에서 `seq`가 1부터 하나씩 늘어납니다. 비는 번호가 있으면 쓰기 실패로 빠진 기록입니다.
- 강제 종료(`process.shutdown` `forced`) 직후의 기록은 디스크에 닿지 못할 수 있습니다.

## 3. 기록의 공통 필드

```jsonc
{
  "v": 1, // 계약 버전
  "t": "2026-11-25T05:12:03.481Z", // 벽시계, UTC, 밀리초
  "mono": 123456.7, // performance.now() (ms, 프로세스 기준)
  "boot": "b-1a2b3c4d", // 부팅마다 새로 만드는 ID
  "seq": 42, // 부팅 안에서 단조 증가
  "kind": "socket.closed",
  // …아래 표의 kind별 필드
}
```

`t`와 `mono`의 차이가 부팅 중에 벌어지면 맥이 잠들었거나 시계가 바뀐 것입니다(`clock.gap`도 함께 봅니다).

## 4. 기록 종류

`conn`은 소켓 연결 시도 번호입니다. 부팅 안에서 시도할 때마다 1씩 늘어나므로, 같은 `conn`의 기록이 한 연결의 일생입니다.
`?`는 있을 때만 들어가는 필드입니다.

### 프로세스

| kind               | 언제                                                   | 필드                                                                                                                                               |
| ------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `process.booted`   | 부팅 직후(첫 기록)                                     | `pid`, `bunVersion`, `config`: `pollMinutes`, `catchup`, `catchupMaxHours`, `slackStatus`, `channelTriage`, `diagSnapshotSec`, `diagRetentionDays` |
| `process.shutdown` | 종료 시작·완료·강제                                    | `phase`(`started`·`completed`·`forced`), `signal`                                                                                                  |
| `clock.gap`        | 1초 타이머가 5초 넘게 늦게 돎(잠자기·이벤트 루프 막힘) | `expectedMs`, `wallElapsedMs`, `monoElapsedMs`                                                                                                     |
| `desk.state`       | 시작 시 데스크가 준비됐을 때, 막혔을 때(한 번)         | `ready`, `problem?`                                                                                                                                |

### 소켓 (`src/slack/socket.ts`)

| kind                          | 언제                                            | 필드                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `socket.url-requested`        | `apps.connections.open` 성공·실패               | `conn`, `ok`, `ms`, `error?` — URL은 절대 담지 않음                                                                                                       |
| `socket.opened`               | WebSocket `open`                                | `conn`, `msSinceRequest`                                                                                                                                  |
| `socket.hello`                | Slack의 `hello`                                 | `conn`, `numConnections`(1이어도 항상, 없으면 `null`), `helloAfterMs`, `debugHost?`, `approximateConnectionTime?`(Slack이 이 연결을 유지할 예정 시간, 초) |
| `socket.disconnect-requested` | Slack의 `disconnect` 프레임                     | `conn`, `reason?`, `debugHost?`                                                                                                                           |
| `socket.error`                | WebSocket `error` 이벤트                        | `conn`, `message`                                                                                                                                         |
| `socket.closed`               | WebSocket `close`                               | `conn`, `code`, `reason`, `wasClean`, `greeted`(hello를 받았었는지), `livedMs`, `lastFrameAgoMs`(마지막 프레임이 닫힐 때 몇 ms 전이었는지)                |
| `socket.reconnect-scheduled`  | 재연결 예약                                     | `delayMs`, `attempt`(hello 이후 연속 실패 횟수 + 1)                                                                                                       |
| `socket.reconnect-failed`     | 재연결 실패                                     | `error`, `nextDelayMs`                                                                                                                                    |
| `socket.envelope`             | `envelope_id`가 있는 모든 프레임(ack 보낸 직후) | `conn`, `type`, `envelopeId`, `retryAttempt?`, `retryReason?`, `eventId?`, `eventTime?`, `eventType?`, `channel?`, `channelType?`, `ts?`, `subtype?`      |
| `socket.frame-unreadable`     | JSON이 아니거나 형식이 다른 프레임              | `conn`, `bytes`                                                                                                                                           |

- **ping은 기록 한 줄씩 남기지 않습니다**(소음). Bun 1.4.2의 클라이언트 WebSocket은 서버 ping을 `ping` 이벤트로 알려 주고,
  리스너가 있어도 pong은 Bun이 자동으로 보냅니다(`src/slack/socket.diag.test.ts`가 고정). 그래서 ping 수와 마지막 ping 시각은
  `status.json`의 `socket.pingsReceived`·`socket.lastPingAt`에 있습니다. Bun을 올릴 때 이 테스트가 깨지면 ping 관찰이 사라진 것입니다.
- `socket.envelope`의 `retryAttempt`·`retryReason`은 Slack이 같은 이벤트를 다시 보낸 것(앞 전달에서 ack를 못 받음)을 뜻합니다.
  메시지 기록(`message.observed`)과는 `channel:ts`로 잇습니다.

### 메시지 경로

| kind               | 언제                                        | 필드                                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message.observed` | 귀가 메시지를 볼 때마다(소켓·따라잡기 모두) | `id`(`채널:ts`, 대기열 ID), `path`(`socket`·`catchup`), `channel`, `ts`, `user?`, `receivedAt`, `delayMs`(= `receivedAt` − `ts`), `deliver`, `reason?`(주소 판별이 거른 이유), `outcome`(`queued`·`overheard`·`not-delivered`·`remember-only`) |
| `inbox.taken`      | 대기열에서 메시지를 꺼낼 때                 | `by`(`turn-start`·`inbox_take`), `messages`: `{ id, waitedMs }[]`                                                                                                                                                                              |
| `turn.started`     | 턴 시작                                     | `conversation`, `cause`(`messages`·`resume`), `messageIds`                                                                                                                                                                                     |
| `turn.ended`       | 턴 종료(성공·오류·예외)                     | `conversation`, `ms`, `ok`, `toolRoundTrips?`, `costUsd?`, `error?`                                                                                                                                                                            |
| `triage.decided`   | 채널 판단 한 번                             | `conversation`, `judged`(본 메시지 ID), `outcome`(`answer`·`quiet`·`unreadable`·`failed`), `ids`(답할 메시지), `ms`                                                                                                                            |

한 메시지의 일생: `socket.envelope`(소켓이면) → `message.observed` → `inbox.taken` → `turn.started` → `turn.ended`.
`message.observed`의 `delayMs`가 크고 `path`가 `catchup`이면 귀(소켓)가 놓친 메시지를 따라잡기가 건진 것입니다.

### 폴링·따라잡기·하트비트

| kind             | 언제                         | 필드                                                                                                                            |
| ---------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `poll.ran`       | 폴링 한 번 끝남, 또는 건너뜀 | `skipped`, `ms`, `tasks`: `{ name, ms, ok }[]`                                                                                  |
| `catchup.ran`    | 따라잡기 한 번 끝남          | `trigger`(`poll`·`connected`·`other`), `ms`, `firstRun`, `since?`, `reads?`, `found?`, `answered?`, `rememberedOnly?`, `error?` |
| `heartbeat.beat` | 하트비트 한 번               | `outcome`(`working`: 시각 갱신 · `blocked`: 데스크 막힘 · `left`: 다른 문제로 시각을 그대로 둠 · `failed`), `problem?`          |

`catchup.ran`의 `trigger`: `connected`는 소켓이 (다시) 연결된 직후, `poll`은 정기 폴링입니다. 겹친 호출은 한 번으로 합쳐지고,
대기 중인 실행은 그것을 예약한 호출의 trigger를 씁니다.

## 5. 상태 스냅샷 `status.json`

```jsonc
{
  "v": 1,
  "writtenAt": "…", // 이 값이 DIAG_SNAPSHOT_SEC보다 한참 오래됐으면 프로세스가 멈췄거나 꺼진 것
  "mono": 0,
  "boot": "b-…",
  "pid": 0,
  "sections": {
    "socket": {
      "conn": 3,
      "live": true, // hello를 받았고 그 뒤로 닫히지 않음
      "readyState": 1, // 0 연결 중 · 1 열림 · 2 닫는 중 · 3 닫힘 · null 소켓 없음
      "bufferedAmount": 0,
      "connectedAt": "…",
      "lastFrameAt": "…", // ping 포함 마지막 프레임
      "lastFrameType": "ping",
      "framesReceived": 0, // 메시지 프레임 수(ping 제외)
      "pingsReceived": 0,
      "lastPingAt": "…",
      "lastEnvelopeAt": "…",
      "reconnects": 0, // 첫 연결 뒤의 성공한 연결 수
    },
    "inbox": { "pending": 0, "unseen": 0, "oldestWaitingMs": null },
    "turn": { "conversation": null, "startedAt": null, "suspended": 0, "failingTurns": 0 },
    "poll": { "everyMs": 600000, "lastStartedAt": "…", "lastEndedAt": "…", "nextAt": "…" },
    "catchup": {
      "lastRunAt": "…",
      "lastTrigger": "poll",
      "lastSince": "…",
      "lastFound": 0,
      "lastError": null,
    },
  },
  "clock": { "lastGapAt": null },
  "diag": { "records": 0, "writeErrors": 0 },
}
```

- 섹션은 해당 부품이 만들어졌을 때만 있습니다(예: `CATCHUP=off`면 `catchup` 없음). 섹션 하나를 읽다 실패하면 그 섹션만 빠집니다.
- **반쯤 죽은 소켓 보는 법**: `live: true`, `readyState: 1`인데 `lastFrameAt`(= 마지막 ping)이 평소 ping 간격보다 훨씬 오래됐으면,
  프로세스는 연결이 살아 있다고 믿지만 실제로는 아무것도 오지 않는 상태입니다.

## 6. 호환 규칙

- **같은 `v`에서 허용:** kind 추가, 필드 추가(있을 때만 들어가는 필드로), 스냅샷 섹션·필드 추가.
- **`v`를 올림:** 필드·kind 이름 변경, 삭제, 의미나 단위 변경, 파일 위치·형식 변경. 아래 변경 이력에 남깁니다.
- 관찰자는 모르는 kind와 필드를 무시해야 합니다.

### 변경 이력

- v1 (2026-11-25): 처음 만듦.

## 7. 확인

```bash
tail -f "data/diag/diag-$(date -u +%F).jsonl"          # 오늘(UTC) 기록
cat data/diag/status.json                                # 지금 상태
grep '"kind":"message.observed"' data/diag/diag-*.jsonl | grep '"path":"catchup"'   # 따라잡기가 건진 메시지
grep -E '"kind":"socket\.(closed|hello|reconnect)' data/diag/diag-*.jsonl           # 연결의 일생
```
