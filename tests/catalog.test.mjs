import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyTitle, filterJapanese, LANGUAGE_POLICY_VERSION } from '../assets/language.mjs';
import { PAGE_SIZE, escapeHTML, stats, safeUrl, prepareItems, isListed, selectItems, catalogInfo, firstSeenMs, visitBaseline, isNewSince } from '../assets/catalog-core.mjs';
import { PreviewController, previewSpec } from '../assets/preview-controller.mjs';
import { auditContent, contentExclusionReasons } from '../assets/content-filter.mjs';
import { SOURCE, RSS_URL, SCHEMA_VERSION, RATING_VERSION, PREVIEW_VERSION, decode, stripMarkup, parseFeed, parseListing, parseDetail, parseThumbnailPreview, migrateItems, migrateLifecycle, migrateFirstSeen, expireNotFound, mergeItems, detailQueue, detailQueuePlan, updateCatalog, pruneCatalog, assessRun, validateForSave, buildHead, runMain } from '../scripts/update.mjs';

const NOW=Date.parse('2026-10-04T10:00:00Z');
const url=id=>`${SOURCE}/video/${id}/test`;
const item=id=>({id:`video:${id}`,videoId:String(id),sourceUrl:url(id),title:`テスト作品 ${id}`,categories:[]});
const rss=(id=201)=>`<rss><channel><item><title>テスト &amp; サンプル</title><link>${url(id)}</link><pubDate>Sun, 04 Oct 2026 09:00:00 GMT</pubDate></item></channel></rss>`;
const listing=(id,next=2)=>`<h4>Videos Being Watched</h4><a href="${url(999)}">Not an archive</a><h4><span>Most Recent Videos</span></h4><div><a href="${url(id)}"><img src="https://cdn.tokyo-motion.net/${id}.jpg" alt="テスト作品 ${id}"><span>HD</span><span>01:20</span></a><a href="${url(id)}">テスト作品 ${id}</a><span>2 days ago</span><span>1,234 views</span><span>88%</span></div>${next?`<a href="/page=${next}">Next</a>`:''}<h4>Information</h4>`;
const lastListing=(id,previous=1)=>listing(id,0).replace('<h4>Information</h4>',`<a href="/page=${previous}">Previous</a><h4>Information</h4>`);
const detail=(id=201,likes=12,dislikes=3)=>`<meta content="テスト作品 ${id}" property="og:title"><meta content="https://cdn.tokyo-motion.net/${id}.jpg" property="og:image"><script>let fake='123000 views';</script><div class="dislike" style="width:88%"></div><h4>テスト作品 ${id}</h4><div class="vote-msg"><span id="video_likes" class="text-white">${likes}</span><span id="video_dislikes" class="text-white">${dislikes}</span></div><a>Share</a><a>Flag</a><a>Favorite</a><a>Embed</a><div>Embed Video</div><textarea>&lt;iframe src="https://www.tokyomotion.net/embed/abc123"&gt;</textarea><p>Uploader · 2 days ago, 1,234 views</p><h4>Related Videos</h4><p>1 day ago, 999999 views</p>`;

