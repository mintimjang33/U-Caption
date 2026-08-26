const statusEl = document.getElementById("status");
const btn = document.getElementById("fetchBtn");
const output = document.getElementById("output");
const copyBtn = document.getElementById("copyBtn");
const sendBtn = document.getElementById("sendBtn");
const sendStatus = document.getElementById("sendStatus");

let lastResult = null; // { url, title, transcript, lang }

function refreshStatus() {
  chrome.runtime.sendMessage({ type: "get_status" }, (res) => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = "🔴 상태 확인 실패";
      return;
    }
    statusEl.textContent = res.connected
      ? "🟢 로컬 서버 연결됨"
      : "🔴 로컬 서버 연결 안 됨 (server/index.js를 켜주세요)";
  });
}

btn.addEventListener("click", async () => {
  output.textContent = "가져오는 중...";
  copyBtn.style.display = "none";
  sendBtn.style.display = "none";
  sendStatus.textContent = "";
  lastResult = null;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.runtime.sendMessage({ type: "fetch_current", url: tab?.url || "", tabId: tab?.id }, (res) => {
    if (chrome.runtime.lastError) {
      output.textContent = "오류: " + chrome.runtime.lastError.message;
      return;
    }
    if (!res.ok) {
      output.textContent = "오류: " + res.error;
      return;
    }
    output.textContent = (res.title ? `[${res.title}]\n\n` : "") + res.transcript;
    lastResult = { url: tab?.url || "", title: res.title, transcript: res.transcript, lang: res.lang };
    copyBtn.style.display = "block";
    sendBtn.style.display = "block";
  });
});

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(output.textContent);
    copyBtn.textContent = "✅ 복사됨";
    setTimeout(() => (copyBtn.textContent = "📋 복사"), 1500);
  } catch (err) {
    copyBtn.textContent = "복사 실패: " + err.message;
  }
});

sendBtn.addEventListener("click", () => {
  if (!lastResult) return;
  sendBtn.disabled = true;
  sendStatus.textContent = "전송 중...";
  chrome.runtime.sendMessage({ type: "push_to_remote", result: lastResult }, (res) => {
    sendBtn.disabled = false;
    if (chrome.runtime.lastError) {
      sendStatus.textContent = "❌ 전송 실패: " + chrome.runtime.lastError.message;
      return;
    }
    if (!res.ok) {
      sendStatus.textContent = "❌ 전송 실패: " + res.error;
      return;
    }
    sendStatus.textContent = `✅ 등록됨 — Claude에서 get_transcript_job_result(job_id: "${res.job.id}")로 바로 조회 가능`;
  });
});

refreshStatus();
