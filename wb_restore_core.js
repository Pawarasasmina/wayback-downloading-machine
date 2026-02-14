import fs from "fs";
import path from "path";
import * as cheerio from "cheerio";

/* ---------------- utils ---------------- */
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function normalizeUrl(u) { return (u || "").split("#")[0]; }
function isHttp(u) { return /^https?:\/\//i.test(u); }
const posix = path.posix;

function toPosix(p) { return String(p).replace(/\\/g, "/"); }

function guessExtFromContentType(ct) {
  if (!ct) return "";
  ct = ct.split(";")[0].trim().toLowerCase();
  const map = {
    "text/css": ".css",
    "text/javascript": ".js",
    "application/javascript": ".js",
    "application/json": ".json",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "image/webp": ".webp",
    "font/woff2": ".woff2",
    "font/woff": ".woff",
    "text/html": ".html",
  };
  return map[ct] ?? "";
}

function urlToLocalAssetPath(assetUrl) {
  const u = new URL(assetUrl);
  let p = u.pathname;
  if (p.endsWith("/")) p += "index";
  const base = path.join("assets", u.host, p);
  return toPosix(base);
}

function pageUrlToLocalPath(pageUrl) {
  const u = new URL(pageUrl);
  let p = u.pathname;
  if (p === "/" || p === "") return "index.html";
  if (p.endsWith("/")) p += "index";
  if (!path.extname(p)) p += ".html";
  const out = path.join("pages", u.host, p);
  return toPosix(out);
}

function waybackFetchUrl(ts, originalUrl, mode = "") {
  // mode: "id_", "", "im_"
  return `https://web.archive.org/web/${ts}${mode ? mode : ""}/${originalUrl}`;
}

async function fetchPinned(ts, originalUrl, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const tries = [
        waybackFetchUrl(ts, originalUrl, "id_"), // avoid rewrites (CSS important)
        waybackFetchUrl(ts, originalUrl, ""),
        waybackFetchUrl(ts, originalUrl, "im_"),
      ];

      let lastErr;
      for (const u of tries) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
          
          const r = await fetch(u, { 
            redirect: "follow", 
            signal: controller.signal 
          });
          
          clearTimeout(timeoutId);
          
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const buf = Buffer.from(await r.arrayBuffer());
          const ct = r.headers.get("content-type") || "";
          return { buf, ct };
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr;
    } catch (e) {
      if (attempt === retries - 1) throw e;
      console.log(`Retry ${attempt + 1}/${retries} for ${originalUrl}: ${e.message}`);
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1))); // exponential backoff
    }
  }
}

/* ---------------- CSS helpers ---------------- */
function extractCssLinks(cssText) {
  const links = new Set();

  const importRe = /@import\s+(?:url\(\s*)?(?:["']?)([^"')\s]+)(?:["']?)\s*\)?\s*;/gi;
  let m;
  while ((m = importRe.exec(cssText))) {
    const u = m[1].trim();
    if (u && !u.startsWith("data:")) links.add(u);
  }

  const urlRe = /url\(\s*(?:["']?)([^"')]+)(?:["']?)\s*\)/gi;
  while ((m = urlRe.exec(cssText))) {
    const u = m[1].trim();
    if (u && !u.startsWith("data:")) links.add(u);
  }

  return [...links];
}

function rewriteCssUrls(cssText, baseCssUrl, absToRel) {
  const replacer = (full, rawUrl) => {
    const cleaned = normalizeUrl(rawUrl.trim());
    if (!cleaned || cleaned.startsWith("data:")) return full;

    let abs;
    try { abs = isHttp(cleaned) ? cleaned : new URL(cleaned, baseCssUrl).toString(); }
    catch { return full; }

    const rel = absToRel.get(abs);
    if (!rel) return full;
    return full.replace(rawUrl, rel);
  };

  cssText = cssText.replace(
    /@import\s+(?:url\(\s*)?(?:["']?)([^"')\s]+)(?:["']?)\s*\)?\s*;/gi,
    (full, u) => replacer(full, u)
  );

  cssText = cssText.replace(
    /url\(\s*(?:["']?)([^"')]+)(?:["']?)\s*\)/gi,
    (full, u) => replacer(full, u)
  );

  return cssText;
}

