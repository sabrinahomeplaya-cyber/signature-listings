export const config = {
  maxDuration: 60
};

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    const body = req.body;

    // Extract the URL from the user message
    const userMessage = body.messages?.[0]?.content || '';
    const urlMatch = userMessage.match(/https?:\/\/[^\s]+/);
    const listingUrl = urlMatch ? urlMatch[0] : null;

    let pageContent = '';

    if (listingUrl) {
      try {
        // Fetch the page content directly
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
          // Clean HTML - remove scripts, styles, keep text content
          pageContent = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 15000); // Limit to 15k chars
        }
      } catch (fetchErr) {
        console.error('Page fetch error:', fetchErr.message);
      }
    }

    // Build the messages with actual page content
    const systemPrompt = body.system || '';
    const originalUserMessage = body.messages?.[0]?.content || '';

    // Replace the user message with actual content
    const enhancedMessages = [{
      role: 'user',
      content: pageContent
        ? `Voici le contenu réel de la page immobilière (URL: ${listingUrl}):\n\n${pageContent}\n\n---\n\nMaintenant extrait les informations et retourne le JSON demandé. Utilise UNIQUEMENT les informations présentes dans ce contenu. Ne jamais inventer ou supposer des données qui ne sont pas dans le texte ci-dessus.`
        : originalUserMessage
    }];

    // Call Claude without web_search (we already have the content)
    const claudeBody = {
      model: body.model || 'claude-sonnet-4-20250514',
      max_tokens: body.max_tokens || 8000,
      system: systemPrompt,
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

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
