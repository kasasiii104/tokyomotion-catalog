import { mkdir, readFile, writeFile } from "node:fs/promises";

const SOURCE = "https://www.tokyomotion.net";
const RSS_URL = `${SOURCE}/rss`;
const OUTPUT = new URL("../data/videos.json", import.meta.url);
const LISTING_PAGES = Number(process.env.TM_LISTING_PAGES || 8);
const MAX_ITEMS = Number(process.env.TM_MAX_ITEMS || 100);

function decode(value = "") {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function textTag(block, name) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, "i");
  const match = block.match(re);
  return match ? decode(match[1]).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
}

function attrTag(block, name) {
  const re = new RegExp(`<(?:(?:[\\w.-]+):)?${name}\\b[^>]*(?:url|href)=["']([^"']+)`, "i");
  const match = block.match(re);
  return match ? decode(match[1]) : "";
}

function normalizeUrl(value, base = SOURCE) {
  try {
    const url = new URL(decode(value), base);
    return /^https?:$/i.test(url.protocol) ? url.href : "";
  } catch (_) {
    return "";
  }
}

function stripMarkup(value = "") {
  return decode(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstAttr(block, names) {
  const re = new RegExp(`\\b(?:${names.join("|")})=["']([^"']+)`, "i");
  const match = block.match(re);
  return match ? decode(match[1]) : "";
}

function parseListing(html, pageUrl) {
  const links = html.match(/<a\b[^>]*href=["'][^"']*\/video\/[^"'#?]+["'][^>]*>[\s\S]*?<\/a>/gi) || [];
  const items = [];
  const seen = new Set();
  for (const link of links) {
    const hrefMatch = link.match(/\bhref=["']([^"']+)/i);
    const sourceUrl = hrefMatch ? normalizeUrl(hrefMatch[1], pageUrl) : "";
    if (!/^https?:\/\/(?:www\.)?tokyomotion\.net\/video\//i.test(sourceUrl) || seen.has(sourceUrl)) continue;
    seen.add(sourceUrl);
    const body = link.replace(/^[\s\S]*?>/, "").replace(/<\/a>\s*$/i, "");
    const slug = sourceUrl.split("/").pop().replace(/[-_]+/g, " ");
    const title = stripMarkup(body) || decode(slug) || "TokyoMotion作品";
    const imageValue = firstAttr(body, ["data-src", "data-original", "src"]);
    const image = imageValue ? normalizeUrl(imageValue, pageUrl) : "";
    items.push({ id: sourceUrl, title, sourceUrl, image, embedUrl: "", categories: [], date: 0, dateLabel: "日付不明" });
  }
  return items;
}

function parseFeed(xml) {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return blocks.map((block, index) => {
    const title = textTag(block, "title") || "TokyoMotion作品";
    const sourceUrl = textTag(block, "link") || attrTag(block, "link") || textTag(block, "guid");
    const description = textTag(block, "description") + " " + textTag(block, "encoded");
    const image = attrTag(block, "thumbnail") || attrTag(block, "content") || attrTag(block, "enclosure") || textTag(block, "url");
    const embedMatch = (description + " " + block).match(/https?:\/\/(?:www\.)?tokyomotion\.net\/embed\/[A-Za-z0-9_-]+/i);
    const categories = [...block.matchAll(/<(?:[\w.-]+:)?category(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?category>/gi)]
      .map((match) => decode(match[1]).replace(/<[^>]+>/g, "").trim()).filter(Boolean);
    const rawDate = textTag(block, "pubDate") || textTag(block, "date") || textTag(block, "published");
    const date = rawDate ? Date.parse(rawDate) : 0;
    const id = textTag(block, "guid") || sourceUrl || `${title}-${index}`;
    const timestamp = Number.isFinite(date) ? date : 0;
    return { id, title, sourceUrl, image, embedUrl: embedMatch ? embedMatch[0] : "", categories, date: timestamp, dateLabel: timestamp ? new Date(timestamp).toLocaleDateString("ja-JP") : "日付不明" };
  }).filter((item) => item.sourceUrl && /^https?:\/\/(?:www\.)?tokyomotion\.net\/video\//i.test(item.sourceUrl));
}

function parseRelativeDate(value, now = Date.now()) {
  const match = String(value).match(/(\d+)\s+(minutes?|hours?|days?|weeks?|months?|years?)\s+ago/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factors = { minute: 60e3, minutes: 60e3, hour: 36e5, hours: 36e5, day: 864e5, days: 864e5, week: 6048e5, weeks: 6048e5, month: 2592e6, months: 2592e6, year: 31536e6, years: 31536e6 };
  return Number.isFinite(amount) && factors[unit] ? now - amount * factors[unit] : 0;
}

function parseDetailDate(html) {
  const iso = html.match(/<time\b[^>]*datetime=["']([^"']+)["']/i);
  if (iso) {
    const timestamp = Date.parse(iso[1]);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return parseRelativeDate(stripMarkup(html));
}

function parseDetailStats(html) {
  const viewMatch = html.match(/([\d,]+)\s*views?\b/i);
  const views = viewMatch ? Number(viewMatch[1].replace(/,/g, "")) : null;
  const marker = html.search(/Embed\s+Video/i);
  const section = marker >= 0 ? html.slice(Math.max(0, marker - 7000), marker) : html.slice(0, 7000);
  const likeMatch = section.match(/(?:like|upvote|positive)[^\d]{0,120}([\d,]+)/i);
  const dislikeMatch = section.match(/(?:dislike|downvote|negative)[^\d]{0,120}([\d,]+)/i);
  const numbers = [...section.matchAll(/>\s*([0-9][0-9,]*)\s*</g)].map((match) => Number(match[1].replace(/,/g, ""))).filter(Number.isFinite);
  const likes = likeMatch ? Number(likeMatch[1].replace(/,/g, "")) : numbers.length >= 2 ? numbers.at(-2) : null;
  const dislikes = dislikeMatch ? Number(dislikeMatch[1].replace(/,/g, "")) : numbers.length >= 2 ? numbers.at(-1) : null;
  return { views: Number.isFinite(views) ? views : null, likes: Number.isFinite(likes) ? likes : null, dislikes: Number.isFinite(dislikes) ? dislikes : null };
}

function mergeItems(...lists) {
  const map = new Map();
  for (const item of lists.flat()) {
    const sourceUrl = normalizeUrl(item.sourceUrl || item.id);
    if (!sourceUrl || !/^https?:\/\/(?:www\.)?tokyomotion\.net\/video\//i.test(sourceUrl)) continue;
    const previous = map.get(sourceUrl);
    if (!previous) {
      map.set(sourceUrl, { ...item, id: item.id || sourceUrl, sourceUrl, categories: [...new Set(item.categories || [])] });
      continue;
    }
    const date = item.date || previous.date || 0;
    map.set(sourceUrl, {
      ...previous,
      ...item,
      id: previous.id || item.id || sourceUrl,
      sourceUrl,
      title: item.title && item.title !== "TokyoMotion作品" ? item.title : previous.title,
      image: item.image || previous.image || "",
      embedUrl: item.embedUrl || previous.embedUrl || "",
      date,
      dateLabel: date ? (item.date ? item.dateLabel : previous.dateLabel) : "日付不明",
      views: item.views != null ? item.views : previous.views ?? null,
      likes: item.likes != null ? item.likes : previous.likes ?? null,
      dislikes: item.dislikes != null ? item.dislikes : previous.dislikes ?? null,
      categories: [...new Set([...(previous.categories || []), ...(item.categories || [])])]
    });
  }
  return [...map.values()];
}

async function fetchText(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { "User-Agent": "TokyoMotion-Catalog/1.0", Accept: "text/html, application/rss+xml, application/xml" }, signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function enrich(item) {
  if (item.embedUrl && item.image && item.views != null && item.likes != null && item.dislikes != null) return item;
  try {
    const html = await fetchText(item.sourceUrl);
    const match = html.match(/https?:\/\/(?:www\.)?tokyomotion\.net\/embed\/[A-Za-z0-9_-]+/i);
    const imageMatch = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i);
    let image = item.image;
    if (!image && imageMatch) {
      try { image = new URL(decode(imageMatch[1]), item.sourceUrl).href; } catch (_) {}
    }
    const detailDate = parseDetailDate(html);
    const stats = parseDetailStats(html);
    const date = item.date || detailDate || 0;
    return { ...item, image, embedUrl: match ? match[0] : item.embedUrl || "", date, dateLabel: date ? new Date(date).toLocaleDateString("ja-JP") : item.dateLabel || "日付不明", ...stats };
  } catch (error) {
    console.warn(`detail fetch skipped: ${item.sourceUrl} (${error.message})`);
    return item;
  }
}

async function mapLimit(items, limit, fn) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

let previousItems = [];
try {
  const previous = JSON.parse(await readFile(OUTPUT, "utf8"));
  previousItems = Array.isArray(previous.items) ? previous.items : [];
} catch (_) {}

const xml = await fetchText(RSS_URL);
const feedItems = parseFeed(xml).slice(0, 80);
const pageUrls = Array.from({ length: Math.max(1, LISTING_PAGES) }, (_, index) => index === 0 ? SOURCE : `${SOURCE}/page=${index + 1}`);
const listingHtml = await mapLimit(pageUrls, 3, async (url) => {
  try { return { url, html: await fetchText(url) }; }
  catch (error) { console.warn(`listing fetch skipped: ${url} (${error.message})`); return { url, html: "" }; }
});
const listingItems = listingHtml.flatMap(({ url, html }) => html ? parseListing(html, url) : []);
const mergedItems = mergeItems(previousItems, feedItems, listingItems);
const items = await mapLimit(mergedItems.slice(0, MAX_ITEMS), 4, enrich);
items.sort((a, b) => b.date - a.date);
await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify({ updatedAt: new Date().toISOString(), source: RSS_URL, listingPages: LISTING_PAGES, items }, null, 2)}\n`);
console.log(`updated ${items.length} catalog items from RSS and ${listingHtml.length} official pages`);
