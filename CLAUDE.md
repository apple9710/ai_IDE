# CLAUDE.md

Claude Code를 위한 이 저장소 안내 문서입니다.

## 프로젝트 개요

**Claude IDE** — Claude Code를 안에서 실행하기 위한 VS Code 스타일 데스크톱 IDE (Electron 33).
파일 트리, Monaco 에디터, 실제 PTY 터미널, git 상태, 멀티 프로젝트 탭, Claude Agent SDK 기반 채팅 패널을 제공합니다.

## 실행 / 개발

```bash
npm install          # 최초 1회 (native 모듈 prebuilt 사용)
npm start            # = electron .
```

- **`start.vbs`** 더블클릭 → cmd(콘솔) 창 없이 실행 (권장).
- **`start.bat`** → 콘솔 창이 함께 뜸.
- 이 머신은 Visual Studio 빌드 툴이 없어 native 모듈을 컴파일할 수 없음 → **반드시 prebuilt 바이너리를 쓰는 패키지만** 추가할 것 (`@lydell/node-pty` 사용 중).

## 아키텍처

Electron 표준 3층 구조. 프로세스 간 통신은 전부 `ipcMain`/`ipcRenderer` (preload에서 `contextBridge`로 노출).

| 파일 | 역할 |
|------|------|
| `main.js` | 메인 프로세스. 창 생성, 파일/폴더 IPC, git 상태, PTY 스폰, Claude Agent SDK 채팅 세션 관리 |
| `preload.js` | `contextBridge`로 안전한 API를 렌더러에 노출 |
| `renderer/index.html` | UI 레이아웃 (activity bar · 파일 트리 · 에디터 · 터미널 · 채팅) |
| `renderer/renderer.js` | 렌더러 로직. 프로젝트 레지스트리(`projects[]`), 탭 전환, 에디터, 채팅 DOM |
| `renderer/styles.css` | Claude 데스크톱 스타일 웜 다크 테마 (clay accent `#d97757`) |

### 핵심 구조

- **멀티 프로젝트**: `projects[]` 레지스트리. 각 프로젝트가 자기 파일 트리·에디터 탭·터미널·Claude 세션을 가짐. 활성 프로젝트 필드를 모듈 전역(`rootFolder`, `openTabs`, `terminals` …)에 미러링하고 `switchProject`에서 스냅샷/복원. 채팅 상태는 프로젝트 객체에 두어 백그라운드에서도 계속 렌더링됨.
- **터미널**: `@lydell/node-pty` → `pty:spawn`/`pty:write`/`pty:data`/`pty:resize`/`pty:kill`. 터미널 id는 projectId로 prefix해서 전역 유일성 확보. 실행 시 `claude` 자동 실행.
- **채팅**: `@anthropic-ai/claude-agent-sdk` (ESM → CJS 메인에서 dynamic import). 세션은 `chats` Map (projectId 키). 스트리밍 입력 모드 + `includePartialMessages`로 토큰 실시간 스트리밍. `canUseTool` → 렌더러 권한 카드(허용/항상 허용/거부). 모델(`opus`/`sonnet`/`haiku`/`fable`)·reasoning effort(`low`~`max`) 셀렉터, 이미지 첨부 지원.
- **콘솔 창 숨김**: 메인에서 `execFile`로 git 호출 시 `windowsHide: true`. PTY는 conpty라 콘솔 창이 뜨지 않음. 런처 콘솔 창은 `start.vbs`로 회피.

## 규칙

- 코드는 주변 코드의 스타일(주석 밀도, 네이밍, 관용구)에 맞출 것. UI 문자열은 한국어.
- native 모듈 추가 금지 (위 "실행/개발" 참고).
- `docs/` 아래에 아키텍처/기능 문서가 있음.