test('entity decoding and script removal do not invent visible metadata',()=>{
  assert.equal(decode('A&#x26;B &amp; &#39;'),'A&B & \'');
  assert.equal(stripMarkup('<script>999 views</script><p>0 views</p>'),'0 views');
});
test('RSS retains title and exact publication date',()=>{
  const [x]=parseFeed(rss());assert.equal(x.title,'テスト & サンプル');assert.equal(x.videoId,'201');assert.equal(x.dateSource,'rss');
});
test('archive excludes watched/recommendation block, deduplicates anchors and extracts exact title',()=>{
  const result=parseListing(listing(101,3),`${SOURCE}/page=2`,NOW);
  assert.equal(result.items.length,1);assert.equal(result.items[0].videoId,'101');assert.equal(result.items[0].title,'テスト作品 101');
  assert.equal(result.items[0].views,1234);assert.equal(result.items[0].ratingPercent,88);assert.equal(result.hasNext,true);
});
test('missing list structure is a failure, never a fake empty archive',()=>{
  assert.throws(()=>parseListing('<h1>Site Unavailable</h1>',SOURCE),/listing_structure_changed/);
});
test('preview frames require official rotation metadata for the matching work',()=>{
  const tag='<img id="rotate_201_20_9_viewed" src="https://cdn.tokyo-motion.net/media/videos/tmb75/201/9.jpg">';
  const p=parseThumbnailPreview(tag,'201',NOW);
  assert.equal(p.count,20);assert.equal(p.posterIndex,9);assert.equal(p.baseUrl,'https://cdn.tokyo-motion.net/media/videos/tmb75/201/');
  assert.equal(parseThumbnailPreview(tag,'202',NOW),null);
  assert.equal(parseThumbnailPreview(tag.replace('tokyo-motion.net','example.com'),'201',NOW),null);
  assert.equal(parseThumbnailPreview(tag.replace('_20_','_99_'),'201',NOW),null);
  assert.equal(parseThumbnailPreview(tag.replace('rotate_201_20_9_viewed','poster'),'201',NOW),null);
});
test('detail previews never use a related work rotation',()=>{
  const rotation=id=>`<img id="rotate_${id}_20_1_related" src="https://cdn.tokyo-motion.net/media/videos/tmb75/${id}/1.jpg">`;
  assert.equal(parseDetail(detail()+rotation(202),NOW,'201').preview,undefined);
  assert.equal(parseDetail(detail()+rotation(201),NOW,'201').preview.count,20);
  assert.equal(parseDetail('This is a private video'+rotation(201),NOW,'201').preview,null);
});
test('detail reads votes and main view count, not CSS percent or related views',()=>{
  const x=parseDetail(detail(),NOW);assert.equal(x.likes,12);assert.equal(x.dislikes,3);assert.equal(x.views,1234);assert.equal(x.title,'テスト作品 201');
});
test('unknown ratings stay null, not percent-derived vote counts',()=>{
  const html=detail().replace(/<span id="video_(?:dis)?likes"[^>]*>[^<]*<\/span>/g,'<span>Not available</span>');
  const x=parseDetail(html,NOW);assert.equal(x.likes,null);assert.equal(x.dislikes,null);
});
test('zero ratings remain valid zero',()=>{
  const x=parseDetail(detail(201,0,0),NOW);assert.equal(x.likes,0);assert.equal(x.dislikes,0);
});
test('actual vote controls accept thousands and ignore nearby fake counts',()=>{
  const html=detail(201,'1,234','6').replace('<div>Embed Video</div>','<span>999</span><span>999</span><div>Embed Video</div>');
  const x=parseDetail(html,NOW);assert.equal(x.likes,1234);assert.equal(x.dislikes,6);assert.equal(x.ratingVersion,RATING_VERSION);assert.ok(x.ratingPercent>99);
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
  const x={...item(1),statsVersion:SCHEMA_VERSION,ratingVersion:RATING_VERSION,previewVersion:PREVIEW_VERSION,detailCheckedAt:new Date(NOW-25*3600000).toISOString()};assert.equal(detailQueue([x],NOW).length,1);
  assert.equal(detailQueue([{...x,detailCheckedAt:new Date(NOW).toISOString()}],NOW).length,0);
});
test('previous parser versions are re-audited even when recently checked',()=>{
  assert.equal(detailQueue([{...item(1),statsVersion:SCHEMA_VERSION,detailCheckedAt:new Date(NOW).toISOString()}],NOW).length,1);
});
const mockSource=async requested=>{
  if(requested===RSS_URL)return rss();
  if(requested===SOURCE)return listing(202,2);
  const page=Number(requested.match(/page=(\d+)/)?.[1]||0);
  if(page)return listing(200-page,page+1);
  return detail(Number(requested.match(/\/video\/(\d+)/)?.[1]||1));
};
test('100 existing works do not suppress incoming works; archive resumes across runs',async()=>{
  const previous={items:Array.from({length:100},(_,i)=>({...item(i+1),statsVersion:SCHEMA_VERSION,ratingVersion:RATING_VERSION,previewVersion:PREVIEW_VERSION,detailCheckedAt:new Date(NOW).toISOString()}))};
  const result=await updateCatalog(previous,{getText:mockSource,now:NOW,delayMs:0,detailLimit:5,recentPages:2,maxRecentPages:2,backfillPages:2});
  assert.ok(result.items.length>100);assert.ok(result.items.some(x=>x.videoId==='201'));assert.ok(result.items.some(x=>x.videoId==='1'));
  assert.equal(result.backfill.nextPage,5);assert.equal(result.summary.detailRefreshed,5);
  const second=await updateCatalog(result,{getText:mockSource,now:NOW+1800000,delayMs:0,detailLimit:5,recentPages:2,maxRecentPages:2,backfillPages:2});
  assert.equal(second.backfill.nextPage,7);assert.ok(second.items.length>result.items.length);
});
test('listing pagerFound includes current and previous links only within the listing',()=>{
  for(const page of [1,2]){const result=parseListing(lastListing(1,page),`${SOURCE}/page=2`,NOW);assert.equal(result.pagerFound,true);assert.equal(result.hasNext,false)}
  const result=parseListing(listing(1,0)+'<a href="/page=3">Next</a>',SOURCE,NOW);assert.equal(result.pagerFound,false);assert.equal(result.hasNext,false);
});
test('backfill pager_missing retains cursor without completing',async()=>{
  const result=await updateCatalog({backfill:{nextPage:9,complete:false}},{getText:async u=>u.includes('page=9')?listing(1,0):mockSource(u),now:NOW,delayMs:0,detailLimit:0,previewAuditPages:0});
  assert.equal(result.backfill.complete,false);assert.equal(result.backfill.nextPage,9);assert.equal(result.backfill.completedAt,undefined);assert.deepEqual(result.errors,[{stage:'backfill',page:9,reason:'pager_missing'}]);
});
test('backfill previous-only last page records completedAt and rechecks after eight days',async()=>{
  const requests=[],getText=async u=>{requests.push(u);return u.includes('page=9')?lastListing(1,8):mockSource(u)},options={getText,now:NOW,delayMs:0,detailLimit:0,previewAuditPages:0};
  const result=await updateCatalog({backfill:{nextPage:9,complete:false}},options);
  assert.equal(result.backfill.complete,true);assert.equal(result.backfill.nextPage,10);assert.equal(result.backfill.completedAt,new Date(NOW).toISOString());
  requests.length=0;await updateCatalog(result,{...options,now:NOW+6*86400000});assert.ok(!requests.includes(`${SOURCE}/page=9`));
  requests.length=0;const again=await updateCatalog(result,{...options,now:NOW+8*86400000});
  assert.ok(requests.includes(`${SOURCE}/page=9`));assert.equal(again.summary.backfillFrom,9);assert.equal(again.backfill.complete,true);assert.equal(again.backfill.completedAt,new Date(NOW+8*86400000).toISOString());
});
test('legacy backfill completion gains timestamp without immediate recheck',async()=>{
  const result=await updateCatalog({backfill:{nextPage:9,complete:true}},{getText:mockSource,now:NOW,delayMs:0,detailLimit:0,previewAuditPages:0});
  assert.equal(result.backfill.complete,true);assert.equal(result.backfill.nextPage,9);assert.equal(result.backfill.completedAt,new Date(NOW).toISOString());assert.equal(result.summary.backfillPages,0);
});
test('preview audit pager_missing retains cursor without completing',async()=>{
  const result=await updateCatalog({backfill:{nextPage:10,complete:true},previewAudit:{version:PREVIEW_VERSION,nextPage:7,endPage:7,complete:false}},{getText:async u=>u.includes('page=7')?listing(1,0):mockSource(u),now:NOW,delayMs:0,detailLimit:0,backfillPages:0});
  assert.equal(result.previewAudit.complete,false);assert.equal(result.previewAudit.nextPage,7);assert.deepEqual(result.errors,[{stage:'preview_audit',page:7,reason:'pager_missing'}]);
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
test('404 keeps the catalog entry, removes stale embed and defers recheck',async()=>{
  const result=await updateCatalog({items:[{...item(9999),embedUrl:`${SOURCE}/embed/old`}]},{getText:async u=>{
    if(u===url(9999)){const error=new Error('HTTP_404');error.status=404;throw error}return mockSource(u);
  },now:NOW,delayMs:0});
  const x=result.items.find(x=>x.videoId==='9999');assert.equal(x.availability,'not_found');assert.equal(x.embedUrl,'');assert.equal(x.lastError,'HTTP_404');assert.equal(detailQueue([x],NOW).length,0);
});

test('UI separates card preview, details and full playback without a preview-close button',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const script=await readFile(new URL('../assets/app.mjs',import.meta.url),'utf8');
  new vm.Script(script.replace(/^import .*;\n/gm,''));
  assert.ok(!html.includes('id="age"'));assert.ok(html.includes('<dialog id="details"'));assert.ok(html.includes('id="more"'));assert.ok(html.includes('id="shelf"'));
  assert.ok(script.includes("$('watch-media').append(frame)"));assert.ok(!script.includes('data-stop'));assert.ok(!script.includes('プレビューを閉じる'));
  assert.equal(stats({statsVersion:2,views:null,likes:null,dislikes:null}).views,'再生数 未取得');
  assert.equal(stats({statsVersion:2,views:0,likes:0,dislikes:0}).views,'0回再生');
  assert.equal(safeUrl('javascript:alert(1)','embed'),'');assert.equal(safeUrl('https://example.com/embed/abc','embed'),'');
});

test('language filter accepts Japanese and codes without translating',()=>{
  for(const title of ['友達に会いに行く','夏の記憶','FC2-PPV-1234567 テストの動画 HD','ﾃｽﾄの動画','テスト動画 ABC-123'])assert.equal(classifyTitle(title).keep,true,title);
});
test('English, Chinese, mixed Chinese and ambiguous Han-only titles are excluded',()=>{
  for(const title of ['A beautiful summer afternoon','这是测试视频','這個測試影片','中文 サンプル','東京旅行','123456','日本の A very long English description of this video'])assert.equal(classifyTitle(title).keep,false,title);
});
test('existing foreign works are removed from data and not requested again',async()=>{
  const requests=[];const previous={items:[item(1),{...item(2),title:'English test video'},{...item(3),title:'这是测试'}]};
  const result=await updateCatalog(previous,{getText:async u=>{requests.push(u);return mockSource(u)},now:NOW,delayMs:0});
  assert.ok(result.items.some(x=>x.videoId==='1'));assert.ok(!result.items.some(x=>x.videoId==='2'||x.videoId==='3'));assert.ok(!requests.includes(url(2)));assert.equal(result.languagePolicy.removedExisting,2);assert.ok(result.summary.newItems>=0);
});
test('new foreign discoveries are rejected before fetching their details',async()=>{
  const requests=[];const source=async u=>{requests.push(u);return (await mockSource(u)).replaceAll('テスト作品','English sample').replaceAll('テスト &amp; サンプル','English sample')};
  const result=await updateCatalog({items:[]},{getText:source,now:NOW,delayMs:0});
  assert.equal(result.items.length,0);assert.ok(!requests.some(u=>u.includes('/video/')));assert.ok(result.languagePolicy.excludedThisRun>0);
});
test('foreign titles discovered on details are excluded a second time',async()=>{
  const result=await updateCatalog({items:[]},{getText:async u=>u.includes('/video/')?detail().replaceAll('テスト作品','English sample'):mockSource(u),now:NOW,delayMs:0});
  assert.equal(result.items.length,0);
});
test('increased defaults cover 6 recent and 12 archive pages without resetting cursor',async()=>{
  const requests=[];const result=await updateCatalog({items:[],backfill:{nextPage:45,complete:false}},{getText:async u=>{requests.push(u);return mockSource(u)},now:NOW,delayMs:0,detailLimit:0});
  assert.equal(result.collection.recentPages,6);assert.equal(result.collection.backfillPages,12);assert.equal(result.backfill.nextPage,57);assert.equal(result.summary.backfillPages,12);assert.ok(requests.includes(`${SOURCE}/page=6`));assert.ok(requests.includes(`${SOURCE}/page=56`));
});
test('client applies the same language rules to stale cached data',()=>{
  const mixed=[item(1),{...item(2),title:'English test video'},{...item(3),title:'这是测试'}];
  assert.equal(filterJapanese(mixed).accepted.length,1);assert.equal(prepareItems(mixed).length,1);
});
test('search, favorites, history and missing-date ordering use the full catalog',()=>{
  const a={...item(1),date:NOW,views:4},b={...item(2),date:NOW-1000,views:10},c={...item(3),date:0,views:null};
  assert.equal(selectItems([a,b,c],{view:'popular'})[0].id,b.id);assert.equal(selectItems([a,b,c],{view:'archive'})[2].id,c.id);
  assert.deepEqual(selectItems([a,b,c],{view:'favorites',favorites:new Set([b.id])}).map(x=>x.id),[b.id]);
  assert.deepEqual(selectItems([a,b,c],{view:'history',history:[c.id,a.id]}).map(x=>x.id),[c.id,a.id]);
  assert.equal(selectItems([a,b,c],{query:'作品 2'}).length,1);
});

test('public catalog views hide unavailable works',()=>{
  const items=[
    item(1),
    {...item(2),availability:'embed_available'},
    {...item(3),availability:'not_found'},
    {...item(4),availability:'unavailable'},
  ].map(x=>({...x,categories:['テスト']}));
  const filters=[
    ...['home','recent','popular','rated','archive','unknown'].map(view=>({view})),
    {query:'テスト作品'},
    {category:'テスト'},
  ];
  for(const options of filters){
    assert.deepEqual(selectItems(items,options).map(x=>x.id).sort(),['video:1','video:2'],JSON.stringify(options));
  }
});
test('favorites and history retain unavailable works',()=>{
  const items=[{...item(1),availability:'not_found'},{...item(2),availability:'unavailable'}];
  const ids=items.map(x=>x.id);
  assert.deepEqual(selectItems(items,{view:'favorites',favorites:new Set(ids)}).map(x=>x.id).sort(),ids);
  assert.deepEqual(selectItems(items,{view:'history',history:ids}).map(x=>x.id),ids);
});
test('popular shelf starts with a listed work when the most viewed work is not found',()=>{
  const items=[
    {...item(1),availability:'not_found',views:1000},
    {...item(2),availability:'embed_available',views:10},
    {...item(3),views:5},
  ];
  assert.equal(selectItems(items,{view:'popular'})[0].id,'video:2');
});
test('a retained work reappears when its embed becomes available',()=>{
  const items=prepareItems([{...item(1),availability:'not_found'}]);
  assert.deepEqual(selectItems(items),[]);
  assert.equal(items.length,1);
  items[0].availability='embed_available';
  assert.deepEqual(selectItems(items).map(x=>x.id),['video:1']);
});
test('app category options are built from listed works',async()=>{
  const script=await readFile(new URL('../assets/app.mjs',import.meta.url),'utf8');
  assert.match(script,/categories=.*items\.filter\(isListed\)\.flatMap\(x=>x\.categories\)/);
});

const previewData={type:'images',source:'official_thumbnail_rotation',baseUrl:'https://cdn.tokyo-motion.net/media/videos/tmb75/1/',count:20};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function controllerHarness(load=async url=>url){
  const timers=new Map();let id=0;
  const controller=new PreviewController({load,schedule:(fn,ms)=>{timers.set(++id,{fn,ms});return id},cancel:key=>timers.delete(key)});
  async function advance(){const task=[...timers].find(([,x])=>x.ms===700);assert.ok(task,'next frame is scheduled');timers.delete(task[0]);task[1].fn();await tick()}
  return {controller,timers,advance};
}
test('client accepts only declared frames of the same work',()=>{
  assert.equal(previewSpec({...item(1),preview:previewData}).urls.length,20);
  for(const patch of [{videoId:'2'},{availability:'unavailable'},{preview:{...previewData,count:99}},{preview:{...previewData,baseUrl:'https://example.com/media/videos/tmb75/1/'}}])assert.equal(previewSpec({...item(1),preview:previewData,...patch}),null);
});
test('browser timer functions are called without a controller receiver',async()=>{
  let schedules=0,cancels=0;
  const c=new PreviewController({load:async()=>{},schedule:function(){assert.equal(this,undefined);schedules++;return 1},cancel:function(){assert.equal(this,undefined);cancels++}});
  c.toggle('one',{urls:['one','two'],interval:700},{});await tick();c.pause();c.stop();assert.ok(schedules>=2);assert.ok(cancels>=2);
});
test('tap starts, next tap freezes, next tap resumes without a close control',async()=>{
  const {controller:c,timers,advance}=controllerHarness();let frame='',status='';
  const spec=previewSpec({...item(1),preview:previewData}),handlers={onFrame:u=>frame=u,onState:s=>status=s};
  assert.equal(timers.size,0);
  c.toggle('one',spec,handlers);await tick();assert.equal(status,'playing');assert.match(frame,/1\.jpg$/);
  await advance();assert.match(frame,/2\.jpg$/);
  c.toggle('one',spec,handlers);assert.equal(status,'paused');assert.equal(timers.size,0);const frozen=frame;
  await tick();assert.equal(frame,frozen);
  c.toggle('one',spec,handlers);await tick();assert.match(frame,/3\.jpg$/);assert.equal(status,'playing');c.stop();assert.equal(timers.size,0);
});
test('switching cards cancels in-flight load and stale frames cannot update either card',async()=>{
  const pending=[];const {controller:c}=controllerHarness((url,signal)=>new Promise(resolve=>pending.push({resolve,signal})));
  let first=0,second=0,resets=0;const spec={urls:['one','two'],interval:700};
  c.toggle('one',spec,{onFrame:()=>first++,onReset:()=>resets++});
  c.toggle('two',spec,{onFrame:()=>second++});
  assert.equal(pending[0].signal.aborted,true);assert.equal(resets,1);
  pending[0].resolve();pending[1].resolve();await tick();assert.equal(first,0);assert.equal(second,1);c.stop();
});
test('pause during a network request ignores its later completion',async()=>{
  let resolve,frames=0;const {controller:c,timers}=controllerHarness(()=>new Promise(r=>resolve=r));
  c.toggle('one',{urls:['one','two'],interval:700},{onFrame:()=>frames++});c.pause();resolve();await tick();assert.equal(frames,0);assert.equal(timers.size,0);
});
test('failed preview images stop after three failures and do not retry forever',async()=>{
  const {controller:c,timers,advance}=controllerHarness(async()=>{throw Error('unavailable')});let status='';
  c.toggle('one',{urls:['one','two','three','four'],interval:700},{onState:s=>status=s});await tick();await advance();await advance();
  assert.equal(status,'error');assert.equal(c.active.playing,false);assert.equal(timers.size,0);c.stop();
});
test('archive preview audit resumes separately and updates only previously collected works',async()=>{
  const initial={items:[{...item(193),statsVersion:2,previewVersion:1,ratingVersion:1,detailCheckedAt:new Date(NOW).toISOString()}],backfill:{nextPage:10,complete:true}};
  const source=async u=>(await mockSource(u)).replace('<img src=',u.includes('page=7')?'<img id="rotate_193_20_1_recent" src=':'<img src=').replace('https://cdn.tokyo-motion.net/193.jpg','https://cdn.tokyo-motion.net/media/videos/tmb75/193/1.jpg');
  const result=await updateCatalog(initial,{getText:source,now:NOW,delayMs:0,detailLimit:0,backfillPages:0,recentPages:1,maxRecentPages:1,previewAuditPages:7});
  assert.equal(result.items.find(x=>x.videoId==='193').preview.count,20);assert.equal(result.previewAudit.nextPage,9);assert.equal(result.backfill.nextPage,10);
  assert.ok(!result.items.some(x=>x.videoId==='195'));
  const again=await updateCatalog(result,{getText:source,now:NOW,delayMs:0,detailLimit:0,backfillPages:0,recentPages:1,maxRecentPages:1,previewAuditPages:7});
  assert.equal(again.previewAudit.complete,true);assert.equal(again.previewAudit.nextPage,10);
});
test('preview audit failure retains its page cursor',async()=>{
  const previous={items:[item(1)],backfill:{nextPage:10,complete:true}};
  const result=await updateCatalog(previous,{getText:u=>u.includes('page=7')?Promise.reject(Error('timeout')):mockSource(u),now:NOW,delayMs:0,detailLimit:0,backfillPages:0});
  assert.equal(result.previewAudit.nextPage,7);assert.ok(result.errors.some(x=>x.stage==='preview_audit'));
});

async function uiHarness(){
  class Element{
    constructor(tag='div'){this.tag=tag;this.children=[];this.listeners={};this.dataset={};this.attributes={};this.value='';this.isConnected=true;this.hidden=false;this.open=false;const classes=new Set();this.classList={add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x),toggle:(x,on)=>on?classes.add(x):classes.delete(x)}}
    set innerHTML(value){this.html=value;this.replaceChildren()}
    get innerHTML(){return this.html||''}
    append(...nodes){for(const node of nodes){this.children.push(node);node.parent=this}}
    replaceChildren(...nodes){for(const child of this.children){child.parent=null;child.removed=true}this.children=[];this.append(...nodes)}
    setAttribute(key,value){this.attributes[key]=value}
    addEventListener(key,fn){this.listeners[key]=fn}
    focus(){this.focused=true}
    showModal(){this.open=true}
    close(){this.open=false;this.listeners.close?.()}
    insertAdjacentHTML(position,html){this.inserted=html}
    querySelectorAll(){return []}
    querySelector(selector){return ({'.media':this.media,'[data-preview]':this.button,'img':this.image,'.preview-indicator':this.indicator})[selector]||new Element('button')}
  }
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]));
  const nodes=new Map(),events={};const get=id=>{assert.ok(ids.has(id),`Missing DOM element: ${id}`);if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id)};get('sort').value='new';
  class TestController extends PreviewController{constructor(){super({load:async()=>{},schedule:()=>1,cancel(){}})}}
  const ctx=vm.createContext({document:{getElementById:get,createElement:tag=>new Element(tag),querySelectorAll:()=>[],addEventListener:(key,fn)=>events[key]=fn},window:{scrollY:123,scrollTo(){},addEventListener(){}},localStorage:{getItem:()=>'{invalid',setItem(){}},sessionStorage:{getItem:()=>null,setItem(){}},URL,Map,Set,Date,setTimeout:()=>1,clearTimeout(){},PAGE_SIZE,esc:escapeHTML,safeUrl,stats,prepareItems,isListed,selectItems,catalogInfo,visitBaseline,isNewSince,PreviewController:TestController,previewSpec});
  const script=(await readFile(new URL('../assets/app.mjs',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/load\(\);\s*$/,'');vm.runInContext(script,ctx);
  const samples=[{...item(1),image:previewData.baseUrl+'default.jpg',preview:previewData,embedUrl:`${SOURCE}/embed/example1`,statsVersion:2,views:1234,likes:12,dislikes:3},{...item(2),preview:{...previewData,baseUrl:previewData.baseUrl.replace('/1/','/2/')},embedUrl:`${SOURCE}/embed/example2`}];ctx.samples=samples;vm.runInContext('state.items=samples;state.byId=new Map(samples.map(x=>[x.id,x]));',ctx);
  function makeCard(id){const card=new Element('article');card.dataset.id='video:'+id;card.dataset.card='grid:video:'+id;card.media=new Element();card.button=new Element('button');card.button.image=new Element('img');card.button.image.src=previewData.baseUrl+'default.jpg';card.button.indicator=new Element();card.append(card.media);return card}
  return {ctx,makeCard,nodes,events};
}
test('card contains visible views, rating, vote counts and separate preview/detail/play actions',async()=>{
  const {ctx}=await uiHarness();const html=vm.runInContext('card(samples[0],"grid")',ctx);
  assert.match(html,/1,234回再生/);assert.match(html,/高評価 80%/);assert.match(html,/高評価 12 \/ 低評価 3/);assert.match(html,/data-preview/);assert.match(html,/data-detail/);assert.match(html,/data-watch/);assert.ok(!html.includes('<iframe'));
});
test('tap toggles the card preview and appending more cards preserves it',async()=>{
  const {ctx,makeCard,nodes}=await uiHarness();ctx.firstCard=makeCard(1);
  vm.runInContext('togglePreview(firstCard);state.shown=1;',ctx);await tick();
  assert.equal(ctx.firstCard.button.dataset.state,'playing');
  vm.runInContext('render({append:true})',ctx);assert.equal(ctx.firstCard.button.dataset.state,'playing');assert.match(nodes.get('grid').inserted,/grid:video:1/);
  vm.runInContext('togglePreview(firstCard)',ctx);assert.equal(ctx.firstCard.button.dataset.state,'paused');assert.equal(ctx.firstCard.button.attributes['aria-pressed'],'false');
});
test('detail view stops preview and full player is mounted only in the watch view',async()=>{
  const {ctx,makeCard,nodes}=await uiHarness();ctx.firstCard=makeCard(1);
  vm.runInContext('togglePreview(firstCard)',ctx);await tick();
  vm.runInContext('openDetails(samples[0],firstCard.button)',ctx);assert.equal(nodes.get('details').open,true);assert.equal(vm.runInContext('previews.active',ctx),null);
  vm.runInContext('openWatch(samples[0],firstCard.button)',ctx);assert.equal(nodes.get('details').open,false);assert.equal(nodes.get('browse-view').hidden,true);
  const frame=nodes.get('watch-media').children[0];assert.equal(frame.src,`${SOURCE}/embed/example1`);assert.equal(frame.parent,nodes.get('watch-media'));
  vm.runInContext('showBrowse()',ctx);assert.equal(frame.removed,true);assert.equal(nodes.get('browse-view').hidden,false);assert.equal(nodes.get('watch-view').hidden,true);
});
test('unavailable work never starts preview or mounts a full player',async()=>{
  const {ctx,makeCard,nodes}=await uiHarness();ctx.firstCard=makeCard(1);
  vm.runInContext('samples[0].availability="unavailable";togglePreview(firstCard);openWatch(samples[0],firstCard.button)',ctx);
  assert.equal(vm.runInContext('previews.active',ctx),null);assert.equal(nodes.get('watch-media'),undefined);assert.equal(ctx.firstCard.button.indicator.textContent,'プレビュー素材なし');
});
test('backgrounding the page pauses rather than continuing preview requests',async()=>{
  const {ctx,makeCard,events}=await uiHarness();ctx.firstCard=makeCard(1);vm.runInContext('togglePreview(firstCard)',ctx);await tick();ctx.document.hidden=true;events.visibilitychange();assert.equal(ctx.firstCard.button.dataset.state,'paused');
});

test('content policy handles explicit label variants and every metadata field',()=>{
  for(const label of ['FC2PPV-1234567','ＦＣ２－ＰＰＶ－１２３４５６７','f c 2 p p v 1234567','fc2_1234567','FC2\u200b-PPV','FC2&#45;PPV']) {
    for(const field of ['title','description','categories','tags']) {
      assert.deepEqual(contentExclusionReasons({[field]:['categories','tags'].includes(field)?[label]:label}),['fc2ppv'],`${field}: ${label}`);
    }
  }
  for(const title of ['男の娘のテスト','男 ノ 娘','おとこの娘','オトコノ娘','otokonoko','Otoko-no-ko','FEMBOY','femboys'])assert.deepEqual(contentExclusionReasons({title}),['otokonoko'],title);
  assert.deepEqual(contentExclusionReasons({title:'FC2-PPV 男の娘のテスト'}),['fc2ppv','otokonoko']);
});
test('content policy does not guess genre or combine separate fields into a label',()=>{
  for(const title of ['男の子のテスト','女の子のテスト','女装のテスト','FC2ブログの説明','FC2 ライブの説明','FC2 18 のテスト','テストのPPV','ABCFC2PPVXYZ'])assert.deepEqual(contentExclusionReasons({title}),[],title);
  assert.deepEqual(contentExclusionReasons({title:'FC2',description:'PPV'}),[]);
  assert.deepEqual(contentExclusionReasons({image:'https://example.com/femboy.jpg'}),[]);
});
test('audit rejects every duplicate of a blocked ID and retains only ID and reason',()=>{
  const result=auditContent([{...item(1),title:'FC2-PPV テスト'},item(1),item(2)]);
  assert.deepEqual(result.accepted.map(x=>x.videoId),['2']);
  assert.deepEqual(result.excludedItems,[{videoId:'1',reasons:['fc2ppv']}]);
  assert.equal(result.rejected.length,1);
  assert.equal(auditContent([item(1)],result.excludedItems).accepted.length,0);
});
test('offline cleanup preserves permitted works, counters, collection time and all crawl cursors',()=>{
  const keep={...item(1),date:NOW,views:234,likes:9,dislikes:2,preview:previewData};
  const previous={updatedAt:'2026-10-01T00:00:00Z',backfill:{nextPage:65},previewAudit:{nextPage:20},summary:{newItems:3,rssItems:20},items:[keep,{...item(2),title:'FC2-PPV テスト'},{...item(3),categories:['男の娘']},{...item(4),description:'男の娘 FC2-PPV のテスト'}]};
  const snapshot=structuredClone(previous),result=pruneCatalog(previous,NOW);
  assert.deepEqual(previous,snapshot);assert.deepEqual(result.items,[keep]);
  for(const key of ['updatedAt','backfill','previewAudit'])assert.deepEqual(result[key],previous[key]);
  assert.equal(result.summary.total,1);assert.equal(result.summary.withViews,1);assert.equal(result.summary.newItems,0);
  assert.equal(result.contentPolicy.removedExisting,3);assert.deepEqual(result.contentPolicy.lastRemoval.reasons,{fc2ppv:2,otokonoko:2});
  const again=pruneCatalog(result,NOW+1000);
  assert.deepEqual(again.items,result.items);assert.equal(again.contentPolicy.removedExisting,0);assert.equal(again.contentPolicy.removedExistingTotal,3);assert.deepEqual(again.contentPolicy.lastRemoval,result.contentPolicy.lastRemoval);
});
test('prune-only removes existing English titles and records language policy without changing Japanese works',()=>{
  const keep={...item(1),views:234},previous={languagePolicy:{removedExistingTotal:4},summary:{rssItems:20},items:[keep,{...item(2),title:'English sample video'}]},snapshot=structuredClone(previous);
  const result=pruneCatalog(previous,NOW);
  assert.deepEqual(previous,snapshot);assert.deepEqual(result.items,[keep]);assert.equal(result.summary.total,1);assert.equal(result.summary.withViews,1);assert.equal(result.summary.rssItems,20);
  assert.deepEqual(result.languagePolicy,{version:LANGUAGE_POLICY_VERSION,mode:'japanese_titles_only',auditedAt:new Date(NOW).toISOString(),excludedThisRun:1,removedExisting:1,removedExistingTotal:5,reasons:{english_title:1}});
  const again=pruneCatalog(result,NOW+1000);
  assert.deepEqual(again.items,[keep]);assert.equal(again.languagePolicy.removedExisting,0);assert.equal(again.languagePolicy.excludedThisRun,0);assert.equal(again.languagePolicy.removedExistingTotal,5);assert.deepEqual(again.languagePolicy.reasons,{});
});
test('old, new, archive and renamed works are blocked before any detail request',async()=>{
  const requests=[],previous={items:[{...item(1),title:'FC2-PPV テスト'}]};
  const getText=async u=>{
    requests.push(u);
    if(u===RSS_URL)return rss(1);
    if(u===SOURCE)return listing(202).replaceAll('テスト作品 202','男の娘のテスト');
    if(u.includes('/page='))return listing(203,0).replaceAll('テスト作品 203','ＦＣ２－ＰＰＶ テスト');
    throw new Error('blocked details must not be requested');
  };
  const result=await updateCatalog(previous,{getText,now:NOW,delayMs:0,recentPages:1,backfillPages:1,previewAuditPages:0});
  assert.equal(result.items.length,0);assert.ok(!requests.some(u=>u.includes('/video/')));
  assert.equal(result.contentPolicy.removedExisting,1);assert.equal(result.contentPolicy.excludedItems.length,3);
  const second=await updateCatalog(result,{getText:async u=>u===RSS_URL?rss(1):listing(202,0),now:NOW+1000,delayMs:0,recentPages:1,backfillPages:0,previewAuditPages:0,detailLimit:0});
  assert.equal(second.items.length,0);assert.equal(second.contentPolicy.removedExistingTotal,1);
});
test('raw RSS and detail descriptions are checked before Japanese-only display cleanup',async()=>{
  const feed=parseFeed(rss().replace('</item>','<description>FC2-PPV</description></item>'));
  assert.deepEqual(contentExclusionReasons(feed[0]),['fc2ppv']);
  const html=detail()+'<meta property="og:description" content="femboy">';
  const parsed=parseDetail(html,NOW,'201');
  assert.equal(parsed.description,'');assert.deepEqual(contentExclusionReasons(parsed),['otokonoko']);
  const result=await updateCatalog({items:[]},{getText:async u=>u.includes('/video/')?html:mockSource(u),now:NOW,delayMs:0,recentPages:1,backfillPages:0,previewAuditPages:0});
  assert.equal(result.items.length,0);assert.equal(result.contentPolicy.excludedItems.length,2);
});
test('new labels discovered during preview audit also remove the existing entry before details',async()=>{
  const requests=[],previous={items:[item(1)],backfill:{nextPage:9,complete:true},previewAudit:{version:PREVIEW_VERSION,nextPage:7,endPage:8,complete:false}};
  const result=await updateCatalog(previous,{getText:async u=>{requests.push(u);return u.includes('page=7')?listing(1,8).replaceAll('テスト作品 1','男の娘のテスト'):mockSource(u)},now:NOW,delayMs:0,recentPages:1,backfillPages:0,previewAuditPages:1});
  assert.ok(!result.items.some(x=>x.videoId==='1'));assert.ok(!requests.includes(url(1)));assert.equal(result.contentPolicy.removedExisting,1);
});
test('client removes stale blocked data from every browse mode including favorites and history',()=>{
  const items=prepareItems([item(1),{...item(2),title:'FC2-PPV テスト'},{...item(3),tags:['男の娘']},item(4)],[{videoId:'4',reasons:['fc2ppv']}]);
  assert.deepEqual(items.map(x=>x.videoId),['1']);
  for(const view of ['home','recent','popular','rated','archive','favorites','history'])assert.deepEqual(selectItems(items,{view,favorites:new Set(['video:1','video:2','video:3','video:4']),history:['video:4','video:3','video:2','video:1']}).map(x=>x.videoId),['1']);
});
test('home intro and CTA are gone and home rendering has no missing DOM reference',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  for(const text of ['あなたのカタログ','気になったら、タップ。','サムネで画像プレビュー。もう一度タップで停止。','タイトルから詳細、本編は大きなプレイヤーで。','新着をチェック','id="hero"','id="browse-new"'])assert.ok(!html.includes(text),text);
  const {ctx,nodes}=await uiHarness();vm.runInContext('render()',ctx);
  assert.equal(nodes.get('shelf-section').hidden,false);assert.match(nodes.get('grid').innerHTML,/grid:video:1/);
});
test('load applies tombstones and safely closes any removed detail or watch view',async()=>{
  const {ctx,nodes}=await uiHarness();
  vm.runInContext('openDetails(samples[0]);openWatch(samples[0]);',ctx);
  ctx.fetch=async()=>({ok:true,json:async()=>({items:[item(1),item(2)],contentPolicy:{excludedItems:[{videoId:'1',reasons:['fc2ppv']}]} })});
  await vm.runInContext('load()',ctx);
  assert.equal(vm.runInContext('state.byId.has("video:1")',ctx),false);assert.equal(vm.runInContext('state.watch',ctx),null);
  assert.equal(nodes.get('watch-view').hidden,true);assert.equal(nodes.get('browse-view').hidden,false);
});

