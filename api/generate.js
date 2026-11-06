import { locked } from './_auth.js';

export const config = {
  maxDuration: 120
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (locked(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const body = req.body;
    const userMessage = body.messages?.[0]?.content || '';
    // noFetch : le générateur envoie déjà le texte à traduire, aucune page à lire
    const urlMatch = body.noFetch ? null : userMessage.match(/https?:\/\/[^\s]+/);
    const listingUrl = urlMatch ? urlMatch[0] : null;

    let pageContent = '';
    let photos = null;

    if (listingUrl) {
      try {
        const pageResponse = await fetch(listingUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(15000)
        });

        if (pageResponse.ok) {
          const html = await pageResponse.text();
          const imageUrls = new Set();

          // ── 1. Liens <a href="..."> directs vers images (Howes Realty pattern) ──
          const aHrefRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
          let m;
          while ((m = aHrefRegex.exec(html)) !== null) {
            if (isValidPhoto(m[1])) imageUrls.add(m[1]);
          }

          // ── 2. src="..." dans <img> ──
          const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
          while ((m = imgRegex.exec(html)) !== null) {
            const src = m[1];
            // ShortPixel : extraire la vraie URL depuis sp-ao.shortpixel.ai/client/.../https://...
            const spMatch = src.match(/https?:\/\/[^/]+shortpixel[^/]*\/[^/]+\/(https?:\/\/.+)/i);
            if (spMatch) {
              const realUrl = decodeURIComponent(spMatch[1]);
              if (isValidPhoto(realUrl)) imageUrls.add(realUrl);
            } else if (isValidPhoto(src)) {
              imageUrls.add(src);
            }
          }

          // ── 3. data-src="..." (lazy loading) ──
          const dataSrcRegex = /data-src=["']([^"']+)["']/gi;
          while ((m = dataSrcRegex.exec(html)) !== null) {
            const spMatch = m[1].match(/https?:\/\/[^/]+shortpixel[^/]*\/[^/]+\/(https?:\/\/.+)/i);
            if (spMatch) {
              const realUrl = decodeURIComponent(spMatch[1]);
              if (isValidPhoto(realUrl)) imageUrls.add(realUrl);
            } else if (isValidPhoto(m[1])) {
              imageUrls.add(m[1]);
            }
          }

          // ── 4. srcset ──
          const srcsetRegex = /srcset=["']([^"']+)["']/gi;
          while ((m = srcsetRegex.exec(html)) !== null) {
            for (const part of m[1].split(',')) {
              const url = part.trim().split(/\s+/)[0];
              if (isValidPhoto(url)) imageUrls.add(url);
            }
          }

          // ── 5. og:image meta ──
          const metaRegex = /<meta[^>]+content=["']([^"']+)["'][^>]*>/gi;
          while ((m = metaRegex.exec(html)) !== null) {
            if (isValidPhoto(m[1])) imageUrls.add(m[1]);
          }

          // ── 6. Images dans les arrays JS inline (listing.images, data.images, etc.) ──
          const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
          let sm;
          while ((sm = scriptRegex.exec(html)) !== null) {
            const scriptContent = sm[1];
            const urlInJsRegex = /"(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi;
            let um;
            while ((um = urlInJsRegex.exec(scriptContent)) !== null) {
              if (isValidPhoto(um[1])) imageUrls.add(um[1]);
            }
          }

          photos = onePerPhoto([...imageUrls]);

          // ── 7. Highlights depuis l'objet JS inline (listing.signature-sc.com) ──
          let inlineHighlights = [];
          // Pattern A: const listing = { ... highlights: [...] }
          const hlPatternA = html.match(/const listing\s*=\s*\{[\s\S]*?highlights\s*:\s*\[([\s\S]*?)\]/);
          // Pattern B: const highlights = [...]
          const hlPatternB = html.match(/const highlights\s*=\s*\[([\s\S]*?)\];/);
          const hlScriptMatch = hlPatternA || hlPatternB;
          if (hlScriptMatch) {
            const hlRaw = hlScriptMatch[1];
            const hlItems = hlRaw.match(/"([^"]+)"/g);
            if (hlItems) inlineHighlights = hlItems.map(s => s.replace(/^"|"$/g, ''));
          }

          // ── Nettoyer le HTML en texte ──
          const textContent = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 12000);

          const highlightsSection = inlineHighlights.length > 0
            ? `\n\n=== HIGHLIGHTS OBLIGATOIRES (copie exacte, aucune modification) ===\n` + inlineHighlights.map(h => `- ${h}`).join('\n')
            : '';

          // Les photos ne passent plus par Claude : les lui faire recopier une à une
          // dépassait les 60 secondes (1 129 URLs sur un listing Christie's).
          pageContent = textContent + highlightsSection;
        }
      } catch (fetchErr) {
        console.error('Page fetch error:', fetchErr.message);
      }
    }

    // Une page illisible ne part pas chez Claude : il répondrait en phrases, sans JSON, et
    // l'écran dirait « Aucun JSON trouvé ». Properstar la garde derrière un défi que seul
    // un navigateur passe (403 ici), et rien ne doit chercher à le contourner.
    if (listingUrl && !pageContent) {
      const site = listingUrl.replace(/^https?:\/\/(www\.)?/i, '').split('/')[0];
      return res.status(422).json({ error: { unreadable: true, message: `Ce site (${site}) ne laisse pas lire ses pages automatiquement. Cherche la même annonce sur le site de l'agence et colle ce lien-là.` } });
    }

    const userText = pageContent
        ? `Voici le contenu de la page (URL: ${listingUrl}):\n\n${pageContent}\n\n---\n\nExtrait les informations et retourne le JSON.\n- Laisse le champ "images" vide ([]) : les photos sont ajoutées par le serveur.\n- Si une section "HIGHLIGHTS OBLIGATOIRES" est présente, tu DOIS reprendre ces highlights un par un dans le champ "highlights" du JSON, dans le même ordre, sans en ajouter, en retirer ni en reformuler aucun. S'ils ne sont pas dans la langue demandée, traduis-les fidèlement.`
        : (body.messages?.[0]?.content || '');

    // Claude regarde quelques photos avant d'écrire : l'annonce d'origine ne dit souvent rien des
    // matériaux ni du style, et c'est ce qui distingue un bien d'un autre (Casa Noy, Casa Viva).
    const seen = body.readPhotos && photos ? await photosToRead(photos) : [];
    const textOnly = [{ role: 'user', content: userText }];
    const enhancedMessages = seen.length
      ? [{ role: 'user', content: [...seen, { type: 'text', text: userText }] }]
      : textOnly;

    const claudeBody = {
      model: body.model || 'claude-sonnet-5',
      max_tokens: body.max_tokens || 8000,
      system: body.system || '',
      messages: enhancedMessages
    };

    const ask = messages => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ ...claudeBody, messages })
    });

    let response = await ask(enhancedMessages);
    let photosRead = seen.length;
    // Une photo refusée ne doit pas priver du listing : on repart sur le texte seul
    if (seen.length && (response.status === 400 || response.status === 413)) {
      console.error('Photos refusées par Claude :', response.status);
      response = await ask(textOnly);
      photosRead = 0;
    }

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    if (photos) data.images = photos;
    data.photosRead = photosRead;
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// WordPress publie chaque photo en plusieurs tailles (105x70, 300x200, ..., 1536x1025,
// l'original, et leurs copies .jpg.webp) : une seule URL par photo, la plus grande
// qui ne dépasse pas 2000 px de large, sinon l'original. La même photo revient aussi
// avec ou sans « www. » et avec un « #imageobject » en suffixe.
// Une copie dont le grand côté fait moins de 1200 px ne remplace jamais l'original :
// Casa Rapha n'exposait que 374x240 et l'original de 2048 px, et la vignette était partie.
// La taille peut aussi venir après le nom du fichier : Villa Noy (Squarespace) donnait chaque
// photo en huit versions, de « ?format=100w » à l'original, et 22 photos en faisaient 176.
function onePerPhoto(urls) {
  const size = u => {
    const m = u.match(/-(\d+)x(\d+)\.(?:jpe?g|png|webp)/i);
    if (m) return m;
    const q = u.match(/[?&](?:format|w|width)=(\d+)w?(?:&|$)/i);
    return q && [q[0], q[1], q[1]];
  };
  const width = u => { const m = size(u); return m ? +m[1] : Infinity; };
  const longSide = u => { const m = size(u); return m ? Math.max(+m[1], +m[2]) : Infinity; };
  const groups = new Map();
  for (const raw of urls) {
    const url = raw.replace(/&amp;/g, '&').replace(/#.*$/, '');
    const key = url.replace(/\?.*$/, '').replace(/^https?:\/\/(www\.)?/i, '').replace(/\.(jpe?g|png)\.webp/i, '.$1').replace(/-\d+x\d+(\.(?:jpe?g|png|webp))/i, '$1');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(url);
  }
  return [...groups.values()].map(variants => {
    const plain = variants.filter(u => !/\.(jpe?g|png)\.webp/i.test(u));
    const pool = plain.length ? plain : variants;
    // Squarespace plafonne à 2500 px et reste léger (526 Ko à Villa Noy, l'original lui-même) :
    // la limite de 2000 px protège des originaux WordPress, qui pèsent plusieurs Mo
    const sized = pool.filter(u => width(u) <= (/[?&]format=/i.test(u) ? 2500 : 2000)).sort((a, b) => width(b) - width(a));
    // Une photo qui n'existe qu'en vignette (105x70) est celle d'un AUTRE bien du site
    if (pool.every(u => width(u) < 400)) return null;
    const original = pool.find(u => !size(u));
    if (sized[0] && (longSide(sized[0]) >= 1200 || !original)) return sized[0];
    return original || pool[0];
  }).filter(Boolean);
}

// Huit photos réparties sur l'annonce, pour voir la façade, les pièces et le jardin plutôt que les
// huit premières d'un même salon. Une photo illisible ou trop lourde est simplement laissée de côté.
const PHOTOS_TO_READ = 8;
const MAX_READ_BYTES = 3.5 * 1024 * 1024; // 5 Mo une fois encodée, la limite de l'API

async function photosToRead(photos) {
  const step = Math.max(1, (photos.length - 1) / (PHOTOS_TO_READ - 1));
  const picks = [...new Set(Array.from({ length: Math.min(PHOTOS_TO_READ, photos.length) }, (_, i) => photos[Math.round(i * step)]))];
  const read = await Promise.all(picks.map(async url => {
    try {
      const smaller = url.replace(/([?&]format=)\d+w/i, (m, a) => `${a}1000w`);
      const res = await fetch(smaller, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'image/jpeg,image/png;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      const media_type = imageType(bytes);
      if (!media_type || bytes.length > MAX_READ_BYTES) return null;
      return { type: 'image', source: { type: 'base64', media_type, data: bytes.toString('base64') } };
    } catch {
      return null;
    }
  }));
  return read.filter(Boolean);
}

// Le type annoncé doit être le vrai : un fichier .jpg peut arriver en WebP, et Claude refuserait
function imageType(b) {
  if (b[0] === 0xFF && b[1] === 0xD8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function isValidPhoto(url) {
  if (!url || !url.startsWith('http')) return false;
  // L'extension se cherche dans le chemin : un lien de partage Pinterest porte
  // l'image dans ses paramètres, ce n'est pas une photo.
  let path;
  try { path = new URL(url.replace(/&amp;/g, '&')).pathname; } catch { return false; }
  if (!/\.(jpg|jpeg|png|webp)/i.test(path)) return false;
  const lower = url.toLowerCase();
  const exclude = ['logo', 'icon', 'favicon', 'avatar', 'badge', 'pixel', 'tracking',
                   'placeholder', 'blank', 'spacer', '1x1', 'sprite', 'flag',
                   'shortpixel', 'profile', 'agent', 'team',
                   'apercu-']; // la copie légère de l'aperçu de lien n'est pas une photo du listing
  return !exclude.some(word => lower.includes(word));
}
