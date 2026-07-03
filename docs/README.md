# Claude IDE — 문서

Claude Code를 실행하기 위한 가벼운 VS Code 스타일 데스크톱 IDE (Electron 기반)의 문서 모음입니다.

## 문서 목록

| 문서 | 내용 |
|------|------|
| [features.md](./features.md) | 사용자 기능 가이드 — 프로젝트 탭, 에디터, 터미널, Claude 채팅, PDF/이미지 뷰어, 모델·추론 설정, 이미지 첨부, 메시지 복사 |
| [architecture.md](./architecture.md) | 기술 구조 — 프로세스 구성, IPC 채널, 프로젝트 상태 모델, Claude 세션 관리, 설정 저장 |

프로젝트 루트의 [`../README.md`](../README.md) 에는 빠른 시작(설치·실행)과 요약이 있습니다.

## 빠른 시작

```bash
npm install      # 최초 1회
npm start        # 실행
```

또는 `start.bat` 더블클릭.

## 한눈에 보는 레이아웃

```
┌──┬────────────┬───────────────────────────┬──────────┐
│활│ 폴더 트리   │  [프로젝트 탭]              │  Claude  │
│동│            │  [파일 탭]                  │  채팅    │
│바│            │   코드 에디터 / PDF·이미지  │  패널    │
│  ├────────────┴───────────────────────────┤          │
│  │             터미널                       │          │
└──┴──────────────────────────────────────────┴──────────┘
```

## 기술 스택

- **Electron 33** — 데스크톱 셸
- **@anthropic-ai/claude-agent-sdk** — Claude 채팅 엔진 (ESM, main에서 dynamic import)
- **@lydell/node-pty** — 프리빌드 PTY (네이티브 컴파일 불필요)
- **@xterm/xterm** — 터미널 UI
- **monaco-editor** — 코드 에디터
