// server.js — Fastify web server for Mercari (JPY-only + first_image)
// Run: npm i && npx playwright install chromium && node server.js
import Fastify from "fastify";
import { chromium } from "playwright";

const fastify = Fastify({ logger: true });

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

const SELECTORS_TITLE  = ["[data-testid='item-title']", "main h1", "h1"];
const SELECTORS_SELLER = ["[data-testid='seller-name']", "a[href^='/user/profile/']"];
const ITEM_ID_RE = /\/item\/(m\d+)/i;
const INT_NUM_RE = /^(?:\d{1,3}(?:,\d{3})*|\d+)$/;
const NUM_RE = /([0-9][0-9,\.]*)/;

function parseIntLike(s) {
  if (!s) return null;
  const raw = s.replace(/[^\d]/g, "");
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}
function parseNum(s) {
  if (!s) return null;
  const m = NUM_RE.exec(s.replace(/\u00a0/g, " "));
  if (!m) return null;
  const raw = m[1].replace(/,/g, "");
  const n = Number.parseFloat(raw);
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
    () =>
      !document.querySelector(".merSkeleton") ||
      [...document.querySelectorAll(".merSkeleton")].every((el) => !el.offsetParent),
    { timeout }
  ).catch(() => {});
}

/** (1) lấy JPY trong box converted-currency-section: (<p>¥</p><p>850</p>...) */
async function extractJPYFromConvertedSection(page) {
  return await page.evaluate((INT_NUM_RE_SRC) => {
    const NUM = new RegExp(INT_NUM_RE_SRC);
    const box = document.querySelector("[data-testid='converted-currency-section']");
    if (!box) return null;
    const ps = Array.from(box.querySelectorAll("p"));
    let yenIdx = ps.findIndex((p) => (p.textContent || "").trim() === "¥");
    if (yenIdx !== -1 && ps[yenIdx + 1]) {
      const nTxt = (ps[yenIdx + 1].textContent || "").trim();
      if (NUM.test(nTxt)) return { text: `¥ ${nTxt}`, num: nTxt };
    }
    const joined = ps.map((p) => (p.textContent || "").trim()).join(" ");
    const m = joined.match(/¥\s*([\d,]+)/);
    if (m) return { text: `¥ ${m[1]}`, num: m[1] };
    return null;
  }, INT_NUM_RE.source);
}