test('load revalidates the stable catalog URL with a timeout and supports older browsers',async()=>{
  for(const support of ['timeout','missing timeout','missing AbortSignal']){
    const {ctx,nodes}=await uiHarness();const signal={};let duration,request;
    if(support==='timeout')ctx.AbortSignal={timeout:ms=>{duration=ms;return signal}};
    else if(support==='missing timeout')ctx.AbortSignal={};
    ctx.fetch=async(url,options)=>{request={url,options};return {ok:true,json:async()=>({items:[item(1)]})}};
    await vm.runInContext('load()',ctx);
    assert.equal(request.url,'data/videos.json');assert.equal(request.url.includes('ts='),false);assert.equal(request.options.cache,'no-cache');
    if(support==='timeout'){assert.equal(duration,30000);assert.equal(request.options.signal,signal)}else assert.equal('signal' in request.options,false);
    assert.equal(nodes.get('refresh').disabled,false);assert.equal(vm.runInContext('state.loading',ctx),false);
  }
});
test('load falls back to AbortController and clears its timer after success or timeout',async()=>{
  for(const support of ['missing timeout','missing AbortSignal'])for(const timeout of [false,true]){
    const {ctx,nodes}=await uiHarness();vm.runInContext('showCatalog({items:samples},false)',ctx);
    const previous=vm.runInContext('({data:state.data,items:state.items,byId:state.byId})',ctx),html=nodes.get('grid').innerHTML;
    const signal={aborted:false},timer={};let fire,duration,cleared,request,abort,complete;
    if(support==='missing timeout')ctx.AbortSignal={};
    ctx.AbortController=class{constructor(){this.signal=signal}abort(){signal.aborted=true;abort?.()}};
    ctx.setTimeout=(fn,ms)=>{fire=fn;duration=ms;return timer};ctx.clearTimeout=id=>{cleared=id};
    // Hold the refresh response until loading is asserted.
    ctx.fetch=(url,options)=>{
      request={url,options};
      return new Promise((resolve,reject)=>{
        abort=()=>{const error=new Error('aborted');error.name='AbortError';reject(error)};
        complete=()=>resolve({ok:true,json:async()=>({items:[item(1)]})});
      });
    };
    const pending=vm.runInContext('load()',ctx);
    await tick();
    assert.equal(request.options.signal,signal);assert.equal(duration,30000);assert.equal(nodes.get('refresh').disabled,true);
    if(timeout){fire();assert.equal(signal.aborted,true)}else complete();
    await pending;
    assert.equal(cleared,timer);assert.equal(nodes.get('refresh').disabled,false);assert.equal(vm.runInContext('state.loading',ctx),false);
    if(timeout){
      for(const key of ['data','items','byId'])assert.equal(vm.runInContext('state.'+key,ctx),previous[key]);
      assert.equal(nodes.get('grid').innerHTML,html);assert.equal(nodes.get('notice').hidden,false);assert.equal(nodes.get('notice').textContent,'一覧の取得がタイムアウトしました');
    }else assert.equal(signal.aborted,false);
  }
});
test('load preserves all catalog state and previews when category preparation fails',async()=>{
  const {ctx,nodes,makeCard}=await uiHarness();ctx.firstCard=makeCard(1);
  vm.runInContext('showCatalog({items:samples},false);togglePreview(firstCard)',ctx);await tick();
  const previous=vm.runInContext('({data:state.data,items:state.items,byId:state.byId,active:previews.active})',ctx),html=nodes.get('grid').innerHTML;
  ctx.fetch=async()=>({ok:true,json:async()=>({items:[{...item(3),categories:['test',42]}]})});
  await vm.runInContext('load()',ctx);
  for(const key of ['data','items','byId'])assert.equal(vm.runInContext('state.'+key,ctx),previous[key]);
  assert.equal(vm.runInContext('previews.active',ctx),previous.active);assert.equal(nodes.get('grid').innerHTML,html);
  assert.equal(nodes.get('notice').hidden,false);assert.match(nodes.get('notice').textContent,/localeCompare/);assert.equal(nodes.get('refresh').disabled,false);assert.equal(vm.runInContext('state.loading',ctx),false);
});
test('load preserves the old catalog and restores refresh after AbortError or TimeoutError',async()=>{
  for(const name of ['AbortError','TimeoutError']){
    const {ctx,nodes}=await uiHarness();vm.runInContext('showCatalog({items:samples},false)',ctx);
    const previous=vm.runInContext('({data:state.data,items:state.items,byId:state.byId})',ctx),html=nodes.get('grid').innerHTML;
    ctx.fetch=async()=>{const error=new Error('aborted');error.name=name;throw error};
    await vm.runInContext('load()',ctx);
    for(const key of ['data','items','byId'])assert.equal(vm.runInContext('state.'+key,ctx),previous[key]);
    assert.equal(nodes.get('grid').innerHTML,html);assert.equal(nodes.get('notice').hidden,false);assert.equal(nodes.get('notice').textContent,'一覧の取得がタイムアウトしました');
    assert.equal(nodes.get('refresh').disabled,false);assert.equal(vm.runInContext('state.loading',ctx),false);
  }
});

