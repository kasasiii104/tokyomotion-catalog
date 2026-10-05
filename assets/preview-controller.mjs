import {safeUrl} from './catalog-core.mjs';

// Expand only a frame sequence explicitly declared by the official page.
export function previewSpec(item) {
  const p=item.preview;
  if(!p||p.type!=='images'||p.source!=='official_thumbnail_rotation'||['unavailable','not_found'].includes(item.availability))return null;
  const base=safeUrl(p.baseUrl,'image');
  if(!base||!/^\d+$/.test(String(item.videoId))||!new RegExp(`/media/videos/tmb\\d*/${item.videoId}/$`).test(new URL(base).pathname))return null;
  if(new URL(base).search||new URL(base).hash||!Number.isInteger(p.count)||p.count<2||p.count>40)return null;
  return {urls:Array.from({length:p.count},(_,i)=>base+(i+1)+'.jpg'),interval:700};
}

export function loadImage(url,signal) {
  return new Promise((resolve,reject)=>{
    const img=new Image();let settled=false;
    const finish=error=>{if(settled)return;settled=true;img.onload=img.onerror=null;signal?.removeEventListener('abort',abort);error?reject(error):resolve(url)};
    const abort=()=>{finish(new Error('aborted'));img.src=''};
    img.referrerPolicy='no-referrer';img.decoding='async';
    img.onload=()=>finish();img.onerror=()=>finish(new Error('image_unavailable'));
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return}img.src=url;
  });
}

export class PreviewController {
  constructor({load=loadImage,schedule=setTimeout,cancel=clearTimeout}={}) {this.load=load;this.schedule=schedule;this.cancel=cancel;this.active=null}
  toggle(key,spec,callbacks) {
    if(this.active?.key===key){if(this.active.playing)this.pause();else this.resume();return}
    this.stop();
    if(!spec?.urls?.length)return;
    this.active={key,spec,...callbacks,index:-1,failures:0,playing:false,timer:null,request:null,token:0};
    this.resume();
  }
  resume() {
    const a=this.active;if(!a||a.playing)return;
    a.playing=true;a.failures=0;a.onState?.('loading');void this.step(a);
  }
  pause() {
    const a=this.active;if(!a)return;
    a.playing=false;a.token++;this.cancel(a.timer);a.timer=null;a.request?.abort();a.request=null;a.onState?.('paused');
  }
  stop() {
    const a=this.active;if(!a)return;
    this.pause();this.active=null;a.onReset?.();a.onState?.('idle');
  }
  async step(a) {
    if(this.active!==a||!a.playing)return;
    const token=++a.token,request=new AbortController();a.request=request;
    a.index=(a.index+1)%a.spec.urls.length;
    const timeout=this.schedule(()=>request.abort(),8000);
    try {
      await this.load(a.spec.urls[a.index],request.signal);
      if(this.active!==a||!a.playing||a.token!==token)return;
      a.failures=0;a.onFrame?.(a.spec.urls[a.index],a.index);a.onState?.('playing');
    } catch {
      if(this.active!==a||!a.playing||a.token!==token)return;
      a.failures++;
      if(a.failures>=Math.min(3,a.spec.urls.length)){a.playing=false;a.onState?.('error');return}
    } finally {this.cancel(timeout);if(a.request===request)a.request=null}
    if(this.active===a&&a.playing)a.timer=this.schedule(()=>void this.step(a),a.spec.interval);
  }
}
