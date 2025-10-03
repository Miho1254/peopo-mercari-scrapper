// index.js — Mercari JPY-only + first image (bắt theo converted-currency-section)
// run: npm i playwright && npx playwright install chromium
//      node index.js "https://jp.mercari.com/item/XXXXXXXXXXX"

import { chromium } from "playwright";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

const SELECTORS_TITLE  = ["[data-testid='item-title']", "main h1", "h1"];
const SELECTORS_SELLER = ["[data-testid='seller-name']", "a[href^='/user/profile/']"];
const ITEM_ID_RE = /\/item\/(m\d+)/i;
const INT_NUM_RE = /^(?:\d{1,3}(?:,\d{3})*|\d+)$/; // "1,199" hoặc "1199"

function parseIntLike(s) {
  if (!s) return null;
  const raw = s.replace(/[^\d]/g, "");
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

async function textBySelectors(page, sels) {
  for (const sel of sels) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const txt = (await el.textContent())?.trim();
      if (txt) return txt;
    } catch {}
  }
  return null;
}

async function waitUntilSkeletonGone(page, timeout = 15000) {
  await page.waitForSelector("main", { timeout }).catch(() => {});
  await page.waitForFunction(
    () => !document.querySelector(".merSkeleton") ||
          [...document.querySelectorAll(".merSkeleton")].every(el => !el.offsetParent),
    { timeout }
  ).catch(() => {});
}

/** 1) Bắt trực tiếp từ #converted-currency-section: '(' '¥' '850' '更新日時...' ')' */
async function extractJPYFromConvertedSection(page) {
  return await page.evaluate((INT_NUM_RE_SRC) => {
    const NUM = new RegExp(INT_NUM_RE_SRC);
    const box = document.querySelector("[data-testid='converted-currency-section']");
    if (!box) return null;

    const ps = Array.from(box.querySelectorAll("p"));
    // tìm ký hiệu và số liền kề
    let yenIdx = ps.findIndex(p => (p.textContent || "").trim() === "¥");
    if (yenIdx !== -1 && ps[yenIdx + 1]) {
      const nTxt = (ps[yenIdx + 1].textContent || "").trim();
      if (NUM.test(nTxt)) return { text: `¥ ${nTxt}`, num: nTxt };
    }
    // fallback: ghép mọi text trong box theo thứ tự để bắt "¥ 123,456"
    const joined = ps.map(p => (p.textContent || "").trim()).join(" ");
    const m = joined.match(/¥\s*([\d,]+)/);
    if (m) return { text: `¥ ${m[1]}`, num: m[1] };
    return null;
  }, INT_NUM_RE.source);
}