test('assessRun classifies clean, partial, blocked and all-detail failures',()=>{
  assert.deepEqual(assessRun({}),{level:'ok',counts:{},messages:[]});
  const assess=(errors,summary={recentPagesOk:1,detailAttempted:0})=>assessRun({errors,summary});
  assert.equal(assess([{stage:'rss',reason:'rss_empty_or_changed'}]).level,'degraded');
  assert.equal(assess([{stage:'recent',reason:'changed'}],{recentPagesOk:0}).level,'severe');
  for(const reason of ['HTTP_401','HTTP_403','HTTP_429','source_access_unavailable'])assert.equal(assess([{stage:'backfill',reason}]).level,'severe');
  assert.equal(assess([{stage:'detail',reason:'timeout'}],{recentPagesOk:1,detailAttempted:1}).level,'severe');
  assert.equal(assess([{stage:'detail',reason:'HTTP_404'}],{recentPagesOk:1,detailAttempted:1}).level,'degraded');
  assert.equal(assess([{stage:'detail',reason:'timeout'}],{recentPagesOk:1,detailAttempted:2}).level,'degraded');
});
test('RSS success with recent 429 is severe and records actual requests',async()=>{
  const result=await updateCatalog({}, {getText:async source=>{if(source===RSS_URL)return rss();throw Object.assign(new Error('HTTP_429'),{status:429})},now:NOW,recentPages:2,backfillPages:0,previewAuditPages:0,delayMs:0});
  assert.equal(result.summary.rssItems,1);assert.equal(result.summary.recentPagesOk,0);assert.equal(result.summary.detailAttempted,0);
  assert.equal(assessRun(result).level,'severe');assert.equal(assessRun(result).counts.recent,1);
});
test('validateForSave accepts valid catalogs and rejects schema violations even with allowShrink',()=>{
  const valid={schemaVersion:SCHEMA_VERSION,items:[item(1)]},snapshot=structuredClone(valid);
  assert.deepEqual(validateForSave(valid,{}),{ok:true});assert.deepEqual(valid,snapshot);
  for(const result of [null,{}, {...valid,schemaVersion:SCHEMA_VERSION+1},{...valid,items:{}},{...valid,items:[null]},{...valid,items:[{videoId:'1'}]},{...valid,items:[{sourceUrl:url(1)}]}]){
    const validation=validateForSave(result,{}, {allowShrink:true});assert.equal(validation.ok,false);assert.ok(validation.reason);
  }
});
test('validateForSave guards large drops with strict boundaries and configurable thresholds',()=>{
  const catalog=count=>({schemaVersion:SCHEMA_VERSION,items:Array.from({length:count},(_,i)=>item(i+1))}),previous=catalog(200),current=catalog(90);
  const validation=validateForSave(current,previous);assert.equal(validation.ok,false);assert.match(validation.reason,/previous=200, current=90/);
  assert.deepEqual(validateForSave(current,previous,{allowShrink:true}),{ok:true});
  assert.deepEqual(validateForSave(catalog(0),catalog(50)),{ok:true});
  assert.deepEqual(validateForSave(catalog(100),previous),{ok:true});
  assert.equal(validateForSave(catalog(49),catalog(100)).ok,false);
  assert.deepEqual(validateForSave(current,previous,{minPrevious:201}),{ok:true});
  assert.deepEqual(validateForSave(current,previous,{maxDropRatio:0.6}),{ok:true});
});
test('runMain refuses unsafe saves without changing existing bytes and allows explicit shrink only',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'catalog-save-'));
  try {
    const output=join(dir,'videos.json'),previous={schemaVersion:SCHEMA_VERSION,items:Array.from({length:200},(_,i)=>item(i+1))},before=JSON.stringify(previous),shrunk={...previous,items:previous.items.slice(0,90)};
    for(const argv of [[],['--prune-only'],['--allow-shrink'],['--prune-only','--allow-shrink']]){
      const result=argv.includes('--allow-shrink')?{...shrunk,schemaVersion:0}:shrunk,logs=[];
      await writeFile(output,before);
      assert.equal(await runMain({argv,output,update:async()=>result,prune:()=>result,log:x=>logs.push(x),env:{}}),1);
      assert.equal(await readFile(output,'utf8'),before);assert.ok(logs.some(x=>x.startsWith('::error title=Catalog save refused::')));
    }
    for(const argv of [['--allow-shrink'],['--prune-only','--allow-shrink']]){
      await writeFile(output,before);
      assert.equal(await runMain({argv,output,update:async()=>shrunk,prune:()=>shrunk,log:()=>{},env:{}}),0);
      assert.deepEqual(JSON.parse(await readFile(output,'utf8')),shrunk);
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('runMain prune-only saves the previous schema version unchanged',async()=>{
  const dir=await mkdtemp(join(process.cwd(),'.hq-L1-prune-'));
  try {
    const output=join(dir,'videos.json'),previous={schemaVersion:SCHEMA_VERSION-1,items:[item(1)]};
    await writeFile(output,JSON.stringify(previous));
    assert.equal(await runMain({argv:['--prune-only'],output,log:()=>{},env:{}}),0);
    const saved=JSON.parse(await readFile(output,'utf8'));assert.equal(saved.schemaVersion,previous.schemaVersion);assert.deepEqual(saved.items,previous.items);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('runMain prune-only saves an empty catalog when the file is missing',async()=>{
  const dir=await mkdtemp(join(process.cwd(),'.hq-L1-missing-'));
  try {
    const output=join(dir,'videos.json');
    assert.equal(await runMain({argv:['--prune-only'],output,log:()=>{},env:{}}),0);
    const saved=JSON.parse(await readFile(output,'utf8'));assert.equal(Object.hasOwn(saved,'schemaVersion'),false);assert.deepEqual(saved.items,[]);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('runMain normal updates reject results with a previous schema version',async()=>{
  const dir=await mkdtemp(join(process.cwd(),'.hq-L1-schema-'));
  try {
    const output=join(dir,'videos.json'),previous={schemaVersion:SCHEMA_VERSION-1,items:[item(1)]},before=JSON.stringify(previous),logs=[];
    await writeFile(output,before);
    assert.equal(await runMain({argv:[],output,update:async()=>previous,log:x=>logs.push(x),env:{}}),1);
    assert.equal(await readFile(output,'utf8'),before);assert.ok(logs.some(x=>x.includes('Invalid schemaVersion')));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('runMain saves partial and strict severe results, appends summary and preserves file on throw',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'catalog-main-'));
  try {
    const output=join(dir,'nested','videos.json'),summary=join(dir,'summary.md'),logs=[];
    const partial={schemaVersion:SCHEMA_VERSION,items:[],summary:{recentPagesOk:1},errors:[{stage:'detail',reason:'timeout'}]};
    await writeFile(summary,'existing summary\n');
    assert.equal(await runMain({argv:[],output,update:async()=>partial,log:x=>logs.push(x),env:{GITHUB_STEP_SUMMARY:summary}}),0);
    assert.deepEqual(JSON.parse(await readFile(output,'utf8')),partial);assert.ok(logs.some(x=>x.startsWith('::warning title=Catalog partially failed::detail=1')));
    assert.match(await readFile(summary,'utf8'),/^existing summary\n[\s\S]*\| degraded \| detail=1 \|/);
    const warned={schemaVersion:SCHEMA_VERSION,items:[],errors:[],warnings:[{stage:'schedule',reason:'run_gap',minutes:240}]};
    assert.equal(await runMain({argv:[],output,update:async()=>warned,log:x=>logs.push(x),env:{}}),0);
    assert.ok(logs.some(x=>x.startsWith('::warning title=Catalog partially failed::')&&x.includes('run_gap')));
    const severe={...partial,summary:{recentPagesOk:0}};
    assert.equal(await runMain({argv:['--strict'],output:new URL(`file://${output}`),update:async()=>severe,log:x=>logs.push(x),env:{}}),2);
    assert.deepEqual(JSON.parse(await readFile(output,'utf8')),severe);assert.ok(logs.some(x=>x.startsWith('::error title=Catalog collection degraded::')));
    const before=await readFile(output,'utf8');
    assert.equal(await runMain({argv:[],output,update:async()=>{throw new Error('all failed')},log:()=>{},env:{}}),1);
    assert.equal(await readFile(output,'utf8'),before);
    assert.equal(await runMain({argv:['--prune-only','--strict'],output,prune:()=>({schemaVersion:SCHEMA_VERSION,items:[]}),update:()=>{throw new Error('unexpected update')},log:()=>{},env:{}}),0);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('recent discovery extends to previous newest on page 8 and compares IDs numerically',async()=>{
  const pages=[];
  const getText=async source=>{if(source===RSS_URL)return rss();const page=source===SOURCE?1:Number(source.match(/page=(\d+)/)[1]);pages.push(page);return listing(108-page,page+1)};
  const result=await updateCatalog({items:[item(99),item(100)]},{getText,now:NOW,delayMs:0,recentPages:2,backfillPages:0,previewAuditPages:0,detailLimit:0});
  assert.deepEqual(pages,[1,2,3,4,5,6,7,8]);assert.equal(result.summary.previousNewestId,100);assert.equal(result.summary.recentPagesFetched,8);assert.equal(result.summary.reachedPreviousNewest,true);assert.deepEqual(result.warnings,[]);assert.equal(result.collection.maxRecentPages,30);
});
test('recent discovery cap warns and degrades without collection errors',async()=>{
  const result=await updateCatalog({items:[item(1)]},{getText:async source=>source===RSS_URL?rss():listing(200,source===SOURCE?2:Number(source.match(/page=(\d+)/)[1])+1),now:NOW,delayMs:0,recentPages:2,maxRecentPages:4,backfillPages:0,previewAuditPages:0,detailLimit:0});
  assert.equal(result.summary.recentPagesFetched,4);assert.equal(result.summary.reachedPreviousNewest,false);assert.deepEqual(result.errors,[]);assert.deepEqual(result.warnings,[{stage:'recent_gap',reason:'previous_newest_not_reached',pages:4}]);assert.equal(assessRun(result).level,'degraded');assert.match(assessRun(result).messages.join(),/previous_newest_not_reached/);
});
test('recent discovery without previous items uses minimum pages and null reach status',async()=>{
  const result=await updateCatalog({},{getText:mockSource,now:NOW,delayMs:0,recentPages:2,backfillPages:0,previewAuditPages:0,detailLimit:0});
  assert.equal(result.summary.recentPagesFetched,2);assert.equal(result.summary.previousNewestId,null);assert.equal(result.summary.reachedPreviousNewest,null);assert.equal(result.summary.minutesSinceLastRun,null);assert.deepEqual(result.warnings,[]);
});
test('four hour run gap records 240 minutes and degrades',async()=>{
  const result=await updateCatalog({updatedAt:new Date(NOW-240*60000).toISOString()},{getText:mockSource,now:NOW,delayMs:0,recentPages:2,backfillPages:0,previewAuditPages:0,detailLimit:0});
  assert.equal(result.summary.minutesSinceLastRun,240);assert.deepEqual(result.warnings,[{stage:'schedule',reason:'run_gap',minutes:240}]);assert.equal(assessRun(result).level,'degraded');
});
test('recent discovery preserves minimum after reaching ID and stops extension at end or failure',async()=>{
  for(const mode of ['reached','end','failure']){
    const pages=[];
    const result=await updateCatalog({items:[item(100)]},{getText:async source=>{if(source===RSS_URL)return rss();const page=source===SOURCE?1:Number(source.match(/page=(\d+)/)[1]);pages.push(page);if(mode==='failure'&&page===3)throw Error('timeout');return listing(mode==='reached'?100:200,mode==='end'?0:page+1)},now:NOW,delayMs:0,recentPages:2,backfillPages:0,previewAuditPages:0,detailLimit:0});
    assert.deepEqual(pages,mode==='failure'?[1,2,3]:[1,2]);assert.equal(result.summary.reachedPreviousNewest,mode==='reached');assert.deepEqual(result.warnings,mode==='reached'?[]:[{stage:'recent_gap',reason:'previous_newest_not_reached',pages:pages.length}]);if(mode==='failure')assert.equal(result.errors[0].stage,'recent');
  }
});

test('detail failure backoff releases the 241st expired work on the second run',async()=>{
  const checked=new Date(NOW-48*3600000).toISOString();
  const previous={schemaVersion:SCHEMA_VERSION,items:Array.from({length:241},(_,i)=>({...item(i+1),statsVersion:SCHEMA_VERSION,ratingVersion:RATING_VERSION,previewVersion:PREVIEW_VERSION,detailCheckedAt:checked}))};
  const requests=[];const options={now:NOW,delayMs:0,detailLimit:240,recentPages:1,maxRecentPages:1,backfillPages:0,previewAuditPages:0,getText:async u=>{
    if(u===RSS_URL)return rss(1);if(!u.includes('/video/'))return listing(1,0);
    requests.push(u);if(u!==url(241))throw Error('HTTP_500');return detail(241);
  }};
  const first=await updateCatalog(previous,options);assert.equal(requests.length,240);assert.ok(!requests.includes(url(241)));
  const failed=first.items.find(x=>x.videoId==='1');assert.equal(failed.detailFailures,1);assert.equal(failed.detailAttemptAt,new Date(NOW).toISOString());assert.equal(failed.detailCheckedAt,checked);assert.equal(failed.lastError,'HTTP_500');
  requests.length=0;await updateCatalog(first,{...options,now:NOW+1800000});assert.deepEqual(requests,[url(241)]);
});
test('detail backoff expires exponentially with a seven day cap and preserves queue ordering',()=>{
  const pending=(id,failures)=>({...item(id),detailFailures:failures,detailAttemptAt:new Date(NOW).toISOString()});
  for(const [failures,hours] of [[1,1],[2,2],[3,4],[9,168],[1000,168]]){
    const x=pending(1,failures);assert.deepEqual(detailQueue([x],NOW+hours*3600000-1),[]);assert.deepEqual(detailQueue([x],NOW+hours*3600000),[x]);
  }
  const items=[pending(9,2),pending(7,1),pending(8,1),pending(1,0)];
  assert.deepEqual(detailQueue(items,NOW+168*3600000).map(x=>x.videoId),['1','8','7','9']);
  const refresh=items.map(x=>({...x,detailCheckedAt:new Date(NOW-(Number(x.videoId)+48)*3600000).toISOString()}));
  assert.deepEqual(detailQueue(refresh,NOW+168*3600000).map(x=>x.videoId),['1','8','7','9']);
});
const queueHour=3600000;
const checkedQueueItem=(id,hours,fields={})=>({
  ...item(id),detailCheckedAt:new Date(NOW-hours*queueHour).toISOString(),
  statsVersion:SCHEMA_VERSION,ratingVersion:RATING_VERSION,previewVersion:PREVIEW_VERSION,...fields,
});

test('popular details prioritize the top twelve and honor listing and age filters',()=>{
  const ranked=Array.from({length:13},(_,i)=>checkedQueueItem(i+1,i===12?5:4,{views:100-i}));
  ranked[0].detailCheckedAt=new Date(NOW-3*queueHour).toISOString();
  const hidden=checkedQueueItem(14,6,{views:1000,availability:'not_found'});
  const nonnumeric=checkedQueueItem(15,6,{views:'1000'});
  const {queue,detailLanes}=detailQueuePlan([hidden,nonnumeric,...ranked],NOW);
  assert.deepEqual(queue,[...ranked.slice(1,12),ranked[12]]);
  assert.deepEqual(detailLanes,{pending:0,popular:12,fresh:0,rotation:0});
  const hotOnly=detailQueuePlan(ranked,NOW,240,{popularPool:12});
  assert.deepEqual(hotOnly.queue,ranked.slice(1,12));
});

test('fresh details require publication within seven days and a check over six hours old',()=>{
  const fresh=checkedQueueItem(1,7,{date:NOW-7*24*queueHour});
  const recentCheck=checkedQueueItem(2,6,{date:fresh.date});
  const oldRelease=checkedQueueItem(3,7,{date:fresh.date-1});
  const futureRelease=checkedQueueItem(4,7,{date:NOW+1});
  const unavailable=checkedQueueItem(5,7,{date:fresh.date,availability:'unavailable'});
  const {queue,detailLanes}=detailQueuePlan([recentCheck,oldRelease,futureRelease,unavailable,fresh],NOW);
  assert.equal(detailLanes.fresh,1);
  assert.equal(queue[0],fresh);
});

test('five hundred pending details leave reserved slots for popular, fresh and rotation',()=>{
  const pending=Array.from({length:500},(_,i)=>item(i+1));
  const popular=Array.from({length:36},(_,i)=>checkedQueueItem(501+i,4,{views:100-i}));
  const fresh=Array.from({length:24},(_,i)=>checkedQueueItem(537+i,7,{date:NOW-3*24*queueHour}));
  const rotation=Array.from({length:60},(_,i)=>checkedQueueItem(561+i,25,{availability:'not_found'}));
  const {queue,detailLanes}=detailQueuePlan([...pending,...popular,...fresh,...rotation],NOW,240);
  assert.equal(queue.length,240);
  assert.deepEqual(detailLanes,{pending:120,popular:36,fresh:24,rotation:60});
});

test('unused detail slots roll forward without duplicate video IDs or exceeding the limit',()=>{
  const popular=checkedQueueItem(2,30,{views:100,date:NOW-7*24*queueHour});
  const pending=checkedQueueItem(1,30,{previewVersion:0});
  const rotation=Array.from({length:20},(_,i)=>checkedQueueItem(3+i,25));
  const items=[pending,popular,{...popular},...rotation];
  const {queue,detailLanes}=detailQueuePlan(items,NOW,8);
  assert.deepEqual(detailLanes,{pending:1,popular:1,fresh:0,rotation:6});
  assert.equal(new Set(queue.map(x=>x.videoId)).size,8);
  assert.equal(queue.length,8);
  assert.deepEqual(detailQueue(items,NOW,0),[]);
});

test('an unparsable detailCheckedAt is re-queued as pending instead of dropping out of every lane',()=>{
  // Astra final check: with current versions and an invalid timestamp, no lane selected the work.
  for(const offset of [0,24*queueHour,365*24*queueHour]){
    const plan=detailQueuePlan([checkedQueueItem(1,0,{detailCheckedAt:'invalid',views:100,date:NOW})],NOW+offset,1);
    assert.deepEqual(plan.queue.map(x=>x.videoId),['1']);
    assert.equal(plan.detailLanes.pending,1);
  }
});
test('detail backoff excludes candidates from every lane',()=>{
  const backoff={detailFailures:2,detailAttemptAt:new Date(NOW-queueHour).toISOString()};
  const items=[
    {...item(1),...backoff},
    checkedQueueItem(2,4,{views:100,...backoff}),
    checkedQueueItem(3,7,{date:NOW-7*24*queueHour,...backoff}),
    checkedQueueItem(4,25,{availability:'not_found',...backoff}),
  ];
  assert.deepEqual(detailQueuePlan(items,NOW),{
    queue:[],detailLanes:{pending:0,popular:0,fresh:0,rotation:0},
  });
});

test('listing and RSS merges preserve detail failure bookkeeping',()=>{
  const old={...item(1),detailFailures:3,detailAttemptAt:new Date(NOW).toISOString()};
  const [merged]=mergeItems([old],parseListing(listing(1,0),SOURCE,NOW).items,parseFeed(rss(1)));
  assert.equal(merged.detailFailures,3);assert.equal(merged.detailAttemptAt,old.detailAttemptAt);
});
test('successful details and 404 reset consecutive detail failures',async()=>{
  for(const status of [200,404]){
    const result=await updateCatalog({schemaVersion:SCHEMA_VERSION,items:[{...item(1),detailFailures:2,detailAttemptAt:new Date(NOW-3*3600000).toISOString()}]},{getText:async u=>{
      if(u===RSS_URL)return rss(1);if(!u.includes('/video/'))return listing(1,0);
      if(status===404)throw Object.assign(Error('HTTP_404'),{status});return detail(1);
    },now:NOW,delayMs:0,recentPages:1,backfillPages:0,previewAuditPages:0});
    const x=result.items.find(x=>x.videoId==='1');assert.equal(x.detailFailures,0);assert.equal(x.detailAttemptAt,null);assert.equal(x.detailCheckedAt,new Date(NOW).toISOString());
  }
});
test('source access failures do not increase detail failures or change attempt timestamps',async()=>{
  for(const status of [401,403,429,'source_access_unavailable']){
    const old={...item(1),detailFailures:1,detailAttemptAt:new Date(NOW-2*3600000).toISOString()};
    const result=await updateCatalog({schemaVersion:SCHEMA_VERSION,items:[old]},{getText:async u=>{
      if(u===RSS_URL)return rss(1);if(!u.includes('/video/'))return listing(1,0);
      throw Object.assign(Error(typeof status==='number'?`HTTP_${status}`:status),{status});
    },now:NOW,delayMs:0,recentPages:1,backfillPages:0,previewAuditPages:0});
    const x=result.items.find(x=>x.videoId==='1');assert.equal(x.detailFailures,1);assert.equal(x.detailAttemptAt,old.detailAttemptAt);assert.equal(x.detailCheckedAt,undefined);
  }
});

test('RSS English titles preserve existing Japanese titles and source priority',async()=>{
  for(const titleSource of [undefined,'listing','detail']){
    const old={...item(1),...(titleSource?{titleSource}:{})};
    const result=await updateCatalog({items:[old]},{getText:async u=>u===RSS_URL?rss(1).replace('テスト &amp; サンプル','English sample video'):listing(2,0),now:NOW,delayMs:0,recentPages:1,backfillPages:0,previewAuditPages:0,detailLimit:0});
    const x=result.items.find(x=>x.videoId==='1');assert.equal(x.title,old.title);assert.equal(x.titleSource,titleSource||'listing');assert.equal(result.languagePolicy.removedExisting,0);
  }
});
test('listing English titles remove legacy Japanese works and count removals',async()=>{
  const result=await updateCatalog({items:[item(1)],languagePolicy:{removedExistingTotal:4}},{getText:async u=>u===RSS_URL?rss(1):listing(1,0).replaceAll('テスト作品 1','English sample video'),now:NOW,delayMs:0,recentPages:1,backfillPages:0,previewAuditPages:0,detailLimit:0});
  assert.equal(result.items.length,0);assert.equal(result.languagePolicy.removedExisting,1);assert.equal(result.languagePolicy.removedExistingTotal,5);
});
test('detail Japanese titles outrank listing English titles in either merge order',()=>{
  const detailed={...item(1),...parseDetail(detail(1),NOW,'1')},listed=parseListing(listing(1,0).replaceAll('テスト作品 1','English sample video'),SOURCE,NOW).items;
  for(const lists of [[[detailed],listed],[listed,[detailed]]]){
    const [x]=mergeItems(...lists);assert.equal(x.title,'テスト作品 1');assert.equal(x.titleSource,'detail');
  }
});
test('empty titles retain their source and unavailable titles bypass priority preservation',()=>{
  const old={...item(1),titleSource:'detail'};
  const [empty]=mergeItems([old],[{...item(1),title:'',titleSource:'rss'}]);assert.equal(empty.title,old.title);assert.equal(empty.titleSource,'detail');
  for(const availability of ['unavailable','not_found']){
    const [x]=mergeItems([old],[{...item(1),title:'',titleSource:'rss',availability}]);assert.equal(x.title,'');assert.equal(x.titleSource,'rss');
  }
});
test('detail language rejection counts existing works once in cumulative removals',async()=>{
  const result=await updateCatalog({items:[item(1)],languagePolicy:{removedExistingTotal:3}},{getText:async u=>u===RSS_URL?rss(1):u.includes('/video/')?detail(1).replaceAll('テスト作品 1','English sample video'):listing(1,0),now:NOW,delayMs:0,recentPages:1,backfillPages:0,previewAuditPages:0});
  assert.equal(result.items.length,0);assert.equal(result.languagePolicy.removedExisting,1);assert.equal(result.languagePolicy.removedExistingTotal,4);
});

test('time budget stops remaining details and preserves completed details without failure backoff',async()=>{
  let elapsed=0;const requests=[],old={...item(1),detailFailures:1,detailAttemptAt:new Date(NOW-2*3600000).toISOString()};
  const result=await updateCatalog({schemaVersion:SCHEMA_VERSION,items:[old,item(2)]},{getText:async u=>{
    requests.push(u);if(u===RSS_URL)return rss(3);if(u===SOURCE)return listing(2,0);elapsed=101;return detail(3);
  },now:NOW,clock:()=>elapsed,timeBudgetMs:100,delayMs:0,recentPages:1,backfillPages:0,previewAuditPages:0});
  assert.deepEqual(requests,[RSS_URL,SOURCE,url(3)]);
  assert.deepEqual(result.errors,[{stage:'budget',reason:'time_budget_exceeded'}]);
  assert.equal(result.summary.elapsedMs,101);assert.equal(result.collection.timeBudgetMs,100);
  const unchanged=result.items.find(x=>x.videoId==='1');assert.equal(unchanged.detailFailures,1);assert.equal(unchanged.detailAttemptAt,old.detailAttemptAt);
  assert.equal(result.items.find(x=>x.videoId==='3').detailCheckedAt,new Date(NOW).toISOString());
  const skipped=result.items.find(x=>x.videoId==='2');assert.equal(skipped.detailFailures,undefined);assert.equal(skipped.detailAttemptAt,undefined);
  assert.equal(result.summary.detailAttempted,1);assert.equal(result.summary.detailFailed,0);assert.equal(assessRun(result).level,'degraded');
});
test('time budget allows requests at the deadline and uses a separate clock from recorded now',async()=>{
  let elapsed=0;const requests=[];
  const result=await updateCatalog({},{getText:async u=>{requests.push(u);elapsed=100;return u===RSS_URL?rss(1):u===SOURCE?listing(1,0):detail(1)},now:NOW,clock:()=>elapsed,timeBudgetMs:100,delayMs:0,recentPages:1,backfillPages:0,previewAuditPages:0});
  assert.deepEqual(requests,[RSS_URL,SOURCE,url(1)]);assert.deepEqual(result.errors,[]);assert.equal(result.summary.elapsedMs,100);assert.equal(result.updatedAt,new Date(NOW).toISOString());assert.equal(result.items[0].detailCheckedAt,new Date(NOW).toISOString());
});
test('time budget after RSS skips later stages and is degraded without recent success',async()=>{
  let elapsed=0;const requests=[];
  const result=await updateCatalog({},{getText:async u=>{requests.push(u);elapsed=101;return rss()},now:NOW,clock:()=>elapsed,timeBudgetMs:100,delayMs:0});
  assert.deepEqual(requests,[RSS_URL]);assert.deepEqual(result.errors,[{stage:'budget',reason:'time_budget_exceeded'}]);assert.equal(result.items.length,1);assert.equal(assessRun(result).level,'degraded');
});
test('time budget before any metadata preserves the all-source-failure throw',async()=>{
  let calls=0,requests=0;
  await assert.rejects(()=>updateCatalog({},{getText:async()=>{requests++;return rss()},clock:()=>calls++?101:0,timeBudgetMs:100,delayMs:0}),/No source metadata retrieved; previous catalog preserved \(time_budget_exceeded\)/);
  assert.equal(requests,0);
});


test('recentGap: 7ページ目503後も次回100まで探索して解消',async()=>{
  const options={now:NOW,delayMs:0,backfillPages:0,previewAuditPages:0,detailLimit:0},pages=[];
  const source=fail=>async u=>{if(u===RSS_URL)return rss(200);const page=u===SOURCE?1:Number(u.match(/page=(\d+)/)[1]);pages.push(page);if(fail&&page===7)throw Object.assign(Error('HTTP_503'),{status:503});return listing(page<=6?210-page*10:page===7?149:100,page+1)};
  const first=await updateCatalog({items:[item(100)]},{...options,getText:source(true)});
  assert.deepEqual(pages,[1,2,3,4,5,6,7]);assert.deepEqual(first.recentGap,{targetId:100,since:new Date(NOW).toISOString()});assert.equal(first.summary.crawlTargetId,100);assert.equal(assessRun(first).level,'degraded');assert.ok(first.warnings.some(x=>x.reason==='previous_newest_not_reached'));
  assert.deepEqual(pruneCatalog(first,NOW).recentGap,first.recentGap);assert.deepEqual(validateForSave(first,{}),{ok:true});
  pages.length=0;
  const second=await updateCatalog(first,{...options,now:NOW+60000,getText:source(false)});
  assert.deepEqual(pages,[1,2,3,4,5,6,7,8]);assert.equal(second.summary.previousNewestId,200);assert.equal(second.summary.crawlTargetId,100);assert.equal(second.summary.reachedPreviousNewest,true);assert.equal('recentGap' in second,false);assert.deepEqual(second.warnings,[]);
});
test('recentGap: 途中失敗後の到達では保持',async()=>{
  const since=new Date(NOW-86400000).toISOString();
  const result=await updateCatalog({items:[item(200)],recentGap:{targetId:100,since}},{getText:async u=>{if(u===RSS_URL)return rss(200);if(u===SOURCE)throw Error('HTTP_503');return listing(100,3)},now:NOW,recentPages:2,delayMs:0,backfillPages:0,previewAuditPages:0,detailLimit:0});
  assert.equal(result.summary.reachedPreviousNewest,true);assert.deepEqual(result.recentGap,{targetId:100,since});assert.ok(result.warnings.some(x=>x.reason==='previous_newest_not_reached'));assert.equal(assessRun(result).level,'degraded');
});
test('recentGap: 時間予算超過で保持',async()=>{
  let elapsed=0;
  const result=await updateCatalog({items:[item(100)]},{getText:async u=>{if(u===RSS_URL)return rss(200);elapsed=101;return listing(200,2)},now:NOW,clock:()=>elapsed,timeBudgetMs:100,delayMs:0,backfillPages:0,previewAuditPages:0,detailLimit:0});
  assert.deepEqual(result.recentGap,{targetId:100,since:new Date(NOW).toISOString()});assert.equal(result.summary.reachedPreviousNewest,false);assert.ok(result.errors.some(x=>x.reason==='time_budget_exceeded'));assert.ok(result.warnings.some(x=>x.reason==='previous_newest_not_reached'));assert.equal(assessRun(result).level,'degraded');
});
test('recentGap: 8日経過で放棄し警告',async()=>{
  const since=new Date(NOW-8*86400000).toISOString(),previous={items:[item(200)],recentGap:{targetId:100,since}};
  const options={getText:async u=>u===RSS_URL?rss(200):listing(200,2),now:NOW,delayMs:0,backfillPages:0,previewAuditPages:0,detailLimit:0};
  const result=await updateCatalog(previous,options);
  assert.equal(result.summary.crawlTargetId,200);assert.equal('recentGap' in result,false);assert.deepEqual(result.warnings,[{stage:'recent_gap',reason:'gap_abandoned',targetId:100,since}]);assert.equal(assessRun(result).level,'degraded');
  const retained=await updateCatalog(previous,{...options,recentGapMaxDays:9});assert.equal(retained.summary.crawlTargetId,100);assert.deepEqual(retained.recentGap,previous.recentGap);
});
test('recentGap: 前回データなしでは作成しない',async()=>{
  const result=await updateCatalog({},{getText:async u=>{if(u===RSS_URL)return rss();throw Error('HTTP_503')},now:NOW,delayMs:0,backfillPages:0,previewAuditPages:0,detailLimit:0});
  assert.equal(result.summary.crawlTargetId,null);assert.equal('recentGap' in result,false);assert.deepEqual(result.warnings,[]);
});
test('recentGap: 全新着除外でも期限切れ目標を再作成せず次回は既定ページで停止',async()=>{
  const pages=[],since=new Date(NOW-8*86400000).toISOString();
  const options={now:NOW,delayMs:0,backfillPages:0,previewAuditPages:0,detailLimit:0,getText:async u=>{if(u===RSS_URL)return rss(200).replace('テスト &amp; サンプル','English sample video');const page=u===SOURCE?1:Number(u.match(/page=(\d+)/)[1]);pages.push(page);const id=200-Math.floor((page-1)*50/29);return listing(id,page+1).replaceAll(`テスト作品 ${id}`,'English sample video')}};
  const first=await updateCatalog({items:[item(100)],recentGap:{targetId:100,since}},options);
  assert.equal(first.summary.recentPagesFetched,30);assert.equal(first.summary.previousNewestId,100);assert.equal(first.summary.crawlTargetId,100);assert.equal('recentGap' in first,false);assert.equal(first.newestSeenId,200);assert.deepEqual(first.items.map(x=>x.videoId),['100']);assert.deepEqual(first.warnings,[{stage:'recent_gap',reason:'gap_abandoned',targetId:100,since}]);
  pages.length=0;
  const second=await updateCatalog(first,{...options,now:NOW+60000});
  assert.deepEqual(pages,[1,2,3,4,5,6]);assert.equal(second.summary.crawlTargetId,200);assert.equal(second.summary.reachedPreviousNewest,true);assert.equal('recentGap' in second,false);
});
test('newestSeenId: 新着の除外作品だけを観測し次回基準とpruneで保持',async()=>{
  for(const [feedId,recentId,backfillId] of [[300,200,250],[200,300,250],[200,250,300]]){
    const options={now:NOW,delayMs:0,recentPages:1,maxRecentPages:1,backfillPages:1,previewAuditPages:0,detailLimit:0,getText:async u=>u===RSS_URL?rss(feedId).replace('テスト &amp; サンプル','English sample video'):listing(u===SOURCE?recentId:backfillId,3).replaceAll(`テスト作品 ${u===SOURCE?recentId:backfillId}`,'FC2 PPV テスト')};
    const first=await updateCatalog({items:[item(100)],newestSeenId:150},options);
    assert.equal(first.newestSeenId,recentId);assert.deepEqual(first.items.map(x=>x.videoId),['100']);assert.equal(pruneCatalog(first,NOW).newestSeenId,recentId);
    const second=await updateCatalog({...first,recentGap:undefined},{...options,backfillPages:0});
    assert.equal(second.summary.previousNewestId,100);assert.equal(second.summary.crawlTargetId,recentId);assert.equal(second.newestSeenId,recentId);
  }
});
test('recentGap: 不正sinceを今回日時に補正して7日後に放棄',async()=>{
  const options={now:NOW,delayMs:0,recentPages:1,maxRecentPages:1,backfillPages:0,previewAuditPages:0,detailLimit:0,getText:async u=>u===RSS_URL?rss(200):listing(200,2)};
  const first=await updateCatalog({items:[item(100)],recentGap:{targetId:100,since:'invalid'}},options);
  assert.deepEqual(first.recentGap,{targetId:100,since:new Date(NOW).toISOString()});
  const second=await updateCatalog(first,{...options,now:NOW+7*86400000});
  assert.equal('recentGap' in second,false);assert.equal(second.summary.crawlTargetId,200);assert.ok(second.warnings.some(x=>x.reason==='gap_abandoned'&&x.since===first.recentGap.since));
});

for(const excluded of [false,true])test(`newestSeenId: 放棄時RSS${excluded?'除外':'保存'}と一覧全滅後も100まで回復探索`,async()=>{
  const options={now:NOW,recentPages:2,delayMs:0,backfillPages:0,previewAuditPages:0,detailLimit:0},since=new Date(NOW-8*86400000).toISOString();
  const feed=rss(300).replace('テスト &amp; サンプル',excluded?'English sample video':'テスト作品 300');
  const first=await updateCatalog({items:[item(100)],newestSeenId:100,recentGap:{targetId:100,since}},{...options,getText:async u=>{if(u===RSS_URL)return feed;throw Object.assign(Error('HTTP_503'),{status:503})}});
  assert.ok(first.warnings.some(x=>x.reason==='gap_abandoned'));assert.equal('recentGap' in first,false);assert.equal(first.newestSeenId,100);assert.equal(first.items.some(x=>x.videoId==='300'),!excluded);
  const pages=[];
  const second=await updateCatalog(first,{...options,now:NOW+60000,getText:async u=>{if(u===RSS_URL)return feed;const page=u===SOURCE?1:Number(u.match(/page=(\d+)/)[1]);pages.push(page);return listing(page===4?100:301-page,page+1)}});
  assert.equal(second.summary.crawlTargetId,100);assert.equal(second.summary.previousNewestId,excluded?100:300);assert.deepEqual(pages,[1,2,3,4]);assert.equal(second.summary.reachedPreviousNewest,true);assert.equal(second.newestSeenId,300);assert.equal('recentGap' in second,false);
});
test('newestSeenId: 放棄時1ページ成功後の失敗では次回基準100を保持',async()=>{
  const options={now:NOW,recentPages:2,delayMs:0,backfillPages:0,previewAuditPages:0,detailLimit:0,getText:async u=>{if(u===RSS_URL)return rss(300);if(u===SOURCE)return listing(300,2);throw Error('HTTP_503')}};
  const first=await updateCatalog({items:[item(100)],newestSeenId:100,recentGap:{targetId:100,since:new Date(NOW-8*86400000).toISOString()}},options);
  assert.equal(first.newestSeenId,100);assert.equal('recentGap' in first,false);assert.ok(first.warnings.some(x=>x.reason==='gap_abandoned'));
  const second=await updateCatalog(first,{...options,now:NOW+60000});assert.equal(second.summary.crawlTargetId,100);assert.equal(second.newestSeenId,100);
});
test('newestSeenId: 通常gapは失敗時保持し成功到達後に進む',async()=>{
  const since=new Date(NOW-86400000).toISOString(),options={now:NOW,recentPages:2,delayMs:0,backfillPages:0,previewAuditPages:0,detailLimit:0};
  const first=await updateCatalog({items:[item(100)],newestSeenId:100,recentGap:{targetId:100,since}},{...options,getText:async u=>{if(u===RSS_URL)return rss(400);if(u===SOURCE)return listing(300,2);throw Error('HTTP_503')}});
  assert.equal(first.newestSeenId,100);assert.deepEqual(first.recentGap,{targetId:100,since});
  const second=await updateCatalog(first,{...options,getText:async u=>u===RSS_URL?rss(400):listing(u===SOURCE?300:100,3)});
  assert.equal(second.newestSeenId,300);assert.equal('recentGap' in second,false);
});
test('recentGap: 放棄時と次回の一覧全滅でもsinceを更新し7日後に再放棄',async()=>{
  const options={now:NOW,recentPages:2,delayMs:0,backfillPages:0,previewAuditPages:0,detailLimit:0,getText:async u=>{if(u===RSS_URL)return rss(300);throw Error('HTTP_503')}};
  const first=await updateCatalog({items:[item(100)],newestSeenId:100,recentGap:{targetId:100,since:new Date(NOW-8*86400000).toISOString()}},options);
  assert.equal('recentGap' in first,false);assert.ok(first.warnings.some(x=>x.reason==='gap_abandoned'));
  const next=NOW+60000,second=await updateCatalog(first,{...options,now:next});
  assert.equal(second.newestSeenId,100);assert.deepEqual(second.recentGap,{targetId:100,since:new Date(next).toISOString()});assert.equal(second.warnings.some(x=>x.reason==='gap_abandoned'),false);
  const third=await updateCatalog(second,{...options,now:next+7*86400000-1});assert.deepEqual(third.recentGap,second.recentGap);assert.equal(third.warnings.some(x=>x.reason==='gap_abandoned'),false);
  const fourth=await updateCatalog(third,{...options,now:next+7*86400000});assert.equal('recentGap' in fourth,false);assert.equal(fourth.newestSeenId,100);assert.equal(fourth.warnings.filter(x=>x.reason==='gap_abandoned').length,1);
});
test('newestSeenId: RSSとbackfillだけの大きいIDでは進まずbackfill失敗も新着成功を妨げない',async()=>{
  const options={now:NOW,recentPages:1,maxRecentPages:1,delayMs:0,backfillPages:1,previewAuditPages:0,detailLimit:0};
  const first=await updateCatalog({items:[item(100)],newestSeenId:100},{...options,getText:async u=>u===RSS_URL?rss(400):listing(u===SOURCE?100:500,3)});assert.equal(first.newestSeenId,100);
  const second=await updateCatalog(first,{...options,getText:async u=>{if(u===RSS_URL)return rss(400);if(u===SOURCE)return listing(200,2);throw Object.assign(Error('HTTP_403'),{status:403})}});assert.equal(second.newestSeenId,200);
});

test('catalogInfo formats the update in Japan time and counts listed items',()=>{
  const data={updatedAt:'2026-11-18T02:51:27Z'};
  const items=[{}, {availability:'not_found'}, {availability:'unavailable'}, {}];
  const info=catalogInfo(data,items);
  assert.match(info.updatedText,/2026\/11\/18 11:51/);
  assert.equal(info.listed,2);
  assert.equal(info.total,4);
  assert.equal(info.text,`最終更新 ${info.updatedText}（日本時間） · 収録 2件（削除・非公開を除く。総数 4件）`);
  assert.equal(catalogInfo(data,[{}]).text,`最終更新 ${info.updatedText}（日本時間） · 収録 1件`);
});

test('catalogInfo shows 未更新 for missing or invalid timestamps',()=>{
  for(const data of [{},{updatedAt:null},{updatedAt:'invalid'}]){
    const info=catalogInfo(data,[]);
    assert.equal(info.updatedText,'未更新');
    assert.equal(info.text,'最終更新 未更新（日本時間） · 収録 0件');
  }
});

test('catalogInfo prefers supplied numeric counts',()=>{
  const info=catalogInfo({},[{}],{listed:1234,total:5678});
  assert.equal(info.listed,1234);
  assert.equal(info.total,5678);
  assert.match(info.text,/収録 1,234件（削除・非公開を除く。総数 5,678件）/);
  assert.equal(catalogInfo({},[{}],{listed:0}).listed,0);
  assert.equal(catalogInfo({},[{}],{total:5}).listed,1);
});

test('UI places catalog info below the chips and updates it with catalogInfo',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const script=await readFile(new URL('../assets/app.mjs',import.meta.url),'utf8');
  assert.match(html,/<nav class="chips"[^>]*>[^\n]*<\/nav>\s*<p id="catalog-info" class="catalog-info" aria-live="polite">読み込み中…<\/p>\s*<div id="notice"/);
  assert.match(script,/\$\('catalog-info'\)\.textContent\s*=\s*catalogInfo\(state\.data,\s*state\.items\)\.text/);
});

const LIFECYCLE_DAY=86400000;
const lifecycleDate=days=>new Date(NOW+days*LIFECYCLE_DAY).toISOString();

test('migrateLifecycle initializes only timestamps supported by legacy detail results',()=>{
  for(const [availability,field] of [['not_found','notFoundSince'],['embed_available','detailOkAt'],['unavailable','detailOkAt']]){
    const legacy={availability,detailCheckedAt:lifecycleDate(-3)};
    const migrated=migrateLifecycle(legacy);
    assert.deepEqual(migrated,{...legacy,[field]:legacy.detailCheckedAt});
    assert.strictEqual(migrateLifecycle(migrated),migrated);
    const existing={...legacy,[field]:lifecycleDate(-5)};
    assert.strictEqual(migrateLifecycle(existing),existing);
    for(const old of [{availability},{availability,detailCheckedAt:'invalid'}]){
      assert.strictEqual(migrateLifecycle(old),old);
    }
  }
  const unchecked={detailCheckedAt:lifecycleDate(-3)};
  assert.strictEqual(migrateLifecycle(unchecked),unchecked);
});

test('expireNotFound requires elapsed time and two distant 404s without intervening success',()=>{
  const eligible={availability:'not_found',notFoundSince:lifecycleDate(-31),detailCheckedAt:lifecycleDate(-1)};
  const kept=[
    {...eligible,detailCheckedAt:eligible.notFoundSince},
    {...eligible,notFoundSince:lifecycleDate(-29),detailCheckedAt:lifecycleDate(0)},
    {...eligible,notFoundSince:lifecycleDate(-30),detailCheckedAt:lifecycleDate(0)},
    {...eligible,detailOkAt:lifecycleDate(-31)},
    {...eligible,detailOkAt:lifecycleDate(-30)},
    {...eligible,notFoundSince:'invalid'},
    {...eligible,detailCheckedAt:'invalid'},
    ...['unavailable','embed_available',undefined].map(availability=>({...eligible,availability})),
  ];
  const earlierSuccess={...eligible,detailOkAt:lifecycleDate(-32)};
  assert.deepEqual(expireNotFound([eligible,...kept,earlierSuccess],NOW),{kept,removed:[eligible,earlierSuccess]});
  assert.deepEqual(expireNotFound([eligible],NOW,{days:31}),{kept:[eligible],removed:[]});
});

function lifecycleUpdate(previous,days,status,detailLimit=1) {
  return updateCatalog(previous,{
    getText:async u=>{
      if(u===RSS_URL)return rss(1);
      if(!u.includes('/video/'))return listing(1,0);
      if(status!==200)throw Object.assign(Error(`HTTP_${status}`),{status});
      return detail(1);
    },
    now:NOW+days*LIFECYCLE_DAY,delayMs:0,recentPages:1,backfillPages:0,previewAuditPages:0,detailLimit,
  });
}

test('updateCatalog tracks first and repeated 404s and preserves lifecycle dates on other failures',async()=>{
  const previous={items:[{...item(1),availability:'embed_available',statsVersion:SCHEMA_VERSION,detailCheckedAt:lifecycleDate(-2)}]};
  const first=await lifecycleUpdate(previous,0,404);
  assert.equal(first.items[0].availability,'not_found');
  assert.equal(first.items[0].notFoundSince,lifecycleDate(0));
  assert.equal(first.items[0].detailOkAt,lifecycleDate(-2));
  const second=await lifecycleUpdate(first,2,404);
  assert.equal(second.items[0].notFoundSince,lifecycleDate(0));
  assert.equal(second.items[0].detailCheckedAt,lifecycleDate(2));
  const failed=await lifecycleUpdate(second,4,500);
  assert.equal(failed.items[0].detailFailures,1);
  assert.equal(failed.items[0].notFoundSince,lifecycleDate(0));
  assert.equal(failed.items[0].detailOkAt,lifecycleDate(-2));
  assert.equal(failed.items[0].detailCheckedAt,lifecycleDate(2));
});

test('updateCatalog expires old 404 items and accumulates removal counts',async()=>{
  const previous={items:[{...item(1),availability:'not_found',statsVersion:SCHEMA_VERSION,detailCheckedAt:lifecycleDate(-31)}],
    notFoundPolicy:{removedTotal:4}};
  const result=await lifecycleUpdate(previous,0,404);
  assert.deepEqual(result.items,[]);
  assert.equal(result.summary.expiredNotFound,1);
  assert.deepEqual(result.notFoundPolicy,{days:30,removedThisRun:1,removedTotal:5,lastRemoval:{at:lifecycleDate(0),count:1},expired:[{videoId:'1',at:lifecycleDate(0)}]});
  const next=await lifecycleUpdate(result,1,200,0);
  assert.equal(next.summary.expiredNotFound,0);
  assert.deepEqual(next.notFoundPolicy,{...result.notFoundPolicy,removedThisRun:0,expired:[]});
  assert.deepEqual(pruneCatalog(result,NOW).notFoundPolicy,result.notFoundPolicy);
});

test('updateCatalog rechecks rediscovered expired works before listing them',async()=>{
  const previous={items:[{...item(1),availability:'not_found',statsVersion:SCHEMA_VERSION,detailCheckedAt:lifecycleDate(-31)}]};
  const expired=await lifecycleUpdate(previous,0,404);
  assert.deepEqual(expired.notFoundPolicy.expired,[{videoId:'1',at:lifecycleDate(0)}]);

  const revived=await lifecycleUpdate(expired,1,404,0);
  assert.equal(revived.summary.revivedFromExpired,1);
  assert.deepEqual(revived.notFoundPolicy.expired,[]);
  assert.equal(revived.items[0].availability,'not_found');
  assert.equal(revived.items[0].notFoundSince,lifecycleDate(1));
  assert.equal(revived.items[0].firstSeenAt,lifecycleDate(1));
  assert.equal(Object.hasOwn(revived.items[0],'detailCheckedAt'),false);
  assert.deepEqual(selectItems(revived.items,{view:'home'}),[]);

  const stillMissing=await lifecycleUpdate(revived,2,404);
  assert.equal(stillMissing.summary.detailLanes.pending,1);
  assert.equal(stillMissing.items[0].notFoundSince,lifecycleDate(1));
  assert.deepEqual(selectItems(stillMissing.items,{view:'home'}),[]);

  const recovered=await lifecycleUpdate(stillMissing,4,200);
  assert.equal(recovered.items[0].availability,'embed_available');
  assert.equal(Object.hasOwn(recovered.items[0],'notFoundSince'),false);
  assert.deepEqual(selectItems(recovered.items,{view:'home'}),recovered.items);
});

test('updateCatalog drops expired markers older than 180 days and deduplicates the rest',async()=>{
  const previous={notFoundPolicy:{expired:[
    {videoId:'1',at:lifecycleDate(-181)},
    {videoId:'2',at:lifecycleDate(-180)},
    {videoId:'3',at:lifecycleDate(-10),title:'余分なタイトル'},
    {videoId:'3',at:lifecycleDate(-11)},
  ]}};
  const result=await lifecycleUpdate(previous,0,404,0);
  assert.deepEqual(result.notFoundPolicy.expired,[
    {videoId:'2',at:lifecycleDate(-180)},
    {videoId:'3',at:lifecycleDate(-10)},
  ]);
  assert.equal(result.summary.revivedFromExpired,0);
  assert.equal(selectItems(result.items,{view:'home'}).length,1);
});

test('updateCatalog clears notFoundSince when an expirable item recovers',async()=>{
  const previous={items:[{...item(1),availability:'not_found',statsVersion:SCHEMA_VERSION,
    notFoundSince:lifecycleDate(-33),detailCheckedAt:lifecycleDate(-2)}]};
  assert.equal(expireNotFound(previous.items,NOW).removed.length,1);
  const result=await lifecycleUpdate(previous,0,200);
  assert.equal(result.items[0].availability,'embed_available');
  assert.equal(result.items[0].detailOkAt,lifecycleDate(0));
  assert.equal(Object.hasOwn(result.items[0],'notFoundSince'),false);
  assert.equal(result.summary.expiredNotFound,0);
});

test('migrateFirstSeen initializes from valid dates and preserves existing timestamps',()=>{
  const dated={date:NOW-1000};
  const migrated=migrateFirstSeen(dated,NOW);
  assert.deepEqual(migrated,{...dated,firstSeenAt:new Date(dated.date).toISOString()});
  assert.equal(migrateFirstSeen({date:NOW+1000},NOW).firstSeenAt,new Date(NOW).toISOString());
  for(const invalid of [{},{date:0},{date:-1},{date:Infinity},{date:NaN},{date:String(NOW)}]){
    assert.equal(Object.hasOwn(migrateFirstSeen(invalid,NOW),'firstSeenAt'),false);
  }
  const existing={date:NOW,firstSeenAt:migrated.firstSeenAt};
  assert.equal(migrateFirstSeen(existing,NOW),existing);
  assert.equal(migrateFirstSeen(migrated,NOW+1000),migrated);
});

test('updateCatalog stamps new items and preserves firstSeenAt through listing and detail refreshes',async()=>{
  const firstSeenAt=new Date(NOW-86400000).toISOString();
  const existing={...item(1),firstSeenAt};
  assert.equal(mergeItems([existing],[item(1)])[0].firstSeenAt,firstSeenAt);
  const detailRequests=[];
  const result=await updateCatalog({items:[existing]},{
    now:NOW,delayMs:0,recentPages:1,backfillPages:0,previewAuditPages:0,
    getText:async source=>{
      if(source===RSS_URL)return rss(2);
      if(source===SOURCE)return listing(1,0);
      detailRequests.push(source);
      return detail(source===url(1)?1:2);
    },
  });
  assert.deepEqual(new Set(detailRequests),new Set([url(1),url(2)]));
  assert.equal(result.items.find(x=>x.videoId==='1').firstSeenAt,firstSeenAt);
  assert.equal(result.items.find(x=>x.videoId==='2').firstSeenAt,new Date(NOW).toISOString());
});

test('visitBaseline anchors each tab to the previous visit and ignores invalid timestamps',()=>{
  const last=String(NOW-2000),session=String(NOW-4000);
  assert.deepEqual(visitBaseline({},NOW),{baseline:null,session:'none',last:String(NOW)});
  assert.deepEqual(visitBaseline({last},NOW),{baseline:Number(last),session:last,last:String(NOW)});
  assert.deepEqual(visitBaseline({last,session},NOW),{baseline:Number(session),session,last:String(NOW)});
  assert.equal(visitBaseline({last,session:'none'},NOW).baseline,null);
  for(const invalid of ['',' ','invalid','Infinity']){
    assert.equal(visitBaseline({last:invalid},NOW).baseline,null);
    assert.equal(visitBaseline({last,session:invalid},NOW).baseline,null);
  }
});

test('since view lists only newly seen listed items in the usual newest-first order',()=>{
  const seen=(id,offset,fields={})=>({...item(id),firstSeenAt:new Date(NOW+offset).toISOString(),...fields});
  const items=[
    seen(1,2000,{date:NOW-2000}),seen(2,1000,{date:NOW-1000}),seen(3,0),seen(4,-1),
    seen(5,1000,{availability:'not_found'}),seen(6,1000,{availability:'unavailable'}),item(7),
  ];
  assert.deepEqual(selectItems(items,{view:'since',since:NOW,sort:'old'}).map(x=>x.videoId),['2','1']);
  assert.deepEqual(selectItems(items,{view:'since',since:null}),[]);
});

test('firstSeenMs and isNewSince require a valid timestamp after the baseline',()=>{
  const seen={firstSeenAt:new Date(NOW).toISOString()};
  assert.equal(firstSeenMs(seen),NOW);
  assert.equal(isNewSince(seen,NOW-1),true);
  assert.equal(isNewSince(seen,NOW),false);
  assert.equal(isNewSince(seen,null),false);
  assert.equal(isNewSince(seen,String(NOW-1)),false);
  for(const invalid of [{},{firstSeenAt:'invalid'},{firstSeenAt:NOW}]){
    assert.equal(Number.isNaN(firstSeenMs(invalid)),true);
    assert.equal(isNewSince(invalid,NOW),false);
  }
});

test('UI includes since navigation in both menus and renders the NEW badge on shared cards',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const script=await readFile(new URL('../assets/app.mjs',import.meta.url),'utf8');
  for(const style of ['nav-item','chip']){
    assert.ok(html.includes(`<button data-view="since" class="${style}" hidden>前回からの新着<span class="since-count" data-since-count>`));
  }
  assert.match(script,/function card.*isNewSince\(x,state\.visit\?\.baseline\).*class="new-badge">NEW/);
  assert.match(script,/since:'前回からの新着'/);
  assert.match(script,/\[data-view="since"\]/);
});

test('updateCatalog defaults to 320 detail requests when the pending lane is empty',async()=>{
  const detailCheckedAt=new Date(NOW-48*3600000).toISOString();
  const previous={schemaVersion:SCHEMA_VERSION,items:Array.from({length:321},(_,i)=>({
    ...item(i+1),statsVersion:SCHEMA_VERSION,ratingVersion:RATING_VERSION,previewVersion:PREVIEW_VERSION,detailCheckedAt,
  }))};
  const requests=[];
  const result=await updateCatalog(previous,{
    now:NOW,delayMs:0,recentPages:1,maxRecentPages:1,backfillPages:0,previewAuditPages:0,
    getText:async source=>{
      if(source===RSS_URL)return rss(1);
      if(source===SOURCE)return listing(1,0);
      requests.push(source);
      return detail(Number(source.match(/\/video\/(\d+)/)[1]));
    },
  });
  assert.equal(result.collection.detailLimit,320);
  assert.equal(result.summary.detailLanes.pending,0);
  assert.equal(result.summary.detailAttempted,320);
  assert.equal(new Set(requests).size,320);
});

test('buildHead selects and projects the listed catalog with counts and categories',()=>{
  const updatedAt=new Date(NOW).toISOString(),day=86400000;
  const items=[
    {...item(1),date:5,views:80,categories:['猫'],tags:['タグ'],detailFailures:1},
    {...item(2),date:4,views:100,ratingPercent:75,categories:['犬','猫']},
    {...item(3),date:3,ratingPercent:95,firstSeenAt:new Date(NOW-day).toISOString()},
    {...item(4),date:2,firstSeenAt:new Date(NOW-3*day).toISOString()},
    {...item(5),date:1,firstSeenAt:new Date(NOW-4*day).toISOString(),categories:['鳥']},
    {...item(6),date:10,views:200,ratingPercent:100,availability:'not_found',categories:['非公開']},
    {...item(7),date:11,views:300,ratingPercent:100,availability:'unavailable',categories:['削除']},
    {...item(8),date:0,firstSeenAt:new Date(NOW+day).toISOString()}
  ];
  const catalog={updatedAt,source:SOURCE,backfill:{nextPage:7},items,errors:[{stage:'detail'}]};
  const options={newCount:1,popularCount:1,ratedCount:1};
  const head=buildHead(catalog,options),ids=head.items.map(x=>x.id);
  assert.deepEqual(ids,[...selectItems(items).slice(0,3).map(x=>x.id),'video:4']);
  for(const sort of ['new','views','rating']){
    assert.equal(selectItems(head.items,{sort})[0].id,selectItems(items,{sort})[0].id);
  }
  assert.deepEqual(buildHead(catalog,{...options,sinceMax:1}).items.map(x=>x.id),ids.slice(0,3));
  const tied=[{...item(10),date:1,views:100,ratingPercent:95},items[2],items[1]];
  const tiedHead=buildHead({...catalog,items:tied},options);
  for(const sort of ['views','rating']){
    assert.equal(selectItems(tiedHead.items,{sort})[0].id,selectItems(tied,{sort})[0].id);
  }
  assert.deepEqual(head.items[0],{...item(1),date:5,views:80,categories:['猫'],tags:['タグ']});
  assert.deepEqual(head,{headVersion:1,updatedAt,source:SOURCE,backfill:catalog.backfill,errorCount:1,
    counts:{total:8,listed:6},categories:['犬','鳥','猫'].sort((a,b)=>a.localeCompare(b,'ja')),
    full:'data/videos.json',items:head.items});
});

test('runMain creates both catalog files on first run and regenerates the head on prune-only',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'catalog-head-'));
  try{
    const output=join(dir,'videos.json'),result={schemaVersion:SCHEMA_VERSION,items:[item(1)]};
    await assert.rejects(readFile(output),{code:'ENOENT'});
    for(const argv of [[],['--prune-only']]){
      await rm(join(dir,'catalog-head.json'),{force:true});
      assert.equal(await runMain({argv,output,update:async()=>result,log:()=>{},env:{}}),0);
      const saved=JSON.parse(await readFile(output,'utf8'));
      assert.deepEqual(saved.items,result.items);
      assert.equal(await readFile(join(dir,'catalog-head.json'),'utf8'),JSON.stringify(buildHead(saved))+'\n');
    }
  }finally{await rm(dir,{recursive:true,force:true})}
});

test('runMain returns 1 when catalog head rename fails after saving the full catalog',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'catalog-head-fail-'));
  try{
    const output=join(dir,'videos.json'),result={schemaVersion:SCHEMA_VERSION,items:[item(1)]},logs=[];
    await mkdir(join(dir,'catalog-head.json'));
    // The workflow must stop before committing catalog files from different runs.
    assert.equal(await runMain({argv:[],output,update:async()=>result,log:x=>logs.push(x),env:{}}),1);
    assert.deepEqual(JSON.parse(await readFile(output,'utf8')),result);
    assert.ok(logs.some(x=>x.startsWith('::error title=Catalog head not written::')));
  }finally{await rm(dir,{recursive:true,force:true})}
});

test('runMain replaces a stale head with a disabled marker when head generation throws',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'catalog-head-disabled-'));
  try{
    const output=join(dir,'videos.json'),head=join(dir,'catalog-head.json'),logs=[];
    const result={schemaVersion:SCHEMA_VERSION,updatedAt:lifecycleDate(0),items:[{...item(1),categories:[1,2]}]};
    await writeFile(head,JSON.stringify(buildHead({updatedAt:lifecycleDate(-1),items:[item(2)]})));
    assert.throws(()=>buildHead(result));
    assert.equal(await runMain({argv:[],output,update:async()=>result,log:x=>logs.push(x),env:{}}),0);
    assert.deepEqual(JSON.parse(await readFile(output,'utf8')),result);
    assert.deepEqual(JSON.parse(await readFile(head,'utf8')),{headVersion:0,updatedAt:result.updatedAt});
    assert.ok(logs.some(x=>x.startsWith('::warning title=Catalog head not built::')));
  }finally{await rm(dir,{recursive:true,force:true})}
});

