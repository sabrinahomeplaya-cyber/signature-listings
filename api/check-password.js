import { locked } from './_auth.js';

// Le générateur et la brochure demandent ici si le mot de passe de cet appareil est le bon.
export default function handler(req, res) {
  if (locked(req, res)) return;
  return res.status(200).json({ success: true });
}
