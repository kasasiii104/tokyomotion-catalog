import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { classifyTitle, filterJapanese } from '../assets/language.mjs';
import { PAGE_SIZE, escapeHTML, stats, safeUrl, prepareItems, selectItems } from '../assets/catalog-core.mjs';
import { PreviewController, previewSpec } from '../assets/preview-controller.mjs';
import { auditContent, contentExclusionReasons } from '../assets/content-filter.mjs';
import { SOURCE, RSS_URL, SCHEMA_VERSION, RATING_VERSION, PREVIEW_VERSION, decode, stripMarkup, parseFeed, parseListing, parseDetail, parseThumbnailPreview, migrateItems, mergeItems, detailQueue, updateCatalog, pruneCatalog } from '../scripts/update.mjs';

const NOW=Date.parse('2026-10-04T10:00:00Z');
const url=id=>`${SOURCE}/video/${id}/test`;
const item=id=>({id:`video:${id}`,videoId:String(id),sourceUrl:url(id),title:`テスト作品 ${id}`,categories:[]});
const rss=(id=201)=>`<rss><channel><item><title>テスト &amp; サンプル</title><link>${url(id)}</link><pubDate>Sun, 04 Oct 2026 09:00:00 GMT</pubDate></item></channel></rss>`;
const listing=(id,next=2)=>`<h4>Videos Being Watched</h4><a href="${url(999)}">Not an archive</a><h4><span>Most Recent Videos</span></h4><div><a href="${url(id)}"><img src="https://cdn.tokyo-motion.net/${id}.jpg" alt="テスト作品 ${id}"><span>HD</span><span>01:20</span></a><a href="${url(id)}">テスト作品 ${id}</a><span>2 days ago</span><span>1,234 views</span><span>88%</span></div>${next?`<a href="/page=${next}">Next</a>`:''}<h4>Information</h4>`;
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
  const result=await updateCatalog(previous,{getText:mockSource,now:NOW,delayMs:0,detailLimit:5,recentPages:2,backfillPages:2});
  assert.ok(result.items.length>100);assert.ok(result.items.some(x=>x.videoId==='201'));assert.ok(result.items.some(x=>x.videoId==='1'));
  assert.equal(result.backfill.nextPage,5);assert.equal(result.summary.detailRefreshed,5);
  const second=await updateCatalog(result,{getText:mockSource,now:NOW+1800000,delayMs:0,detailLimit:5,recentPages:2,backfillPages:2});
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
  const result=await updateCatalog(initial,{getText:source,now:NOW,delayMs:0,detailLimit:0,backfillPages:0,recentPages:1,previewAuditPages:7});
  assert.equal(result.items.find(x=>x.videoId==='193').preview.count,20);assert.equal(result.previewAudit.nextPage,9);assert.equal(result.backfill.nextPage,10);
  assert.ok(!result.items.some(x=>x.videoId==='195'));
  const again=await updateCatalog(result,{getText:source,now:NOW,delayMs:0,detailLimit:0,backfillPages:0,recentPages:1,previewAuditPages:7});
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
  const ctx=vm.createContext({document:{getElementById:get,createElement:tag=>new Element(tag),querySelectorAll:()=>[],addEventListener:(key,fn)=>events[key]=fn},window:{scrollY:123,scrollTo(){},addEventListener(){}},localStorage:{getItem:()=>'{invalid',setItem(){}},URL,Map,Set,Date,setTimeout:()=>1,clearTimeout(){},PAGE_SIZE,esc:escapeHTML,safeUrl,stats,prepareItems,selectItems,PreviewController:TestController,previewSpec});
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
