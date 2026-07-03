# 아키텍처

Claude IDE의 내부 구조 문서입니다. 코드 수정 전 참고용.

---

## 1. 파일 구성

```
ai_ide/
├─ main.js               # Electron 메인 프로세스 (창, IPC, PTY, Claude SDK)
├─ preload.js            # contextBridge — 렌더러에 안전한 window.api 노출
├─ renderer/
│  ├─ index.html         # 마크업 (활동바/사이드바/에디터/터미널/채팅)
│  ├─ renderer.js        # 렌더러 로직 전부 (UI, 상태, 이벤트)
│  └─ styles.css         # 웜 다크 테마 (clay 액센트 #d97757)
├─ start.bat             # npm start 런처
└─ docs/                 # 이 문서
```

- **contextIsolation: true, nodeIntegration: false** — 렌더러는 Node에 직접 접근하지 않고, `preload.js`가 노출한 `window.api`(IPC 래퍼)만 사용합니다.
- **plugins: true** — Chromium 내장 PDF 뷰어 활성화용.

---

## 2. IPC 채널

모든 채널은 `preload.js`의 `window.api.*` 로 감싸져 렌더러에 노출됩니다.

### 설정 / 파일 / Git
| 채널 | 방향 | 용도 |
|------|------|------|
| `config:get` / `config:set` | invoke | 설정 로드 / 병합 저장 |
| `dialog:openFolder` | invoke | 폴더 선택 다이얼로그 |
| `fs:readDir` | invoke | 디렉터리 1단계 읽기 (정렬된 목록) |
| `fs:readFile` | invoke | 텍스트 파일 읽기 (5MB 초과·바이너리 거부) |
| `fs:readFileBinary` | invoke | PDF/이미지 등 base64 + mime 반환 |
| `fs:writeFile` | invoke | 파일 저장 |
| `fs:createFile` / `fs:createFolder` / `fs:rename` / `fs:delete` | invoke | 파일/폴더 조작 |
| `git:status` | invoke | `{isRepo, branch, root, files}` (porcelain 파싱) |

