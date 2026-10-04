import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { SOURCE, RSS_URL, SCHEMA_VERSION, decode, stripMarkup, parseFeed, parseListing, parseDetail, migrateItems, mergeItems, detailQueue, updateCatalog } from '../scripts/update.mjs';

const NOW=Date.parse('2026-10-04T10:00:00Z');
const url=id=>`${SOURCE}/video/${id}/test`;
const item=id=>({id:`video:${id}`,videoId:String(id),sourceUrl:url(id),title:`Test ${id}`,categories:[]});
const rss=(id=201)=>`<rss><channel><item><title>Test &amp; sample</title><link>${url(id)}</link><pubDate>Sun, 04 Oct 2026 09:00:00 GMT</pubDate></item></channel></rss>`;
const listing=(id,next=2)=>`<h4>Videos Being Watched</h4><a href="${url(999)}">Not an archive</a><h4><span>Most Recent Videos</span></h4><div><a href="${url(id)}"><img src="https://cdn.tokyo-motion.net/${id}.jpg" alt="Test ${id}"><span>HD</span><span>01:20</span></a><a href="${url(id)}">Test ${id}</a><span>2 days ago</span><span>1,234 views</span><span>88%</span></div>${next?`<a href="/page=${next}">Next</a>`:''}<h4>Information</h4>`;
const detail=(id=201,likes=12,dislikes=3)=>`<meta content="Test ${id}" property="og:title"><meta content="https://cdn.tokyo-motion.net/${id}.jpg" property="og:image"><script>let fake='123000 views';</script><div class="dislike" style="width:88%"></div><h4>Test ${id}</h4><span>${likes}</span><span>${dislikes}</span><a>Embed Video</a><textarea>&lt;iframe src="https://www.tokyomotion.net/embed/abc123"&gt;</textarea><p>Uploader · 2 days ago, 1,234 views</p><h4>Related Videos</h4><p>1 day ago, 999999 views</p>`;