test('load renders head then full catalog and preserves browse state and the visit baseline',async()=>{
  const {ctx,nodes}=await uiHarness();
  const items=[{...item(1),categories:['犬']},{...item(2),categories:['犬']}];
  const head={...buildHead({items:items.slice(0,1)}),categories:['犬','猫'],counts:{total:100,listed:90}};
  const requests=[];
  let resolveFull,visits=0;
  ctx.localStorage.setItem=key=>{if(key==='tm-last-visit')visits++};
  ctx.fetch=(url,options)=>{
    requests.push(url);
    assert.equal(options.cache,'no-cache');
    if(url==='data/catalog-head.json')return Promise.resolve({ok:true,json:async()=>head});
    return new Promise(resolve=>{resolveFull=resolve});
  };
  const pending=vm.runInContext('load()',ctx);
  await tick();
  assert.deepEqual(requests,['data/catalog-head.json','data/videos.json']);
  assert.match(nodes.get('grid').innerHTML,/grid:video:1/);
  assert.doesNotMatch(nodes.get('grid').innerHTML,/grid:video:2/);
  assert.match(nodes.get('catalog-info').textContent,/90件.*100件/);
  assert.match(nodes.get('category').innerHTML,/猫/);
  assert.equal(nodes.get('refresh').disabled,true);
  assert.equal(nodes.get('more').hidden,true);
  assert.equal(nodes.get('count').textContent,'先読み 1件を表示中 · 全件を読み込み中…');
  assert.equal(visits,0);
  const limit=vm.runInContext('state.limit',ctx);
  nodes.get('more').listeners.click();
  assert.equal(vm.runInContext('state.limit',ctx),limit);
  vm.runInContext("setView('recent');state.limit=42",ctx);
  nodes.get('q').value='テスト';
  nodes.get('category').value='犬';
  nodes.get('sort').value='rating';
  vm.runInContext('render()',ctx);
  let restored;
  ctx.window.scrollTo=options=>{restored=options.top};
  const grid=nodes.get('grid'),replace=grid.replaceChildren.bind(grid);
  grid.replaceChildren=(...children)=>{ctx.window.scrollY=0;replace(...children)};
  resolveFull({ok:true,json:async()=>({items})});
  await pending;
  assert.equal(restored,123);
  assert.equal(vm.runInContext('state.partial',ctx),false);
  assert.equal(vm.runInContext('state.view',ctx),'recent');
  assert.equal(vm.runInContext('state.limit',ctx),42);
  assert.equal(nodes.get('q').value,'テスト');
  assert.equal(nodes.get('category').value,'犬');
  assert.equal(nodes.get('sort').value,'rating');
  assert.match(grid.innerHTML,/grid:video:2/);
  assert.equal(visits,1);
  assert.equal(nodes.get('refresh').disabled,false);
});

