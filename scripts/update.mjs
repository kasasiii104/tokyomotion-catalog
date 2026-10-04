import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const SOURCE = "https://www.tokyomotion.net";
export const RSS_URL = `${SOURCE}/rss`;
export const SCHEMA_VERSION = 2;
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
    return [{id:`video:${videoKey(url)}`,videoId:videoKey(url),sourceUrl:url,title:tagText(block,"title"),
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
    items.push({id:`video:${anchor.key}`,videoId:anchor.key,sourceUrl:anchor.url,title,
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

export function parseDetail(html,now=Date.now()) {
  const text=stripMarkup(html);
  if(/This is a private video|video (?:has been|was) (?:removed|deleted)|video (?:does not exist|not found)/i.test(text)) {
    return {availability:"unavailable",embedUrl:"",likes:null,dislikes:null,detailCheckedAt:new Date(now).toISOString(),statsVersion:SCHEMA_VERSION};
  }
  const embed=embedUrl(html),marker=text.indexOf("Embed Video");
  if(!embed||marker<0)throw new Error("detail_unavailable_or_structure_changed");
  // Never read votes from CSS widths, scripts, or a "dislike" substring.
  const votes=text.slice(0,marker).match(/(?:^|\s)([\d,]+)\s+([\d,]+)\s*$/);
  // The uploader line identifies the main work's count, not a related card.
  const info=text.slice(marker).split(/Related Videos|Comments/)[0];
  const viewMatch=info.match(/\b(?:\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago)\s*,\s*([\d,]+)\s+views\b/i);
  const rawDate=meta(html,"datePublished")||meta(html,"uploadDate")||attr(html.match(/<time\b[^>]*datetime=["'][^"']+["'][^>]*>/i)?.[0]||"","datetime");
  const exact=rawDate?Date.parse(rawDate):NaN,relative=viewMatch?parseRelativeDate(viewMatch[0],now):0;
  const date=Number.isFinite(exact)?exact:relative;
  return {title:meta(html,"og:title").replace(/\s+-\s+TOKYO Motion\s*$/i,""),image:imageUrl(meta(html,"og:image")||meta(html,"twitter:image")),
    embedUrl:embed,availability:"embed_available",views:viewMatch?Number(viewMatch[1].replace(/,/g,"")):null,
    likes:votes?Number(votes[1].replace(/,/g,"")):null,dislikes:votes?Number(votes[2].replace(/,/g,"")):null,
    date,dateSource:Number.isFinite(exact)?"official":date?"relative":"unknown",dateLabel:dateLabel(date),
    statsVersion:SCHEMA_VERSION,detailCheckedAt:new Date(now).toISOString(),lastError:null};
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
    for(const field of ["title","image","embedUrl"])if(!item[field] && old?.[field] && item.availability!=="unavailable")result[field]=old[field];
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

export function detailQueue(items,now,limit=100) {
  const due=items.filter(x=>!x.detailCheckedAt||now-Date.parse(x.detailCheckedAt)>24*HOUR||x.statsVersion!==SCHEMA_VERSION||(now-x.date<48*HOUR&&now-Date.parse(x.detailCheckedAt)>6*HOUR));
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

export async function updateCatalog(previous={}, {getText=fetchText,now=Date.now(),backfillPages=2,detailLimit=100,delayMs=300}={}) {
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
  for(const page of [1,2]) {
    try{const result=parseListing(await request(page===1?SOURCE:`${SOURCE}/page=${page}`),`${SOURCE}/page=${page}`,now);listings.push(...result.items);successfulListings++;}
    catch(error){errors.push({stage:"recent",page,reason:error.message});if(accessBlocked)break;}
  }
  const backfill={nextPage:3,complete:false,...previous.backfill},startPage=backfill.nextPage;
  let processedPages=0;
  for(let i=0;i<backfillPages&&!backfill.complete&&!accessBlocked;i++) {
    const page=backfill.nextPage;
    try {
      const result=parseListing(await request(`${SOURCE}/page=${page}`),`${SOURCE}/page=${page}`,now);
      listings.push(...result.items);successfulListings++;processedPages++;backfill.nextPage=page+1;backfill.complete=!result.hasNext;
    }catch(error){errors.push({stage:"backfill",page,reason:error.message});break;}
  }
  if(!feed.length&&!successfulListings)throw new Error(`No source metadata retrieved; previous catalog preserved (${errors.map(e=>e.reason).join(", ")})`);
  let items=mergeItems(migrateItems(previous),listings,feed);
  const queue=detailQueue(items,now,detailLimit),details=[];
  for(const item of queue) {
    if(accessBlocked)break;
    try {
      const detail=parseDetail(await request(item.sourceUrl),now);
      const keepDate=item.dateSource==="rss"&&detail.dateSource!=="official";
      details.push({...item,...detail,views:detail.views??item.views??null,date:keepDate?item.date:detail.date,dateSource:keepDate?"rss":detail.dateSource,dateLabel:keepDate?item.dateLabel:detail.dateLabel});
    }catch(error){errors.push({stage:"detail",videoId:item.videoId,reason:error.message});}
  }
  items=mergeItems(items,details).map(item=>({...item,categories:item.categories||[]}));
  items.sort((a,b)=>(b.date||0)-(a.date||0)||Number(b.videoId)-Number(a.videoId));
  return {schemaVersion:SCHEMA_VERSION,updatedAt:new Date(now).toISOString(),source:RSS_URL,backfill,
    summary:{total:items.length,newItems:items.length-new Set((previous.items||[]).map(x=>videoKey(x.sourceUrl))).size,
      rssItems:feed.length,listingItems:new Set(listings.map(x=>x.videoId)).size,backfillFrom:startPage,backfillPages:processedPages,
      detailRefreshed:details.length,pendingDetails:items.filter(x=>!x.detailCheckedAt).length,withImages:items.filter(x=>x.image).length,
      withEmbeds:items.filter(x=>x.embedUrl).length,withViews:items.filter(x=>x.views!=null).length,withVotes:items.filter(x=>x.likes!=null&&x.dislikes!=null).length},errors,items};
}

async function main() {
  let previous={items:[]};
  try{previous=JSON.parse(await readFile(OUTPUT,"utf8"));}catch(error){if(error.code!=="ENOENT")throw error;}
  const result=await updateCatalog(previous);
  await mkdir(new URL("../data/",import.meta.url),{recursive:true});
  const temp=new URL(`${OUTPUT.href}.tmp`);
  await writeFile(temp,`${JSON.stringify(result,null,2)}\n`);await rename(temp,OUTPUT);
  console.log(JSON.stringify({updatedAt:result.updatedAt,summary:result.summary,backfill:result.backfill,errors:result.errors}));
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
