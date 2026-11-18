import { mkdir, readFile, writeFile, rename, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyTitle, filterJapanese, LANGUAGE_POLICY_VERSION } from "../assets/language.mjs";
import { auditContent, contentId, contentExclusionReasons, CONTENT_POLICY_VERSION } from "../assets/content-filter.mjs";
import { firstSeenMs, isListed, selectItems } from "../assets/catalog-core.mjs";

export const SOURCE = "https://www.tokyomotion.net";
export const RSS_URL = `${SOURCE}/rss`;
export const SCHEMA_VERSION = 2;
export const RATING_VERSION = 1;
export const PREVIEW_VERSION = 1;
const OUTPUT = new URL("../data/videos.json", import.meta.url);
const HOUR = 3600000;
const NOT_FOUND_DAYS = 30;
const EXPIRED_RETENTION_DAYS = 180;

export function decode(value = "") {
  return String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/&#(x[\da-f]+|\d+);/gi, (all,n) => {
      const code=n[0].toLowerCase()==="x" ? parseInt(n.slice(1),16) : Number(n);
      return code>0 && code<=0x10ffff ? String.fromCodePoint(code) : all;
    })
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/gi, x=>({"&amp;":"&","&lt;":"<","&gt;":">","&quot;":'"',"&apos;":"'","&nbsp;":" "})[x.toLowerCase()]);
}

export function stripMarkup(value = "") {
  return decode(String(value).replace(/<!--[\s\S]*?-->/g," ")
    .replace(/<(script|style|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi," ")
    .replace(/<[^>]+>/g," ")).replace(/\s+/g," ").trim();
}

function attr(tag,name) {
  return decode(tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,"i"))?.slice(1).find(x=>x!==undefined)||"");
}

function meta(html,name) {
  for(const tag of html.match(/<meta\b[^>]*>/gi)||[]) {
    if([attr(tag,"property"),attr(tag,"name"),attr(tag,"itemprop")].includes(name))return attr(tag,"content");
  }
  return "";
}

