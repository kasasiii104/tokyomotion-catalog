import { mkdir, readFile, writeFile } from "node:fs/promises";

const SOURCE = "https://www.tokyomotion.net";
const RSS_URL = `${SOURCE}/rss`;
const OUTPUT = new URL("../data/videos.json", import.meta.url);

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
    return { id, title, sourceUrl, image, embedUrl: embedMatch ? embedMatch[0] : "", categories, date: Number.isFinite(date) ? date : 0 };
  }).filter((item) => item.sourceUrl && /^https?:\/\/(?:www\.)?tokyomotion\.net\/video\//i.test(item.sourceUrl));
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
  if (item.embedUrl) return item;
  try {
    const html = await fetchText(item.sourceUrl);
    const match = html.match(/https?:\/\/(?:www\.)?tokyomotion\.net\/embed\/[A-Za-z0-9_-]+/i);
    return { ...item, embedUrl: match ? match[0] : "" };
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

const xml = await fetchText(RSS_URL);
const feedItems = parseFeed(xml).slice(0, 80);
const items = await mapLimit(feedItems, 4, enrich);
items.sort((a, b) => b.date - a.date);
await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify({ updatedAt: new Date().toISOString(), source: RSS_URL, items }, null, 2)}\n`);
console.log(`updated ${items.length} catalog items`);
