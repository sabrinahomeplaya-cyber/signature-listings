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

// Le prix et le prix barré s'écrivent $2,600,000 : la devise a sa propre case. Ce qui n'est pas un
// simple nombre (Price upon request, $2.5M, 1,000,000 MXN) reste tel qu'il est écrit.
function priceAmount(value) {
  const text = String(value || '').trim();
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