export function normalizeUrl(value,base=SOURCE) {
  if(!value)return "";
  try {
    const url=new URL(decode(value),base);
    return ["http:","https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch{return "";}
}

export function videoKey(value) {
  return normalizeUrl(value).match(/^https?:\/\/(?:www\.)?tokyomotion\.net\/video\/(\d+)(?:\/|$)/i)?.[1]||"";
}

function sourceUrl(value) {
  const url=normalizeUrl(value);
  if(!videoKey(url))return "";
  const parsed=new URL(url);
  parsed.protocol="https:";parsed.hostname="www.tokyomotion.net";parsed.search="";parsed.hash="";
  return parsed.href;
}

function imageUrl(value,base=SOURCE) {
  const url=normalizeUrl(value,base);
  return url && /(^|\.)(?:tokyomotion|tokyo-motion)\.net$/i.test(new URL(url).hostname) ? url.replace(/^http:/,"https:") : "";
}

export function parseThumbnailPreview(tag,expectedId,now=Date.now()) {
  const declaration=attr(tag,'id').match(/^rotate_(\d+)_(\d+)_(\d+)(?:_|$)/);
  const url=imageUrl(attr(tag,'data-src')||attr(tag,'data-original')||attr(tag,'src'));
  if(!declaration||String(expectedId)!==declaration[1]||!url)return null;
  const count=Number(declaration[2]),posterIndex=Number(declaration[3]);
  const parsed=new URL(url);
  if(count<2||count>40||posterIndex<1||posterIndex>count||!new RegExp(`/media/videos/tmb\\d*/${expectedId}/\\d+\\.jpg$`).test(parsed.pathname))return null;
  parsed.pathname=parsed.pathname.replace(/\d+\.jpg$/,'');parsed.search='';parsed.hash='';
  return {type:'images',baseUrl:parsed.href,count,posterIndex,intervalMs:700,source:'official_thumbnail_rotation',checkedAt:new Date(now).toISOString()};
}

function embedUrl(html) {
  return decode(html).match(/https?:\/\/(?:www\.)?tokyomotion\.net\/embed\/[A-Za-z0-9_-]+/i)?.[0]?.replace(/^http:/,"https:")||"";
}

function dateLabel(date) {
  return date ? new Date(date).toLocaleDateString("ja-JP",{timeZone:"Asia/Tokyo"}) : "日付不明";
}

function tagText(block,name) {
  const value=block.match(new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`,"i"))?.[1]||"";
  return stripMarkup(decode(value));
}

export function parseFeed(xml) {
  return (xml.match(/<item\b[\s\S]*?<\/item>/gi)||[]).flatMap(block=>{
    const url=sourceUrl(tagText(block,"link")||tagText(block,"guid"));
    if(!url)return [];
    const parsedDate=Date.parse(tagText(block,"pubDate")||tagText(block,"published"));
    const date=Number.isFinite(parsedDate)?parsedDate:0;
    const imageTag=block.match(/<(?:media:thumbnail|enclosure)\b[^>]*>/i)?.[0]||"";
    const title=tagText(block,"title"),description=tagText(block,"description");
    return [{id:`video:${videoKey(url)}`,videoId:videoKey(url),sourceUrl:url,title,titleSource:"rss",
      contentExclusions:contentExclusionReasons({title,description}),
      image:imageUrl(attr(imageTag,"url")),embedUrl:embedUrl(block),
      categories:[...block.matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/gi)].map(x=>stripMarkup(decode(x[1]))).filter(Boolean),
      date,dateSource:date?"rss":"unknown",dateLabel:dateLabel(date)}];
  });
}

export function parseRelativeDate(value,now=Date.now()) {
  const match=String(value).match(/\b(\d+)\s+(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago\b/i);
  if(!match)return 0;
  const unit=match[2].toLowerCase().replace(/s$/,"");
  return now-Number(match[1])*({second:1000,minute:60000,hour:HOUR,day:24*HOUR,week:168*HOUR,month:720*HOUR,year:8760*HOUR})[unit];
}

// Only the paginated list is an archive, not the rotating "being watched" block.
export function parseListing(html,pageUrl,now=Date.now()) {
  const marker=[...html.matchAll(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/gi)].find(x=>stripMarkup(x[0])==="Most Recent Videos");
  if(!marker)throw new Error("listing_structure_changed");
  const section=html.slice(marker.index+marker[0].length).split(/<h[1-6]\b[^>]*>\s*Information\s*<\/h[1-6]>/i)[0];
  const anchors=[...section.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].flatMap(match=>{
    const tag=match[0].match(/^<a\b[^>]*>/i)?.[0]||"";
    const url=sourceUrl(normalizeUrl(attr(tag,"href"),pageUrl));
    return url?[{index:match.index,html:match[0],tag,url,key:videoKey(url)}]:[];
  });
  const items=[],seen=new Set();
  for(let i=0;i<anchors.length;i++) {
    const anchor=anchors[i];
    if(seen.has(anchor.key))continue;
    seen.add(anchor.key);
    const next=anchors.slice(i+1).find(x=>x.key!==anchor.key);
    const block=section.slice(anchor.index,next?.index??section.length);
    const img=block.match(/<img\b[^>]*>/i)?.[0]||"";
    const titleAnchor=anchors.slice(i).find(x=>x.key===anchor.key && stripMarkup(x.html).replace(/^(?:HD\s+)?(?:\d+:)+\d+\s*/i,"").trim());
    const title=attr(anchor.tag,"title")||attr(img,"alt")||attr(img,"title")||stripMarkup(titleAnchor?.html||anchor.html).replace(/^(?:HD\s+)?(?:\d+:)+\d+\s*/i,"");
    const text=stripMarkup(block),views=text.match(/\b([\d,]+)\s+views\b/i),rating=text.match(/(?:^|\s)(\d{1,3})\s*%/);
    const date=parseRelativeDate(text,now);
    const preview=parseThumbnailPreview(img,anchor.key,now);
    items.push({id:`video:${anchor.key}`,videoId:anchor.key,sourceUrl:anchor.url,title,titleSource:"listing",...(preview?{preview,previewVersion:PREVIEW_VERSION}:{}),
      image:imageUrl(attr(img,"data-src")||attr(img,"data-original")||attr(img,"src"),pageUrl),categories:[],
      date,dateSource:date?"relative":"unknown",dateLabel:dateLabel(date),views:views?Number(views[1].replace(/,/g,"")):null,
      ratingPercent:rating && Number(rating[1])<=100?Number(rating[1]):null,listingCheckedAt:new Date(now).toISOString()});
  }
  if(!items.length)throw new Error("listing_empty_or_unavailable");
  const current=Number(pageUrl.match(/page=(\d+)/)?.[1]||1);
  const pages=(section.match(/<a\b[^>]*>/gi)||[]).map(tag=>normalizeUrl(attr(tag,"href"),pageUrl)).map(url=>url.match(/[?\/]page=(\d+)/)?.[1]).filter(page=>page!==undefined);
  const pagerFound=pages.length>0,hasNext=pages.some(page=>Number(page)>current);
  return {items,hasNext,pagerFound};
}

export function parseDetail(html,now=Date.now(),videoId='') {
  const text=stripMarkup(html);
  if(/This is a private video|video (?:has been|was) (?:removed|deleted)|video (?:does not exist|not found)/i.test(text)) {
    return {availability:"unavailable",embedUrl:"",preview:null,likes:null,dislikes:null,ratingPercent:null,previewVersion:PREVIEW_VERSION,detailCheckedAt:new Date(now).toISOString(),statsVersion:SCHEMA_VERSION,ratingVersion:RATING_VERSION};
  }
  const embed=embedUrl(html),marker=text.indexOf("Embed Video");
  if(!embed||marker<0)throw new Error("detail_unavailable_or_structure_changed");
  // Read the actual counters, not CSS widths or numbers near sharing controls.
  const spans=[...html.replace(/<(script|style|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi,"").matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)];
  const counter=id=>{
    const span=spans.find(x=>attr(x[0].match(/^<span\b[^>]*>/i)?.[0]||"","id")===id);
    const value=span?stripMarkup(span[1]):"";
    return /^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value)?Number(value.replace(/,/g,"")):null;
  };
  const likes=counter("video_likes"),dislikes=counter("video_dislikes");
  // The uploader line identifies the main work's count, not a related card.
  const info=text.slice(marker).split(/Related Videos|Comments/)[0];
  const viewMatch=info.match(/\b(?:\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago)\s*,\s*([\d,]+)\s+views\b/i);
  const rawDate=meta(html,"datePublished")||meta(html,"uploadDate")||attr(html.match(/<time\b[^>]*datetime=["'][^"']+["'][^>]*>/i)?.[0]||"","datetime");
  const exact=rawDate?Date.parse(rawDate):NaN,relative=viewMatch?parseRelativeDate(viewMatch[0],now):0;
  const date=Number.isFinite(exact)?exact:relative;
  const mainId=videoId||videoKey(meta(html,'og:url'));
  const preview=(html.match(/<img\b[^>]*>/gi)||[]).map(tag=>parseThumbnailPreview(tag,mainId,now)).find(Boolean);
  const title=meta(html,"og:title").replace(/\s+-\s+TOKYO Motion\s*$/i,"");
  const rawDescription=stripMarkup(meta(html,'og:description')).slice(0,2000);
  const description=rawDescription!==title&&classifyTitle(rawDescription).keep?rawDescription:'';
  return {title,titleSource:"detail",description,contentExclusions:contentExclusionReasons({title,description:rawDescription}),image:imageUrl(meta(html,"og:image")||meta(html,"twitter:image")),
    ...(preview?{preview}:{}),previewVersion:PREVIEW_VERSION,
    embedUrl:embed,availability:"embed_available",views:viewMatch?Number(viewMatch[1].replace(/,/g,"")):null,
    likes,dislikes,ratingPercent:likes!=null&&dislikes!=null&&likes+dislikes>0?100*likes/(likes+dislikes):null,
    date,dateSource:Number.isFinite(exact)?"official":date?"relative":"unknown",dateLabel:dateLabel(date),
    statsVersion:SCHEMA_VERSION,ratingVersion:RATING_VERSION,detailCheckedAt:new Date(now).toISOString(),lastError:null};
}

export function migrateItems(data) {
  return (data.items||[]).map(item=>{
    if(item.statsVersion===SCHEMA_VERSION)return item;
    // v1 can contain percentages mislabelled as votes, and dates from related items.
    const {views,likes,dislikes,ratingPercent,date,dateLabel,dateSource,detailCheckedAt,...rest}=item;
    return {...rest,views:null,likes:null,dislikes:null,ratingPercent:null,date:0,dateLabel:"日付不明",dateSource:"unknown",statsVersion:0};
  });
}

function parseLifecycleDate(value) {
  return typeof value==="string"?Date.parse(value):NaN;
}

export function migrateLifecycle(item) {
  if(!Number.isFinite(parseLifecycleDate(item.detailCheckedAt)))return item;
  if(item.availability==="not_found"&&!Object.hasOwn(item,"notFoundSince"))return {...item,notFoundSince:item.detailCheckedAt};
  if(["embed_available","unavailable"].includes(item.availability)&&!Object.hasOwn(item,"detailOkAt"))return {...item,detailOkAt:item.detailCheckedAt};
  return item;
}

export function migrateFirstSeen(item,now) {
  if(Object.hasOwn(item,"firstSeenAt")||!Number.isFinite(item.date)||item.date<=0)return item;
  return {...item,firstSeenAt:new Date(Math.min(item.date,now)).toISOString()};
}

export function expireNotFound(items,now,{days=NOT_FOUND_DAYS}={}) {
  const kept=[],removed=[],duration=days*24*HOUR;
  for(const item of items) {
    const since=parseLifecycleDate(item.notFoundSince);
    if(item.availability==="not_found"&&Number.isFinite(since)&&now-since>duration
      &&parseLifecycleDate(item.detailCheckedAt)-since>=duration
      &&(!Object.hasOwn(item,"detailOkAt")||parseLifecycleDate(item.detailOkAt)<since)) {
      removed.push(item);
    }else kept.push(item);
  }
  return {kept,removed};
}

export function mergeItems(...lists) {
  const map=new Map(),dateRank={unknown:0,relative:1,rss:2,official:3},titleRank={rss:0,listing:1,detail:2};
  for(const item of lists.flat()) {
    const url=sourceUrl(item.sourceUrl),key=videoKey(url);
    if(!key)continue;
    const old=map.get(key),result={...old,...item,id:old?.id||item.id||`video:${key}`,videoId:key,sourceUrl:url,
      categories:[...new Set([...(old?.categories||[]),...(item.categories||[])])]};
    if(["embed_available","unavailable"].includes(item.availability)&&Object.hasOwn(item,"detailOkAt")&&!Object.hasOwn(item,"notFoundSince"))delete result.notFoundSince;
    for(const field of ["title","image","embedUrl"])if(!item[field] && old?.[field] && !["unavailable","not_found"].includes(item.availability))result[field]=old[field];
    result.titleSource=item.titleSource||"listing";
    if(old?.title && !["unavailable","not_found"].includes(item.availability) && (!item.title || titleRank[result.titleSource]<titleRank[old.titleSource||"listing"])) {
      result.title=old.title;result.titleSource=old.titleSource||"listing";
    }
    if(old?.date && (!item.date||(dateRank[old.dateSource]||0)>=(dateRank[item.dateSource]||0))) {
      result.date=old.date;result.dateSource=old.dateSource;result.dateLabel=old.dateLabel;
    }
    if(old && !Object.hasOwn(item,"detailCheckedAt")) {
      for(const field of ["views","ratingPercent"])if(item[field]==null && old[field]!=null)result[field]=old[field];
    }
    map.set(key,result);
  }
  return [...map.values()];
}

export function detailQueue(items,now,limit=240) {
  return detailQueuePlan(items,now,limit).queue;
}

export function detailQueuePlan(items,now,limit=240,{
  popularPool=100,popularHot=12,popularMinAgeHours=3,freshDays=7,freshMinAgeHours=6,
  pendingShare=0.5,popularShare=0.15,freshShare=0.10,
}={}) {
  const eligible=items.filter(x=>!(x.detailFailures>0&&now-Date.parse(x.detailAttemptAt)<Math.min(2**(x.detailFailures-1),168)*HOUR));
  const oldestFirst=(a,b)=>Date.parse(a.detailCheckedAt)-Date.parse(b.detailCheckedAt);
  const fewerFailuresFirst=(a,b)=>(a.detailFailures||0)-(b.detailFailures||0);
  const checkedBefore=(x,hours)=>now-Date.parse(x.detailCheckedAt)>hours*HOUR;
  // An unparsable check time is treated as never checked so the work cannot drop out of every lane.
  const needsDetails=x=>!Number.isFinite(Date.parse(x.detailCheckedAt))||x.statsVersion!==SCHEMA_VERSION||x.ratingVersion!==RATING_VERSION||x.previewVersion!==PREVIEW_VERSION;
  const ranked=items.filter(x=>isListed(x)&&Number.isFinite(x.views)).sort((a,b)=>b.views-a.views).slice(0,popularPool);
  const eligibleItems=new Set(eligible);
  // Keep the published ranking fixed when an entry is recent or in backoff.
  const popular=[ranked.slice(0,popularHot),ranked.slice(popularHot)].flatMap(group=>
    group.filter(x=>eligibleItems.has(x)&&checkedBefore(x,popularMinAgeHours)).sort(oldestFirst));
  const lanes={
    pending:eligible.filter(needsDetails).sort((a,b)=>fewerFailuresFirst(a,b)||Number(b.videoId)-Number(a.videoId)),
    popular,
    fresh:eligible.filter(x=>isListed(x)&&Number.isFinite(x.date)&&now-x.date>=0&&now-x.date<=freshDays*24*HOUR&&checkedBefore(x,freshMinAgeHours)).sort(oldestFirst),
    rotation:eligible.filter(x=>x.detailCheckedAt&&(needsDetails(x)||checkedBefore(x,24)||(now-x.date<48*HOUR&&checkedBefore(x,6))))
      .sort((a,b)=>fewerFailuresFirst(a,b)||oldestFirst(a,b)),
  };
  const slots=share=>Math.max(1,Math.floor(limit*share));
  const quotas={pending:slots(pendingShare),popular:slots(popularShare),fresh:slots(freshShare)};
  quotas.rotation=Math.max(0,limit-quotas.pending-quotas.popular-quotas.fresh);

  const queue=[],selected=new Set();
  const detailLanes={pending:0,popular:0,fresh:0,rotation:0};
  function take(lane,count) {
    for(const x of lanes[lane]){
      if(count<=0||queue.length>=limit)break;
      if(selected.has(x.videoId))continue;
      selected.add(x.videoId);
      queue.push(x);
      detailLanes[lane]++;
      count--;
    }
  }
  for(const lane of Object.keys(quotas))take(lane,quotas[lane]);
  for(const lane of ["pending","rotation","popular","fresh"])take(lane,limit-queue.length);
  return {queue,detailLanes};
}

export async function fetchText(url) {
  const response=await fetch(url,{headers:{"User-Agent":"TokyoMotion-Catalog/2.0",Accept:"text/html, application/rss+xml, application/xml"},signal:AbortSignal.timeout(20000)});
  if(!response.ok){const error=new Error(`HTTP_${response.status}`);error.status=response.status;throw error;}
  const text=await response.text();
  if(/Site Unavailable|Verify you are human|Checking your browser|Access Denied/i.test(text.slice(0,3000)))throw new Error("source_access_unavailable");
  return text;
}

function contentPolicy(previous,audit,now) {
  const excluded=new Map(audit.excludedItems.map(x=>[x.videoId,x.reasons]));
  const removed=[...new Set((previous.items||[]).map(contentId))].filter(id=>excluded.has(id));
  const reasons={fc2ppv:0,otokonoko:0},removedReasons={fc2ppv:0,otokonoko:0};
  for(const row of audit.excludedItems)for(const reason of row.reasons)reasons[reason]++;
  for(const id of removed)for(const reason of excluded.get(id))removedReasons[reason]++;
  return {version:CONTENT_POLICY_VERSION,auditedAt:new Date(now).toISOString(),
    removedExisting:removed.length,removedExistingTotal:(previous.contentPolicy?.removedExistingTotal||0)+removed.length,
    lastRemoval:removed.length?{at:new Date(now).toISOString(),count:removed.length,reasons:removedReasons}:previous.contentPolicy?.lastRemoval||null,
    reasons,excludedItems:audit.excludedItems};
}

function itemCounts(items) {
  return {total:items.length,
    pendingDetails:items.filter(x=>!x.detailCheckedAt||x.ratingVersion!==RATING_VERSION||x.previewVersion!==PREVIEW_VERSION).length,
    withImages:items.filter(x=>x.image).length,withPreviews:items.filter(x=>x.preview&&!['unavailable','not_found'].includes(x.availability)).length,
    withEmbeds:items.filter(x=>x.embedUrl).length,withViews:items.filter(x=>x.views!=null).length,withVotes:items.filter(x=>x.likes!=null&&x.dislikes!=null).length};
}

const HEAD_FIELDS = [
  "id", "videoId", "sourceUrl", "title", "image", "embedUrl", "availability",
  "categories", "date", "dateLabel", "dateSource", "views", "likes", "dislikes",
  "ratingPercent", "statsVersion", "listingCheckedAt", "preview", "description",
  "contentExclusions", "firstSeenAt", "tags"
];

export function buildHead(catalog,{newCount=216,popularCount=120,ratedCount=120,sinceDays=3,sinceMax=600}={}) {
  const items=catalog.items||[];
  const listed=items.filter(isListed);
  const newest=selectItems(listed,{sort:"new"});
  const updated=Date.parse(catalog.updatedAt);
  const cutoff=updated-sinceDays*24*HOUR;
  const recent=newest.filter(item=>{
    const seen=firstSeenMs(item);
    return seen>=cutoff&&seen<=updated;
  }).sort((a,b)=>firstSeenMs(b)-firstSeenMs(a)).slice(0,sinceMax);
  const selected=new Set([
    ...newest.slice(0,newCount),
    ...selectItems(listed,{sort:"views"}).slice(0,popularCount),
    ...selectItems(listed,{sort:"rating"}).slice(0,ratedCount),
    ...recent
  ].map(item=>item.id));
  return {
    headVersion:1,
    updatedAt:catalog.updatedAt,
    source:catalog.source,
    backfill:catalog.backfill,
    errorCount:(catalog.errors||[]).length,
    counts:{total:items.length,listed:listed.length},
    categories:[...new Set(listed.flatMap(item=>item.categories||[]))].sort((a,b)=>a.localeCompare(b,"ja")),
    full:"data/videos.json",
    items:newest.filter(item=>selected.delete(item.id)).map(item=>
      Object.fromEntries(HEAD_FIELDS.filter(key=>Object.hasOwn(item,key)).map(key=>[key,item[key]])))
  };
}

// Offline cleanup preserves metadata, crawl cursors and the last collection time.
// Only IDs and reasons are kept as tombstones, not removed titles or media URLs.
export function pruneCatalog(previous={},now=Date.now()) {
  const audit=auditContent(previous.items||[],previous.contentPolicy?.excludedItems);
  const languageAudit=filterJapanese(audit.accepted),titles=new Set(languageAudit.accepted.map(x=>x.title)),items=audit.accepted.filter(x=>titles.has(x.title)),reasons={};
  const removedExisting=languageAudit.rejected.length;
  for(const x of languageAudit.rejected)reasons[x.reason]=(reasons[x.reason]||0)+1;
  return {...previous,contentPolicy:contentPolicy(previous,audit,now),
    languagePolicy:{...previous.languagePolicy,version:LANGUAGE_POLICY_VERSION,mode:"japanese_titles_only",auditedAt:new Date(now).toISOString(),excludedThisRun:removedExisting,removedExisting,removedExistingTotal:(previous.languagePolicy?.removedExistingTotal||0)+removedExisting,reasons},
    summary:{...previous.summary,...itemCounts(items),newItems:0},items};
}

// F2: 320 keeps the full rotation near the previous ~28 days while popular/fresh lanes take 25% (simulated on 2026-11-18 data).
export async function updateCatalog(previous={}, {getText=fetchText,now=Date.now(),recentPages=6,maxRecentPages=30,recentGapMaxDays=7,staleAfterMinutes=90,backfillPages=12,backfillRecheckDays=7,previewAuditPages=24,detailLimit=320,delayMs=300,timeBudgetMs=15*60*1000,clock=Date.now}={}) {
  const startedAt=clock();
  const previousItems=migrateItems({items:(previous.items||[]).map(item=>migrateFirstSeen(migrateLifecycle(item),now))});
  let accessBlocked=false,budgetExceeded=false;
  const errors=[],warnings=[];
  const previousNewestId=(previous.items||[]).reduce((newest,item)=>{const id=Number(item.videoId);return Number.isFinite(id)&&id>0?Math.max(newest||0,id):newest},null);
  const previousSeenId=Number.isFinite(previous.newestSeenId)&&previous.newestSeenId>0?previous.newestSeenId:null;
  const defaultTargetId=previousSeenId??previousNewestId;
  let abandonedTargetId=null;
  let recentGap=Number.isFinite(previous.recentGap?.targetId)&&previous.recentGap.targetId>0?previous.recentGap:null;
  if(recentGap&&!Number.isFinite(Date.parse(recentGap.since)))recentGap={...recentGap,since:new Date(now).toISOString()};
  if(recentGap&&now-Date.parse(recentGap.since)>=recentGapMaxDays*86400000){
    warnings.push({stage:"recent_gap",reason:"gap_abandoned",targetId:recentGap.targetId,since:recentGap.since});
    // Abandoned gaps may still be discovered by backfill.
    abandonedTargetId=recentGap.targetId;recentGap=null;
  }
  const crawlTargetId=recentGap?.targetId??defaultTargetId;
  const elapsed=previous.updatedAt?Math.floor((now-Date.parse(previous.updatedAt))/60000):null;
  const minutesSinceLastRun=Number.isFinite(elapsed)?elapsed:null;
  if(minutesSinceLastRun>staleAfterMinutes)warnings.push({stage:"schedule",reason:"run_gap",minutes:minutesSinceLastRun});
  let recentPagesFetched=0,reachedPreviousNewest=crawlTargetId===null?null:false,lastRecent=null,recentFailed=false;
  const request=async url=>{
    if(budgetExceeded||clock()-startedAt>timeBudgetMs){if(!budgetExceeded)errors.push({stage:"budget",reason:"time_budget_exceeded"});budgetExceeded=true;throw new Error("time_budget_exceeded");}
    if(accessBlocked)throw new Error("source_access_unavailable");
    try{return await getText(url);}catch(error){if([401,403,429].includes(error.status)||error.message==="source_access_unavailable")accessBlocked=true;throw error;}
    finally{if(delayMs)await new Promise(resolve=>setTimeout(resolve,delayMs));}
  };
  let feed=[];
  try{feed=parseFeed(await request(RSS_URL));if(!feed.length)throw new Error("rss_empty_or_changed");}
  catch(error){if(!budgetExceeded)errors.push({stage:"rss",reason:error.message});}
  const listings=[];
  let successfulListings=0;
  for(let page=1;!budgetExceeded&&(page<=recentPages||(page<=maxRecentPages&&crawlTargetId!==null&&!reachedPreviousNewest&&!recentFailed&&lastRecent?.hasNext));page++) {
    recentPagesFetched++;
    try{const result=parseListing(await request(page===1?SOURCE:`${SOURCE}/page=${page}`),`${SOURCE}/page=${page}`,now);listings.push(...result.items);successfulListings++;lastRecent=result;if(crawlTargetId!==null&&result.items.some(item=>Number(item.videoId)<=crawlTargetId))reachedPreviousNewest=true;}
    catch(error){if(budgetExceeded)break;recentFailed=true;lastRecent=null;errors.push({stage:"recent",page,reason:error.message});if(accessBlocked||page>recentPages)break;}
  }
  const newestSeenId=recentFailed||budgetExceeded||accessBlocked?previousSeenId:listings.reduce((newest,item)=>{const id=Number(item.videoId);return Number.isFinite(id)&&id>0?Math.max(newest||0,id):newest},previousSeenId);
  recentGap=crawlTargetId!==null&&(abandonedTargetId===null||crawlTargetId>abandonedTargetId)&&(!reachedPreviousNewest||recentFailed||budgetExceeded||accessBlocked)?{targetId:crawlTargetId,since:recentGap?.since||new Date(now).toISOString()}:null;
  if(recentGap)warnings.push({stage:"recent_gap",reason:"previous_newest_not_reached",pages:recentPagesFetched});
  const recentPagesOk=successfulListings;
  const backfill={nextPage:recentPages+1,complete:false,...previous.backfill};
  backfill.nextPage=Math.max(recentPages+1,backfill.nextPage);
  if(backfill.complete){
    if(!backfill.completedAt)backfill.completedAt=new Date(now).toISOString();
    else if(now-Date.parse(backfill.completedAt)>=backfillRecheckDays*86400000){backfill.complete=false;backfill.nextPage=Math.max(recentPages+1,backfill.nextPage-1);}
  }
  const startPage=backfill.nextPage;
  let processedPages=0;
  for(let i=0;i<backfillPages&&!backfill.complete&&!accessBlocked&&!budgetExceeded;i++) {
    const page=backfill.nextPage;
    try {
      const result=parseListing(await request(`${SOURCE}/page=${page}`),`${SOURCE}/page=${page}`,now);
      listings.push(...result.items);successfulListings++;processedPages++;
      if(!result.hasNext&&!result.pagerFound){errors.push({stage:"backfill",page,reason:"pager_missing"});break;}
      backfill.nextPage=page+1;backfill.complete=!result.hasNext;if(backfill.complete)backfill.completedAt=new Date(now).toISOString();
    }catch(error){if(budgetExceeded)break;errors.push({stage:"backfill",page,reason:error.message});break;}
  }
  if(!feed.length&&!successfulListings)throw new Error(`No source metadata retrieved; previous catalog preserved (${errors.map(e=>e.reason).join(", ")})`);
  const previousAudit=filterJapanese(previousItems);
  const previousIds=new Set((previous.items||[]).map(x=>videoKey(x.sourceUrl)));
  const expired=new Map();
  for(const entry of previous.notFoundPolicy?.expired||[]){
    const videoId=String(entry?.videoId??""),at=entry?.at,time=parseLifecycleDate(at);
    if(!/^\d+$/.test(videoId)||!Number.isFinite(time)||now-time>EXPIRED_RETENTION_DAYS*24*HOUR)continue;
    if(!expired.has(videoId)||time>parseLifecycleDate(expired.get(videoId).at))expired.set(videoId,{videoId,at});
  }
  const firstSeenAt=new Date(now).toISOString();
  let contentAudit=auditContent([...previousItems,...listings,...feed],previous.contentPolicy?.excludedItems);
  const candidates=mergeItems(contentAudit.accepted);
  const discoveryAudit=filterJapanese(candidates);
  let revivedFromExpired=0;
  let items=discoveryAudit.accepted.map(item=>{
    if(previousIds.has(item.videoId)||!expired.delete(item.videoId))return item;
    revivedFromExpired++;
    return {...item,availability:"not_found",notFoundSince:firstSeenAt};
  });
  // One bounded rescan of already-visited lists repairs old items without guessing image URLs.
  // Keep the archive discovery cursor intact and never add a work solely from this audit.
  const auditEnd=Math.max(recentPages,Number(previous.backfill?.nextPage||recentPages+1)-1);
  const previewAudit=previous.previewAudit?.version===PREVIEW_VERSION?{...previous.previewAudit}:{version:PREVIEW_VERSION,nextPage:recentPages+1,endPage:auditEnd,complete:auditEnd<=recentPages};
  const existing=new Map(items.map(x=>[x.videoId,x]));let previewAuditProcessed=0;
  for(let i=0;i<previewAuditPages&&!previewAudit.complete&&!accessBlocked&&!budgetExceeded;i++){
    const page=previewAudit.nextPage;
    try{
      const result=parseListing(await request(`${SOURCE}/page=${page}`),`${SOURCE}/page=${page}`,now);
      contentAudit=auditContent([...items,...result.items],contentAudit.excludedItems);
      const excluded=new Set(contentAudit.excludedItems.map(x=>x.videoId));
      items=items.filter(x=>!excluded.has(x.videoId));
      for(const found of result.items){const old=existing.get(found.videoId);if(old&&found.preview&&!['unavailable','not_found'].includes(old.availability)){old.preview=found.preview;old.previewVersion=PREVIEW_VERSION}}
      if(!result.hasNext&&!result.pagerFound){errors.push({stage:"preview_audit",page,reason:"pager_missing"});break;}
      previewAudit.nextPage=page+1;previewAuditProcessed++;previewAudit.complete=!result.hasNext||previewAudit.nextPage>previewAudit.endPage;
    }catch(error){if(budgetExceeded)break;errors.push({stage:'preview_audit',page,reason:error.message});break}
  }
  const {queue,detailLanes}=detailQueuePlan(items,now,detailLimit),details=[];
  let detailAttempted=0;
  for(const item of queue) {
    if(accessBlocked||budgetExceeded)break;
    detailAttempted++;
    try {
      const detail=parseDetail(await request(item.sourceUrl),now,item.videoId);
      const keepDate=item.dateSource==="rss"&&detail.dateSource!=="official";
      const updated={...item,...detail,detailOkAt:detail.detailCheckedAt,detailFailures:0,detailAttemptAt:null,views:detail.views??item.views??null,date:keepDate?item.date:detail.date,dateSource:keepDate?"rss":detail.dateSource,dateLabel:keepDate?item.dateLabel:detail.dateLabel};
      delete updated.notFoundSince;
      details.push(updated);
    }catch(error){
      if(budgetExceeded){detailAttempted--;break;}
      errors.push({stage:"detail",videoId:item.videoId,reason:error.message});
      if(error.status===404){
        const detailCheckedAt=new Date(now).toISOString();
        const notFoundSince=item.availability==="not_found"&&Number.isFinite(parseLifecycleDate(item.notFoundSince))?item.notFoundSince:detailCheckedAt;
        details.push({...item,notFoundSince,detailFailures:0,detailAttemptAt:null,availability:"not_found",embedUrl:"",preview:null,likes:null,dislikes:null,ratingPercent:null,statsVersion:SCHEMA_VERSION,ratingVersion:RATING_VERSION,previewVersion:PREVIEW_VERSION,detailCheckedAt,lastError:"HTTP_404"});
      }
      else if(!accessBlocked)details.push({...item,detailFailures:(item.detailFailures||0)+1,detailAttemptAt:new Date(now).toISOString(),lastError:error.message});
    }
  }
  contentAudit=auditContent([...items,...details],contentAudit.excludedItems);
  const finalAudit=filterJapanese(mergeItems(contentAudit.accepted));
  items=finalAudit.accepted.map(item=>({...item,categories:item.categories||[]}));
  items.sort((a,b)=>(b.date||0)-(a.date||0)||Number(b.videoId)-Number(a.videoId));
  const rejected=[...discoveryAudit.rejected,...finalAudit.rejected],reasons={};
  const finalIds=new Set(items.map(x=>x.videoId));
  const removedExisting=new Set([...previousAudit.rejected,...rejected].map(x=>x.videoId).filter(id=>previousIds.has(id)&&!finalIds.has(id))).size;
  for(const x of rejected)reasons[x.reason]=(reasons[x.reason]||0)+1;
  const {kept,removed}=expireNotFound(items,now);
  for(const {videoId} of removed)expired.set(videoId,{videoId,at:firstSeenAt});
  items=kept.map(item=>previousIds.has(item.videoId)||Object.hasOwn(item,"firstSeenAt")?item:{...item,firstSeenAt});
  const expiredNotFound=removed.length;
  return {schemaVersion:SCHEMA_VERSION,updatedAt:new Date(now).toISOString(),source:RSS_URL,backfill,previewAudit,...(newestSeenId!==null?{newestSeenId}:{}),...(recentGap?{recentGap}:{}),
    contentPolicy:contentPolicy(previous,contentAudit,now),
    notFoundPolicy:{days:NOT_FOUND_DAYS,removedThisRun:expiredNotFound,removedTotal:(previous.notFoundPolicy?.removedTotal||0)+expiredNotFound,
      expired:[...expired.values()],lastRemoval:expiredNotFound?{at:new Date(now).toISOString(),count:expiredNotFound}:previous.notFoundPolicy?.lastRemoval||null},
    languagePolicy:{version:LANGUAGE_POLICY_VERSION,mode:"japanese_titles_only",auditedAt:new Date(now).toISOString(),excludedThisRun:rejected.length,removedExisting,removedExistingTotal:(previous.languagePolicy?.removedExistingTotal||0)+removedExisting,reasons},
    collection:{recentPages,maxRecentPages,backfillPages,previewAuditPages,detailLimit,timeBudgetMs},
    summary:{...itemCounts(items),detailLanes,expiredNotFound,revivedFromExpired,elapsedMs:clock()-startedAt,newItems:items.filter(x=>!previousIds.has(x.videoId)).length,
      rssItems:feed.length,listingItems:new Set(listings.map(x=>x.videoId)).size,backfillFrom:startPage,backfillPages:processedPages,
      detailRefreshed:details.filter(x=>!x.detailFailures).length,detailFailed:details.filter(x=>x.detailFailures>0).length,recentPagesFetched,previousNewestId,crawlTargetId,reachedPreviousNewest,minutesSinceLastRun,recentPagesOk,detailAttempted,previewAuditPages:previewAuditProcessed},errors,warnings,items};
}

export function assessRun(result) {
  const errors=result.errors||[],counts={},messages=[];
  for(const error of errors)counts[error.stage]=(counts[error.stage]||0)+1;
  if(!errors.length&&!(result.warnings||[]).length)return {level:"ok",counts,messages};
  if(result.summary?.recentPagesOk===0&&(!counts.budget||counts.recent))messages.push("No recent pages succeeded");
  if(errors.some(error=>/\bHTTP_(401|403|429)\b|source_access_unavailable/.test(error.reason)))messages.push("Source access blocked");
  const attempted=result.summary?.detailAttempted||0;
  if(attempted>0&&errors.filter(error=>error.stage==="detail"&&error.reason!=="HTTP_404").length===attempted)messages.push("All requested details failed without 404");
  const level=messages.length?"severe":"degraded";
  for(const warning of result.warnings||[])messages.push(`${warning.stage}: ${warning.reason}`);
  return {level,counts,messages};
}

export function validateForSave(result,previous,options={}) {
  const {allowShrink=false,minPrevious=100,maxDropRatio=0.5,expectedSchema}={expectedSchema:SCHEMA_VERSION,...options};
  if(result?.schemaVersion!==expectedSchema)return {ok:false,reason:"Invalid schemaVersion"};
  if(!Array.isArray(result.items))return {ok:false,reason:"Invalid items: expected an array"};
  if(result.items.some(item=>!item?.videoId||!item?.sourceUrl))return {ok:false,reason:"Invalid item: videoId and sourceUrl required"};
  const before=Array.isArray(previous?.items)?previous.items.length:0,after=result.items.length;
  if(!allowShrink&&before>=minPrevious&&after<before*(1-maxDropRatio))return {ok:false,reason:`Catalog item count dropped: previous=${before}, current=${after}`};
  return {ok:true};
}

export async function runMain({argv=process.argv,output=OUTPUT,update=updateCatalog,prune=pruneCatalog,log=console.log,env=process.env}={}) {
  try {
    let previous={items:[]};
    try{previous=JSON.parse(await readFile(output,"utf8"));}catch(error){if(error.code!=="ENOENT")throw error;}
    const result=argv.includes('--prune-only')?await prune(previous):await update(previous);
    const validation=validateForSave(result,previous,{allowShrink:argv.includes('--allow-shrink'),expectedSchema:argv.includes('--prune-only')?previous.schemaVersion:SCHEMA_VERSION});
    if(!validation.ok){log(`::error title=Catalog save refused::${validation.reason}`);return 1;}
    const target=output instanceof URL?fileURLToPath(output):output,temp=`${target}.tmp`;
    let headJson;
    try {
      headJson=JSON.stringify(buildHead(result));
    }catch(error){
      log(`::warning title=Catalog head not built::${error.message}`);
      headJson=JSON.stringify({headVersion:0,updatedAt:result.updatedAt});
    }
    await mkdir(dirname(target),{recursive:true});
    await writeFile(temp,`${JSON.stringify(result,null,2)}\n`);await rename(temp,target);
    try {
      const headTarget=join(dirname(target),"catalog-head.json"),headTemp=`${headTarget}.tmp`;
      await writeFile(headTemp,`${headJson}\n`);
      await rename(headTemp,headTarget);
    }catch(error){
      log(`::error title=Catalog head not written::${error.message}`);
      return 1;
    }
    const {excludedItems,...policy}=result.contentPolicy||{};
    log(JSON.stringify({updatedAt:result.updatedAt,summary:result.summary,backfill:result.backfill,contentPolicy:policy,errors:result.errors}));
    const assessment=assessRun(result),summary=[Object.entries(assessment.counts).map(([stage,count])=>`${stage}=${count}`).join(", "),...assessment.messages].filter(Boolean).join("; ");
    if(assessment.level!=="ok")log(`::${assessment.level==="severe"?"error title=Catalog collection degraded":"warning title=Catalog partially failed"}::${summary}`);
    // The catalog is already saved; a summary write failure must not block the commit step.
    if(env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,`\n| Catalog health | Stage errors |\n| --- | --- |\n| ${assessment.level} | ${summary||"none"} |\n`).catch(error=>log(`::warning title=Step summary not written::${error.message}`));
    return argv.includes('--strict')&&assessment.level==="severe"?2:0;
  }catch(error){log(error.message);return 1;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runMain().then(code=>{process.exitCode=code},error=>{console.error(error.message);process.exitCode=1;});