/* ---------------- HTML collect ---------------- */
function collectAssetsAndLinks($, pageUrl, baseOrigin) {
  const assets = new Set();
  const links = new Set();

  const addAsset = (raw) => {
    if (!raw) return;
    const cleaned = normalizeUrl(String(raw).trim());
    if (!cleaned || cleaned.startsWith("data:") || cleaned.startsWith("mailto:") || cleaned.startsWith("javascript:")) return;
    try {
      const abs = isHttp(cleaned) ? cleaned : new URL(cleaned, pageUrl).toString();
      assets.add(abs);
    } catch {}
  };

  const addLink = (raw) => {
    if (!raw) return;
    const cleaned = normalizeUrl(String(raw).trim());
    if (!cleaned || cleaned.startsWith("data:") || cleaned.startsWith("mailto:") || cleaned.startsWith("javascript:")) return;
    try {
      const abs = isHttp(cleaned) ? cleaned : new URL(cleaned, pageUrl).toString();
      const u = new URL(abs);
      if (u.origin === baseOrigin) links.add(abs);
    } catch {}
  };

  [
    ["link[rel='stylesheet']", "href"],
    ["script[src]", "src"],
    ["img[src]", "src"],
    ["img[data-src]", "data-src"],
    ["source[src]", "src"],
    ["video[src]", "src"],
    ["audio[src]", "src"],
    ["link[rel='icon']", "href"],
    ["link[rel='shortcut icon']", "href"],
    ["link[rel='manifest']", "href"],
    ["link[rel='preload']", "href"],
  ].forEach(([sel, attr]) => {
    $(sel).each((_, el) => addAsset($(el).attr(attr)));
  });

  $("img[srcset], source[srcset]").each((_, el) => {
    const v = $(el).attr("srcset") || "";
    v.split(",").forEach(part => {
      const u = part.trim().split(/\s+/)[0];
      if (u) addAsset(u);
    });
  });

  $("[style]").each((_, el) => {
    const st = $(el).attr("style") || "";
    const re = /url\(([^)]+)\)/g;
    let m;
    while ((m = re.exec(st))) {
      let u = m[1].trim().replace(/^['"]|['"]$/g, "");
      addAsset(u);
    }
  });

  $("style").each((_, el) => {
    const css = $(el).html() || "";
    const re = /url\(([^)]+)\)/g;
    let m;
    while ((m = re.exec(css))) {
      let u = m[1].trim().replace(/^['"]|['"]$/g, "");
      addAsset(u);
    }
  });

  $("a[href]").each((_, el) => addLink($(el).attr("href")));

  return { assets: [...assets], links: [...links] };
}

/* ---------------- rewrite with correct relative paths ---------------- */
function makeRelative(fromFileRel, toFileRel) {
  const fromDir = posix.dirname(toPosix(fromFileRel));
  const rel = posix.relative(fromDir, toPosix(toFileRel)) || "";
  // ensure browser-friendly relative (no empty)
  return rel === "" ? "./" : rel;
}

function rewriteHtmlAssetsAndLinks($, pageUrl, currentPageRel, absAssetToLocal, absPageToLocal) {
  const rewriteAttr = (selector, attr, mapper) => {
    $(selector).each((_, el) => {
      const v = $(el).attr(attr);
      if (!v) return;
      const cleaned = normalizeUrl(String(v).trim());
      if (!cleaned || cleaned.startsWith("data:") || cleaned.startsWith("mailto:") || cleaned.startsWith("javascript:")) return;

      let abs;
      try { abs = isHttp(cleaned) ? cleaned : new URL(cleaned, pageUrl).toString(); }
      catch { return; }

      const rep = mapper(abs);
      if (rep) $(el).attr(attr, rep);
    });
  };

  const assetMapper = (abs) => {
    const assetRel = absAssetToLocal.get(abs);
    if (!assetRel) return null;
    return makeRelative(currentPageRel, assetRel);
  };

  const pageMapper = (abs) => {
    const pageRel = absPageToLocal.get(abs);
    if (!pageRel) return null;
    return makeRelative(currentPageRel, pageRel);
  };

  // assets
  rewriteAttr("link[rel='stylesheet']", "href", assetMapper);
  rewriteAttr("script[src]", "src", assetMapper);
  rewriteAttr("img[src]", "src", assetMapper);
  rewriteAttr("img[data-src]", "data-src", assetMapper);
  rewriteAttr("source[src]", "src", assetMapper);
  rewriteAttr("video[src]", "src", assetMapper);
  rewriteAttr("audio[src]", "src", assetMapper);
  rewriteAttr("link[rel='icon']", "href", assetMapper);
  rewriteAttr("link[rel='shortcut icon']", "href", assetMapper);
  rewriteAttr("link[rel='manifest']", "href", assetMapper);
  rewriteAttr("link[rel='preload']", "href", assetMapper);

  // srcset
  $("img[srcset], source[srcset]").each((_, el) => {
    const v = $(el).attr("srcset") || "";
    const parts = v.split(",").map(part => {
      const seg = part.trim().split(/\s+/);
      const u = seg[0];
      const rest = seg.slice(1).join(" ");
      if (!u) return part;

      let abs;
      try { abs = isHttp(u) ? u : new URL(u, pageUrl).toString(); }
      catch { return part; }

      const assetRel = absAssetToLocal.get(abs);
      if (!assetRel) return part;

      const rep = makeRelative(currentPageRel, assetRel);
      return rest ? `${rep} ${rest}` : rep;
    });
    $(el).attr("srcset", parts.join(", "));
  });

  // internal links
  rewriteAttr("a[href]", "href", pageMapper);
}

/* ---------------- timestamp picking ---------------- */
async function getClosestTimestamp(targetUrl, dateYYYYMMDD) {
  const closest = `${dateYYYYMMDD.replace(/-/g, "")}120000`;
  const cdx = new URL("https://web.archive.org/cdx/search/cdx");
  cdx.searchParams.set("url", targetUrl);
  cdx.searchParams.set("output", "json");
  cdx.searchParams.set("fl", "timestamp,original,statuscode,mimetype");
  cdx.searchParams.set("filter", "statuscode:200");
  cdx.searchParams.set("limit", "1");
  cdx.searchParams.set("sort", "closest");
  cdx.searchParams.set("closest", closest);

  const r = await fetch(cdx.toString());
  const data = await r.json();
  if (!Array.isArray(data) || data.length < 2) return null;
  return data[1][0];
}

async function cdxList(url, { limit = 30 } = {}) {
  const cdx = new URL("https://web.archive.org/cdx/search/cdx");
  cdx.searchParams.set("url", url);
  cdx.searchParams.set("output", "json");
  cdx.searchParams.set("fl", "timestamp,original,statuscode,mimetype");
  cdx.searchParams.set("filter", "statuscode:200");
  cdx.searchParams.set("collapse", "digest");
  cdx.searchParams.set("limit", String(limit));
  cdx.searchParams.set("sort", "desc");

  const r = await fetch(cdx.toString());
  const data = await r.json();
  if (!Array.isArray(data) || data.length < 2) return [];
  return data.slice(1);
}

async function fetchHtmlId(ts, absUrl) {
  const snapUrl = `https://web.archive.org/web/${ts}id_/${absUrl}`;
  const r = await fetch(snapUrl, { redirect: "follow" });
  if (!r.ok) return null;
  return await r.text();
}

function countHtmlAssetsQuick(html) {
  const $ = cheerio.load(html);
  return (
    $("link[rel='stylesheet'][href]").length +
    $("script[src]").length +
    $("img[src], img[data-src]").length
  );
}

async function findStableTimestampAuto(baseUrl) {
  const rows = await cdxList(baseUrl, { limit: 30 });
  for (const row of rows) {
    const ts = row[0];
    const html = await fetchHtmlId(ts, baseUrl);
    if (!html) continue;
    const assetsCount = countHtmlAssetsQuick(html);
    if (assetsCount >= 10) {
      return { timestamp: ts, reason: `auto-picked latest stable capture (assets=${assetsCount})` };
    }
  }
  return null;
}

export async function pickTimestampFromInputs({ url, date, wayback }) {
  const baseUrl = url.endsWith("/") ? url : url + "/";

  if (wayback) {
    const m = wayback.match(/\/web\/(\d{8,14})/);
    if (!m) throw new Error("Wayback URL එකෙන් timestamp extract කරන්න බැහැ. /web/2025... වගේ එකක් ඕන.");
    const ts = m[1].padEnd(14, "0");
    return { timestamp: ts, baseUrl, pickReason: "from wayback url" };
  }

  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error("Date format එක YYYY-MM-DD වෙන්න ඕන. (e.g. 2025-02-28)");
    }
    const ts = await getClosestTimestamp(baseUrl, date);
    if (!ts) throw new Error(`No Wayback capture found near ${date} for ${baseUrl}`);
    return { timestamp: ts, baseUrl, pickReason: `closest to ${date}` };
  }

  const auto = await findStableTimestampAuto(baseUrl);
  if (!auto) throw new Error(`No stable Wayback capture found for ${baseUrl}`);
  return { timestamp: auto.timestamp, baseUrl, pickReason: auto.reason };
}

