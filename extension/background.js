const WS_URL = "ws://localhost:8765";
const RECONNECT_DELAY_MS = 3000;
const TAB_LOAD_TIMEOUT_MS = 15000;

let socket = null;
let reconnectTimer = null;

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    socket = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    console.log("[U-Caption] connected to local server");
  };

  socket.onclose = () => {
    socket = null;
    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose fires right after; reconnect is scheduled there.
  };

  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "fetch_transcript") {
      handleFetchTranscript(msg.requestId, msg.videoId);
    }
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY_MS);
}

function sendToServer(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(obj));
  }
}

async function handleFetchTranscript(requestId, videoId) {
  try {
    const result = await fetchTranscript(videoId);
    sendToServer({ type: "transcript_result", requestId, ...result });
  } catch (err) {
    sendToServer({ type: "transcript_error", requestId, error: err.message });
  }
}

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

// --- Main entry point: try the fast (no visible tab) path first, then
// fall back to driving the real YouTube UI in a background tab. ---------
async function fetchTranscript(videoId) {
  const meta = await fetchWatchPageMeta(videoId);

  try {
    const fast = await tryFetchViaTimedText(meta.tracks);
    if (fast) {
      return { title: meta.title, lang: fast.lang, transcript: fast.transcript };
    }
  } catch {
    // fall through to the tab-based method below
  }

  const viaTab = await fetchTranscriptViaTab(videoId);
  return {
    title: meta.title || viaTab.title,
    lang: viaTab.lang || null,
    transcript: viaTab.transcript,
  };
}

// --- Fast path: fetch the watch page HTML (for title + caption track
// list) and try to fetch the raw timedtext XML directly. YouTube
// increasingly blocks this (empty 200 response) for non-session
// requests, so this is a best-effort attempt only. ----------------------
async function fetchWatchPageMeta(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const res = await fetch(watchUrl, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`유튜브 페이지를 불러오지 못했어요 (status ${res.status})`);
  }
  const html = await res.text();

  const titleMatch = html.match(/<title>([^<]*)<\/title>/);
  const title = titleMatch ? titleMatch[1].replace(/ - YouTube$/, "") : null;

  const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.*?\});/s);
  if (!playerMatch) {
    return { title, tracks: [] };
  }
  let data;
  try {
    data = JSON.parse(playerMatch[1]);
  } catch {
    return { title, tracks: [] };
  }
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  return { title, tracks };
}

async function tryFetchViaTimedText(tracks) {
  if (!tracks || tracks.length === 0) return null;
  const track =
    tracks.find((t) => t.languageCode === "ko") ||
    tracks.find((t) => t.languageCode?.startsWith("en")) ||
    tracks[0];

  const res = await fetch(track.baseUrl, { credentials: "include" });
  if (!res.ok) return null;
  const xml = await res.text();
  if (!xml || xml.trim().length === 0) return null;

  const transcript = parseTranscriptXml(xml);
  if (!transcript) return null;
  return { transcript, lang: track.languageCode };
}

function parseTranscriptXml(xml) {
  const matches = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)];
  const decodeEntities = (s) =>
    s
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  return matches
    .map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, "")).trim())
    .filter(Boolean)
    .join("\n");
}

// --- Fallback path: open the video in a background (inactive) tab and
// drive the same "스크립트 표시(Show transcript)" UI a real user would
// click, then read the rendered transcript panel text. Muted + paused
// immediately so it never produces sound or plays video. ----------------
function fetchTranscriptViaTab(videoId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}`, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab?.id) {
        reject(new Error(chrome.runtime.lastError?.message || "탭을 열지 못했어요."));
        return;
      }
      const tabId = tab.id;
      let settled = false;

      const cleanup = () => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.remove(tabId, () => void chrome.runtime.lastError);
      };

      const finish = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        cleanup();
        fn();
      };

      const timeoutTimer = setTimeout(() => {
        finish(() => reject(new Error("영상 페이지를 불러오는 데 시간이 너무 오래 걸렸어요.")));
      }, TAB_LOAD_TIMEOUT_MS);

      const onUpdated = (updatedTabId, info) => {
        if (updatedTabId !== tabId || info.status !== "complete") return;
        runExtractionInTab(tabId)
          .then((result) => finish(() => resolve(result)))
          .catch((err) => finish(() => reject(err)));
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  });
}

async function runExtractionInTab(tabId) {
  const injectionResults = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractTranscriptFromPage,
  });
  const result = injectionResults?.[0]?.result;
  if (!result || result.error) {
    throw new Error(result?.error || "자막 패널에서 텍스트를 읽지 못했어요.");
  }
  return result;
}

// Runs inside the YouTube tab itself (via chrome.scripting.executeScript).
// Must be fully self-contained: no references to outer closures.
function extractTranscriptFromPage() {
  return new Promise((resolve) => {
    (async () => {
      try {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const video = document.querySelector("video");
        if (video) {
          video.muted = true;
          video.pause();
        }

        await wait(1500);
        if (video) {
          video.muted = true;
          video.pause();
        }

        const moreBtn = [...document.querySelectorAll("tp-yt-paper-button, button, ytd-button-renderer")].find(
          (b) => /더보기|more/i.test((b.innerText || b.getAttribute("aria-label") || "").trim()) && b.offsetHeight > 0
        );
        if (moreBtn) {
          moreBtn.click();
          await wait(800);
        }

        const findButton = (label) =>
          [...document.querySelectorAll("button")].find(
            (b) => (b.getAttribute("aria-label") || b.innerText || "").trim() === label && b.offsetHeight > 0
          );

        const transcriptBtn = findButton("스크립트 표시") || findButton("Show transcript");
        if (!transcriptBtn) {
          resolve({ error: "이 영상에는 자막(스크립트)이 없는 것 같아요." });
          return;
        }
        transcriptBtn.click();
        await wait(2500);

        if (video) {
          video.muted = true;
          video.pause();
        }

        const segments = document.querySelectorAll("ytd-transcript-segment-renderer");
        if (!segments.length) {
          resolve({ error: "자막 패널을 열었지만 내용을 읽지 못했어요." });
          return;
        }
        const transcript = [...segments]
          .map((s) => s.innerText.trim())
          .filter(Boolean)
          .join("\n");

        const titleEl = document.querySelector("h1.ytd-watch-metadata, h1 yt-formatted-string");
        const title = titleEl ? titleEl.innerText.trim() : document.title.replace(/ - YouTube$/, "");

        resolve({ transcript, title });
      } catch (e) {
        resolve({ error: e.message });
      }
    })();
  });
}

// Messages from the popup (manual/debug use)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "get_status") {
    sendResponse({ connected: !!(socket && socket.readyState === WebSocket.OPEN) });
    return true;
  }
  if (msg.type === "fetch_current") {
    const videoId = extractVideoId(msg.url || "");
    if (!videoId) {
      sendResponse({ ok: false, error: "현재 탭이 유튜브 영상 페이지가 아니에요." });
      return true;
    }
    fetchTranscript(videoId)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep the message channel open for the async response
  }
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// MV3 service workers unload when idle; this alarm both wakes the worker
// back up periodically and re-checks/re-establishes the WebSocket connection.
chrome.alarms.create("u-caption-keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "u-caption-keepalive") connect();
});

connect();
