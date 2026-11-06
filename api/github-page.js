import { locked } from './_auth.js';

// Une page telle qu'elle est sur GitHub. Le site met deux minutes à suivre une publication :
// une page relue sur le site juste après ferait revenir l'ancienne valeur en la republiant.
const OWNER = 'sabrinahomeplaya-cyber';
const REPO = 'signature-listings';
const BRANCH = 'main';

export default async function handler(req, res) {
  if (locked(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GitHub token not configured' });

  const { slug, lang } = req.query;
  if (!/^[\w-]+$/.test(slug || '') || !/^(fr|en|es)$/.test(lang || '')) {
    return res.status(400).json({ error: 'Bad slug or lang' });
  }

  try {
    const page = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/for-sale/${slug}/${lang}/index.html?ref=${BRANCH}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.raw+json',
        'User-Agent': 'signature-listings'
      }
    });
    // Cette langue n'existe pas : ce n'est pas une erreur, et une panne ne doit pas s'y confondre
    if (page.status === 404) return res.status(200).json({ html: null });
    if (!page.ok) return res.status(502).json({ error: `GitHub répond ${page.status}` });
    return res.status(200).json({ html: await page.text() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
