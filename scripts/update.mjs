import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classifyTitle, filterJapanese, LANGUAGE_POLICY_VERSION } from "../assets/language.mjs";
import { auditContent, contentId, contentExclusionReasons, CONTENT_POLICY_VERSION } from "../assets/content-filter.mjs";

export const SOURCE = "https://www.tokyomotion.net";
export const RSS_URL = `${SOURCE}/rss`;
export const SCHEMA_VERSION = 2;
export const RATING_VERSION = 1;
export const PREVIEW_VERSION = 1;
const OUTPUT = new URL("../data/videos.json", import.meta.url);
const HOUR = 3600000;

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
    return [{id:`video:${videoKey(url)}`,videoId:videoKey(url),sourceUrl:url,title,
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
    items.push({id:`video:${anchor.key}`,videoId:anchor.key,sourceUrl:anchor.url,title,...(preview?{preview,previewVersion:PREVIEW_VERSION}:{}),
      image:imageUrl(attr(img,"data-src")||attr(img,"data-original")||attr(img,"src"),pageUrl),categories:[],
      date,dateSource:date?"relative":"unknown",dateLabel:dateLabel(date),views:views?Number(views[1].replace(/,/g,"")):null,
      ratingPercent:rating && Number(rating[1])<=100?Number(rating[1]):null,listingCheckedAt:new Date(now).toISOString()});
  }
  if(!items.length)throw new Error("listing_empty_or_unavailable");
  const current=Number(pageUrl.match(/page=(\d+)/)?.[1]||1);
  const hasNext=(section.match(/<a\b[^>]*>/gi)||[]).map(tag=>normalizeUrl(attr(tag,"href"),pageUrl))
    .some(url=>Number(url.match(/[?\/]page=(\d+)/)?.[1]||0)>current);
  return {items,hasNext};
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
  return {title,description,contentExclusions:contentExclusionReasons({title,description:rawDescription}),image:imageUrl(meta(html,"og:image")||meta(html,"twitter:image")),
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

export function mergeItems(...lists) {
  const map=new Map(),dateRank={unknown:0,relative:1,rss:2,official:3};
  for(const item of lists.flat()) {
    const url=sourceUrl(item.sourceUrl),key=videoKey(url);
    if(!key)continue;
    const old=map.get(key),result={...old,...item,id:old?.id||item.id||`video:${key}`,videoId:key,sourceUrl:url,
      categories:[...new Set([...(old?.categories||[]),...(item.categories||[])])]};
    for(const field of ["title","image","embedUrl"])if(!item[field] && old?.[field] && !["unavailable","not_found"].includes(item.availability))result[field]=old[field];
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
  const due=items.filter(x=>!x.detailCheckedAt||now-Date.parse(x.detailCheckedAt)>24*HOUR||x.statsVersion!==SCHEMA_VERSION||x.ratingVersion!==RATING_VERSION||x.previewVersion!==PREVIEW_VERSION||(now-x.date<48*HOUR&&now-Date.parse(x.detailCheckedAt)>6*HOUR));
  const pending=due.filter(x=>!x.detailCheckedAt).sort((a,b)=>Number(b.videoId)-Number(a.videoId));
  const refresh=due.filter(x=>x.detailCheckedAt).sort((a,b)=>Date.parse(a.detailCheckedAt)-Date.parse(b.detailCheckedAt));
  const selected=[...pending.slice(0,Math.max(1,Math.floor(limit*.65))),...refresh.slice(0,Math.max(1,Math.floor(limit*.35)))];
  const keys=new Set(selected.map(x=>x.videoId));
  for(const item of [...pending,...refresh])if(selected.length<limit&&!keys.has(item.videoId)){selected.push(item);keys.add(item.videoId);}
  return selected.slice(0,limit);
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

// Offline cleanup preserves metadata, crawl cursors and the last collection time.
// Only IDs and reasons are kept as tombstones, not removed titles or media URLs.
export function pruneCatalog(previous={},now=Date.now()) {
  const audit=auditContent(previous.items||[],previous.contentPolicy?.excludedItems);
  return {...previous,contentPolicy:contentPolicy(previous,audit,now),
    summary:{...previous.summary,...itemCounts(audit.accepted),newItems:0},items:audit.accepted};
}

export async function updateCatalog(previous={}, {getText=fetchText,now=Date.now(),recentPages=6,backfillPages=12,previewAuditPages=24,detailLimit=240,delayMs=300}={}) {
  let accessBlocked=false;
  const errors=[];
  const request=async url=>{
    if(accessBlocked)throw new Error("source_access_unavailable");
    try{return await getText(url);}catch(error){if([401,403,429].includes(error.status)||error.message==="source_access_unavailable")accessBlocked=true;throw error;}
    finally{if(delayMs)await new Promise(resolve=>setTimeout(resolve,delayMs));}
  };
  let feed=[];
  try{feed=parseFeed(await request(RSS_URL));if(!feed.length)throw new Error("rss_empty_or_changed");}
  catch(error){errors.push({stage:"rss",reason:error.message});}
  const listings=[];
  let successfulListings=0;
  for(let page=1;page<=recentPages;page++) {
    try{const result=parseListing(await request(page===1?SOURCE:`${SOURCE}/page=${page}`),`${SOURCE}/page=${page}`,now);listings.push(...result.items);successfulListings++;}
    catch(error){errors.push({stage:"recent",page,reason:error.message});if(accessBlocked)break;}
  }
  const backfill={nextPage:recentPages+1,complete:false,...previous.backfill};
  backfill.nextPage=Math.max(recentPages+1,backfill.nextPage);
  const startPage=backfill.nextPage;
  let processedPages=0;
  for(let i=0;i<backfillPages&&!backfill.complete&&!accessBlocked;i++) {
    const page=backfill.nextPage;
    try {
      const result=parseListing(await request(`${SOURCE}/page=${page}`),`${SOURCE}/page=${page}`,now);
      listings.push(...result.items);successfulListings++;processedPages++;backfill.nextPage=page+1;backfill.complete=!result.hasNext;
    }catch(error){errors.push({stage:"backfill",page,reason:error.message});break;}
  }
  if(!feed.length&&!successfulListings)throw new Error(`No source metadata retrieved; previous catalog preserved (${errors.map(e=>e.reason).join(", ")})`);
  const previousAudit=filterJapanese(migrateItems(previous));
  let contentAudit=auditContent([...migrateItems(previous),...listings,...feed],previous.contentPolicy?.excludedItems);
  const candidates=mergeItems(contentAudit.accepted);
  const discoveryAudit=filterJapanese(candidates);
  let items=discoveryAudit.accepted;
  // One bounded rescan of already-visited lists repairs old items without guessing image URLs.
  // Keep the archive discovery cursor intact and never add a work solely from this audit.
  const auditEnd=Math.max(recentPages,Number(previous.backfill?.nextPage||recentPages+1)-1);
  const previewAudit=previous.previewAudit?.version===PREVIEW_VERSION?{...previous.previewAudit}:{version:PREVIEW_VERSION,nextPage:recentPages+1,endPage:auditEnd,complete:auditEnd<=recentPages};
  const existing=new Map(items.map(x=>[x.videoId,x]));let previewAuditProcessed=0;
  for(let i=0;i<previewAuditPages&&!previewAudit.complete&&!accessBlocked;i++){
    const page=previewAudit.nextPage;
    try{
      const result=parseListing(await request(`${SOURCE}/page=${page}`),`${SOURCE}/page=${page}`,now);
      contentAudit=auditContent([...items,...result.items],contentAudit.excludedItems);
      const excluded=new Set(contentAudit.excludedItems.map(x=>x.videoId));
      items=items.filter(x=>!excluded.has(x.videoId));
      for(const found of result.items){const old=existing.get(found.videoId);if(old&&found.preview&&!['unavailable','not_found'].includes(old.availability)){old.preview=found.preview;old.previewVersion=PREVIEW_VERSION}}
      previewAudit.nextPage=page+1;previewAuditProcessed++;previewAudit.complete=!result.hasNext||previewAudit.nextPage>previewAudit.endPage;
    }catch(error){errors.push({stage:'preview_audit',page,reason:error.message});break}
  }
  const queue=detailQueue(items,now,detailLimit),details=[];
  for(const item of queue) {
    if(accessBlocked)break;
    try {
      const detail=parseDetail(await request(item.sourceUrl),now,item.videoId);
      const keepDate=item.dateSource==="rss"&&detail.dateSource!=="official";
      details.push({...item,...detail,views:detail.views??item.views??null,date:keepDate?item.date:detail.date,dateSource:keepDate?"rss":detail.dateSource,dateLabel:keepDate?item.dateLabel:detail.dateLabel});
    }catch(error){
      errors.push({stage:"detail",videoId:item.videoId,reason:error.message});
      if(error.status===404)details.push({...item,availability:"not_found",embedUrl:"",preview:null,likes:null,dislikes:null,ratingPercent:null,statsVersion:SCHEMA_VERSION,ratingVersion:RATING_VERSION,previewVersion:PREVIEW_VERSION,detailCheckedAt:new Date(now).toISOString(),lastError:"HTTP_404"});
    }
  }
  contentAudit=auditContent([...items,...details],contentAudit.excludedItems);
  const finalAudit=filterJapanese(mergeItems(contentAudit.accepted));
  items=finalAudit.accepted.map(item=>({...item,categories:item.categories||[]}));
  items.sort((a,b)=>(b.date||0)-(a.date||0)||Number(b.videoId)-Number(a.videoId));
  const previousIds=new Set((previous.items||[]).map(x=>videoKey(x.sourceUrl)));
  const rejected=[...discoveryAudit.rejected,...finalAudit.rejected],reasons={};
  for(const x of rejected)reasons[x.reason]=(reasons[x.reason]||0)+1;
  return {schemaVersion:SCHEMA_VERSION,updatedAt:new Date(now).toISOString(),source:RSS_URL,backfill,previewAudit,
    contentPolicy:contentPolicy(previous,contentAudit,now),
    languagePolicy:{version:LANGUAGE_POLICY_VERSION,mode:"japanese_titles_only",auditedAt:new Date(now).toISOString(),excludedThisRun:rejected.length,removedExisting:previousAudit.rejected.length,removedExistingTotal:(previous.languagePolicy?.removedExistingTotal||0)+previousAudit.rejected.length,reasons},
    collection:{recentPages,backfillPages,previewAuditPages,detailLimit},
    summary:{...itemCounts(items),newItems:items.filter(x=>!previousIds.has(x.videoId)).length,
      rssItems:feed.length,listingItems:new Set(listings.map(x=>x.videoId)).size,backfillFrom:startPage,backfillPages:processedPages,
      detailRefreshed:details.length,previewAuditPages:previewAuditProcessed},errors,items};
}

async function main() {
  let previous={items:[]};
  try{previous=JSON.parse(await readFile(OUTPUT,"utf8"));}catch(error){if(error.code!=="ENOENT")throw error;}
  const result=process.argv.includes('--prune-only')?pruneCatalog(previous):await updateCatalog(previous);
  await mkdir(new URL("../data/",import.meta.url),{recursive:true});
  const temp=new URL(`${OUTPUT.href}.tmp`);
  await writeFile(temp,`${JSON.stringify(result,null,2)}\n`);await rename(temp,OUTPUT);
  const {excludedItems,...policy}=result.contentPolicy;
  console.log(JSON.stringify({updatedAt:result.updatedAt,summary:result.summary,backfill:result.backfill,contentPolicy:policy,errors:result.errors}));
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
