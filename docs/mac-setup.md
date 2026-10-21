# 맥을 에이전트 장비로 만들기

에이전트 한 명 = 장비 한 대입니다. 이 문서는 맥 한 대를 한 에이전트의 업무용 컴퓨터로 만드는 순서입니다.
같은 순서를 장비마다 반복하면 되고, 장비마다 다른 것은 `.env`뿐입니다.

## 0. 하드웨어 조건

- **화면이 켜져 있어야 합니다.** 에이전트는 화면을 보고 일하므로 덮개를 닫은 맥북은 쓸 수 없습니다.
  덮개를 열어 두거나, 닫아 둘 거라면 외부 모니터나 HDMI 더미 플러그를 연결합니다.
- 전원 어댑터 연결, 가능하면 유선 네트워크(Socket Mode 연결 안정성).

## 1. Slack 앱 (에이전트마다 하나)

에이전트는 봇이 아니라 정식 멤버 계정으로 일합니다. 사람이 에이전트에게 보낸 DM은 봇에게 전달되지 않으므로,
이벤트를 **에이전트 계정 대신(on behalf of users)** 구독하고 그 앱을 **에이전트 계정이 승인**합니다.

1. 에이전트용 Slack 멤버 계정을 준비하고 멤버 ID를 복사해 둡니다(프로필 → ⋮ → 멤버 ID 복사). 사람(당신)의 멤버 ID도 복사합니다.
2. [api.slack.com/apps](https://api.slack.com/apps)에서 앱을 만듭니다(워크스페이스 관리자 계정).
3. **Socket Mode** 켜기 → App-Level Token 생성(scope: `connections:write`) → `xapp-…` = `SLACK_APP_TOKEN`.
4. **OAuth & Permissions → User Token Scopes** (읽기 전용 + 상태 하나):
   `im:history`, `mpim:history`, `channels:history`, `groups:history`,
   `users:read`, `channels:read`, `groups:read`, `im:read`, `mpim:read`.
   예외로 **`users.profile:write`** 하나를 더합니다. 에이전트가 자기 Slack 상태를 API로 바꾸는 데만 씁니다
   (`SLACK_STATUS=on`일 때만 허용, README "Slack 상태"). 다른 쓰기 scope는 넣지 않습니다.
   Bot Token Scopes는 필요 없습니다. 예전에 넣어 둔 `chat:write` 같은 쓰기 scope가 있다면 지웁니다
   — `users.profile:write` 외의 쓰기 scope가 있는 토큰으로는 에이전트가 아예 시작하지 않습니다.
5. **Event Subscriptions** 켜기 → **Subscribe to events on behalf of users**에
   `message.im`, `message.mpim`, `message.channels`, `message.groups` 추가.
6. **Settings → Collaborators**에 에이전트 계정을 추가합니다.
7. 이 맥의 브라우저에서 **에이전트 계정으로** api.slack.com에 들어가 같은 앱의 **Install to Workspace**를 누르고 승인합니다.
   나오는 **User OAuth Token**(`xoxp-…`) = `SLACK_READ_TOKEN`. (관리자 승인이 필요한 워크스페이스면 관리자 계정으로 승인)
8. 에이전트가 들어가 있어야 하는 채널(예: `#team`)에 에이전트 계정을 초대합니다. 봇 초대는 필요 없습니다.

## 2. 맥 준비

- **자동 로그인**: 시스템 설정 → 사용자 및 그룹 → 자동 로그인을 이 계정으로. 재부팅 뒤에도 에이전트가 화면을
  가진 세션에서 다시 시작하려면 필요합니다(FileVault가 켜져 있으면 자동 로그인이 막힙니다).
- **잠들지 않게**:
  ```bash
  sudo pmset -a sleep 0 displaysleep 0 disksleep 0
  ```
  시스템 설정 → 잠금 화면에서 화면 보호기 시작·디스플레이 끄기를 "안 함", 암호 요구를 "안 함"으로 둡니다.
- **입력 소스는 ABC 하나만**: 시스템 설정 → 키보드 → 입력 소스. 한글 입력기가 켜져 있으면 키 입력이 조합되어
  달라질 수 있습니다. 에이전트의 한글 입력은 입력기 없이 유니코드로 들어가므로 ABC만으로 충분합니다.
- **도구 설치**:
  ```bash
  xcode-select --install          # swiftc (손 빌드용)
  brew install --cask slack       # 데스크톱 앱을 쓸 경우
  # bun 1.4.2, Claude Code CLI 설치 후:
  claude auth login               # 이 맥에서 쓸 Claude 계정으로 로그인
  ```
- **Slack 데스크톱 앱**에 에이전트 계정으로 로그인하고 창을 최대화해 둡니다. 설정 → 고급의
  "Enter 키로 메시지 보내기"가 기본값(켜짐)인지 확인합니다. 웹앱을 쓸 거라면 `SLACK_CLIENT=web`.

## 3. 저장소와 설정

```bash
cd ~/Agent/slack-agent-org
bun install
cp .env.example .env     # 아래 값 채우기
bun run desk:build       # → .bin/desk-helper
```

반드시 채울 값: `AGENT_NAME`, `AGENT_SLACK_USER_ID`, `HUMAN_SLACK_USER_IDS`, `SLACK_APP_TOKEN`,
`SLACK_READ_TOKEN`. 나머지는 기본값이 있고 `.env.example`에 설명이 있습니다.

## 4. 권한과 점검

```bash
bun run doctor
```

항목마다 ✔/✘와 고치는 방법이 나옵니다. 처음에는 보통 두 권한이 빠져 있습니다. 권한이 없으면 `doctor`가
macOS 권한 창을 띄우고 실행한 앱을 목록에 올려 두므로, 창에서 "시스템 설정 열기" → 스위치를 켜면 됩니다.
목록은 시스템 설정 왼쪽의 "손쉬운 사용"(접근성 기능 화면)이 아니라 **개인정보 보호 및 보안 오른쪽 목록 안**에
있습니다. 바로 열기:

```bash
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
```

시스템 설정 → 개인정보 보호 및 보안에서:

- **손쉬운 사용**(손: 마우스·키보드 이벤트)
- **화면 및 시스템 오디오 녹음**(눈: 스크린샷)

에 다음 둘을 추가합니다.

1. 지금 쓰는 **터미널 앱** — `bun run doctor`, `bun run start`처럼 터미널에서 실행할 때.
2. **bun 실행 파일** — launchd 서비스로 돌 때. 경로는 `doctor` 출력과 `service:install` 출력에 나옵니다
   (심볼릭 링크가 아닌 실제 파일 경로). 목록의 + 버튼 → cmd+shift+G로 경로 입력.
   Homebrew bun은 경로에 버전이 들어가므로(`/opt/homebrew/Cellar/bun/1.4.2/bin/bun`) `brew pin bun`으로 고정합니다.
   업그레이드되면 경로가 바뀌어 권한이 풀립니다.

권한을 준 뒤에는 해당 프로세스를 다시 시작해야 반영됩니다. `doctor`가 찍은 `data/screen/screen.png`를 열어
배경화면만이 아니라 창들이 보이는지 확인하세요.

## 5. 첫 실행

```bash
bun run start
```

`agent ready` 로그가 나오면 당신의 계정으로 에이전트에게 DM을 보냅니다. `message received` → 에이전트가
화면에서 Slack을 열고 답장하는 모습을 볼 수 있습니다. 마우스를 건드리지 마세요 — 에이전트의 손입니다.
Ctrl+C 한 번은 현재 턴을 마치고 종료, 두 번은 즉시 종료입니다.

## 6. 상시 실행

```bash
bun run service:install
```

로그인과 함께 시작되고, 죽으면 다시 시작됩니다. 로그는 `data/logs/agent.log`(JSON 한 줄씩)입니다.

서비스로 처음 돌 때 macOS가 "bun이 화면에 접근하려 합니다 — 허용 / 시스템 설정 열기" 창을 띄울 수 있습니다.
**사람이 직접 허용**합니다(에이전트는 자기 권한 창을 누르지 않도록 되어 있습니다). 권한이 없는 동안 에이전트는
턴을 시작하지 않고 메시지를 대기열에 쌓아 두며, 로그에 30초마다 `desk not ready`를 남깁니다. 같은 창이 나중에
다시 뜨면(macOS의 주기적 재확인일 수 있음) 다시 허용하면 쌓인 메시지부터 이어서 처리합니다.

```bash
tail -f data/logs/agent.log
bun run service:restart     # 현재 턴을 마치고 재시작 (코드·설정 변경 후)
bun run service:uninstall   # 완전히 끄기 (다음 로그인에도 안 켜짐)
launchctl bootout gui/$(id -u)/com.slack-agent-org.agent   # 등록은 두고 지금만 끄기
pgrep -fl "src/index.ts"    # 떠 있는 에이전트 확인 (하나여야 함)
```

서비스는 꺼지면 launchd가 다시 켜므로 프로세스를 kill 하는 것으로는 끌 수 없습니다. 터미널의 `bun run start`와
서비스를 동시에 띄우지 마세요 — Slack은 이벤트 하나를 연결 하나에만 보내므로 메시지가 나뉘고, 두 프로세스가
같은 마우스를 씁니다.

업데이트: `git pull && bun install && bun run service:restart`.

## 문제 해결

| 증상                                      | 확인할 것                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| 시작하자마자 `SLACK_READ_TOKEN can write` | 1-4단계: 앱에서 쓰기 scope를 지우고 에이전트 계정으로 다시 설치, 새 `xoxp-` 토큰으로 교체   |
| DM을 보내도 `message received`가 없음     | 1-5단계 "on behalf of users" 구독, 1-7단계를 에이전트 계정으로 했는지                       |
| 채널 메시지가 안 들어옴                   | 에이전트 계정이 채널 멤버인지, 메시지가 에이전트를 멘션했는지(멘션·DM·참여한 스레드만 받음) |
| 스크린샷에 창이 안 보이고 배경만 보임     | 화면 녹음 권한 (터미널 또는 bun), 권한 준 뒤 재시작                                         |
| 클릭·입력이 안 됨                         | 손쉬운 사용 권한, `doctor`의 accessibility                                                  |
| 한글이 이상하게 입력됨                    | 입력 소스를 ABC 하나만                                                                      |
| 로그에 `desk not ready`                   | 서비스용 bun의 두 권한, 화면에 떠 있는 macOS 허용 창 (6단계)                                |
| 로그에 `another process is connected`     | 다른 에이전트 프로세스가 같은 앱 토큰으로 떠 있음 — `pgrep -fl "src/index.ts"` 후 정리      |
| 연결은 정상인데 아무것도 안 들어옴        | 메시지가 실제로 그 DM에 들어갔는지부터: 보내는 기기가 오프라인이면 Slack에 도달하지 않음    |
| 답장 첫 글자가 빠짐                       | `bun run desk:build`로 손(도우미)을 최신으로 다시 빌드                                      |
| `turn failed … no result`                 | `claude auth status`, Claude 사용량 한도                                                    |
| 에이전트끼리 대화가 멈춤                  | 의도된 루프 정지입니다. 사람이 한마디 하면 풀립니다(`MAX_AGENT_EXCHANGES`)                  |
