import { classifyTitle } from './language.mjs';
import { auditContent } from './content-filter.mjs';
export const PAGE_SIZE=36;
export const number=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
export const escapeHTML=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function safeUrl(value,kind){try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password)return '';if(kind==='image')return /(^|\.)(tokyomotion|tokyo-motion)\.net$/i.test(u.hostname)?u.href:'';if(!['www.tokyomotion.net','tokyomotion.net'].includes(u.hostname))return '';if(kind==='embed'&&!/^\/embed\/[A-Za-z0-9_-]+$/.test(u.pathname))return '';if(kind==='source'&&!/^\/video\/\d+(?:\/|$)/.test(u.pathname))return '';return u.href}catch{return ''}}
export function ratingValue(x){if(x.statsVersion===2&&number(x.likes)&&number(x.dislikes))return x.likes+x.dislikes>0?100*x.likes/(x.likes+x.dislikes):-1;return number(x.ratingPercent)&&x.ratingPercent<=100?x.ratingPercent:-1}
export function stats(x){const views=(x.statsVersion===2||x.listingCheckedAt)&&number(x.views)?x.views.toLocaleString('ja-JP')+'回再生':'再生数 未取得';const rating=ratingValue(x);const votes=x.statsVersion===2&&number(x.likes)&&number(x.dislikes)?'高評価 '+x.likes.toLocaleString('ja-JP')+' / 低評価 '+x.dislikes.toLocaleString('ja-JP'):'';return {views,rating:rating>=0?'高評価 '+Math.round(rating)+'%':votes?'評価なし':'評価 未取得',votes}}
export function prepareItems(items,excludedItems){return auditContent(items||[],excludedItems).accepted.filter(x=>classifyTitle(x.title).keep).map(x=>({...x,id:String(x.id),title:String(x.title||''),categories:Array.isArray(x.categories)?x.categories:[]}))}
export function isListed(x){return !['not_found','unavailable'].includes(x.availability)}
export function catalogInfo(data, items, {listed, total} = {}) {
  const updatedAt = data?.updatedAt;
  const date = typeof updatedAt === 'string' ? new Date(updatedAt) : new Date(NaN);
  const updatedText = Number.isNaN(date.getTime()) ? '未更新' : date.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
  listed = Number.isFinite(listed) ? listed : items.filter(isListed).length;
  total = Number.isFinite(total) ? total : items.length;
  let text = `最終更新 ${updatedText}（日本時間） · 収録 ${listed.toLocaleString('ja-JP')}件`;
  if (total > listed) text += `（削除・非公開を除く。総数 ${total.toLocaleString('ja-JP')}件）`;
  return {updatedText, listed, total, text};
}
export function firstSeenMs(x){
  return typeof x.firstSeenAt==='string'?Date.parse(x.firstSeenAt):NaN;
}
export function visitBaseline({last,session},now){
  const value=session??last??'none';
  const timestamp=typeof value==='string'&&value.trim()?Number(value):NaN;
  return {baseline:Number.isFinite(timestamp)?timestamp:null,session:value,last:String(now)};
}
export function isNewSince(x,since){
  return typeof since==='number'&&firstSeenMs(x)>since;
}
function compareNewest(a,b){
  if(!a.date||!b.date)return (!a.date)-(!b.date)||Number(b.videoId)-Number(a.videoId);
  return b.date-a.date||Number(b.videoId)-Number(a.videoId);
}
export function selectItems(items,{query='',category='',view='home',sort='new',favorites=new Set(),history=[],since=null}={}){const q=query.trim().toLocaleLowerCase('ja-JP');const historyOrder=new Map(history.map((id,i)=>[id,i]));const includeUnlisted=view==='favorites'||view==='history';const out=items.filter(x=>(includeUnlisted||isListed(x))&&(view!=='since'||isNewSince(x,since))&&(!q||[x.title,...x.categories].join(' ').toLocaleLowerCase('ja-JP').includes(q))&&(!category||x.categories.includes(category))&&(view!=='favorites'||favorites.has(x.id))&&(view!=='history'||historyOrder.has(x.id)));const mode=({popular:'views',rated:'rating',archive:'old',recent:'new',since:'new',history:'history'})[view]||sort;out.sort((a,b)=>{if(mode==='history')return historyOrder.get(a.id)-historyOrder.get(b.id);if(mode==='views')return (number(b.views)?b.views:-1)-(number(a.views)?a.views:-1)||compareNewest(a,b);if(mode==='rating')return ratingValue(b)-ratingValue(a)||compareNewest(a,b);if(mode==='title')return a.title.localeCompare(b.title,'ja');if(!a.date||!b.date)return (!a.date)-(!b.date)||Number(b.videoId)-Number(a.videoId);return mode==='old'?a.date-b.date||Number(a.videoId)-Number(b.videoId):b.date-a.date||Number(b.videoId)-Number(a.videoId)});return out}
