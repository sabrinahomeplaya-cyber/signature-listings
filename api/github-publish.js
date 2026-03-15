export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GitHub token not configured' });

  const { path, content, message } = req.body;

  if (!path || !content || !message) {
    return res.status(400).json({ error: 'Missing path, content or message' });
  }

  const OWNER = 'sabrinahomeplaya-cyber';
  const REPO  = 'signature-listings';
  const BRANCH = 'main';

  const apiUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;

  try {
    // Check if file already exists (to get its SHA for update)
    let sha = null;
    const checkRes = await fetch(apiUrl + `?ref=${BRANCH}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json'
      }
    });
    if (checkRes.ok) {
      const existing = await checkRes.json();
      sha = existing.sha;
    }

    // Create or update the file
    const body = {
      message,
      content: Buffer.from(content).toString('base64'),
      branch: BRANCH
    };
    if (sha) body.sha = sha;

    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const putData = await putRes.json();

    if (!putRes.ok) {
      return res.status(putRes.status).json({ error: putData.message || 'GitHub error' });
    }

    return res.status(200).json({ success: true, url: putData.content?.html_url });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
