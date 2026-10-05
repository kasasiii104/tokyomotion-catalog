import {PAGE_SIZE,escapeHTML as esc,safeUrl,stats,prepareItems,selectItems} from './catalog-core.mjs';
import {PreviewController,previewSpec} from './preview-controller.mjs';

const $=id=>document.getElementById(id);
function stored(key){try{const value=JSON.parse(localStorage.getItem(key)||'[]');return Array.isArray(value)?value.filter(x=>typeof x==='string'):[]}catch{return []}}
const state={items:[],byId:new Map(),favorites:new Set(stored('tm-favorites')),history:stored('tm-history'),view:'home',limit:PAGE_SIZE,shown:0,data:null,loading:false,watch:null,watchTimer:null,returnScroll:0,returnFocus:null,detailId:null};
const previews=new PreviewController();
function save(){try{localStorage.setItem('tm-favorites',JSON.stringify([...state.favorites]));localStorage.setItem('tm-history',JSON.stringify(state.history.slice(0,100)))}catch{}}
function playable(x){return !!safeUrl(x.embedUrl,'embed')&&!['not_found','unavailable'].includes(x.availability)}
function dateText(x){return (x.dateLabel||'日付不明')+(x.dateSource==='relative'?'頃':'')}
function statsMarkup(x){const s=stats(x);return `<div class="card-stats"><span class="views-stat">${esc(s.views)}</span><span class="rating-stat">${esc(s.rating)}</span></div>${s.votes?`<div class="vote-count">${esc(s.votes)}</div>`:''}`}
function thumbnail(x){
  const image=safeUrl(x.image,'image'),available=!!previewSpec(x);
  return `<button type="button" class="thumb-button" data-preview aria-label="${available?'画像プレビューを開始・停止':'プレビュー素材なし'}" aria-pressed="false" ${available?'':'aria-disabled="true"'}><span class="sr-only">${esc(x.title)}</span>${image?`<img src="${esc(image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`:'<span class="thumb-fallback">サムネイル未取得</span>'}<span class="preview-indicator" aria-hidden="true">${available?'画像プレビュー':'プレビューなし'}</span></button><button type="button" class="fav" data-fav aria-label="お気に入り" aria-pressed="${state.favorites.has(x.id)}">${state.favorites.has(x.id)?'♥':'♡'}</button>`;
}
function card(x,section){return `<article class="card" data-id="${esc(x.id)}" data-card="${esc(section+':'+x.id)}"><div class="media">${thumbnail(x)}</div><div class="card-body"><h3 class="card-title"><button type="button" data-detail>${esc(x.title)}</button></h3>${statsMarkup(x)}<div class="card-date">${esc(dateText(x))}</div><div class="card-actions"><button type="button" data-watch ${playable(x)?'':'disabled'}>▶ 本編を再生</button><button type="button" data-detail>詳細</button></div></div></article>`}
function bindImages(root){root.querySelectorAll('img:not([data-bound])').forEach(img=>{img.dataset.bound='1';const fail=()=>{if(!img.isConnected)return;img.classList.add('image-failed');img.alt='画像を読み込めません'};img.addEventListener('error',fail);img.addEventListener('load',()=>img.classList.remove('image-failed'));if(img.complete&&!img.naturalWidth)fail()})}
function togglePreview(cardEl){
  const item=state.byId.get(cardEl.dataset.id),spec=item&&previewSpec(item);
  const button=cardEl.querySelector('[data-preview]'),label=button.querySelector('.preview-indicator'),img=button.querySelector('img');
  if(!spec||!img){label.textContent='プレビュー素材なし';return}
  const poster=img.src;
  previews.toggle(cardEl.dataset.card,spec,{
    onFrame:(url,index)=>{img.src=url;button.dataset.frame=String(index+1)},
    onReset:()=>{img.src=poster;delete button.dataset.frame},
    onState:status=>{button.dataset.state=status;const running=['playing','loading'].includes(status);button.setAttribute('aria-pressed',String(running));button.setAttribute('aria-label',running?'画像プレビューを停止':'画像プレビューを開始');label.textContent=({idle:'画像プレビュー',loading:'読み込み中 · タップで停止',playing:'タップで停止',paused:'停止中 · タップで再開',error:'読込失敗 · タップで再試行'})[status];cardEl.classList.toggle('is-previewing',running)}
  });
}
function description(x){return x.description||'公式の説明文は未取得です。作品の公開情報は公式ページでも確認できます。'}
function sourceLink(x){const url=safeUrl(x.sourceUrl,'source');return url?`<a class="source-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">公式ページ ↗</a>`:''}
function favoriteButton(x){return `<button type="button" class="secondary-button" data-fav aria-pressed="${state.favorites.has(x.id)}">${state.favorites.has(x.id)?'♥ お気に入り済み':'♡ お気に入り'}</button>`}
function detailMarkup(x){
  const image=safeUrl(x.image,'image');
  return `<div data-item="${esc(x.id)}" data-id="${esc(x.id)}"><div class="detail-art">${image?`<img src="${esc(image)}" alt="" referrerpolicy="no-referrer">`:'<span class="thumb-fallback">サムネイル未取得</span>'}<span class="detail-kicker">作品の詳細</span></div><div class="detail-body"><h2 id="detail-title">${esc(x.title)}</h2>${statsMarkup(x)}<p class="detail-date">${esc(dateText(x))}</p><div class="detail-actions"><button class="primary-button" data-watch ${playable(x)?'':'disabled'}>▶ 本編を再生</button>${favoriteButton(x)}</div>${!playable(x)?'<p class="availability-note">公式埋め込みが未取得、または現在利用できない作品です。</p>':''}<p class="description">${esc(description(x))}</p>${x.categories.length?`<div class="tags">${x.categories.map(c=>`<span>${esc(c)}</span>`).join('')}</div>`:''}<div class="detail-source">${sourceLink(x)}<span>数字は最終取得時点の公式掲載値です。</span></div></div></div>`;
}
function openDetails(item,trigger){previews.stop();state.detailId=item.id;state.returnFocus=trigger;$('detail-content').innerHTML=detailMarkup(item);bindImages($('detail-content'));$('details').showModal()}
function closeDetails({focus=true}={}){if($('details').open)$('details').close();state.detailId=null;if(focus)state.returnFocus?.focus()}
function clearWatch(){clearTimeout(state.watchTimer);state.watchTimer=null;$('watch-media').replaceChildren();state.watch=null}
function showBrowse({restore=true}={}){if(!state.watch)return;clearWatch();$('watch-view').hidden=true;$('browse-view').hidden=false;if(restore){window.scrollTo({top:state.returnScroll,behavior:'instant'});state.returnFocus?.focus({preventScroll:true})}}
function mountPlayer(item){
  clearTimeout(state.watchTimer);$('watch-media').replaceChildren();
  if(!playable(item)){$('watch-status').textContent='現在、公式埋め込みを利用できません。';return}
  const frame=document.createElement('iframe');frame.src=safeUrl(item.embedUrl,'embed');frame.title='本編の公式プレイヤー';frame.allow='autoplay; fullscreen; picture-in-picture; encrypted-media';frame.allowFullscreen=true;frame.referrerPolicy='strict-origin-when-cross-origin';
  $('watch-status').textContent='公式プレイヤーを読み込んでいます…';
  frame.addEventListener('load',()=>{if(state.watch!==item.id)return;clearTimeout(state.watchTimer);$('watch-status').textContent='プレイヤー内の▶で再生できます。公式側の制限や通信状況によって再生できない場合があります。'},{once:true});
  $('watch-media').append(frame);
  state.watchTimer=setTimeout(()=>{if(state.watch===item.id)$('watch-status').textContent='読み込みに時間がかかっています。再読み込み、または公式ページでご確認ください。'},12000);
}
function openWatch(item,trigger){
  if(!playable(item))return;
  previews.stop();if(!state.watch)state.returnScroll=window.scrollY;
  if(!$('details').open)state.returnFocus=trigger;
  closeDetails({focus:false});clearWatch();state.watch=item.id;
  $('browse-view').hidden=true;$('watch-view').hidden=false;$('watch-title').textContent=item.title;
  $('watch-info').innerHTML=`<div data-item="${esc(item.id)}" data-id="${esc(item.id)}">${statsMarkup(item)}<p class="detail-date">${esc(dateText(item))}</p><div class="watch-actions">${favoriteButton(item)}${sourceLink(item)}</div><p class="description">${esc(description(item))}</p></div>`;
  mountPlayer(item);state.history=[item.id,...state.history.filter(x=>x!==item.id)].slice(0,100);save();window.scrollTo({top:0,behavior:'instant'});$('watch-back').focus({preventScroll:true});
}
function currentList(){return selectItems(state.items,{query:$('q').value,category:$('category').value,view:state.view,sort:$('sort').value,favorites:state.favorites,history:state.history})}
function render({append=false}={}){
  const list=currentList(),visible=list.slice(0,state.limit);
  if(append){$('grid').insertAdjacentHTML('beforeend',visible.slice(state.shown).map(x=>card(x,'grid')).join(''))}
  else{
    previews.stop();
    $('grid').innerHTML=visible.length?visible.map(x=>card(x,'grid')).join(''):`<div class="empty">${state.view==='favorites'?'お気に入りはまだありません。カードの♡で追加できます。':state.view==='history'?'再生履歴はまだありません。':'条件に一致する作品がありません。'}</div>`;
    const showShelf=state.view==='home'&&!$('q').value.trim()&&!$('category').value&&$('sort').value==='new'&&state.items.length>0;
    $('hero').hidden=!showShelf;$('shelf-section').hidden=!showShelf;$('shelf').innerHTML=showShelf?selectItems(state.items,{view:'popular'}).slice(0,10).map(x=>card(x,'shelf')).join(''):'';
    const names={home:'新着の作品',recent:'新着の作品',popular:'人気の作品',rated:'高評価の作品',archive:'過去の作品',favorites:'お気に入り',history:'再生履歴'};
    const sorts={new:'新着の作品',old:'過去の作品',views:'再生数の多い作品',rating:'高評価の作品',title:'作品一覧'};
    $('section-title').textContent=$('q').value.trim()?'検索結果':state.view==='home'?sorts[$('sort').value]:names[state.view];
    document.querySelectorAll('[data-view]').forEach(el=>{const active=el.dataset.view===state.view;el.classList.toggle('active',active);el.setAttribute('aria-pressed',String(active))});
  }
  state.shown=visible.length;$('count').textContent=`${list.length.toLocaleString('ja-JP')}件 · ${visible.length}件を表示`;$('more').hidden=visible.length>=list.length;bindImages($('main'));
  if(state.data){const d=state.data,date=d.updatedAt?new Date(d.updatedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}):'未更新';$('catalog-status').textContent=`最終取得 ${date}（日本時間） · 日本語タイトルのみ`+(d.backfill?` · 過去作品 ${d.backfill.complete?'巡回完了':'次回'+d.backfill.nextPage+'ページ目から'}`:'')}
}
function setView(view){showBrowse({restore:false});state.view=view;state.limit=PAGE_SIZE;$('q').value='';$('category').value='';$('sort').value=({archive:'old',popular:'views',rated:'rating'})[view]||'new';setMenu(false);render()}
function setMenu(open){$('sidebar').classList.toggle('open',open);$('nav-backdrop').hidden=!open;$('menu-toggle').setAttribute('aria-expanded',String(open));$('menu-toggle').setAttribute('aria-label',open?'メニューを閉じる':'メニューを開く')}
function toggleFavorite(item){
  state.favorites.has(item.id)?state.favorites.delete(item.id):state.favorites.add(item.id);save();
  if(state.view==='favorites'&&!state.watch)render();
  document.querySelectorAll('[data-id]').forEach(el=>{if(el.dataset.id!==item.id)return;const button=el.querySelector('[data-fav]');if(!button)return;const favorite=state.favorites.has(item.id);button.setAttribute('aria-pressed',String(favorite));button.textContent=button.classList.contains('fav')?(favorite?'♥':'♡'):(favorite?'♥ お気に入り済み':'♡ お気に入り')});
}
async function load(){
  if(state.loading)return;state.loading=true;$('refresh').disabled=true;$('notice').hidden=true;
  try{
    const response=await fetch('data/videos.json?ts='+Date.now(),{cache:'no-store'});if(!response.ok)throw new Error('一覧を取得できませんでした（HTTP '+response.status+'）');
    const data=await response.json();if(!Array.isArray(data.items))throw new Error('カタログの形式が不正です。');
    previews.stop();state.data=data;state.items=prepareItems(data.items);state.byId=new Map(state.items.map(x=>[x.id,x]));
    const previous=$('category').value,categories=[...new Set(state.items.flatMap(x=>x.categories))].sort((a,b)=>a.localeCompare(b,'ja'));
    $('category').innerHTML='<option value="">すべてのカテゴリ</option>'+categories.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('');if(categories.includes(previous))$('category').value=previous;render();
    if(state.detailId){const x=state.byId.get(state.detailId);if(x)$('detail-content').innerHTML=detailMarkup(x);else closeDetails()}
    if(state.watch&&!playable(state.byId.get(state.watch)||{}))showBrowse();
    if(data.errors?.length||data.updatedAt&&Date.now()-Date.parse(data.updatedAt)>3*3600000){$('notice').textContent='一部の取得失敗または更新の遅れがあります。最終取得時点の情報を表示しています。';$('notice').hidden=false}
  }catch(error){$('notice').textContent=error.message;$('notice').hidden=false;if(!state.items.length){$('count').textContent='読み込みに失敗しました';$('grid').innerHTML='<div class="empty">右上の更新ボタンで再度読み込めます。</div>';$('hero').hidden=true;$('shelf-section').hidden=true}}
  finally{state.loading=false;$('refresh').disabled=false}
}
document.addEventListener('click',event=>{
  const view=event.target.closest('[data-view]');if(view){setView(view.dataset.view);return}
  const el=event.target.closest('[data-card],[data-item]');if(!el)return;
  const item=state.byId.get(el.dataset.id);if(!item)return;
  if(event.target.closest('[data-fav]')){toggleFavorite(item);return}
  if(event.target.closest('[data-watch]')){openWatch(item,event.target.closest('button'));return}
  if(event.target.closest('[data-detail]')){openDetails(item,event.target.closest('button'));return}
  if(event.target.closest('[data-preview]'))togglePreview(el);
});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){previews.pause();setMenu(false)}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)previews.pause()});
$('detail-close').addEventListener('click',()=>closeDetails());
$('details').addEventListener('click',event=>{if(event.target===$('details'))closeDetails()});
$('details').addEventListener('close',()=>{state.detailId=null});
$('watch-back').addEventListener('click',()=>{showBrowse();if(state.view==='history'||state.view==='favorites')render()});
$('watch-retry').addEventListener('click',()=>{const x=state.byId.get(state.watch);if(x)mountPlayer(x)});
let searchTimer;
function applySearch(){clearTimeout(searchTimer);showBrowse({restore:false});state.limit=PAGE_SIZE;render()}
$('q').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(applySearch,150)});
$('search-form').addEventListener('submit',event=>{event.preventDefault();applySearch()});
$('category').addEventListener('change',applySearch);
$('sort').addEventListener('change',()=>{state.view='home';applySearch()});
$('more').addEventListener('click',()=>{state.limit+=PAGE_SIZE;render({append:true})});
$('refresh').addEventListener('click',load);
$('browse-new').addEventListener('click',()=>setView('recent'));
$('all-popular').addEventListener('click',()=>setView('popular'));
$('menu-toggle').addEventListener('click',()=>setMenu(!$('sidebar').classList.contains('open')));
$('nav-backdrop').addEventListener('click',()=>setMenu(false));
window.addEventListener('pagehide',()=>{previews.stop();clearWatch()});
window.addEventListener('pageshow',()=>{if(!$('watch-view').hidden&&!state.watch){$('watch-view').hidden=true;$('browse-view').hidden=false}});
load();
