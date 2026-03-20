export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;

  if (!token || !owner || !repo) {
    return res.status(500).json({ error: 'GitHub config manquante' });
  }

  const { path } = req.query;
  if (!path) return res.status(400).json({ error: 'Paramètre path manquant' });

  try {
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
    const response = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'signature-listings'
      }
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err.message || 'Erreur GitHub' });
    }

    const data = await response.json();
    const photos = Array.isArray(data)
      ? data
          .filter(f => f.type === 'file' && /\.(jpg|jpeg|png|webp)$/i.test(f.name))
          .map(f => f.name)
          .sort((a, b) => {
            // Tri numérique si les noms commencent par un chiffre
            const na = parseInt(a); const nb = parseInt(b);
            if (!isNaN(na) && !isNaN(nb)) return na - nb;
            return a.localeCompare(b);
          })
      : [];

    return res.status(200).json({ photos });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
