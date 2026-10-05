import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { classifyTitle, filterJapanese } from '../assets/language.mjs';
import { PAGE_SIZE, escapeHTML, stats, safeUrl, prepareItems, selectItems } from '../assets/catalog-core.mjs';
import { SOURCE, RSS_URL, SCHEMA_VERSION, RATING_VERSION, decode, stripMarkup, parseFeed, parseListing, parseDetail, migrateItems, mergeItems, detailQueue, updateCatalog } from '../scripts/update.mjs';

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
  const x={...item(1),statsVersion:SCHEMA_VERSION,ratingVersion:RATING_VERSION,detailCheckedAt:new Date(NOW-25*3600000).toISOString()};assert.equal(detailQueue([x],NOW).length,1);
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
  const previous={items:Array.from({length:100},(_,i)=>({...item(i+1),statsVersion:SCHEMA_VERSION,ratingVersion:RATING_VERSION,detailCheckedAt:new Date(NOW).toISOString()}))};
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

test('UI has inline playback and no modal or initial age gate',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const script=await readFile(new URL('../assets/app.mjs',import.meta.url),'utf8');
  new vm.Script(script.replace(/^import .*;\n/,''));
  assert.ok(!html.includes('id="age"'));assert.ok(!html.includes('id="modal"'));assert.ok(html.includes('id="more"'));assert.ok(html.includes('id="shelf"'));
  assert.ok(script.includes('media.append(frame)'));assert.ok(script.includes('active.frame?.remove()'));
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

async function inlineHarness(){
  class Element{
    constructor(tag='div'){this.tag=tag;this.children=[];this.listeners={};this.dataset={};this.attributes={};this.value='';this.isConnected=true;const classes=new Set();this.classList={add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x),toggle:(x,on)=>on?classes.add(x):classes.delete(x)}}
    set innerHTML(value){this.html=value;this.replaceChildren()}
    get innerHTML(){return this.html||''}
    append(...nodes){for(const node of nodes){this.children.push(node);node.parent=this}}
    replaceChildren(...nodes){for(const child of this.children)child.parent=null;this.children=[];this.append(...nodes)}
    remove(){this.removed=true;if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);this.parent=null}
    setAttribute(key,value){this.attributes[key]=value}
    addEventListener(key,fn){this.listeners[key]=fn}
    focus(){this.focused=true}
    insertAdjacentHTML(position,html){this.inserted=html}
    querySelectorAll(){return []}
    querySelector(selector){if(selector==='.media')return this.media;if(selector==='.player-controls'||selector==='.player-message')return this.children.find(x=>x.className===selector.slice(1))||null;return new Element('button')}
  }
  const nodes=new Map();const get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id)};get('sort').value='new';
  const ctx=vm.createContext({document:{getElementById:get,createElement:tag=>new Element(tag),querySelectorAll:()=>[],addEventListener(){}},window:{addEventListener(){}},localStorage:{getItem:()=>'{invalid',setItem(){}},URL,Map,Set,Date,setTimeout:()=>1,clearTimeout(){},PAGE_SIZE,esc:escapeHTML,safeUrl,stats,prepareItems,selectItems});
  const script=(await readFile(new URL('../assets/app.mjs',import.meta.url),'utf8')).replace(/^import .*;\n/,'').replace(/load\(\);\s*$/,'');vm.runInContext(script,ctx);
  const samples=[{...item(1),embedUrl:`${SOURCE}/embed/example1`},{...item(2),embedUrl:`${SOURCE}/embed/example2`}];ctx.samples=samples;vm.runInContext('state.items=samples;state.byId=new Map(samples.map(x=>[x.id,x]));',ctx);
  function makeCard(id){const card=new Element('article');card.dataset.id=`video:${id}`;card.media=new Element();card.append(card.media);return card}
  return {ctx,makeCard,nodes};
}
test('inline player replaces its card thumbnail and switching destroys the first frame',async()=>{
  const {ctx,makeCard}=await inlineHarness();ctx.firstCard=makeCard(1);ctx.secondCard=makeCard(2);
  vm.runInContext('startInline(firstCard)',ctx);const first=vm.runInContext('state.active.frame',ctx);assert.equal(first.parent,ctx.firstCard.media);assert.equal(first.src,`${SOURCE}/embed/example1`);
  vm.runInContext('startInline(secondCard)',ctx);assert.equal(first.removed,true);assert.equal(vm.runInContext('state.active.frame.parent===secondCard.media',ctx),true);
  vm.runInContext('stopInline({focus:true})',ctx);assert.equal(vm.runInContext('state.active',ctx),null);assert.match(ctx.secondCard.media.innerHTML,/thumb-button/);
});
test('appending more cards preserves the active player',async()=>{
  const {ctx,makeCard,nodes}=await inlineHarness();ctx.firstCard=makeCard(2);vm.runInContext('startInline(firstCard);state.shown=1;',ctx);const frame=vm.runInContext('state.active.frame',ctx);
  vm.runInContext('render({append:true})',ctx);assert.equal(vm.runInContext('state.active.frame',ctx),frame);assert.notEqual(frame.removed,true);assert.match(nodes.get('grid').inserted,/grid:video:1/);
});
test('unavailable work shows a message inside the card without an iframe',async()=>{
  const {ctx,makeCard}=await inlineHarness();ctx.firstCard=makeCard(1);vm.runInContext('state.byId.get("video:1").availability="not_found";startInline(firstCard)',ctx);
  assert.equal(vm.runInContext('state.active.frame',ctx),null);assert.match(ctx.firstCard.media.innerHTML,/現在再生できません/);
});
