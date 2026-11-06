import { createHash, timingSafeEqual } from 'node:crypto';

// La serrure des routes du générateur. Le dépôt est public : le mot de passe ne vit que dans
// la variable GENERATOR_PASSWORD de Vercel. Le trait de soulignement empêche Vercel d'en faire
// une route. Les empreintes se comparent pour que la durée de la réponse ne dise rien du mot
// de passe, et le navigateur l'envoie encodé parce qu'un accent ne passe pas dans un en-tête.
const digest = text => createHash('sha256').update(text).digest();

export function locked(req, res) {
  const expected = (process.env.GENERATOR_PASSWORD || '').trim();
  if (!expected) return false;
  const given = String(req.headers['x-generator-password'] || '');
  if (timingSafeEqual(digest(given), digest(encodeURIComponent(expected)))) return false;
  res.status(401).json({ error: 'Mot de passe incorrect' });
  return true;
}