### 클립보드
| 채널 | 용도 |
|------|------|
| `clipboard:readImage` | 네이티브 클립보드 이미지 → PNG base64 (카카오톡 등 비트맵 폴백) |
| `clipboard:writeText` | 텍스트 복사 (file:// 환경에서 navigator.clipboard 대체) |

### 터미널 (PTY)
| 채널 | 방향 | 용도 |
|------|------|------|
| `pty:spawn` | invoke | 셸 프로세스 생성 (id, cwd, cols, rows) |
| `pty:write` / `pty:resize` / `pty:kill` | send | 입력 / 크기 조정 / 종료 |
| `pty:data` / `pty:exit` | event | 출력 스트림 / 종료 알림 |

메인은 `terminals` Map(id→pty)으로 관리. 터미널 id는 `<projectId>-term-N` 형태로 전역 유일.

### Claude 채팅 (Agent SDK)
| 채널 | 방향 | 용도 |
|------|------|------|
| `agent:send` | invoke | 메시지 전송 `{content, cwd, projectId, model, effort}` |
| `agent:interrupt` | invoke | 진행 중 작업 중단 `{projectId}` |
| `agent:new` | invoke | 세션 종료/초기화 `{projectId}` |
| `agent:set-model` | invoke | 실행 중 세션 모델 변경 `{projectId, model}` |
| `agent:message` | event | SDK 메시지 `{projectId, message}` |
| `agent:permission` | event | 권한 요청 카드 `{projectId, id, …}` |
| `agent:permission-response` | send | 사용자 응답 `{id, behavior}` |
| `agent:error` / `agent:closed` | event | 오류 / 세션 종료 |

- `agent:send`의 `content` 는 **문자열**(텍스트 전용) 또는 **콘텐츠 블록 배열**(이미지 `{type:'image', source:{type:'base64', media_type, data}}` + 텍스트 `{type:'text'}`).
- `model` 은 별칭(`opus`/`sonnet`/`haiku`/`fable`) 또는 미지정(기본), `effort` 는 `low|medium|high|xhigh|max`.

---

## 3. Claude 세션 관리 (main.js)

Agent SDK는 ESM 전용이라 CJS 메인에서 **dynamic import** 로 지연 로드합니다.

- `chats: Map<projectId, {query, input}>` — 프로젝트마다 독립 세션.
- `input` 은 push 가능한 async-iterable(스트리밍 프롬프트). `agent:send` 가 사용자 메시지를 push.
- `query()` 옵션: `cwd`, `permissionMode:'default'`, `canUseTool`(권한 콜백), `includePartialMessages:true`(토큰 스트리밍), 필요 시 `model`/`effort`.
- 모든 `agent:*` 이벤트에 `projectId` 를 실어 렌더러가 올바른 프로젝트 채팅창으로 라우팅.
- 권한 요청은 `pendingPermissions: Map<permId, {resolve, suggestions, projectId}>` 로 대기 후, 렌더러 응답으로 resolve.

---

## 4. 프로젝트 상태 모델 (renderer.js)

여러 프로젝트를 동시에 열되, 화면에 반영되는 것은 활성 프로젝트 하나입니다.

### 레지스트리
```js
projects = [ project, … ]   // 각 project 상태 객체
activeProjectId
```

각 `project` 객체:
```
{ id, folder, expandedPaths(Set), gitState,
  openTabs[], activeTabPath,          // 에디터 탭
  terminals[], activeTermId, termCounter,
  chatEl, chatBusy, currentAssistant, toolCards, chatModel }  // 채팅 상태
```

### 미러링 & 스냅샷/복원
- **활성 프로젝트의 필드**는 모듈 전역(`rootFolder`, `openTabs`, `terminals`, `expandedPaths`, `gitState`, `activeTabPath`, `activeTermId`, `termCounter`)에 미러링됩니다. 기존 함수들은 이 전역을 그대로 사용.
- `switchProject(id)`:
  1. `snapshotActive()` — 현재 전역을 나가는 프로젝트 객체에 저장
  2. `activeProjectId` 변경
  3. `loadActive()` — 들어오는 프로젝트 객체를 전역에 복원하고 UI 전체 재렌더(트리·탭·터미널 표시·채팅 컨테이너·Git·모델 표시)
- **채팅 상태는 전역에 미러링하지 않고** 프로젝트 객체(`project.chatEl` 등)에만 둡니다. 백그라운드 프로젝트에도 `agent:*` 이벤트가 언제든 도착해 자기 채팅창(`chatEl`)에 렌더링돼야 하기 때문입니다.

### DOM 유지 방식
- **에디터**: Monaco 인스턴스는 하나. 탭마다 `model`(또는 바이너리 뷰어용 `url`)을 보관하고, 활성 탭에 맞춰 `setModel`/뷰어 전환. 숨긴 프로젝트의 모델은 dispose하지 않아 상태 유지.
- **터미널**: `#terminal-host` 안에 모든 프로젝트의 `.term-instance` DOM이 살아있고, 전환 시 표시/숨김만 토글. `onPtyData` 는 전 프로젝트를 검색해 배경 세션 출력도 반영.
- **채팅**: `#chat-messages` 호스트 안에 프로젝트마다 `.chat-scroll` 컨테이너를 두고 표시/숨김 토글.

---

## 5. PDF · 이미지 뷰어

1. 파일 클릭 시 확장자로 `text | pdf | image` 판별.
2. 바이너리는 `fs:readFileBinary` 로 base64 수신 → `Uint8Array` → `Blob` → `URL.createObjectURL`.
3. `#binary-viewer` 에 PDF는 `<iframe src=blobURL>`, 이미지는 `<img src=blobURL>`.
4. 탭을 닫으면 `URL.revokeObjectURL` 로 해제.

CSP(`index.html`)에서 `frame-src 'self' blob:`, `img-src 'self' data: blob:`, `object-src 'self' blob:` 허용.

---

## 6. 설정 저장 (config)

`app.getPath('userData')/claude-ide-config.json` 에 저장. 주요 키:

| 키 | 내용 |
|----|------|
| `autoRunCommand` | (기본 `claude`) |
| `lastFolder` | 마지막 활성 폴더 (하위호환) |
| `openFolders[]` | 열려 있던 프로젝트 폴더 목록 |
| `activeFolder` | 활성 프로젝트 폴더 |
| `chatModel` | 선택 모델 별칭 (빈 값 = 기본) |
| `chatEffort` | 선택 추론 강도 |

부팅 시 `openFolders` 를 순회하며 각 프로젝트 탭을 복원하고 `activeFolder` 를 활성화합니다.

---

## 7. 알려진 제약

- 이 머신은 네이티브 npm 모듈을 컴파일할 수 없어, **프리빌드 바이너리**(`@lydell/node-pty`)를 사용합니다.
- 바이너리 뷰어/이미지 첨부는 base64를 메모리에 올리므로 매우 큰 파일에는 부적합 (이미지 첨부는 5MB 제한).
- 코드 변경은 창을 닫고 다시 실행해야 반영됩니다 (핫리로드 없음).