test('load silently falls back to the full catalog for a missing or invalid head',async()=>{
  for(const response of [{ok:false,status:404},{ok:true,json:async()=>{throw new SyntaxError()}},
    {ok:true,json:async()=>({headVersion:1,items:null})},{ok:true,json:async()=>({headVersion:0})}]){
    const {ctx,nodes}=await uiHarness();
    const requests=[];
    ctx.fetch=async url=>{
      requests.push(url);
      return url==='data/catalog-head.json'?response:{ok:true,json:async()=>({items:[item(2)]})};
    };
    await vm.runInContext('load()',ctx);
    assert.deepEqual(requests,['data/catalog-head.json','data/videos.json']);
    assert.equal(vm.runInContext('state.partial',ctx),false);
    assert.match(nodes.get('grid').innerHTML,/grid:video:2/);
    assert.equal(nodes.get('notice').hidden,true);
  }
});

test('load keeps the head and shows the full catalog failure notice',async()=>{
  const {ctx,nodes}=await uiHarness();
  let resolveFull;
  ctx.fetch=url=>url==='data/catalog-head.json'
    ?Promise.resolve({ok:true,json:async()=>buildHead({items:[item(1)],errors:[{}]})})
    :new Promise(resolve=>{resolveFull=resolve});
  const pending=vm.runInContext('load()',ctx);
  await tick();
  resolveFull({ok:false,status:503});
  await pending;
  assert.equal(vm.runInContext('state.partial',ctx),true);
  assert.match(nodes.get('grid').innerHTML,/grid:video:1/);
  assert.equal(nodes.get('notice').hidden,false);
  assert.match(nodes.get('notice').textContent,/全件の読み込みに失敗しました。一部の作品だけを表示しています。/);
  assert.equal(nodes.get('refresh').disabled,false);
  const message='全件の読み込みに失敗しました。右上の更新ボタンで再読み込みできます。';
  for(const action of ["setView('archive')","setView('favorites')","setView('history')",
    "setView('home');$('q').value='テスト';render()","setView('home');$('category').value='犬';render()",
    "setView('home');$('sort').value='old';render()","setView('home');$('sort').value='title';render()"]){
    vm.runInContext(action,ctx);
    assert.equal(nodes.get('grid').innerHTML,`<div class="empty">${message}</div>`);
    assert.equal(nodes.get('count').textContent,message);
  }
  const retry=vm.runInContext('load()',ctx);
  await tick();
  assert.equal(nodes.get('count').textContent,'全件を読み込み中…');
  resolveFull({ok:true,json:async()=>({items:[item(2)]})});
  await retry;
  assert.match(nodes.get('grid').innerHTML,/grid:video:2/);
  assert.equal(vm.runInContext('state.fullFailed',ctx),false);
});

