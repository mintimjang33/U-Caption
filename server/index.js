import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const WS_PORT = 8765;
const REQUEST_TIMEOUT_MS = 20000;

// --- WebSocket bridge to the Chrome extension ---------------------------
// Only one browser is expected to connect at a time (personal-use tool).
let extensionSocket = null;
const pendingRequests = new Map(); // requestId -> { resolve, reject, timer }

const wss = new WebSocketServer({ port: WS_PORT });

wss.on("connection", (socket) => {
  extensionSocket = socket;
  console.error(`[u-caption] extension connected (ws://localhost:${WS_PORT})`);

  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const pending = pendingRequests.get(msg.requestId);
    if (!pending) return;
    pendingRequests.delete(msg.requestId);
    clearTimeout(pending.timer);
    if (msg.type === "transcript_result") {
      pending.resolve(msg);
    } else if (msg.type === "transcript_error") {
      pending.reject(new Error(msg.error || "알 수 없는 오류로 자막을 가져오지 못했어요."));
    }
  });

  socket.on("close", () => {
    if (extensionSocket === socket) extensionSocket = null;
    console.error("[u-caption] extension disconnected");
  });

  socket.on("error", (err) => {
    console.error("[u-caption] extension socket error:", err.message);
  });
});

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") {
      return u.pathname.slice(1).split("/")[0] || null;
    }
    if (u.hostname.endsWith("youtube.com")) {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const shortsMatch = u.pathname.match(/^\/shorts\/([^/?]+)/);
      if (shortsMatch) return shortsMatch[1];
      const embedMatch = u.pathname.match(/^\/embed\/([^/?]+)/);
      if (embedMatch) return embedMatch[1];
    }
  } catch {
    // not a valid URL
  }
  return null;
}

function requestTranscriptFromExtension(videoId) {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== extensionSocket.OPEN) {
      reject(
        new Error(
          "크롬 확장프로그램이 연결되어 있지 않아요. 크롬이 켜져 있고 U-Caption 확장프로그램이 설치/활성화되어 있는지 확인해주세요."
        )
      );
      return;
    }

    const requestId = randomUUID();
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("확장프로그램 응답이 시간 내에 오지 않았어요(20초 초과). 다시 시도해주세요."));
    }, REQUEST_TIMEOUT_MS);

    pendingRequests.set(requestId, { resolve, reject, timer });
    extensionSocket.send(JSON.stringify({ type: "fetch_transcript", requestId, videoId }));
  });
}

// --- MCP server -----------------------------------------------------------
const server = new McpServer({
  name: "u-caption",
  version: "1.0.0",
});

server.registerTool(
  "get_youtube_transcript",
  {
    title: "유튜브 자막 가져오기",
    description:
      "유튜브 영상 링크를 받아서, 크롬 확장프로그램을 통해 실시간으로 그 영상의 자막(자동생성 포함)을 가져온다. 크롬이 켜져 있고 U-Caption 확장프로그램이 연결되어 있어야 동작한다.",
    inputSchema: {
      url: z.string().describe("유튜브 영상 URL (watch, youtu.be, shorts 형식 모두 지원)"),
    },
  },
  async ({ url }) => {
    const videoId = extractVideoId(url);
    if (!videoId) {
      return {
        content: [{ type: "text", text: `유효한 유튜브 링크를 찾지 못했어요: ${url}` }],
        isError: true,
      };
    }

    try {
      const result = await requestTranscriptFromExtension(videoId);
      const header = result.title ? `제목: ${result.title}\n언어: ${result.lang || "알 수 없음"}\n\n` : "";
      return {
        content: [{ type: "text", text: header + result.transcript }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: err.message }],
        isError: true,
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[u-caption] MCP server ready (stdio), WebSocket bridge on ws://localhost:${WS_PORT}`);
