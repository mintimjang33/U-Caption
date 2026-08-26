const statusEl = document.getElementById("status");
const btn = document.getElementById("fetchBtn");
const output = document.getElementById("output");

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
  });
});

refreshStatus();