test('load shows a late head and failure messages after the full catalog returns 503',async()=>{
  const {ctx,nodes}=await uiHarness();
  let resolveHead;
  ctx.fetch=url=>url==='data/catalog-head.json'
    ?new Promise(resolve=>{resolveHead=resolve})
    :Promise.resolve({ok:false,status:503});
  const pending=vm.runInContext('load()',ctx);
  await tick();
  assert.equal(vm.runInContext('state.loading',ctx),true);
  assert.equal(nodes.get('refresh').disabled,true);
  resolveHead({ok:true,json:async()=>buildHead({items:[item(1)]})});
  await pending;
  assert.match(nodes.get('grid').innerHTML,/grid:video:1/);
  assert.equal(nodes.get('notice').hidden,false);
  assert.equal(nodes.get('notice').textContent,'全件の読み込みに失敗しました。一部の作品だけを表示しています。右上の更新ボタンで再読み込みできます。');
  assert.equal(vm.runInContext('state.fullFailed',ctx),true);
  assert.equal(vm.runInContext('state.loading',ctx),false);
  assert.equal(nodes.get('refresh').disabled,false);
  vm.runInContext("setView('archive')",ctx);
  const message='全件の読み込みに失敗しました。右上の更新ボタンで再読み込みできます。';
  assert.equal(nodes.get('grid').innerHTML,`<div class="empty">${message}</div>`);
  assert.equal(nodes.get('count').textContent,message);
});

