
export const config = {
  maxDuration: 60
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const body = req.body;
    const userMessage = body.messages?.[0]?.content || '';
    const urlMatch = userMessage.match(/https?:\/\/[^\s]+/);
    const listingUrl = urlMatch ? urlMatch[0] : null;

    let pageContent = '';

    if (listingUrl) {
      try {
        const pageResponse = await fetch(listingUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
          },
          redirect: 'follow'
        });

        if (pageResponse.ok) {
          const html = await pageResponse.text();

          // ── 1. Extraire les URLs d'images AVANT de supprimer le HTML ──
          const imageUrls = new Set();

          // src="..."
          const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
          let m;
          while ((m = imgRegex.exec(html)) !== null) {
            const src = m[1];
            if (isValidPhoto(src)) imageUrls.add(src);
          }

          // data-src="..." (lazy loading)
          const dataSrcRegex = /data-src=["']([^"']+)["']/gi;
          while ((m = dataSrcRegex.exec(html)) !== null) {
            if (isValidPhoto(m[1])) imageUrls.add(m[1]);
          }

          // srcset="url 1x, url 2x"
          const srcsetRegex = /srcset=["']([^"']+)["']/gi;
          while ((m = srcsetRegex.exec(html)) !== null) {
            for (const part of m[1].split(',')) {
              const url = part.trim().split(/\s+/)[0];
              if (isValidPhoto(url)) imageUrls.add(url);
            }
          }

          // content="..." (og:image etc.)
          const metaRegex = /<meta[^>]+content=["']([^"']+)["'][^>]*>/gi;
          while ((m = metaRegex.exec(html)) !== null) {
            if (isValidPhoto(m[1])) imageUrls.add(m[1]);
          }

          const uniqueImages = [...imageUrls];

          // ── 2. Nettoyer le HTML en texte ──
          const textContent = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 12000);

          // ── 3. Combiner texte + liste des images ──
          const imagesSection = uniqueImages.length > 0
            ? `\n\n=== IMAGES (${uniqueImages.length} photos trouvées) ===\n` + uniqueImages.join('\n')
            : '\n\n=== AUCUNE IMAGE TROUVÉE ===';

          pageContent = textContent + imagesSection;
        }
      } catch (fetchErr) {
        console.error('Page fetch error:', fetchErr.message);
      }
    }

    const enhancedMessages = [{
      role: 'user',
      content: pageContent
        ? `Voici le contenu de la page (URL: ${listingUrl}):\n\n${pageContent}\n\n---\n\nExtrait les informations et retourne le JSON. Utilise les URLs de la section IMAGES pour le champ "images".`
        : (body.messages?.[0]?.content || '')
    }];

    const claudeBody = {
      model: body.model || 'claude-sonnet-4-20250514',
      max_tokens: body.max_tokens || 8000,
      system: body.system || '',
      messages: enhancedMessages
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(claudeBody)
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function isValidPhoto(url) {
  if (!url || !url.startsWith('http')) return false;
  if (!/\.(jpg|jpeg|png|webp)/i.test(url)) return false;
  const lower = url.toLowerCase();
  const exclude = ['logo', 'icon', 'favicon', 'avatar', 'badge', 'pixel', 'tracking', 'placeholder', 'blank', 'spacer', '1x1', 'sprite'];
  return !exclude.some(word => lower.includes(word));
}
