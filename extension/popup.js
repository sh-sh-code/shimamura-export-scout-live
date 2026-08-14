const SCOUT_ORIGIN = "https://shimamura-export-scout-live.y-shoshi49.workers.dev";
const SHOP_URL = "https://www.shop-shimamura.com/disp/itemlist/?b=shimamura&new=1&sortKey=02";

const statusNode = document.querySelector("#status");
const collectButton = document.querySelector("#collect");

function setStatus(message) {
  statusNode.textContent = message;
}

document.querySelector("#openShop").addEventListener("click", () => chrome.tabs.create({ url: SHOP_URL }));
document.querySelector("#openScout").addEventListener("click", () => chrome.tabs.create({ url: SCOUT_ORIGIN }));

collectButton.addEventListener("click", async () => {
  collectButton.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !String(tab.url || "").startsWith("https://www.shop-shimamura.com/")) {
      throw new Error("先に、しまむらオンラインの商品一覧を開いてください。");
    }
    const maxPages = Math.max(0, Number(document.querySelector("#pages").value) || 0);
    const query = new URLSearchParams({
      tabId: String(tab.id),
      maxPages: String(maxPages),
      startUrl: String(tab.url),
    });
    await chrome.tabs.create({ url: chrome.runtime.getURL(`runner.html?${query}`) });
    setStatus("進捗画面を開きました。スキャンはそこで自動開始します。");
  } catch (error) {
    setStatus(`失敗: ${error instanceof Error ? error.message : String(error)}`);
    collectButton.disabled = false;
  }
});
