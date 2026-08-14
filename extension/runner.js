const SCOUT_ORIGIN = "https://shimamura-export-scout-live.y-shoshi49.workers.dev";
const HARD_PAGE_LIMIT = 500;
const PAGE_DELAY_MS = 1100;

const params = new URLSearchParams(location.search);
const shopTabId = Number(params.get("tabId"));
const configuredMaxPages = Math.max(0, Number(params.get("maxPages")) || 0);
const maxPages = configuredMaxPages || HARD_PAGE_LIMIT;
const startUrl = params.get("startUrl") || "";
const statusNode = document.querySelector("#status");
const progressNode = document.querySelector("#progress");
let stopped = false;

document.querySelector("#stop").addEventListener("click", () => {
  stopped = true;
  document.querySelector("#stop").disabled = true;
  setStatus("停止要求を受け付けました。現在のページ保存後に停止します。");
});

function setStatus(message) {
  statusNode.textContent = message;
}

function updateMetrics(pages, found, saved) {
  document.querySelector("#pageCount").textContent = String(pages);
  document.querySelector("#foundCount").textContent = String(found);
  document.querySelector("#savedCount").textContent = String(saved);
  const denominator = configuredMaxPages || Math.max(pages + 1, 10);
  progressNode.style.width = `${Math.min(100, Math.round((pages / denominator) * 100))}%`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function saveProducts(pageUrl, products) {
  let saved = 0;
  for (let index = 0; index < products.length; index += 100) {
    const response = await fetch(`${SCOUT_ORIGIN}/api/browser-import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageUrl, products: products.slice(index, index + 100) }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Scout保存エラー HTTP ${response.status}`);
    saved += Number(result.imported) || 0;
  }
  return saved;
}

async function run() {
  if (!Number.isInteger(shopTabId) || shopTabId <= 0 || !startUrl.startsWith("https://www.shop-shimamura.com/")) {
    throw new Error("商品一覧タブを確認できません。しまむらオンラインの商品一覧からやり直してください。");
  }
  let pageUrl = startUrl;
  let pageNumber = 0;
  let totalFound = 0;
  let totalSaved = 0;
  const visitedPages = new Set();
  const seenProducts = new Set();

  while (!stopped && pageUrl && pageNumber < maxPages) {
    if (visitedPages.has(pageUrl)) break;
    visitedPages.add(pageUrl);
    setStatus(`${pageNumber + 1}ページ目を読み取っています…\n${pageUrl}`);
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId: shopTabId },
      world: "MAIN",
      args: [pageUrl, pageNumber === 0],
      func: collectShimamuraPage,
    });
    const result = execution?.result || {};
    if (result.error) throw new Error(result.error);
    const products = (result.products || []).filter((product) => {
      if (!product?.url || seenProducts.has(product.url)) return false;
      seenProducts.add(product.url);
      return true;
    });
    if (!products.length) {
      if (pageNumber === 0) throw new Error("このページから商品を取得できませんでした。商品一覧ページか確認してください。");
      break;
    }
    pageNumber += 1;
    totalFound += products.length;
    setStatus(`${pageNumber}ページ目: ${products.length}件を発見\nD1へ保存しています…`);
    totalSaved += await saveProducts(result.pageUrl || pageUrl, products);
    updateMetrics(pageNumber, totalFound, totalSaved);
    pageUrl = result.nextUrl || "";
    if (!pageUrl || stopped) break;
    await sleep(PAGE_DELAY_MS);
  }

  progressNode.style.width = "100%";
  document.querySelector("#title").textContent = stopped ? "巡回を停止しました" : "自動巡回が完了しました";
  setStatus(`${pageNumber}ページを処理\n${totalFound}件を発見 / ${totalSaved}件をD1へ保存しました。`);
  document.querySelector("#stop").disabled = true;
}

async function collectShimamuraPage(requestedUrl, useCurrentDocument) {
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
        const url = new URL(anchor.getAttribute("href"), pageUrl);
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
  const findNextUrl = (doc, pageUrl, productCount) => {
    const selectors = ["a[rel='next']", "[class*='pager'] a", "[class*='pagination'] a", "li[class*='next'] a"];
    const links = selectors.flatMap((selector) => [...doc.querySelectorAll(selector)]);
    const current = new URL(pageUrl);
    const currentPage = Math.max(1, Number(current.searchParams.get("page")) || 1);
    const numeric = links.flatMap((link) => {
      try {
        const url = new URL(link.getAttribute("href"), pageUrl);
        if (url.hostname !== "www.shop-shimamura.com") return [];
        const page = Number(url.searchParams.get("page"));
        return Number.isInteger(page) && page > currentPage ? [{ url: url.toString(), page }] : [];
      } catch {
        return [];
      }
    }).sort((a, b) => a.page - b.page);
    if (numeric[0]) return numeric[0].url;
    const explicitNext = links.find((link) => /次へ|次の|NEXT|[›»]/i.test(clean(link.textContent) + " " + clean(link.getAttribute("aria-label"))));
    if (explicitNext) return absolute(explicitNext.getAttribute("href"), pageUrl);
    if (!productCount) return null;
    current.searchParams.set("page", String(currentPage + 1));
    return current.toString();
  };

  try {
    if (location.hostname !== "www.shop-shimamura.com") return { error: "商品一覧タブがしまむらオンラインではありません", products: [] };
    let doc;
    let pageUrl;
    if (useCurrentDocument && new URL(requestedUrl).toString() === new URL(location.href).toString()) {
      doc = document;
      pageUrl = location.href;
    } else {
      const response = await fetch(requestedUrl, { credentials: "include", cache: "no-store", redirect: "follow" });
      if (!response.ok) return { error: `しまむら取得エラー HTTP ${response.status}`, products: [] };
      if (/waitroom/i.test(response.url)) return { error: "しまむらの待合室へ移動しました。時間を置いて再開してください。", products: [] };
      const html = await response.text();
      if (/waitroom|queueittoken|アクセスが集中|順番にご案内/i.test(html)) {
        return { error: "しまむらのアクセス待合室が表示されました。時間を置いて再開してください。", products: [] };
      }
      doc = new DOMParser().parseFromString(html, "text/html");
      pageUrl = response.url;
    }
    const products = [...new Map(parseDocument(doc, pageUrl).map((product) => [product.url, product])).values()];
    return { pageUrl, products, nextUrl: findNextUrl(doc, pageUrl, products.length) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), products: [] };
  }
}

run().catch((error) => {
  document.querySelector("#title").textContent = "自動巡回に失敗しました";
  setStatus(`失敗: ${error instanceof Error ? error.message : String(error)}`);
  document.querySelector("#stop").disabled = true;
});
