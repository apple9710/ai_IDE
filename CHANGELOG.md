# Changelog

이 프로젝트의 주요 변경 사항을 버전별로 기록합니다. 형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를,
버전 번호는 [유의적 버전(SemVer)](https://semver.org/lang/ko/)을 따릅니다.

기능을 추가/변경하는 커밋마다 여기에 항목을 남기고, 릴리스 시 `package.json`의 `version`을 함께 올립니다.

## [0.2.1] - 2026-07-08

### 수정
- 터미널 xterm이 패널보다 커졌을 때(fit 어긋남) 투명하게 채팅 패널 위로 넘쳐 **채팅 클릭을 가로채던 문제** — `#terminal-host`/`.term-instance`에 overflow 클립. 하단에 생기던 가로 스크롤바 줄도 함께 제거됨.
- 채팅 패널 열기/닫기·폭 조절, 사이드바 토글 시 터미널 크기를 재계산(refit)하지 않던 문제.
- 에디터↔터미널 / 채팅 리사이저가 4px라 잡기 어렵던 것 — 히트 영역 확대(±4px) 및 드래그 중 텍스트 선택 방지.

### 추가
- `request/` 폴더: IDE 사용 중 막히는 점을 파일로 적어두면 백그라운드 Claude Code 루프가 주기적으로 확인·구현·커밋하는 요청함 (`request/README.md` 참고).

## [0.2.0] - 2026-07-08

### 추가
- **OpenAI Codex 채팅**: 채팅 패널에 엔진 탭(✳ Claude / ◆ Codex) 추가. 프로젝트마다 Claude·Codex 세션이 독립적으로 유지되며, Codex는 `@openai/codex-sdk`(prebuilt 바이너리)로 구동하고 기존 `codex login` 인증을 재사용. 명령 실행·파일 변경·추론 과정을 툴 카드로 실시간 렌더링.
- **협업 모드 (Claude ⇄ Codex)**: Claude가 계획 → Codex(read-only 샌드박스)가 검토 → 합의(`[합의완료]` 마커) 또는 라운드 상한(1~3회) 도달 시 Claude가 기존 권한 카드 흐름으로 실행. 릴레이 말풍선이 수신자 채팅창에 표시되고, 토론 중 사용자 개입(입력창) / 즉시 중단(■) / 수동 릴레이(전달 승인 카드) 지원.
- **Codex 모델 셀렉터**: Codex 탭 전용 모델 드롭다운. 목록은 부팅 시 `~/.codex/models_cache.json`에서 동적으로 로드(계정에 새 모델이 열리면 자동 반영). 대화 중 모델을 바꾸면 `resumeThread`로 대화를 유지한 채 다음 턴부터 새 모델 적용.
- 패키징: `asarUnpack`에 `@openai/codex-*` 추가 (portable 빌드에서 Codex 바이너리 실행 가능).

### 변경
- UI 이모지 아이콘(📁 📄 ✏️ 등)을 Lucide 스타일 인라인 SVG 아이콘으로 교체 — 파일 트리, 컨텍스트 메뉴, 채팅 툴 카드(완료/오류 상태 색상 포함), 선택 팝업.

## [0.1.0] - 2026-07-03

### 추가
- 초기 릴리스: VS Code 스타일 Electron IDE.
- 파일 트리(생성·이름 변경·삭제, git 상태 배지), Monaco 에디터 탭, PDF/이미지 뷰어.
- 실제 PTY 터미널(`@lydell/node-pty` + xterm), 멀티 프로젝트 탭(프로젝트별 트리·탭·터미널·세션).
- Claude 채팅 패널(`@anthropic-ai/claude-agent-sdk`): 토큰 스트리밍, 권한 카드(허용/항상 허용/거부), 모델·추론 강도 셀렉터, 이미지 첨부(파일·붙여넣기·드래그), 메시지 복사·선택 팝업.
- electron-builder portable exe 빌드, `start.vbs` 무콘솔 런처.
