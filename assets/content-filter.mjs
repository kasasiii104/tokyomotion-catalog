// Shared by collection, one-off cleanup and the browser. Match explicit metadata,
// never infer a category from an image or a person's appearance.
export const CONTENT_POLICY_VERSION = 1;
const REASONS = new Set(['fc2ppv', 'otokonoko']);
const GAP = '[\\s\\p{P}\\p{S}]*';
const FC2PPV = new RegExp(`(?:^|[^a-z0-9])f${GAP}c${GAP}2${GAP}(?:p${GAP}p${GAP}v(?![a-z])|[0-9]{5,}(?![0-9]))`, 'iu');
const OTOKONOKO = new RegExp(`(?:男|[おオ]${GAP}[とト]${GAP}[こコ])${GAP}[のノ]${GAP}娘|(?:^|[^a-z0-9])(?:otoko${GAP}no${GAP}ko|fem${GAP}boys?)(?![a-z0-9])`, 'iu');

function normalize(value) {
  return String(value || '').replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (all, n) => {
    const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  }).replace(/&(?:nbsp|amp|lt|gt|quot|apos);/gi, ' ')
    .normalize('NFKC').replace(/\p{Cf}/gu, '').toLowerCase();
}

export function contentId(item) {
  const value = String(item?.videoId || item?.id || '').replace(/^video:/, '');
  return /^\d+$/.test(value) ? value : '';
}

export function contentExclusionReasons(item = {}) {
  const fields = [item.title, item.description,
    ...(Array.isArray(item.categories) ? item.categories : []),
    ...(Array.isArray(item.tags) ? item.tags : [])].filter(x => typeof x === 'string').map(normalize);
  const reasons = new Set((Array.isArray(item.contentExclusions) ? item.contentExclusions : []).filter(x => REASONS.has(x)));
  if (fields.some(x => FC2PPV.test(x))) reasons.add('fc2ppv');
  if (fields.some(x => OTOKONOKO.test(x))) reasons.add('otokonoko');
  return [...reasons].sort();
}

export function auditContent(items = [], previousExclusions = []) {
  const excluded = new Map();
  function remember(item, reasons) {
    const id = contentId(item);
    if (id && reasons.length) excluded.set(id, [...new Set([...(excluded.get(id) || []), ...reasons])].sort());
  }
  for (const row of previousExclusions || []) remember(row, (row.reasons || []).filter(x => REASONS.has(x)));
  // Audit all versions before accepting any: a generic RSS title must not hide
  // a blocked label already seen on a listing or an earlier detail page.
  for (const item of items) remember(item, contentExclusionReasons(item));
  const accepted = [], rejected = new Map();
  for (const item of items) {
    const id = contentId(item), reasons = excluded.get(id) || contentExclusionReasons(item);
    if (reasons.length) rejected.set(id || item.id, {videoId: id, reasons});
    else accepted.push(item);
  }
  return {accepted, rejected: [...rejected.values()], excludedItems: [...excluded].sort(([a], [b]) => Number(a) - Number(b)).map(([videoId, reasons]) => ({videoId, reasons}))};
}