/** (2) bắt theo p.merText.caption__...primary__... khi ký hiệu ở sibling/ancestor */
async function extractJPYFromCaptionClass(page) {
  const hit = await page.evaluate((INT_NUM_RE_SRC) => {
    const NUM = new RegExp(INT_NUM_RE_SRC);
    const YEN = /[¥円]/;
    const nodes = Array.from(
      document.querySelectorAll("p.merText.caption__5616e150.primary__5616e150")
    );
    const good = nodes.filter((p) => {
      const t = (p.textContent || "").trim();
      if (!NUM.test(t)) return false;
      const cs = getComputedStyle(p);
      return !(
        cs.display === "none" ||
        cs.visibility === "hidden" ||
        cs.opacity === "0"
      );
    });
    const withYen = good.find((p) => {
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

/** (3) proximity generic: text node là số + ¥/円 ở sibling/ancestor */
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
      },
    });

    function elemHasYen(e) {
      return !!e && YEN.test(e.textContent || "");
    }
    function nearYen(el) {
      let cur = el;
      for (let i = 0; i < 4 && cur; i++) {
        if (elemHasYen(cur)) return true;
        const par = cur.parentElement;
        if (par)
          for (const sib of Array.from(par.children)) {
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

/** Ảnh đầu tiên của chính item (ưu tiên m<id>_1.jpg) */
async function getFirstImage(page, itemId) {
  const first = await page.$$eval(
    "img",
    (els, itemId) => {
      const arr = [];
      for (const el of els) {
        const src = el.getAttribute("src") || "";
        if (!src || src.startsWith("data:image")) continue;
        if (src.includes("/images/badges/seller") || src.includes("/thumb/item/"))
          continue;
        if (itemId && !src.includes(`/${itemId}_`)) continue;
        arr.push(src);
      }
      const direct1 = arr.find((u) => /\/m\d+_1\.jpg/i.test(u));
      return direct1 || arr[0] || null;
    },
    itemId
  );
  if (first) return first;
  const any = await page.$("img");
  return any ? await any.getAttribute("src") : null;
}

/** ====== Playwright bootstrap ====== */
const PROXY = process.env.PROXY || ""; // e.g. http://user:pass@jp-proxy:3128
let browser;

async function ensureBrowser() {
  if (browser) return browser;
  browser = await chromium.launch({
    headless: true,
    proxy: PROXY ? { server: PROXY } : undefined,
  });
  return browser;
}

async function scrapeOne(url) {
  const b = await ensureBrowser();
  const ctx = await b.newContext({
    userAgent: UA,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    viewport: { width: 1200, height: 800 },
    reducedMotion: "reduce",
    extraHTTPHeaders: { "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.6" },
  });

  // chỉ chặn analytics; không chặn CSS/JS
  await ctx.route("**/*", async (route) => {
    const u = route.request().url();
    if (/googletagmanager|doubleclick|analytics|hotjar|optimizely/i.test(u))
      return route.abort();
    return route.continue();
  });

  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitUntilSkeletonGone(page);
  await page.waitForLoadState("networkidle").catch(() => {});

  const title = await textBySelectors(page, SELECTORS_TITLE);
  const seller = await textBySelectors(page, SELECTORS_SELLER);

  // lấy JPY theo thứ tự chắc chắn
  let j =
    (await extractJPYFromConvertedSection(page)) ||
    (await extractJPYFromCaptionClass(page)) ||
    (await extractJPYByProximity(page));

  const price_jpy = j ? parseIntLike(j.num) : null;
  const price_text_jpy =
    price_jpy != null ? `¥ ${price_jpy.toLocaleString("ja-JP")}` : null;

  const m = ITEM_ID_RE.exec(url);
  const itemId = m ? m[1] : null;
  const first_image = await getFirstImage(page, itemId);

  await ctx.close();

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

/** ====== Fastify routes ====== */
fastify.get("/health", async () => ({ ok: true }));

fastify.get("/scrape", async (req, reply) => {
  const url = (req.query?.url || "").toString();
  if (!/^https?:\/\/jp\.mercari\.com\/item\/m\d+/.test(url)) {
    return reply.code(400).send({ error: "Invalid Mercari item URL" });
  }
  try {
    const data = await scrapeOne(url);
    return reply.send(data);
  } catch (e) {
    req.log.error(e);
    return reply.code(500).send({ error: "Scrape failed", detail: String(e) });
  }
});

fastify.post("/scrape", async (req, reply) => {
  const body = req.body || {};
  const urls = Array.isArray(body.urls) ? body.urls : [];
  const valid = urls.filter((u) => /^https?:\/\/jp\.mercari\.com\/item\/m\d+/.test(u));
  if (!valid.length) {
    return reply.code(400).send({ error: "Body must be { urls: [Mercari item URLs...] }" });
  }

  // chạy tuần tự để nhẹ nhàng (có thể song song nếu muốn)
  const out = [];
  for (const u of valid) {
    try {
      out.push(await scrapeOne(u));
    } catch (e) {
      out.push({ source_url: u, error: String(e) });
    }
  }
  return reply.send(out);
});

/** ====== start & graceful shutdown ====== */
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: "0.0.0.0" });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();

process.on("SIGINT", async () => {
  fastify.log.info("Shutting down...");
  try { if (browser) await browser.close(); } catch {}
  process.exit(0);
});
process.on("SIGTERM", async () => {
  fastify.log.info("Shutting down...");
  try { if (browser) await browser.close(); } catch {}
  process.exit(0);
});