/** 2) Bắt từ các <p class="merText caption__... primary__..."> khi ký hiệu ở sibling/ancestor */
async function extractJPYFromCaptionClass(page) {
  const hit = await page.evaluate((INT_NUM_RE_SRC) => {
    const NUM = new RegExp(INT_NUM_RE_SRC);
    const YEN = /[¥円]/;
    const nodes = Array.from(document.querySelectorAll("p.merText.caption__5616e150.primary__5616e150"));
    const good = nodes.filter(p => {
      const t = (p.textContent || "").trim();
      if (!NUM.test(t)) return false;
      const cs = getComputedStyle(p);
      return !(cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0");
    });
    // ưu tiên cái nào có ¥/円 ở sibling/ancestor gần
    const withYen = good.find(p => {
      let cur = p;
      for (let i = 0; i < 4 && cur; i++) {
        if (YEN.test(cur.textContent || "")) return true;
        const par = cur.parentElement;
        if (par) {
          for (const sib of Array.from(par.children)) {
            if (sib === cur) continue;
            if (YEN.test(sib.textContent || "")) return true;
          }
        }
        cur = par;
      }
      return false;
    });
    const target = withYen || good[0] || null;
    if (!target) return null;
    const nTxt = (target.textContent || "").trim();
    return { text: `¥ ${nTxt}`, num: nTxt };
  }, INT_NUM_RE.source);

  return hit || null;
}

/** 3) Proximity generic: text node là số + ¥/円 ở sibling/ancestor */
async function extractJPYByProximity(page) {
  const hit = await page.evaluate((INT_NUM_RE_SRC) => {
    const NUM = new RegExp(INT_NUM_RE_SRC);
    const YEN = /[¥円]/;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const t = node.nodeValue?.trim();
        if (!t || !NUM.test(t)) return NodeFilter.FILTER_REJECT;
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0")
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    function elemHasYen(e) { return !!e && YEN.test(e.textContent || ""); }
    function nearYen(el) {
      let cur = el;
      for (let i = 0; i < 4 && cur; i++) {
        if (elemHasYen(cur)) return true;
        const par = cur.parentElement;
        if (par) for (const sib of Array.from(par.children)) {
          if (sib !== cur && elemHasYen(sib)) return true;
        }
        cur = par;
      }
      return false;
    }

    while (walker.nextNode()) {
      const el = walker.currentNode.parentElement;
      if (el && nearYen(el)) return walker.currentNode.nodeValue.trim();
    }
    return null;
  }, INT_NUM_RE.source);

  return hit ? { text: `¥ ${hit}`, num: hit } : null;
}

/** Ảnh đầu tiên của chính item (m<id>_1.jpg ưu tiên) */
async function getFirstImage(page, itemId) {
  const first = await page.$$eval("img", (els, itemId) => {
    const arr = [];
    for (const el of els) {
      const src = el.getAttribute("src") || "";
      if (!src || src.startsWith("data:image")) continue;
      if (src.includes("/images/badges/seller") || src.includes("/thumb/item/")) continue;
      if (itemId && !src.includes(`/${itemId}_`)) continue;
      arr.push(src);
    }
    const direct1 = arr.find(u => /\/m\d+_1\.jpg/i.test(u));
    return direct1 || arr[0] || null;
  }, itemId);
  if (first) return first;
  const any = await page.$("img");
  return any ? (await any.getAttribute("src")) : null;
}

async function scrapeOne(url) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    viewport: { width: 1200, height: 800 },
    reducedMotion: "reduce",
    extraHTTPHeaders: { "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.6" },
  });

  // chỉ chặn analytics; đừng chặn CSS/JS
  await ctx.route("**/*", async (route) => {
    const u = route.request().url();
    if (/googletagmanager|doubleclick|analytics|hotjar|optimizely/i.test(u)) return route.abort();
    return route.continue();
  });

  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitUntilSkeletonGone(page);
  await page.waitForLoadState("networkidle").catch(() => {});

  const title  = await textBySelectors(page, SELECTORS_TITLE);
  const seller = await textBySelectors(page, SELECTORS_SELLER);

  // ==== lấy JPY theo thứ tự ưu tiên ====
  let j = await extractJPYFromConvertedSection(page); // (¥ + number) trong converted-currency-section
  if (!j) j = await extractJPYFromCaptionClass(page); // <p class="merText caption__...">
  if (!j) j = await extractJPYByProximity(page);      // fallback proximity

  const price_jpy = j ? parseIntLike(j.num) : null;
  const price_text_jpy = price_jpy != null ? `¥ ${price_jpy.toLocaleString("ja-JP")}` : null;

  const m = ITEM_ID_RE.exec(url);
  const itemId = m ? m[1] : null;
  const first_image = await getFirstImage(page, itemId);

  await browser.close();

  return {
    source_url: url,
    item_id: itemId,
    title,
    price_text_jpy,
    price_jpy,
    currency: price_jpy != null ? "JPY" : null,
    first_image,
    seller,
  };
}

(async () => {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: node index.js <mercari-item-url>");
    process.exit(2);
  }
  const data = await scrapeOne(url);
  console.log(JSON.stringify([data], null, 2));
})();
