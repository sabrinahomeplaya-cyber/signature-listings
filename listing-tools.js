// Ce que le générateur et la brochure doivent faire de la même façon. Deux copies divergent : la
// brochure a gardé cinq mois un modèle retiré, et les règles d'écriture n'existaient que d'un côté.

// Claude laisse parfois un vrai retour à la ligne dans un texte, ce que JSON interdit (« Bad control
// character in string literal ») : on le remet sous la forme permise, le texte reste le même.
function parseClaudeJson(text) {
  try { return JSON.parse(text); } catch (e) {
    return JSON.parse(text.replace(/"(?:[^"\\]|\\[\s\S])*"/g, s => s.replace(/[\u0000-\u001f]/g, c => ({ '\n': '\\n', '\r': '\\r', '\t': '\\t' })[c] || '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))));
  }
}

async function apiError(res) {
  const e = await res.json().catch(() => ({}));
  const detail = e?.error?.message || e?.error?.type || (typeof e?.error === 'string' ? e.error : '');
  if (e?.error?.unreadable) return new Error(detail);
  if (detail) return new Error(`Erreur API ${res.status} : ${detail}`);
  if (res.status === 504) return new Error('Le serveur a mis plus de 60 secondes à répondre. Réessayez dans un instant.');
  return new Error(`Erreur API ${res.status}`);
}

// L'année est une année, ou une case vide (sa règle du 06/11/2026) : « Ready to deliver » n'y a pas sa place
const yearOnly = y => (String(y || '').match(/\b(?:1[89]|20)\d{2}\b/) || [''])[0];

