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
  setStatus("商品一覧を読み取っています…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !String(tab.url || "").startsWith("https://www.shop-shimamura.com/")) {
      throw new Error("先に、しまむらオンラインの商品一覧を開いてください。");
    }
    const pages = Number(document.querySelector("#pages").value) || 1;
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      args: [pages],
      func: collectShimamuraPages,
    });
    const result = execution?.result;
    if (!result?.products?.length) throw new Error(result?.error || "商品を取得できませんでした。商品一覧ページか確認してください。");
    setStatus(`${result.products.length}件を取得しました。Scoutへ保存しています…`);
    const response = await fetch(`${SCOUT_ORIGIN}/api/browser-import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageUrl: tab.url, products: result.products }),
    });
    const saved = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(saved.error || `Scout保存エラー HTTP ${response.status}`);
    setStatus(`${saved.imported}件をD1へ保存しました。\nScoutを開くと商品候補を確認できます。`);
  } catch (error) {
    setStatus(`失敗: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    collectButton.disabled = false;
  }
});

async function collectShimamuraPages(maxPages) {
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const absolute = (value, base) => {
    try {
      const url = new URL(value, base);
      return url.protocol === "https:" ? url.toString() : null;
    } catch {
      return null;
    }
  };
  const titleFromCard = (card, anchor, image, fullText) => {
    const selectors = [
      "[class*='item-name']", "[class*='item_name']", "[class*='product-name']",
      "[class*='product_name']", "[class*='name']", "h2", "h3", "h4"
    ];
    const candidates = selectors.flatMap((selector) => [...card.querySelectorAll(selector)].map((node) => clean(node.textContent)));
    candidates.push(clean(anchor.getAttribute("aria-label")), clean(anchor.getAttribute("title")), clean(image?.alt), fullText);
    for (const candidate of candidates) {
      const normalized = clean(candidate)
        .replace(/\bNEW\b/gi, " ")
        .replace(/しまむら|アベイル/g, " ")
        .replace(/[0-9]{1,3}(?:,[0-9]{3})*\s*円(?:\s*[＋+]\s*税|\s*税込)?/g, " ")
        .replace(/お気に入り(?:登録)?/g, " ")
        .replace(/(^|\s)\d{1,6}(?=\s|$)/g, " ")
        .replace(/\s+/g, " ").trim();
      if (normalized.length >= 3 && normalized.length <= 160 && /[ぁ-んァ-ヶ一-龠A-Za-z]/.test(normalized)) return normalized;
    }
    return "";
  };
  const parseDocument = (doc, pageUrl) => {
    const brand = new URL(pageUrl).searchParams.get("b") === "avail" ? "avail" : "shimamura";
    const anchors = [...doc.querySelectorAll("a[href]")].filter((anchor) => {
      try {
        const url = new URL(anchor.href, pageUrl);
        return url.hostname === "www.shop-shimamura.com" && /(?:itemdetail|\/item\/)/i.test(url.pathname);
      } catch {
        return false;
      }
    });
    return anchors.flatMap((anchor) => {
      const card = anchor.closest("li, article, [class*='item'], [class*='product']") || anchor;
      const fullText = clean(card.innerText || card.textContent);
      const priceMatch = fullText.match(/([0-9]{1,3}(?:,[0-9]{3})*)\s*円(?:\s*([＋+]\s*税|税別|税込))?/);
      if (!priceMatch) return [];
      const displayedPrice = Number(priceMatch[1].replaceAll(",", ""));
      const taxExclusive = /[＋+]\s*税|税別/.test(priceMatch[2] || fullText);
      const priceJpy = taxExclusive ? Math.floor(displayedPrice * 1.1) : displayedPrice;
      const image = card.querySelector("img");
      const title = titleFromCard(card, anchor, image, fullText);
      const url = absolute(anchor.getAttribute("href"), pageUrl);
      if (!url || !title || priceJpy < 100) return [];
      const imageUrls = [...card.querySelectorAll("img")].flatMap((node) => {
        const values = [node.currentSrc, node.src, node.dataset?.src, node.dataset?.original];
        const srcset = clean(node.getAttribute("srcset"));
        if (srcset) values.push(...srcset.split(",").map((part) => part.trim().split(/\s+/)[0]));
        return values.map((value) => absolute(value, pageUrl)).filter(Boolean);
      }).filter((value, index, values) => values.indexOf(value) === index).slice(0, 8);
      const variants = [...new Set(fullText.match(/(?:^|\s)(SS|S|M|L|LL|3L|4L|5L|6L)(?=\s|$)/g)?.map((value) => value.trim()) || [])];
      const availability = /売り切れ|在庫なし|販売終了/.test(fullText)
        ? "sold_out"
        : /予約/.test(fullText)
          ? "reservation"
          : /在庫あり|カートに入れる/.test(fullText)
            ? "available"
            : "unknown";
      const itemCode = url.match(/(?:itemdetail|item)\/([^/?#]+)/i)?.[1] || "";
      return [{ url, title, priceJpy, displayedPriceJpy: displayedPrice, taxExclusive, imageUrls, variants, availability, itemCode, brand }];
    });
  };

  try {
    if (location.hostname !== "www.shop-shimamura.com") return { error: "しまむらオンラインではありません", products: [] };
    const products = [];
    const startUrl = new URL(location.href);
    const startPage = Math.max(1, Number(startUrl.searchParams.get("page")) || 1);
    for (let offset = 0; offset < Math.min(Math.max(maxPages, 1), 5); offset += 1) {
      let doc;
      let pageUrl;
      if (offset === 0) {
        doc = document;
        pageUrl = location.href;
      } else {
        const nextUrl = new URL(startUrl);
        nextUrl.searchParams.set("page", String(startPage + offset));
        const response = await fetch(nextUrl, { credentials: "include", cache: "no-store", redirect: "follow" });
        if (!response.ok || /waitroom/i.test(response.url)) break;
        const html = await response.text();
        if (/waitroom|queueittoken|アクセスが集中|順番にご案内/.test(html)) break;
        doc = new DOMParser().parseFromString(html, "text/html");
        pageUrl = response.url;
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
      const found = parseDocument(doc, pageUrl);
      if (!found.length && offset > 0) break;
      products.push(...found);
    }
    const unique = [...new Map(products.map((product) => [product.url, product])).values()].slice(0, 160);
    return { products: unique };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), products: [] };
  }
}
