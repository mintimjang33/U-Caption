# U-Caption

크롬에 설치해두면 Claude에게 유튜브 링크만 주면 그 영상의 자막을 실시간으로 가져다주는 도구.

- `extension/` — 크롬 확장프로그램(Manifest V3). 로컬 서버와 WebSocket으로 연결되어 있다가, 요청이 오면 백그라운드에서 유튜브 자막을 직접 가져온다.
- `server/` — 로컬 Node.js 서버. Claude(MCP 클라이언트)와는 stdio로, 확장프로그램과는 WebSocket(포트 8765)으로 통신한다.

## 설치 방법

### 1. 서버 의존성 설치

```bash
cd server
npm install
```

### 2. 크롬 확장프로그램 로드

1. 크롬 주소창에 `chrome://extensions` 입력
2. 우측 상단 "개발자 모드" 켜기
3. "압축해제된 확장 프로그램을 로드합니다" 클릭 → 이 프로젝트의 `extension` 폴더 선택
4. 확장프로그램 아이콘을 눌러 팝업에서 연결 상태 확인 가능(서버가 켜져 있어야 🟢로 표시됨)

### 3. Claude Desktop / Claude Code에 MCP 서버 등록

Claude Desktop의 `claude_desktop_config.json`(또는 Claude Code의 MCP 설정)에 아래처럼 추가:

```json
{
  "mcpServers": {
    "u-caption": {
      "command": "node",
      "args": ["C:\\Users\\user\\Downloads\\U-Caption\\server\\index.js"]
    }
  }
}
```

Claude를 재시작하면 `get_youtube_transcript` 도구를 쓸 수 있다.

## 사용법

크롬이 켜져 있고 U-Caption 확장프로그램이 연결된 상태에서, Claude에게 유튜브 링크를 주면서 자막을 요청하면 된다.

## 동작 원리

1. 확장프로그램(백그라운드 서비스워커)이 브라우저 실행 시 `ws://localhost:8765`로 자동 연결
2. Claude가 `get_youtube_transcript(url)` MCP 도구를 호출하면, 서버가 videoId를 파싱해 확장프로그램에 WebSocket으로 요청 전달
3. 확장프로그램이 **탭을 열지 않고** 백그라운드에서 직접 유튜브 watch 페이지 + 자막(timedtext) XML을 `credentials:"include"`로 요청(실제 브라우저 세션이라 서버 단독 스크래핑과 달리 유튜브 봇 차단을 우회할 가능성이 높음)
4. 결과를 WebSocket으로 서버에 돌려주면, 서버가 그 텍스트를 Claude에게 반환

## 알려진 제약

- 로컬 서버와 크롬이 둘 다 켜져 있어야 동작한다.
- 로그인 세션이 필요한 비공개/멤버십 전용 영상은 지원하지 않는다.
- 유튜브가 확장프로그램 기반 요청도 향후 차단할 가능성은 있다(현재는 실제 브라우저 세션 기반이라 우회 가능성이 높다고 판단).