// Les photos d'une page publiée, dans l'ordre choisi. Les pages anciennes les nomment « ../photos/1.jpg ».
function publishedPhotos(html, pageUrl) {
  const m = html.match(/(?:\bimages\s*:|const photos\s*=)\s*\[([\s\S]*?)\]/);
  if (!m) return [];
  return [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map(x => { try { return new URL(JSON.parse('"' + x[1] + '"'), pageUrl).href; } catch (e) { return ''; } })
    .filter(u => /^https?:\/\//.test(u));
}

// La virgule des milliers et le point des centimes, dans toutes les langues : 1385 ou 1.385 donnent 1,385
function moneyNumber(number) {
  const [, whole, cents = ''] = number.replace(/ /g, '').match(/^(.*?)(?:[.,](\d{1,2}))?$/);
  return Number(whole.replace(/[.,]/g, '')).toLocaleString('en-US') + (/[1-9]/.test(cents) ? '.' + cents.padEnd(2, '0') : '');
}

// Le prix et le prix barré s'écrivent $2,600,000 : la devise a sa propre case, et Claude la recopie
// parfois dans le prix, d'où $2,450,000 USD USD sur la fiche. Ce qui n'est pas un simple nombre
// (Price upon request, $2.5M, un prix en MXN quand la case dit USD) reste tel qu'il est écrit.
function priceAmount(value, currency) {
  const code = /^[A-Z]{3}$/i.test(currency || '') ? currency : 'USD';
  const text = String(value || '').trim().replace(new RegExp(`\\s*${code}$`, 'i'), '');
  const m = text.match(/^\$?\s*(\d[\d ,.]*\d|\d)$/);
  return m ? '$' + moneyNumber(m[1]) : text;
}

// Les frais s'écrivent comme sur tous les listings : $1,385 MXN (sa règle du 06/11/2026). Seul l'exemple gris
// du champ le disait : 1385 tapé, ou lu sur le site d'origine, restait 1385. Sans devise, c'est du MXN. La
// période se retire, le libellé de la case la dit dans la bonne langue. Ce qui n'est pas un simple
// montant (N/A, $1,600 MXN + water) reste tel qu'il est écrit : on ne devine pas.
const FEE_PERIOD = /^[\s/.,-]*(?:(?:per|par|por|al|au|a)\s+)?(?:month(?:ly)?|year(?:ly)?|annual(?:ly)?|mo|yr|mois|mensuel(?:le)?|an(?:née)?|annuel(?:le)?|mes|mensual|año|anual)?[\s.]*$/i;
function feeAmount(value) {
  const text = String(value || '').trim();
  const m = text.match(/^(?:\$|(MXN|USD|CAD)\s*\$?)?\s*(\d[\d ,.]*\d|\d)\s*(MXN|USD|CAD|pesos?)?(.*)$/i);
  if (!m || !FEE_PERIOD.test(m[4])) return text;
  const [, before, number, after] = m;
  return `$${moneyNumber(number)} ${/^peso/i.test(after || '') ? 'MXN' : (after || before || 'MXN').toUpperCase()}`;
}

// Relit une page publiée par le générateur, champ par champ, sans Claude. Les cases de
// détails se reconnaissent à leur libellé, dans les trois langues : les pages anciennes
// n'ont ni les mêmes cases, ni le même ordre.
const DETAIL_LABELS = [
  ['beds', /^(chambres|bedrooms|recámaras|recamaras|habitaciones)/i],
  ['baths', /^(salles de bain|bathrooms|baños)/i],
  ['year', /^(année|year|año)/i],
  ['construction', /^(constru|living area|surface habitable|superficie habitable|área habitable)/i],
  ['lot', /^(terrain|lot|terreno)/i],
  ['predial', /(taxe|tax|predial)/i],
  ['hoa', /(frais mensuels|hoa|mantenimiento|maintenance|cuota)/i],
];

// pageUrl sert aux pages anciennes, qui nomment leurs photos « ../photos/1.jpg ».
// d.notes dit ce que le générateur ne sait pas refaire et qui disparaîtrait à la publication.
function parsePublished(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const text = el => el ? el.textContent.trim() : '';
  const list = re => { const m = html.match(re); return m ? [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => JSON.parse('"' + x[1] + '"')) : []; };
  const notes = [];
  const h1 = doc.querySelector('h1');
  const sub = h1 && h1.nextElementSibling;
  // Le libellé lui-même, pas le cadre qui l'entoure et dont le texte est le même
  const label = re => [...doc.querySelectorAll('div')].find(d => !d.children.length && re.test(text(d)));
  const priceLabel = label(/^(PRIX|PRICE|PRECIO)$/i);
  const splitPrice = s => { const m = s.match(/^(.*?)\s+([A-Z]{3})$/); return m ? [m[1], m[2]] : [s, '']; };
  const [price, currency] = splitPrice(text(priceLabel && priceLabel.nextElementSibling));
  // Une description écrite à la main en paragraphes : le texte se garde, pas le gras
  let description = text(doc.querySelector('.whitespace-pre-line'));
  if (!description) {
    const head = label(/^(DESCRIPTION|DESCRIPCIÓN)$/i);
    const box = head && head.parentElement.nextElementSibling;
    if (box) {
      box.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
      const paras = [...box.querySelectorAll('p')];
      description = (paras.length ? paras.map(p => p.textContent.trim()).join('\n\n') : box.textContent).replace(/[ \t]*\n[ \t]*/g, '\n').trim();
      if (box.querySelector('strong, b, em, a')) notes.push('La description perd sa mise en forme (gras, liens) : seul le texte est repris.');
    }
  }
  const d = {
    title: text(h1),
    preview: (html.match(/og:image" content="([^"]*\/apercu-[^"]*)"/) || [])[1] || '',
    subtitle: sub && sub.tagName === 'P' ? text(sub) : '',
    location: text(h1 && h1.previousElementSibling),
    price, currency: currency || 'USD',
    priceOld: splitPrice(text(doc.querySelector('.line-through')))[0],
    description,
    highlights: list(/(?:\bhighlights\s*:|const highlights\s*=)\s*\[([\s\S]*?)\]\s*[,;]/),
    images: publishedPhotos(html, pageUrl || location.href),
    labels: {}, // le libellé de chaque case tel qu'il est écrit sur cette page : le report s'en sert pour la retrouver
  };
  for (const cell of doc.querySelectorAll('.bg-neutral-50')) {
    if (cell.children.length !== 2) continue;
    const label = text(cell.children[0]), value = text(cell.children[1]);
    const hit = DETAIL_LABELS.find(([k, re]) => re.test(label) && d[k] === undefined);
    if (hit) { d[hit[0]] = value; d.labels[hit[0]] = label; }
    // Le prix au m² se recalcule ; le garage a été retiré du générateur
    else if (/\/\s*(m²|sq ft)/i.test(label)) d.labels.perArea = label;
    else if (value && !/^garage/i.test(label)) notes.push(`La case « ${label} : ${value} » n'existe pas dans le générateur : elle disparaîtra.`);
  }
  for (const [k] of DETAIL_LABELS) if (d[k] === undefined) d[k] = '';
  const ll = html.match(/maps\.google\.com\/maps\?ll=(-?[\d.]+),\s*(-?[\d.]+)/);
  d.lat = ll ? ll[1] : ''; d.lng = ll ? ll[2] : '';
  d.notes = notes;
  return d;
}