test('load shows the retry prompt when the full catalog returns 503 before the head returns 404',async()=>{
  const {ctx,nodes}=await uiHarness();
  let resolveHead;
  ctx.fetch=url=>url==='data/catalog-head.json'
    ?new Promise(resolve=>{resolveHead=resolve})
    :Promise.resolve({ok:false,status:503});
  const pending=vm.runInContext('load()',ctx);
  await tick();
  assert.equal(nodes.get('refresh').disabled,true);
  resolveHead({ok:false,status:404});
  await pending;
  assert.equal(nodes.get('notice').hidden,false);
  assert.match(nodes.get('notice').textContent,/HTTP 503/);
  assert.equal(nodes.get('count').textContent,'読み込みに失敗しました');
  assert.equal(nodes.get('grid').innerHTML,'<div class="empty">右上の更新ボタンで再度読み込めます。</div>');
  assert.equal(nodes.get('shelf-section').hidden,true);
  assert.equal(vm.runInContext('state.loading',ctx),false);
  assert.equal(nodes.get('refresh').disabled,false);
});

test('refresh ignores a head from the previous load arriving during the new load',async()=>{
  const {ctx,nodes}=await uiHarness();
  let resolveHead,resolveFull;
  ctx.fetch=url=>{
    if(url==='data/catalog-head.json')return new Promise(resolve=>{resolveHead=resolve});
    return new Promise(resolve=>{resolveFull=resolve});
  };
  const pending=vm.runInContext('load()',ctx);
  resolveFull({ok:true,json:async()=>({items:[item(2)]})});
  await pending;
  const grid=nodes.get('grid'),firstMarkup=grid.innerHTML;
  assert.match(firstMarkup,/grid:video:2/);
  const refresh=nodes.get('refresh').listeners.click();
  assert.equal(nodes.get('refresh').disabled,true);
  resolveHead({ok:true,json:async()=>buildHead({items:[item(1)]})});
  await tick();
  assert.equal(grid.innerHTML,firstMarkup);
  assert.equal(vm.runInContext('state.partial',ctx),false);
  resolveFull({ok:true,json:async()=>({items:[item(3)]})});
  await refresh;
  assert.match(grid.innerHTML,/grid:video:3/);
});

test('partial catalog waits for the full list in archive and search',async()=>{
  const {ctx,nodes}=await uiHarness();
  let resolveFull;
  ctx.fetch=url=>url==='data/catalog-head.json'
    ?Promise.resolve({ok:true,json:async()=>buildHead({items:[item(1)],errors:[{}]})})
    :new Promise(resolve=>{resolveFull=resolve});
  const pending=vm.runInContext('load()',ctx);
  await tick();
  assert.match(nodes.get('notice').textContent,/一部の取得失敗または更新の遅れ/);
  for(const action of ["setView('archive')","setView('home');$('q').value='テスト';render()"]){
    vm.runInContext(action,ctx);
    assert.match(nodes.get('grid').innerHTML,/全件を読み込み中です…/);
    assert.equal(nodes.get('count').textContent,'全件を読み込み中…');
    assert.equal(nodes.get('more').hidden,true);
  }
  resolveFull({ok:true,json:async()=>({items:[item(2)]})});
  await pending;
  assert.match(nodes.get('grid').innerHTML,/grid:video:2/);
});

test('load starts both requests immediately and ignores a head arriving after the full catalog',async()=>{
  const {ctx,nodes}=await uiHarness();
  const requests=new Map();
  ctx.fetch=url=>new Promise(resolve=>requests.set(url,resolve));
  const pending=vm.runInContext('load()',ctx);
  assert.ok(requests.has('data/catalog-head.json'));
  assert.ok(requests.has('data/videos.json'));
  requests.get('data/videos.json')({ok:true,json:async()=>({items:[item(2)]})});
  await pending;
  const grid=nodes.get('grid');
  assert.match(grid.innerHTML,/grid:video:2/);
  const fullMarkup=grid.innerHTML;
  requests.get('data/catalog-head.json')({ok:true,json:async()=>buildHead({items:[item(1)]})});
  await tick();
  assert.equal(grid.innerHTML,fullMarkup);
  assert.equal(vm.runInContext('state.partial',ctx),false);
});

test('refresh requests only the full catalog and retains the current full view on failure',async()=>{
  const {ctx,nodes}=await uiHarness();
  ctx.fetch=async url=>url==='data/catalog-head.json'
    ?{ok:false,status:404}
    :{ok:true,json:async()=>({items:[]})};
  await vm.runInContext('load()',ctx);
  const fullMarkup=nodes.get('grid').innerHTML,fullCount=nodes.get('count').textContent;
  const requests=[];
  ctx.fetch=async url=>{
    requests.push(url);
    return {ok:false,status:503};
  };
  await nodes.get('refresh').listeners.click();
  assert.deepEqual(requests,['data/videos.json']);
  assert.equal(nodes.get('grid').innerHTML,fullMarkup);
  assert.equal(nodes.get('count').textContent,fullCount);
  assert.equal(vm.runInContext('state.partial',ctx),false);
  assert.equal(nodes.get('notice').hidden,false);
  assert.match(nodes.get('notice').textContent,/HTTP 503/);
});

test('load finalizes new-since controls only with full data and records every successful full visit',async()=>{
  const {ctx,nodes}=await uiHarness();
  const badge={textContent:''},button={hidden:true,querySelector:()=>badge};
  ctx.document.querySelectorAll=selector=>selector==='[data-view="since"]'?[button]:[];
  const local=new Map([['tm-last-visit',String(NOW-1000)]]),session=new Map();
  ctx.localStorage={getItem:key=>local.get(key),setItem:(key,value)=>local.set(key,value)};
  ctx.sessionStorage={getItem:key=>session.get(key),setItem:(key,value)=>session.set(key,value)};
  let now=NOW;
  ctx.Date=class extends Date{static now(){return now}};
  const items=[{...item(1),firstSeenAt:new Date(NOW-500).toISOString()},
    {...item(2),firstSeenAt:new Date(NOW-250).toISOString()}];
  let resolveFull;
  ctx.fetch=url=>url==='data/catalog-head.json'
    ?Promise.resolve({ok:true,json:async()=>buildHead({items:items.slice(0,1)})})
    :new Promise(resolve=>{resolveFull=resolve});
  const pending=vm.runInContext('load()',ctx);
  await tick();
  assert.equal(nodes.get('count').textContent,'先読み 1件を表示中 · 全件を読み込み中…');
  assert.equal(button.hidden,true);
  assert.equal(badge.textContent,'');
  assert.equal(local.get('tm-last-visit'),String(NOW-1000));
  now+=1000;
  resolveFull({ok:true,json:async()=>({items})});
  await pending;
  assert.equal(button.hidden,false);
  assert.equal(badge.textContent,'2');
  assert.equal(local.get('tm-last-visit'),String(now));
  now+=1000;
  const refresh=nodes.get('refresh').listeners.click();
  resolveFull({ok:true,json:async()=>({items})});
  await refresh;
  assert.equal(local.get('tm-last-visit'),String(now));
  assert.equal(session.get('tm-visit-baseline'),String(NOW-1000));
  assert.equal(vm.runInContext('state.visit.baseline',ctx),NOW-1000);
  assert.equal(badge.textContent,'2');
});
