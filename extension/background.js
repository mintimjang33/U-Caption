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

// --- Fallback path: open the video in a tab and drive the same
// "스크립트 표시(Show transcript)" UI a real user would click, then read
// the rendered transcript panel text. Muted + paused immediately so it
// never produces sound. Opened active (not background) because Chrome
// throttles rendering/timers in inactive tabs badly enough that the
// description-expand/transcript-button detection below silently fails. --
function fetchTranscriptViaTab(videoId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}`, active: true }, (tab) => {
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

// Navigates an existing tab to a new URL and resolves once it's fully loaded.
// Used to move a Shorts tab to the equivalent /watch page before extraction.
function navigateTabAndWait(tabId, url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("쇼츠 → 일반 영상 페이지 전환이 시간 내에 끝나지 않았어요."));
    }, TAB_LOAD_TIMEOUT_MS);

    const onUpdated = (updatedTabId, info) => {
      if (updatedTabId !== tabId || info.status !== "complete" || settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url }, () => {
      if (chrome.runtime.lastError) {
        settled = true;
        clearTimeout(timeoutTimer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        reject(new Error(chrome.runtime.lastError.message));
      }
    });
  });
}

async function runExtractionInTab(tabId) {
  // world: "MAIN" is required — the default isolated world content-script
  // context cannot see page-set globals like `ytInitialPlayerResponse` or
  // `ytcfg` (separate JS scope from the page even though the DOM is shared).
  // Running in MAIN world also means our fetch to the innertube endpoint
  // below looks exactly like a request the page itself would make.
  const injectionResults = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
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

        const titleEl = document.querySelector("h1.ytd-watch-metadata, h1 yt-formatted-string");
        const title = titleEl ? titleEl.innerText.trim() : document.title.replace(/ - YouTube$/, "");

        const decodeEntities = (s) =>
          s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        const xmlToTranscript = (xml) =>
          [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
            .map((mm) => decodeEntities(mm[1].replace(/<[^>]+>/g, "")).trim())
            .filter(Boolean)
            .join("\n");

        const diag = []; // collects a one-line reason from each failed attempt for debugging

        async function tracksFromTimedText(tracks) {
          if (!tracks || tracks.length === 0) return { fail: "captionTracks 없음" };
          const track = tracks.find((t) => t.languageCode === "ko") || tracks.find((t) => t.languageCode?.startsWith("en")) || tracks[0];
          const res = await fetch(track.baseUrl);
          if (!res.ok) return { fail: `timedtext fetch 실패 status=${res.status}` };
          const xml = await res.text();
          const transcript = xmlToTranscript(xml);
          if (!transcript) return { fail: `timedtext 응답이 비어있음(len=${xml.length})` };
          return { transcript, lang: track.languageCode };
        }

        // --- Preferred path: call YouTube's own InnerTube `/player` endpoint
        // (the same endpoint the page itself calls) from inside the MAIN
        // world, using the page's real API key/session. This is the current
        // (2026) reliable way to get captionTracks without depending on any
        // particular transcript-panel UI/labels existing. ---------------------
        try {
          const apiKey =
            (typeof ytcfg !== "undefined" && ytcfg.get && ytcfg.get("INNERTUBE_API_KEY")) ||
            "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
          const clientVersion =
            (typeof ytcfg !== "undefined" && ytcfg.get && ytcfg.get("INNERTUBE_CLIENT_VERSION")) || "2.20240101.00.00";
          const videoId = new URLSearchParams(location.search).get("v") || location.pathname.match(/\/shorts\/([^/?]+)/)?.[1];

          const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              context: { client: { clientName: "WEB", clientVersion } },
              videoId,
            }),
          });
          if (!res.ok) {
            diag.push(`innertube: HTTP ${res.status}`);
          } else {
            const data = await res.json();
            const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
            const r = await tracksFromTimedText(tracks);
            if (r.transcript) {
              resolve({ transcript: r.transcript, title, lang: r.lang });
              return;
            }
            diag.push(`innertube: ${r.fail}`);
          }
        } catch (e) {
          diag.push(`innertube: 예외 ${e.message}`);
        }

        // --- Second path: read caption tracks straight off the page's own
        // ytInitialPlayerResponse global (only reachable because we're running
        // in the MAIN world). ---------------------------------------------------
        try {
          let playerResponse = window.ytInitialPlayerResponse;
          if (!playerResponse) {
            const scriptText = [...document.scripts].map((s) => s.textContent).find((t) => t && t.includes("ytInitialPlayerResponse"));
            const m = scriptText && scriptText.match(/ytInitialPlayerResponse\s*=\s*(\{.*?\});/s);
            if (m) playerResponse = JSON.parse(m[1]);
          }
          if (!playerResponse) {
            diag.push("ytInitialPlayerResponse: 못 찾음");
          } else {
            const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
            const r = await tracksFromTimedText(tracks);
            if (r.transcript) {
              resolve({ transcript: r.transcript, title, lang: r.lang });
              return;
            }
            diag.push(`ytInitialPlayerResponse: ${r.fail}`);
          }
        } catch (e) {
          diag.push(`ytInitialPlayerResponse: 예외 ${e.message}`);
        }

        // --- Fallback: drive the real "Show transcript" UI directly. This is
        // the only genuinely reliable method — YouTube's timedtext endpoint
        // requires a runtime-generated PoToken with no documented way to
        // supply one from outside the player, so clicking the real button
        // (which lets the already-authenticated player fetch it) is required.
        // As of the Feb 2026 YouTube UI update, the button only renders once
        // the video description panel is expanded. -----------------------------
        // Walk the whole tree INCLUDING shadow roots — many ytd-* polymer
        // elements attach shadow DOM, so a plain document.querySelectorAll
        // silently misses anything nested inside one.
        function deepQueryAll(selector, root = document) {
          const out = [...root.querySelectorAll(selector)];
          for (const el of root.querySelectorAll("*")) {
            if (el.shadowRoot) out.push(...deepQueryAll(selector, el.shadowRoot));
          }
          return out;
        }
        const clickableEls = () =>
          deepQueryAll("button, tp-yt-paper-button, yt-button-shape, ytd-button-renderer, ytd-menu-service-item-renderer, tp-yt-paper-item, [role='button']");
        const visible = (el) => el.offsetHeight > 0 || el.getClientRects().length > 0;
        const textOf = (el) => (el.getAttribute("aria-label") || el.innerText || el.textContent || "").trim();
        const findByPattern = (re) => clickableEls().find((b) => visible(b) && re.test(textOf(b)));

        document.querySelector("ytd-watch-metadata, #description")?.scrollIntoView({ block: "center" });
        await wait(300);

        // "#expand" is the description panel's own long-standing expand toggle
        // (distinct from any other "더보기" on the page — comments, etc.).
        // ytd-video-description-transcript-section-renderer (which holds the
        // real 스크립트 표시/Show transcript button) only becomes visible once
        // this specific panel is expanded.
        const expandBtn =
          deepQueryAll("#expand, tp-yt-paper-button#expand").find((b) => visible(b)) ||
          findByPattern(/더\s*보기|more|show more/i);
        if (expandBtn) {
          expandBtn.click();
          await wait(1200);
        } else {
          diag.push('버튼클릭: "더보기" 버튼도 못 찾음(설명란 확장 실패)');
        }

        // Prefer the button nested specifically inside the transcript section
        // renderer we now know exists — far more targeted than a page-wide
        // text search that can grab an unrelated "더보기".
        const transcriptSection = deepQueryAll("ytd-video-description-transcript-section-renderer")[0];
        let transcriptBtn =
          (transcriptSection && deepQueryAll("button", transcriptSection).find((b) => visible(b))) ||
          findByPattern(/스크립트\s*표시|show\s*transcript|자막\s*표시|대본\s*표시/i);

        // Some layouts expose it via a "..." (more actions) menu near the
        // like/share row instead of inside the description.
        if (!transcriptBtn) {
          const moreActionsBtn = findByPattern(/더보기 작업|more actions/i);
          if (moreActionsBtn) {
            moreActionsBtn.click();
            await wait(600);
            transcriptBtn = findByPattern(/스크립트\s*표시|show\s*transcript|자막\s*표시|대본\s*표시|transcript/i);
          }
        }

        if (!transcriptBtn) {
          // Last resort: dump anything anywhere in the (shadow-inclusive) tree
          // whose text/aria-label even mentions transcript/스크립트/자막/대본,
          // regardless of tag or visibility, so we can see the real element
          // next time instead of guessing again.
          const candidates = deepQueryAll("*")
            .filter((el) => /transcript|스크립트|자막|대본/i.test(textOf(el)) && textOf(el).length < 60)
            .slice(0, 8)
            .map((el) => `<${el.tagName.toLowerCase()}> "${textOf(el)}" visible=${visible(el)}`);
          diag.push("버튼클릭: 스크립트 버튼 못 찾음");
          diag.push(candidates.length ? "후보들:\n" + candidates.join("\n") : "후보 요소 자체가 전혀 없음");
          resolve({ error: "자막을 못 가져왔어요.\n\n[디버그]\n" + diag.join("\n") });
          return;
        }
        transcriptBtn.click();
        await wait(2500);

        if (video) {
          video.muted = true;
          video.pause();
        }

        // Shadow-DOM-inclusive: the button search already had to pierce shadow
        // roots to find "스크립트 표시" at all, so the segment list rendered
        // after clicking it is very likely nested in shadow DOM too — a plain
        // document.querySelectorAll here silently returns nothing even while
        // the panel is visibly showing content on screen.
        let segments = deepQueryAll("ytd-transcript-segment-renderer");
        if (!segments.length) {
          // Layout/tag fallback: grab whatever rendered inside the transcript
          // panel as a whole (covers chapter-grouped panels where individual
          // segment renderers might use a different tag).
          const panels = deepQueryAll(
            "ytd-transcript-search-panel-renderer, ytd-engagement-panel-section-list-renderer, #segments-container"
          ).filter((el) => visible(el) && el.innerText && el.innerText.trim().length > 20);
          const panelText = panels.map((p) => p.innerText.trim()).sort((a, b) => b.length - a.length)[0];
          if (panelText) {
            resolve({ transcript: panelText, title });
            return;
          }
          diag.push("버튼클릭: 패널 열었지만 세그먼트 없음(shadow DOM 포함해서도 못 찾음)");
          resolve({ error: "자막을 못 가져왔어요.\n\n[디버그]\n" + diag.join("\n") });
          return;
        }
        const transcript = segments
          .map((s) => s.innerText.trim())
          .filter(Boolean)
          .join("\n");

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
    // Extract directly on the tab the user is already looking at (fully
    // rendered, not throttled) instead of opening a new background tab —
    // background tabs get their rendering/timers throttled by Chrome, which
    // was silently breaking the "더보기"/transcript-button detection below.
    // Shorts pages (/shorts/<id>) have a completely different layout with no
    // description/transcript panel at all, so if the current tab is on one,
    // switch that same tab to the equivalent /watch?v= page first — the
    // transcript UI only exists there.
    const isShorts = (msg.url || "").includes("/shorts/");
    const prep =
      msg.tabId != null && isShorts
        ? navigateTabAndWait(msg.tabId, `https://www.youtube.com/watch?v=${videoId}`)
        : Promise.resolve();
    const extraction = prep.then(() =>
      msg.tabId != null ? runExtractionInTab(msg.tabId) : fetchTranscript(videoId)
    );
    extraction
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep the message channel open for the async response
  }
  if (msg.type === "push_to_remote") {
    const r = msg.result || {};
    fetch(`${UC_WEB_BASE}/api/uc-jobs?key=${UC_SHARED_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: r.url, title: r.title, transcript: r.transcript, lang: r.lang }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.error) sendResponse({ ok: false, error: data.error });
        else sendResponse({ ok: true, job: data.job });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

// --- Remote job queue (HongHub) ------------------------------------------
// Lets Claude request a transcript from ANY session/device, not just one
// with this local WebSocket bridge running: Claude registers a job in
// Supabase via HongHub's remote MCP, and this extension polls for queued
// jobs and fulfills them the same way as the popup's manual button.
const UC_WEB_BASE = "https://u-caption-lake.vercel.app";
const UC_SHARED_SECRET = "ucaption_admin_2026";

async function pollRemoteJobs() {
  try {
    const res = await fetch(`${UC_WEB_BASE}/api/uc-jobs?status=queued&key=${UC_SHARED_SECRET}`);
    if (!res.ok) return;
    const { jobs } = await res.json();
    for (const job of jobs || []) {
      try {
        const result = await fetchTranscriptViaTab(job.video_id);
        await fetch(`${UC_WEB_BASE}/api/uc-jobs/${job.id}?key=${UC_SHARED_SECRET}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "done", title: result.title, transcript: result.transcript, lang: result.lang }),
        });
      } catch (err) {
        await fetch(`${UC_WEB_BASE}/api/uc-jobs/${job.id}?key=${UC_SHARED_SECRET}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "error", error: err.message }),
        }).catch(() => {});
      }
    }
  } catch {
    // remote server unreachable (offline, etc.) — just skip this cycle
  }
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// MV3 service workers unload when idle; this alarm both wakes the worker
// back up periodically, re-checks/re-establishes the WebSocket connection,
// and polls HongHub for any remotely-queued transcript jobs. Chrome alarms
// can't fire more often than once a minute, so a remote request can take up
// to ~1 minute to even be picked up.
chrome.alarms.create("u-caption-keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "u-caption-keepalive") {
    connect();
    pollRemoteJobs();
  }
});

connect();
pollRemoteJobs();
