// Le mot de passe du générateur et de la brochure : demandé une fois par appareil, puis envoyé
// avec chaque appel. La vraie serrure est dans les routes (api/_auth.js) : le dépôt est public,
// cet écran ne cache rien à lui seul. S'il disparaît, les routes refusent quand même.
(() => {
  const KEY = 'signature-generator-password';
  const load = () => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } };
  const save = value => { try { value ? localStorage.setItem(KEY, value) : localStorage.removeItem(KEY); } catch (e) {} };
  let password = load();

  const send = (url, options = {}, value = password) =>
    fetch(url, { ...options, headers: { ...options.headers, 'X-Generator-Password': encodeURIComponent(value) } });

  const CSS = `
    #gate { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center; padding: 20px; background: #faf9f6; color: #223256; font-family: 'Inter', sans-serif; }
    #gate form { background: white; border-radius: 24px; box-shadow: 0 4px 40px rgba(34,50,86,0.08); padding: 48px; max-width: 440px; width: 100%; }
    #gate .gate-brand { font-size: 0.68rem; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; color: #61BDCC; margin-bottom: 12px; }
    #gate h2 { font-family: 'Cormorant Garamond', serif; font-size: 2rem; font-weight: 500; line-height: 1.2; margin: 0 0 8px; }
    #gate p { font-size: 0.88rem; color: rgba(34,50,86,0.55); line-height: 1.6; margin: 0 0 28px; }
    #gate input[type=password] { display: block; width: 100%; border: 1.5px solid rgba(34,50,86,0.12); border-radius: 12px; padding: 14px 18px; font-size: 0.9rem; font-family: 'Inter', sans-serif; color: #223256; background: #faf9f6; outline: none; }
    #gate input[type=password]:focus { border-color: #61BDCC; box-shadow: 0 0 0 3px rgba(97,189,204,0.12); }
    #gate .gate-error { font-size: 0.83rem; color: #c0392b; margin-top: 10px; }
    #gate .gate-error:empty { display: none; }
    #gate button { width: 100%; background: #223256; color: white; border: none; border-radius: 12px; padding: 16px 24px; font-size: 0.9rem; font-weight: 600; font-family: 'Inter', sans-serif; cursor: pointer; margin-top: 20px; }
    #gate button:disabled { opacity: 0.6; cursor: not-allowed; }
    @media (max-width: 640px) { #gate form { padding: 36px 24px; } }
  `;

  function showGate(message) {
    if (document.getElementById('gate')) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    const gate = document.createElement('div');
    gate.id = 'gate';
    gate.innerHTML = `<form>
      <div class="gate-brand">Signature ˢᶜ Real Estate</div>
      <h2>Mot de passe</h2>
      <p>Demandé une seule fois sur cet appareil.</p>
      <input type="text" name="username" value="Générateur" autocomplete="username" hidden>
      <input type="password" name="password" aria-label="Mot de passe" autocomplete="current-password" required>
      <div class="gate-error" role="alert"></div>
      <button type="submit">Entrer</button>
    </form>`;
    gate.append(style);
    document.body.append(gate);

    const form = gate.querySelector('form');
    const field = form.elements.password;
    const button = form.querySelector('button');
    const error = form.querySelector('.gate-error');
    error.textContent = message || '';
    field.focus();

    form.addEventListener('submit', async event => {
      event.preventDefault();
      const value = field.value.trim();
      if (!value) return;
      button.disabled = true;
      button.textContent = 'Vérification…';
      error.textContent = '';
      try {
        const res = await send('/api/check-password', {}, value);
        if (res.ok) {
          password = value;
          save(value);
          gate.remove();
          return;
        }
        error.textContent = res.status === 401 ? 'Mot de passe incorrect.' : `Le serveur répond ${res.status}. Réessaie dans un instant.`;
      } catch (e) {
        error.textContent = 'Pas de réponse du serveur. Vérifie ta connexion et réessaie.';
      }
      button.disabled = false;
      button.textContent = 'Entrer';
      field.select();
    });
  }

  // Un mot de passe refusé alors que l'appareil en avait un : il a été changé sur Vercel
  window.apiFetch = async (url, options) => {
    const res = await send(url, options);
    if (res.status === 401) {
      const changed = !!password;
      password = '';
      save('');
      showGate(changed ? 'Le mot de passe a changé. Tape le nouveau.' : '');
    }
    return res;
  };

  window.addEventListener('DOMContentLoaded', () => window.apiFetch('/api/check-password').catch(() => {}));
})();
