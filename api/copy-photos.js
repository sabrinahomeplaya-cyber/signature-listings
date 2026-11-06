import { locked } from './_auth.js';

// Copie les photos d'un listing sur le site : un autre site peut les bloquer (Casa Rapha, 403
// dès que la demande vient d'ailleurs), les retirer ou tomber en panne, et le listing reste vide.
// Deux appels du générateur : « fetch » dépose quelques photos chez GitHub sans rien publier,
// « commit » les range toutes en un seul commit. Une écriture par photo ferait un déploiement
// par photo, et le forfait gratuit de Vercel en autorise 100 par jour.
const OWNER = 'sabrinahomeplaya-cyber';
const REPO = 'signature-listings';
const BRANCH = 'main';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_BATCH = 6;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (locked(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GitHub token not configured' });

  const { action, urls, slug, files } = req.body || {};

  try {
    if (action === 'fetch') {
      if (!Array.isArray(urls) || !urls.length || urls.length > MAX_BATCH) return res.status(400).json({ error: 'Bad urls' });
      return res.status(200).json({ results: await Promise.all(urls.map(url => copyOne(url, token))) });
    }
    if (action === 'commit') {
      const valid = Array.isArray(files) && files.length && files.every(f => /^[\w-]+\.(jpg|png|webp)$/.test(f.name) && /^[0-9a-f]{40}$/.test(f.sha));
      if (!valid || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug || '')) return res.status(400).json({ error: 'Bad slug or files' });
      await commitPhotos(slug, files, token);
      return res.status(200).json({ success: true });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function github(path, token, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `GitHub ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Récupère une photo et la dépose chez GitHub. Son nom viendra de son contenu : republier la
// même photo ne crée ni doublon ni collision avec une photo déjà rangée dans le dossier.
async function copyOne(url, token) {
  if (!isPublicUrl(url)) return { url, error: 'Adresse refusée' };
  try {
    const source = await lighterCopy(url).catch(() => url);
    // Squarespace envoie du WebP à qui ne dit rien : le JPEG passe partout, aperçus de lien compris
    const res = await fetch(source, { headers: { 'User-Agent': UA, 'Accept': 'image/jpeg,image/png;q=0.9,*/*;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { url, error: `Le site répond ${res.status}` };
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES) return { url, error: 'Photo trop lourde' };
    const ext = imageKind(bytes);
    if (!ext) return { url, error: "Ce n'est pas une photo" };
    const blob = await github('/git/blobs', token, { method: 'POST', body: { content: bytes.toString('base64'), encoding: 'base64' } });
    return { url, sha: blob.sha, ext, bytes: bytes.length };
  } catch (err) {
    return { url, error: err.message };
  }
}

async function commitPhotos(slug, files, token) {
  const tree = files.map(f => ({ path: `for-sale/${slug}/photos/${f.name}`, mode: '100644', type: 'blob', sha: f.sha }));
  for (let attempt = 0; ; attempt++) {
    const head = (await github(`/git/ref/heads/${BRANCH}`, token)).object.sha;
    const base = (await github(`/git/commits/${head}`, token)).tree.sha;
    const next = await github('/git/trees', token, { method: 'POST', body: { base_tree: base, tree } });
    const commit = await github('/git/commits', token, { method: 'POST', body: { message: `Copy photos: ${slug} (${files.length})`, tree: next.sha, parents: [head] } });
    try {
      await github(`/git/refs/heads/${BRANCH}`, token, { method: 'PATCH', body: { sha: commit.sha } });
      return;
    } catch (err) {
      // Une autre publication est passée entre-temps : on repart du nouveau sommet
      if (err.status !== 422 || attempt >= 2) throw err;
    }
  }
}

// WordPress garde des copies que la page ne cite pas toujours : celle de 1536 px pèse le tiers
// de l'original et reste nette partout. Son nom porte sa hauteur, déduite de celle de l'original.
async function lighterCopy(url) {
  const m = url.match(/^(.*\/wp-content\/uploads\/.+?)(\.jpe?g)(\?.*)?$/i);
  if (!m || /-\d+x\d+$/.test(m[1])) return url;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Range: 'bytes=0-262143' }, signal: AbortSignal.timeout(10000) });
  const size = jpegSize(Buffer.from(await res.arrayBuffer()));
  if (!size || Math.max(size.w, size.h) <= 1600) return url;
  const scale = 1536 / Math.max(size.w, size.h);
  const w = Math.round(size.w * scale), h = Math.round(size.h * scale);
  const sizes = size.w >= size.h ? [[1536, h], [1536, h + 1], [1536, h - 1]] : [[w, 1536], [w + 1, 1536], [w - 1, 1536]];
  for (const [a, b] of sizes) {
    const copy = `${m[1]}-${a}x${b}${m[2]}`;
    const head = await fetch(copy, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    if (head.ok) return copy;
  }
  return url;
}

function jpegSize(b) {
  if (b[0] !== 0xFF || b[1] !== 0xD8) return null;
  for (let i = 2; i < b.length - 9;) {
    if (b[i] !== 0xFF) { i++; continue; }
    const marker = b[i + 1];
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

function imageKind(b) {
  if (b[0] === 0xFF && b[1] === 0xD8) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'png';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function isPublicUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return !/^(localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(u.hostname);
  } catch {
    return false;
  }
}