test('entity decoding and script removal do not invent visible metadata',()=>{
  assert.equal(decode('A&#x26;B &amp; &#39;'),'A&B & \'');
  assert.equal(stripMarkup('<script>999 views</script><p>0 views</p>'),'0 views');
});
test('RSS retains title and exact publication date',()=>{
  const [x]=parseFeed(rss());assert.equal(x.title,'Test & sample');assert.equal(x.videoId,'201');assert.equal(x.dateSource,'rss');
});
test('archive excludes watched/recommendation block, deduplicates anchors and extracts exact title',()=>{
  const result=parseListing(listing(101,3),`${SOURCE}/page=2`,NOW);
  assert.equal(result.items.length,1);assert.equal(result.items[0].videoId,'101');assert.equal(result.items[0].title,'Test 101');
  assert.equal(result.items[0].views,1234);assert.equal(result.items[0].ratingPercent,88);assert.equal(result.hasNext,true);
});
test('missing list structure is a failure, never a fake empty archive',()=>{
  assert.throws(()=>parseListing('<h1>Site Unavailable</h1>',SOURCE),/listing_structure_changed/);
});
test('detail reads votes and main view count, not CSS percent or related views',()=>{
  const x=parseDetail(detail(),NOW);assert.equal(x.likes,12);assert.equal(x.dislikes,3);assert.equal(x.views,1234);assert.equal(x.title,'Test 201');
});
test('unknown ratings stay null, not percent-derived vote counts',()=>{
  const html=detail().replace('<span>12</span><span>3</span>','<span>Not available</span>');
  const x=parseDetail(html,NOW);assert.equal(x.likes,null);assert.equal(x.dislikes,null);
});
test('zero ratings remain valid zero',()=>{
  const x=parseDetail(detail(201,0,0),NOW);assert.equal(x.likes,0);assert.equal(x.dislikes,0);
});
test('private works lose the official embed instead of bypassing restrictions',()=>{
  const x=parseDetail('<h1>This is a private video</h1>',NOW);assert.equal(x.availability,'unavailable');assert.equal(x.embedUrl,'');
});
test('bad source response does not count as verified details',()=>{
  assert.throws(()=>parseDetail('<h1>Site Unavailable</h1>',NOW),/detail_unavailable/);
});
test('legacy statistics are invalidated for re-audit',()=>{
  const [x]=migrateItems({items:[{...item(1),likes:100,dislikes:100,views:1000,date:NOW}]});assert.equal(x.likes,null);assert.equal(x.views,null);assert.equal(x.date,0);
});
test('numeric ID merges URL spelling variants and keeps exact dates',()=>{
  const [x]=mergeItems([{...item(1),sourceUrl:`${SOURCE}/video/1/a%20b`,date:NOW,dateSource:'rss',dateLabel:'2026/10/4'}],[{...item(1),sourceUrl:`${SOURCE}/video/1/a%E3%80%80b`,date:NOW-999,dateSource:'relative'}]);
  assert.equal(x.date,NOW);assert.equal(x.dateSource,'rss');
});
test('complete metadata is periodically refreshed',()=>{
  const x={...item(1),statsVersion:SCHEMA_VERSION,detailCheckedAt:new Date(NOW-25*3600000).toISOString()};assert.equal(detailQueue([x],NOW).length,1);
  assert.equal(detailQueue([{...x,detailCheckedAt:new Date(NOW).toISOString()}],NOW).length,0);
});
const mockSource=async requested=>{
  if(requested===RSS_URL)return rss();
  if(requested===SOURCE)return listing(202,2);
  const page=Number(requested.match(/page=(\d+)/)?.[1]||0);
  if(page)return listing(200-page,page+1);
  return detail(Number(requested.match(/\/video\/(\d+)/)?.[1]||1));
};
test('100 existing works do not suppress incoming works; archive resumes across runs',async()=>{
  const previous={items:Array.from({length:100},(_,i)=>({...item(i+1),statsVersion:SCHEMA_VERSION,detailCheckedAt:new Date(NOW).toISOString()}))};
  const result=await updateCatalog(previous,{getText:mockSource,now:NOW,delayMs:0,detailLimit:5});
  assert.ok(result.items.length>100);assert.ok(result.items.some(x=>x.videoId==='201'));assert.ok(result.items.some(x=>x.videoId==='1'));
  assert.equal(result.backfill.nextPage,5);assert.equal(result.summary.detailRefreshed,5);
  const second=await updateCatalog(result,{getText:mockSource,now:NOW+1800000,delayMs:0,detailLimit:5});
  assert.equal(second.backfill.nextPage,7);assert.ok(second.items.length>result.items.length);
});
test('backfill failure retains cursor and existing items',async()=>{
  const result=await updateCatalog({items:[item(1)],backfill:{nextPage:9,complete:false}},{getText:async u=>u.includes('page=9')?Promise.reject(new Error('timeout')):mockSource(u),now:NOW,delayMs:0,detailLimit:0});
  assert.equal(result.backfill.nextPage,9);assert.ok(result.items.some(x=>x.videoId==='1'));assert.ok(result.errors.some(x=>x.page===9));
});
test('complete source failure does not erase the previous catalog',async()=>{
  const previous={items:[item(1)]};let calls=0;
  await assert.rejects(()=>updateCatalog(previous,{getText:async()=>{calls++;const error=new Error('HTTP_403');error.status=403;throw error},now:NOW,delayMs:0}),/previous catalog preserved/);
  assert.equal(previous.items.length,1);assert.equal(calls,1);
});

test('UI syntax, safe storage, honest missing-stat labels and age gate removal',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(script);
  assert.ok(!html.includes('id="age"'));assert.ok(html.includes('id="more"'));assert.ok(html.includes('id="retry-player"'));
  const context=vm.createContext({document:{getElementById:()=>({})},localStorage:{getItem:()=>'{broken'},URL});
  vm.runInContext(script.slice(0,script.indexOf("    $('grid').addEventListener")),context);
  const missing=vm.runInContext('stats({statsVersion:2,views:null,likes:null,dislikes:null})',context);
  assert.match(missing,/再生数 未取得/);assert.doesNotMatch(missing,/0回/);
  assert.match(vm.runInContext('stats({statsVersion:2,views:0,likes:0,dislikes:0})',context),/0回再生/);
  assert.equal(vm.runInContext("safeUrl('javascript:alert(1)','embed')",context),'');
  assert.equal(vm.runInContext("safeUrl('https://example.com/embed/abc','embed')",context),'');
});
