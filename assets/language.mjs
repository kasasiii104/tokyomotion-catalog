export const LANGUAGE_POLICY_VERSION = 1;

// Conservative title-language policy. It does not infer spoken language or translate.
export function classifyTitle(value) {
  const title=String(value||'').normalize('NFKC').replace(/<[^>]*>/g,' ').trim();
  if(!title)return {keep:false,language:'unknown',reason:'missing_title'};
  const chinese=/[这们么说让给为动话欢实边听观爱带并从对吗别还过时样应种开谁]/u.test(title)
    ||/(?:中文|汉语|漢語|普通话|普通話|国语|國語|简体|簡體|繁体|繁體|这个|這個|我们|我們|没有|沒有|网友|網友|小姐姐|小哥哥|來自|来自|觀看|观看|合集)/u.test(title);
  if(chinese)return {keep:false,language:'zh',reason:'chinese_title'};
  if(/[\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Thai}]/u.test(title))return {keep:false,language:'other',reason:'non_japanese_title'};
  const kana=(title.match(/[\u3041-\u3096\u30a1-\u30fa]/g)||[]).length;
  const han=(title.match(/\p{Script=Han}/gu)||[]).length;
  // Catalog numbers, quality labels and product identifiers are not English prose.
  const prose=title.replace(/\b(?:FC2[-\s]*PPV[-\s]*\d+|[A-Z]{2,10}[-_]?\d{2,}|(?:F?HD|UHD|SD|VR|DVD|MP4|WMV|AVI|IPPA|\d+[KkPp]))\b/gi,' ');
  const latin=(prose.match(/[A-Za-z]/g)||[]).length;
  const words=(prose.match(/\b[A-Za-z]{2,}\b/g)||[]).length;
  if(!kana)return {keep:false,language:han?'unknown':latin?'en':'unknown',reason:han?'han_only_ambiguous':latin?'english_title':'unverified_title'};
  if(words>=4&&latin/(latin+kana+han)>.55)return {keep:false,language:'en',reason:'english_dominant_title'};
  return {keep:true,language:'ja',reason:'japanese_title'};
}

export function filterJapanese(items) {
  const accepted=[],rejected=[];
  for(const item of items||[]) {
    const decision=classifyTitle(item.title);
    if(decision.keep)accepted.push({...item,titleLanguage:'ja',languagePolicyVersion:LANGUAGE_POLICY_VERSION});
    else rejected.push({videoId:String(item.videoId||item.id||''),reason:decision.reason});
  }
  return {accepted,rejected};
}