/* ---------------- main restore ---------------- */
export async function restoreSiteToFolder({ baseUrl, timestamp, outDir, maxPages = 200, pickReason = "" }) {
  const base = new URL(baseUrl);
  const baseOrigin = base.origin;

  const logLines = [];
  const missing = [];
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    logLines.push(line);
    console.log(line);
  };

  const saveFile = (relPath, bufOrText, binary = true) => {
    const full = path.join(outDir, relPath);
    ensureDir(path.dirname(full));
    fs.writeFileSync(full, bufOrText, binary ? undefined : "utf8");
  };

  const absAssetToLocal = new Map(); // abs asset url -> local asset path
  const absPageToLocal = new Map();  // abs page url  -> local page path

  const downloadedAssets = new Set();
  const downloadedPages = new Set();

  async function downloadAnyAsset(absUrl) {
    if (downloadedAssets.has(absUrl)) return;
    downloadedAssets.add(absUrl);

    if (!absAssetToLocal.has(absUrl)) absAssetToLocal.set(absUrl, urlToLocalAssetPath(absUrl));

    let fetched;
    try {
      fetched = await fetchPinned(timestamp, absUrl);
    } catch {
      missing.push(absUrl);
      log(`MISS ASSET: ${absUrl}`);
      return;
    }

    const { buf, ct } = fetched;
    let rel = absAssetToLocal.get(absUrl);

    if (path.extname(rel) === "") {
      const ext = guessExtFromContentType(ct);
      if (ext) {
        rel += ext;
        absAssetToLocal.set(absUrl, rel);
      }
    }

    const isCss = (ct && ct.toLowerCase().includes("text/css")) || rel.toLowerCase().endsWith(".css");
    if (isCss) {
      log(`CSS: ${absUrl}`);
      let cssText = buf.toString("utf8");

      const found = extractCssLinks(cssText);
      for (const raw of found) {
        if (!raw || raw.startsWith("data:")) continue;

        let nestedAbs;
        try { nestedAbs = isHttp(raw) ? raw : new URL(raw, absUrl).toString(); }
        catch { continue; }

        if (!absAssetToLocal.has(nestedAbs)) absAssetToLocal.set(nestedAbs, urlToLocalAssetPath(nestedAbs));
        await downloadAnyAsset(nestedAbs);
      }

      // NOTE: CSS files live in assets/.. so relative inside css should be relative to css file itself.
      // We keep abs->local mapping, but rewriteCssUrls returns direct local paths (like assets/host/..).
      cssText = rewriteCssUrls(cssText, absUrl, absAssetToLocal);

      saveFile(rel, cssText, false);
      return;
    }

    saveFile(rel, buf, true);
  }

  async function fetchPageHtml(absUrl, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const snapUrl = `https://web.archive.org/web/${timestamp}id_/${absUrl}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
        
        const r = await fetch(snapUrl, { 
          redirect: "follow", 
          signal: controller.signal 
        });
        
        clearTimeout(timeoutId);
        
        if (!r.ok) return null;
        return await r.text();
      } catch (e) {
        if (attempt === retries - 1) throw e;
        console.log(`Retry ${attempt + 1}/${retries} for page ${absUrl}: ${e.message}`);
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1))); // exponential backoff
      }
    }
  }

  log(`Pinned timestamp: ${timestamp}`);
  log(`Pick reason: ${pickReason}`);
  log(`Crawling from: ${baseUrl}`);
  log(`Max pages: ${maxPages}`);

  const queue = [baseUrl];
  const concurrency = 3; // Process up to 3 pages concurrently

  while (queue.length && downloadedPages.size < maxPages) {
    const batch = [];
    while (batch.length < concurrency && queue.length && downloadedPages.size + batch.length < maxPages) {
      const pageAbs = queue.shift();
      if (!downloadedPages.has(pageAbs)) {
        const u = new URL(pageAbs);
        if (u.origin === baseOrigin) {
          batch.push(pageAbs);
        }
      }
    }

    if (batch.length === 0) break;

    // Process batch concurrently
    const batchPromises = batch.map(async (pageAbs) => {
      try {
        downloadedPages.add(pageAbs);

        if (!absPageToLocal.has(pageAbs)) absPageToLocal.set(pageAbs, pageUrlToLocalPath(pageAbs));
        const currentPageRel = absPageToLocal.get(pageAbs);

        log(`PAGE (${downloadedPages.size}/${maxPages}): ${pageAbs}`);

        const html = await fetchPageHtml(pageAbs);
        if (!html) {
          missing.push(pageAbs);
          log(`MISS PAGE: ${pageAbs}`);
          return;
        }

        const $ = cheerio.load(html);
        const { assets, links } = collectAssetsAndLinks($, pageAbs, baseOrigin);

        // enqueue internal links (need to be careful with concurrency)
        const newLinks = [];
        for (const l of links) {
          if (downloadedPages.size + queue.length + newLinks.length >= maxPages) break;
          if (!absPageToLocal.has(l)) absPageToLocal.set(l, pageUrlToLocalPath(l));
          if (!downloadedPages.has(l) && !queue.includes(l)) newLinks.push(l);
        }
        queue.push(...newLinks);

        // download assets concurrently
        const assetPromises = assets.map(async (a) => {
          if (!absAssetToLocal.has(a)) absAssetToLocal.set(a, urlToLocalAssetPath(a));
          try {
            await downloadAnyAsset(a);
          } catch (e) {
            console.log(`Failed to download asset ${a}: ${e.message}`);
          }
        });
        await Promise.all(assetPromises);

        // rewrite HTML -> IMPORTANT: relative from THIS page path
        rewriteHtmlAssetsAndLinks($, pageAbs, currentPageRel, absAssetToLocal, absPageToLocal);

        // save page
        saveFile(currentPageRel, $.html(), false);
      } catch (e) {
        console.log(`Failed to process page ${pageAbs}: ${e.message}`);
        missing.push(pageAbs);
      }
    });

    await Promise.all(batchPromises);

    // Small delay between batches to avoid overwhelming Wayback Machine
    if (queue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (downloadedPages.size % 25 === 0) {
      log(`Progress: pages=${downloadedPages.size}, assets=${downloadedAssets.size}, queue=${queue.length}`);
    }
  }

  // If baseUrl isn't root index.html, create a simple redirect index.html
  const baseRel = absPageToLocal.get(baseUrl);
  if (baseRel && baseRel !== "index.html") {
    const redirectHtml = `<!doctype html><meta http-equiv="refresh" content="0; url=./${baseRel}">`;
    saveFile("index.html", redirectHtml, false);
  }

  const report =
    `Wayback Site Restore Report\n` +
    `Base URL: ${baseUrl}\n` +
    `Timestamp: ${timestamp}\n` +
    `Pick reason: ${pickReason}\n` +
    `Pages saved: ${downloadedPages.size}\n` +
    `Assets saved: ${downloadedAssets.size}\n` +
    `Missing items: ${missing.length}\n\n` +
    `--- LOGS ---\n${logLines.join("\n")}\n\n` +
    `--- MISSING (first 500) ---\n${missing.slice(0, 500).join("\n")}\n`;

  saveFile("report.txt", report, false);
  log(`report.txt written (inside ZIP)`);
}
