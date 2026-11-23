/*
 * La fiche du site dans le générateur (étape 9, 19/11/2026).
 *
 * Le site signature-sc.com montre chaque bien à vendre avec ce que dit son listing, et avec la clé « site » du data.json
 * ANGLAIS pour ce que seul le site dit : l'accroche, l'histoire, les chapitres, la photo de chaque bloc, les équipements,
 * les légendes des photos. Cette section l'écrit, dans le listing EN seulement (le site est en anglais).
 *
 * ⚠️ Deux portes pour les mêmes mots, et aucune n'efface l'autre (ses mots du 19/11/2026 : « Les 2 fonctionnent et se
 * synchronisent ») :
 *   1. sur le site, le mode « Modifier » range une correction dans la base de l'App, f|<bien>|<place> = { v, base },
 *      base étant ce que le listing disait à cet endroit ;
 *   2. ici, à l'ouverture, une correction dont la base est encore ce que dit le listing est reprise dans son champ (ses
 *      points forts aussi, en mode Modifier) ; à la publication elle s'écrit dans le listing, et le site cesse de
 *      l'appliquer d'elle-même. Le dernier qui écrit gagne.
 *
 * ⚠️ Une fiche qui n'a pas pu être lue ne s'écrit jamais : la clé du data.json reste telle quelle (ready faux).
 * Les photos se choisissent parmi celles du listing et s'écrivent par leur NOM de fichier (« 10.jpg ») ; une photo
 * copiée d'un autre site à la publication prend son nouveau nom (copiedPhotos du générateur).
 * Lu par generator.html : Fiche.load(data) dans showResult, Fiche.read() dans publishData, Fiche.changed() et
 * Fiche.saved() dans publishToGitHub.
 * « Préparer la fiche avec Claude » (20/11/2026) remplit toute la section d'après le listing et ses photos : prepare().
 */
(function () {
  var CONTENU = 'https://property.management.signature-sc.com/partage/contenu?js=1'
  var st = null, ready = false, baseline = '', lang = '', slug = '', notes = [], turn = 0, pick = null

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim() }
  function at(o, path) { return path.split('.').reduce(function (x, k) { return x == null ? undefined : x[k] }, o) }
  function put(o, path, v) {
    var ks = path.split('.'), end = ks.pop()
    ks.forEach(function (k, i) { if (o[k] == null) o[k] = /^\d+$/.test(ks[i + 1] || end) ? [] : {}; o = o[k] })
    o[end] = v
  }
  function box() { return document.getElementById('fiche-section') }
  /* Les photos du listing telles que le formulaire les tient en ce moment (sélection et ordre de la section Photos) */
  function imgs() { try { return (typeof formFields === 'function' ? formFields().images : []) || [] } catch (e) { return [] } }
  function file(u) { var m = typeof copiedPhotos !== 'undefined' && copiedPhotos.get(u); return String(m || u).split('/').pop() }
  function urlOf(name, list) { for (var i = 0; i < list.length; i++) if (list[i].split('/').pop() === name) return list[i]; return '' }

  /* ---------- La fiche du listing <-> le formulaire ---------- */
  function fromSite(s, list) {
    s = s || {}
    var u = function (n) { return n ? urlOf(n, list) : '' }, us = function (a) { return (a || []).map(u).filter(Boolean) }
    var alts = {}; Object.keys(s.alts || {}).forEach(function (n) { var x = u(n); if (x) alts[x] = s.alts[n] })
    return {
      tagline: s.tagline || '', name: s.name || '', renovated: s.renovated || '', hero: u(s.hero), walk: us(s.walk),
      keys: (s.keys || []).map(function (k) { return { n: k.n || '', u: k.u || '', t: k.t || '' } }),
      story: { label: (s.story || {}).label || '', lead: (s.story || {}).lead || '', text: (s.story || {}).text || '' },
      chapters: (s.chapters || []).map(function (c) { return { title: c.title || '', text: c.text || '', points: (c.points || []).join('\n'), photos: us(c.photos) } }),
      view: { photo: u((s.view || {}).photo), label: (s.view || {}).label || '', title: (s.view || {}).title || '' },
      aerial: { photo: u((s.aerial || {}).photo), cap: (s.aerial || {}).cap || '' },
      amenities: (s.amenities || []).slice(), alts: alts, hadAmenities: Array.isArray(s.amenities)
    }
  }
  /* Ce qui part dans le listing : rien de vide, une photo seulement si elle est encore dans le listing, par son nom */
  function toSite(f, list) {
    if (!f) return null
    var o = {}, keep = function (u) { return u && list.indexOf(u) >= 0 }, names = function (a) { return a.filter(keep).map(file) }
    var t = function (k, v) { v = norm(v); if (v) o[k] = v }
    t('name', f.name); t('tagline', f.tagline); t('renovated', f.renovated)
    if (keep(f.hero)) o.hero = file(f.hero)
    var keys = f.keys.filter(function (k) { return norm(k.n) }).map(function (k) { var x = { n: norm(k.n) }; if (norm(k.u)) x.u = norm(k.u); x.t = norm(k.t); return x })
    if (keys.length) o.keys = keys
    if (norm(f.story.lead) || norm(f.story.text)) {
      o.story = {}; ['label', 'lead', 'text'].forEach(function (k) { if (norm(f.story[k])) o.story[k] = norm(f.story[k]) })
    }
    var chaps = f.chapters.filter(function (c) { return norm(c.title) || norm(c.text) }).map(function (c) {
      var x = {}; if (norm(c.title)) x.title = norm(c.title); if (norm(c.text)) x.text = norm(c.text)
      var pts = String(c.points).split('\n').map(norm).filter(Boolean); if (pts.length) x.points = pts
      var ph = names(c.photos); if (ph.length) x.photos = ph
      return x
    })
    if (chaps.length) o.chapters = chaps
    if (keep(f.view.photo) && norm(f.view.title)) { o.view = { photo: file(f.view.photo) }; if (norm(f.view.label)) o.view.label = norm(f.view.label); o.view.title = norm(f.view.title) }
    var walk = names(f.walk); if (walk.length) o.walk = walk
    if (keep(f.aerial.photo)) { o.aerial = { photo: file(f.aerial.photo) }; if (norm(f.aerial.cap)) o.aerial.cap = norm(f.aerial.cap) }
    if (f.amenities.length) o.amenities = f.amenities.slice()
    var alts = {}; list.forEach(function (u) { if (norm(f.alts[u])) alts[file(u)] = norm(f.alts[u]) }); if (Object.keys(alts).length) o.alts = alts
    /* Des légendes seules ne font pas une fiche : sans le reste, la carte du site ouvre le listing */
    return Object.keys(o).some(function (k) { return k !== 'alts' }) ? o : null
  }

  /* ---------- Équipements pré-cochés d'après le texte anglais, pour une fiche qui n'en a jamais eu ---------- */
  var GUESS = [
    ['furnished', /(?<!un)furnished/], ['equipped_kitchen', /equipped kitchen|chef'?s kitchen|gourmet kitchen|fitted kitchen/],
    ['ensuite_bathrooms', /en[- ]suite/], ['walk_in_shower', /rain shower|walk-in shower/], ['bathtub', /bath ?tub|soaking tub/],
    ['whirlpool_tub', /whirlpool/], ['walk_in_closet', /walk-in closet/], ['built_in_wardrobes', /built-in (wardrobe|closet)/],
    ['storage', /storage/], ['laundry_room', /laundry/], ['high_ceilings', /high ceiling/], ['double_height', /double[- ]height/],
    ['marble_floors', /marble/], ['home_office', /\boffice\b|\bstudy\b/], ['home_gym', /home gym|private gym/],
    ['smart_home', /smart home|home automation/], ['pet_friendly', /pet[- ]friendly/], ['steam_room', /steam room|sauna/],
    ['infinity_pool', /infinity pool/], ['jacuzzi', /jacuzzi|hot tub/], ['terrace', /terrace/], ['balcony', /balcon/],
    ['rooftop', /rooftop|roof terrace/], ['palapa', /palapa/], ['pergola', /pergola/], ['bbq_area', /\bbbq\b|barbecue|grill/],
    ['outdoor_kitchen', /outdoor kitchen|summer kitchen/], ['outdoor_shower', /outdoor shower/], ['fire_pit', /fire ?pit|outdoor fireplace/],
    ['ocean_view', /ocean view|sea view|views? (of|over) the (caribbean|ocean|sea)/], ['marina_view', /marina view|overlooking the marina|views? (of|over) the marina/],
    ['canal_view', /canal view|overlooking the canal|views? (of|over) the canal/], ['golf_view', /golf view|overlooking the golf|golf course frontage|facing the golf/],
    ['panoramic_view', /panoramic/], ['private_dock', /private dock|own dock|boat dock/], ['beach_access', /beach access|direct access to the beach|private beach|beachfront/],
    ['cenote_access', /private cenote/], ['garage', /garage/], ['covered_parking', /covered parking|underground/], ['parking', /parking/],
    ['air_conditioning', /central (a\/?c|air)/], ['mini_split', /mini[- ]?split/], ['elevator', /elevator/], ['cctv', /cctv|camera|closed circuit/],
    ['solar_panels', /solar/], ['backup_generator', /backup generator|power generator|generator powering/], ['water_softener', /softener/],
    ['water_purification', /purification|osmosis|water filter/], ['fiber_internet', /fiber/], ['concierge', /concierge/],
    ['gated_community', /gated/], ['security_24_7', /24\/7|24-hour|24 hour/], ['gym', /\bgym\b|fitness/], ['beach_club', /beach club/],
    ['tennis_court', /tennis/], ['padel_court', /padel/], ['golf_access', /golf/], ['marina_access', /marina/]
  ]
  function guess(d) {
    var t = [d.title, d.subtitle, d.description].concat(d.highlights || []).join(' \n ').toLowerCase()
    var out = GUESS.filter(function (g) { return g[1].test(t) }).map(function (g) { return g[0] })
    /* Une piscine dans un condo est celle de la résidence ; « private pool » dit le contraire */
    if (/\bpool\b/.test(t) && out.indexOf('infinity_pool') < 0) out.push(/private (swimming )?pool/.test(t) || !/condo|apartment|penthouse|residence of \d+|units/.test(t) ? 'private_pool' : 'shared_pool')
    return out
  }

  /* ---------- Les corrections faites sur le site (le mode « Modifier » de signature-sc.com) ---------- */
  function readEdits() {
    return new Promise(function (done) {
      var s = document.createElement('script'), t = null
      function end(ok) { clearTimeout(t); s.remove(); done(ok ? (window.SCS_EDITS || {}) : null) }
      t = setTimeout(function () { end(false) }, 6000)
      s.onload = function () { end(true) }; s.onerror = function () { end(false) }
      window.SCS_EDITS = undefined
      s.src = CONTENU + '&t=' + Date.now(); document.head.appendChild(s)
    })
  }

  /* ---------- Ouvrir ---------- */
  async function load(d) {
    var my = ++turn
    st = null; ready = false; baseline = ''; notes = []; lang = d.lang || ''; slug = d.slug || ''; busy = false; prev = null; say = ''
    render()
    if (lang !== 'en' || !slug) return
    try {
      var r = await apiFetch('/api/github-page?slug=' + encodeURIComponent(slug) + '&lang=en&file=data')
      var got = await r.json().catch(function () { return {} })
      if (!r.ok || got.data === undefined) throw new Error(got.error || 'erreur ' + r.status)
      var data = got.data ? JSON.parse(got.data) : {}
      var raw = data.site || {}, list = d.images || []
      var edits = await readEdits()
      if (my !== turn) return
      baseline = JSON.stringify(toSite(fromSite(raw, list), list))
      /* Une correction du site tient si le listing dit encore ce qu'il disait quand elle l'a faite */
      var mine = JSON.parse(JSON.stringify(raw)), hl = (data.highlights || d.highlights || []).slice(), n = 0, pre = 'f|' + slug + '|'
      var RAW = { site: raw, listing: { highlights: data.highlights || d.highlights || [] } }
      var editMode = typeof currentMode !== 'undefined' && currentMode === 'edit'
      Object.keys(edits || {}).forEach(function (k) {
        var e = edits[k]
        if (k.indexOf(pre) || !e || typeof e.v !== 'string' || !norm(e.v)) return
        var p = k.slice(pre.length)
        if (norm(at(RAW, p)) !== norm(e.base)) return
        if (/^site\./.test(p)) { put({ site: mine }, p, e.v); n++ }
        else if (editMode && /^listing\.highlights\.\d+$/.test(p)) { hl[Number(p.split('.')[2])] = e.v; n++ }
      })
      st = fromSite(mine, list)
      if (!st.hadAmenities) { st.amenities = guess(d); if (st.amenities.length) notes.push('Équipements pré-cochés d’après le texte du listing : vérifie-les.') }
      if (n) {
        notes.push(n + (n > 1 ? ' corrections faites sur le site sont reprises' : ' correction faite sur le site est reprise') + ' dans cette page : '
          + (n > 1 ? 'elles s’écriront' : 'elle s’écrira') + ' dans le listing à la publication.')
        var field = document.getElementById('e-highlights')
        if (field && editMode) field.value = hl.filter(function (x) { return norm(x) }).join('\n')
      }
      if (edits === null) notes.push('Les corrections faites sur le site n’ont pas pu être lues : elles restent sur le site, rien ne les efface.')
      ready = true
    } catch (err) {
      if (my !== turn) return
      notes.push('La fiche du site n’a pas pu être lue (' + err.message + ') : elle ne sera pas modifiée à la publication.')
    }
    render()
  }

  /* ---------- Dessiner ---------- */
  var CSS = '#fiche-section .sf-sub{margin:26px 0 12px;font-size:.78rem;font-weight:700;color:var(--navy)}'
    + '#fiche-section .sf-help{font-size:.74rem;color:rgba(34,50,86,.5);line-height:1.5}'
    + '#fiche-section .sf-photos{display:flex;flex-wrap:wrap;align-items:center;gap:6px}'
    + '#fiche-section .sf-photos img{width:72px;height:54px;object-fit:cover;border-radius:6px}'
    + '#fiche-section .sf-card{border:1.5px solid rgba(34,50,86,.1);border-radius:12px;padding:16px;margin-top:12px;display:flex;flex-direction:column;gap:12px}'
    + '#fiche-section .sf-head{display:flex;align-items:center;gap:6px;font-size:.78rem;font-weight:700}#fiche-section .sf-head b{flex:1}'
    + '#fiche-section .sf-key{display:grid;grid-template-columns:110px 90px 1fr 34px;gap:8px;margin-top:8px}'
    + '#fiche-section .sf-x{width:34px;height:34px;border-radius:8px;border:none;background:rgba(34,50,86,.06);color:var(--navy);cursor:pointer;font-size:.9rem}'
    + '#fiche-section .sf-x:hover{background:rgba(168,68,58,.12);color:#A8443A}'
    + '#fiche-section .sf-amen{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px 14px;margin-top:6px}'
    + '#fiche-section .sf-amen label{display:flex;align-items:center;gap:8px;font-size:.8rem;cursor:pointer}'
    + '#fiche-section .sf-amen input{accent-color:var(--navy)}'
    + '#fiche-section .sf-chip{display:inline-flex;align-items:center;gap:6px;margin:6px 6px 0 0;padding:5px 6px 5px 12px;border-radius:99px;background:rgba(97,189,204,.14);font-size:.78rem}'
    + '#fiche-section .sf-chip button{border:none;background:none;cursor:pointer;color:var(--navy);font-size:.9rem}'
    + '#fiche-section .sf-add{display:grid;grid-template-columns:200px 1fr auto;gap:8px;margin-top:10px}'
    + '#fiche-section .sf-alt{display:grid;grid-template-columns:72px 1fr;gap:10px;align-items:center;margin-top:8px}'
    + '#fiche-section .sf-alt img{width:72px;height:54px;object-fit:cover;border-radius:6px}'
    + '#fiche-section details summary{cursor:pointer;font-size:.78rem;font-weight:700}'
    + '#fiche-section .sf-claude{display:flex;flex-direction:column;gap:8px;margin:0 0 22px;padding:14px 16px;border-radius:12px;background:rgba(97,189,204,.1)}'
    + '#fiche-section .sf-claude-row{display:flex;flex-wrap:wrap;gap:8px}#fiche-section .sf-claude .info-box{margin:4px 0 0}'
    + '#fiche-section .sf-claude button[disabled]{opacity:.75;cursor:wait}'
    + '#fiche-section .sf-busy{opacity:.45;pointer-events:none}'
    + '.sf-modal{position:fixed;inset:0;z-index:300;background:rgba(15,22,40,.82);display:flex;align-items:center;justify-content:center;padding:16px}'
    + '.sf-modal-in{background:#fff;border-radius:16px;width:min(900px,100%);max-height:88vh;display:flex;flex-direction:column;padding:20px}'
    + '.sf-modal-in .sf-mgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;overflow:auto;padding:2px;margin:14px 0}'
    + '.sf-modal-in .source-photo-item{cursor:pointer}'
    + '.sf-modal-foot{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}'
    + '@media (max-width:600px){#fiche-section .sf-key{grid-template-columns:1fr 1fr 34px}#fiche-section .sf-key input:nth-child(3){grid-column:1/3}#fiche-section .sf-add{grid-template-columns:1fr}}'
  function field(label, path, value, opts) {
    opts = opts || {}
    var input = opts.rows
      ? '<textarea class="field-textarea" rows="' + opts.rows + '" data-p="' + path + '" placeholder="' + esc(opts.ph || '') + '">' + esc(value) + '</textarea>'
      : '<input class="field-input" type="text" data-p="' + path + '" value="' + esc(value) + '" placeholder="' + esc(opts.ph || '') + '">'
    return '<div class="field-group"><label class="field-label">' + label + '</label>' + input + (opts.help ? '<span class="sf-help">' + opts.help + '</span>' : '') + '</div>'
  }
  function photos(path, list, max, label) {
    var chosen = (Array.isArray(list) ? list : [list]).filter(Boolean)
    return '<div class="field-group"><label class="field-label">' + label + '</label><div class="sf-photos">'
      + chosen.map(function (u) { return '<img src="' + esc(u) + '" alt="" loading="lazy">' }).join('')
      + '<button type="button" class="btn-sm btn-outline" data-a="pick" data-path="' + path + '" data-max="' + max + '">' + (chosen.length ? 'Changer' : 'Choisir') + '</button></div></div>'
  }
  function render() {
    var el = box(); if (!el) return
    if (!document.getElementById('sf-css')) { var c = document.createElement('style'); c.id = 'sf-css'; c.textContent = CSS; document.head.appendChild(c) }
    var head = '<div class="edit-section-title">🌐 Fiche du site, en anglais</div>'
    if (lang && lang !== 'en') {
      el.innerHTML = head + '<div class="sf-help">La fiche du site signature-sc.com est en anglais : elle se remplit dans le listing EN de ce bien.</div>'
      return
    }
    var info = notes.map(function (t) { return '<div class="info-box" style="margin-bottom:12px">' + esc(t) + '</div>' }).join('')
    if (!st) { el.innerHTML = head + (info || '<div class="sf-help">Lecture de la fiche…</div>'); return }
    var list = imgs()
    var h = head + '<div class="sf-help" style="margin-bottom:16px">Ce que le site signature-sc.com montre en plus du listing. Les mots s’y corrigent aussi, en mode « Modifier » : '
      + 'le dernier qui écrit gagne. Dans un titre, <b>*italique*</b> et <b>|</b> pour changer de ligne.</div>' + info
    var n = sentPhotos(list).length
    h += '<div class="sf-claude"><div class="sf-claude-row"><button type="button" class="btn-sm btn-teal" data-a="claude"' + (busy ? ' disabled' : '') + '>'
      + (busy ? 'Claude regarde ' + n + ' photos et écrit la fiche… une à deux minutes' : '✨ Préparer la fiche avec Claude') + '</button>'
      + (prev && !busy ? '<button type="button" class="btn-sm btn-outline" data-a="undo-claude">↩ Revenir à avant la proposition</button>' : '') + '</div>'
      + '<span class="sf-help">Il lit le texte du listing, regarde ses photos, écrit tous les blocs ci-dessous en anglais et choisit leurs photos. '
      + 'Rien ne part avant « Publier ».</span>' + (say ? '<div class="info-box">' + esc(say) + '</div>' : '') + '</div>'
    h += '<div' + (busy ? ' class="sf-busy"' : '') + '>'
    h += '<div style="display:flex;flex-direction:column;gap:14px">'
      + '<div class="edit-grid-2">' + field('Accroche, sous le nom', 'tagline', st.tagline, { ph: 'Vide : le sous-titre du listing' })
      + field('Nom sur le site', 'name', st.name, { ph: 'Vide : le premier mot droit, le reste en italique' }) + '</div>'
      + '<div class="edit-grid-2">' + field('Rénovée en', 'renovated', st.renovated, { ph: 'ex. 2022' }) + photos('hero', st.hero, 1, 'Photo d’ouverture') + '</div></div>'

    h += '<div class="sf-sub">Chiffres en plus des chambres, salles de bain et surfaces</div>'
      + st.keys.map(function (k, i) {
        return '<div class="sf-key"><input class="field-input" data-p="keys.' + i + '.n" value="' + esc(k.n) + '" placeholder="ex. 150">'
          + '<input class="field-input" data-p="keys.' + i + '.u" value="' + esc(k.u) + '" placeholder="Unité, ex. ft">'
          + '<input class="field-input" data-p="keys.' + i + '.t" value="' + esc(k.t) + '" placeholder="ex. Private dock on the canal">'
          + '<button type="button" class="sf-x" data-a="del-key" data-i="' + i + '" aria-label="Retirer ce chiffre">✕</button></div>'
      }).join('') + '<div style="margin-top:8px"><button type="button" class="btn-sm btn-navy-light" data-a="add-key">+ Ajouter un chiffre</button></div>'

    h += '<div class="sf-sub">L’histoire</div><div style="display:flex;flex-direction:column;gap:14px">'
      + field('Étiquette', 'story.label', st.story.label, { ph: 'Vide : The location' })
      + field('Grande phrase d’ouverture', 'story.lead', st.story.lead, { rows: 3 })
      + field('Texte', 'story.text', st.story.text, { rows: 3 }) + '</div>'

    h += '<div class="sf-sub">Chapitres</div><div class="sf-help">Les trois premiers encadrent la grande photo et la promenade, les suivants viennent après.</div>'
      + st.chapters.map(function (c, i) {
        return '<div class="sf-card"><div class="sf-head"><b>Chapitre ' + (i + 1) + '</b>'
          + (i ? '<button type="button" class="sf-x" data-a="up" data-i="' + i + '" aria-label="Monter">↑</button>' : '')
          + (i < st.chapters.length - 1 ? '<button type="button" class="sf-x" data-a="down" data-i="' + i + '" aria-label="Descendre">↓</button>' : '')
          + '<button type="button" class="sf-x" data-a="del-chap" data-i="' + i + '" aria-label="Retirer ce chapitre">✕</button></div>'
          + field('Titre', 'chapters.' + i + '.title', c.title, { ph: 'ex. Five suites,|*on two levels*' })
          + field('Texte', 'chapters.' + i + '.text', c.text, { rows: 3 })
          + field('Points, un par ligne', 'chapters.' + i + '.points', c.points, { rows: 4 })
          + photos('chapters.' + i + '.photos', c.photos, 4, 'Photos, 4 au plus (sans photo, le chapitre se lit en deux colonnes)') + '</div>'
      }).join('') + '<div style="margin-top:12px"><button type="button" class="btn-sm btn-navy-light" data-a="add-chap">+ Ajouter un chapitre</button></div>'

    h += '<div class="sf-sub">La grande photo</div><div class="edit-grid-3">' + photos('view.photo', st.view.photo, 1, 'Photo')
      + field('Étiquette', 'view.label', st.view.label, { ph: 'Vide : The view' }) + field('Titre', 'view.title', st.view.title, { ph: 'ex. The water,|*at the garden’s edge.*' }) + '</div>'
    h += '<div class="sf-sub">La promenade</div>' + photos('walk', st.walk, 6, 'Photos, 6 au plus (sans choix, les suivantes du listing)')
    h += '<div class="sf-sub">La photo aérienne, à côté des chiffres</div><div class="edit-grid-2">' + photos('aerial.photo', st.aerial.photo, 1, 'Photo')
      + field('Légende', 'aerial.cap', st.aerial.cap, { ph: 'Vide : le lieu du listing' }) + '</div>'

    h += '<div class="sf-sub">Équipements</div>'
    var known = {}
    ;(window.AMENITY_GROUPS || []).forEach(function (g) {
      h += '<div class="field-label" style="margin-top:12px">' + esc(g.fr) + '</div><div class="sf-amen">'
        + g.items.map(function (it) { known[it.k] = 1; return '<label><input type="checkbox" data-amen="' + it.k + '"' + (st.amenities.indexOf(it.k) >= 0 ? ' checked' : '') + '>' + esc(it.fr) + '</label>' }).join('') + '</div>'
    })
    var mine = st.amenities.filter(function (k) { return !known[k] })
    var gname = {}; (window.AMENITY_GROUPS || []).forEach(function (g) { gname[g.key] = g.fr })
    h += '<div class="field-label" style="margin-top:16px">Ajoutés par toi</div><div>'
      + (mine.length ? mine.map(function (k) {
        var m = /^custom::(?:([a-z]+)::)?(.+)$/.exec(k) || [], g = gname[m[1]] || gname.exterior
        return '<span class="sf-chip">' + esc(m[2] || k) + ' <small style="opacity:.6">' + esc(g || '') + '</small><button type="button" data-a="del-amen" data-k="' + esc(k) + '" aria-label="Retirer">✕</button></span>'
      }).join('') : '<span class="sf-help">Aucun pour l’instant.</span>') + '</div>'
      + '<div class="sf-add"><select class="field-input" data-n="group">' + (window.AMENITY_GROUPS || []).map(function (g) { return '<option value="' + g.key + '">' + esc(g.fr) + '</option>' }).join('') + '</select>'
      + '<input class="field-input" data-n="words" placeholder="En anglais, ex. SONOS audio, indoor and outdoor">'
      + '<button type="button" class="btn-sm btn-navy-light" data-a="add-amen">Ajouter</button></div>'

    h += '<div class="sf-sub">Légendes des photos</div><details><summary>Pour les lecteurs d’écran et Google, en anglais (' + list.filter(function (u) { return norm(st.alts[u]) }).length + ' / ' + list.length + ')</summary>'
      + list.map(function (u) { return '<div class="sf-alt"><img src="' + esc(u) + '" alt="" loading="lazy"><input class="field-input" data-alt="' + esc(u) + '" value="' + esc(st.alts[u] || '') + '" placeholder="ex. The pool, facing the marina"></div>' }).join('') + '</details>'
    h += '</div>'
    el.innerHTML = h
  }

  /* ---------- Le formulaire écrit dans la fiche ---------- */
  document.addEventListener('input', function (e) {
    var t = e.target, el = box(); if (!st || !el || !el.contains(t)) return
    if (t.hasAttribute('data-p')) put(st, t.getAttribute('data-p'), t.value)
    else if (t.hasAttribute('data-alt')) st.alts[t.getAttribute('data-alt')] = t.value
  })
  document.addEventListener('change', function (e) {
    var t = e.target, el = box(); if (!st || !el || !el.contains(t) || !t.hasAttribute('data-amen')) return
    var k = t.getAttribute('data-amen'), i = st.amenities.indexOf(k)
    if (t.checked && i < 0) st.amenities.push(k); else if (!t.checked && i >= 0) st.amenities.splice(i, 1)
  })
  document.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-a]'), el = box(); if (!st || !b || !el || !el.contains(b)) return
    var a = b.getAttribute('data-a'), i = Number(b.getAttribute('data-i'))
    if (busy) return
    if (a === 'claude') return prepare()
    if (a === 'undo-claude') { if (prev) st = prev; prev = null; say = 'La section est revenue à ce qui était écrit avant la proposition.' }
    else if (a === 'add-key') st.keys.push({ n: '', u: '', t: '' })
    else if (a === 'del-key') st.keys.splice(i, 1)
    else if (a === 'add-chap') st.chapters.push({ title: '', text: '', points: '', photos: [] })
    else if (a === 'del-chap') { if (!confirm('Retirer le chapitre ' + (i + 1) + ' ?')) return; st.chapters.splice(i, 1) }
    else if (a === 'up' || a === 'down') { var j = a === 'up' ? i - 1 : i + 1; st.chapters.splice(j, 0, st.chapters.splice(i, 1)[0]) }
    else if (a === 'del-amen') st.amenities.splice(st.amenities.indexOf(b.getAttribute('data-k')), 1)
    else if (a === 'add-amen') {
      var g = el.querySelector('[data-n=group]').value, w = norm(el.querySelector('[data-n=words]').value).replace(/\|/g, ' ')
      if (!w) return
      var k = 'custom::' + g + '::' + w; if (st.amenities.indexOf(k) < 0) st.amenities.push(k)
    }
    else if (a === 'pick') return choose(b.getAttribute('data-path'), Number(b.getAttribute('data-max')))
    render()
  })

  /* ---------- Choisir des photos parmi celles du listing, dans l'ordre des clics ---------- */
  function choose(path, max) {
    var list = imgs(), cur = at(st, path), sel = (Array.isArray(cur) ? cur : [cur]).filter(function (u) { return u && list.indexOf(u) >= 0 })
    var m = document.createElement('div'); m.className = 'sf-modal'
    function draw() {
      m.innerHTML = '<div class="sf-modal-in"><div class="sf-head"><b>' + (max > 1 ? 'Choisis jusqu’à ' + max + ' photos, dans l’ordre' : 'Choisis une photo') + '</b><span class="sf-help">' + sel.length + ' / ' + max + '</span></div>'
        + '<div class="sf-mgrid">' + list.map(function (u) {
          var n = sel.indexOf(u)
          return '<div class="source-photo-item' + (n >= 0 ? ' selected' : '') + '" data-u="' + esc(u) + '"><img src="' + esc(u) + '" alt="" loading="lazy"><span class="photo-rank">' + (n + 1) + '</span><div class="check"></div></div>'
        }).join('') + '</div><div class="sf-modal-foot"><button type="button" class="btn-sm btn-navy-light" data-m="none">Aucune</button>'
        + '<button type="button" class="btn-sm btn-outline" data-m="cancel">Annuler</button><button type="button" class="btn-sm btn-teal" data-m="ok">Valider</button></div></div>'
    }
    m.addEventListener('click', function (e) {
      var it = e.target.closest('[data-u]'), act = e.target.getAttribute('data-m')
      if (it) {
        var u = it.getAttribute('data-u'), n = sel.indexOf(u)
        if (n >= 0) sel.splice(n, 1); else if (max === 1) sel = [u]; else if (sel.length < max) sel.push(u)
        var top = m.querySelector('.sf-mgrid').scrollTop; draw(); m.querySelector('.sf-mgrid').scrollTop = top; return
      }
      if (act === 'none') { sel = []; draw(); return }
      if (act === 'ok') { put(st, path, max === 1 ? (sel[0] || '') : sel.slice()); render() }
      if (act === 'ok' || act === 'cancel' || e.target === m) m.remove()
    })
    draw(); document.body.appendChild(m)
  }

  /* ---------- Préparer la fiche avec Claude (20/11/2026, son « excellente ! ») ----------
   * Claude lit le texte du listing, regarde ses photos et rend toute la section remplie, comme les dix fiches écrites le
   * 18/11/2026. Rien ne part avant « Publier », et « Revenir à avant la proposition » rend ce qui était écrit.
   * ⚠️ Les photos passent RÉDUITES par l'App (/_next/image, 640 px) : ses originaux vont jusqu'à 4 000 px, et au-delà de
   * 20 images l'API refuse toute photo de plus de 3 000 px. Celles d'un listing pas encore publié (le site de l'agence)
   * ne passent pas par l'App : 20 au plus, réparties sur le listing.
   * ⚠️ Claude désigne une photo par son NUMÉRO dans la demande, jamais par son nom : deux agences nomment pareil. */
  /* Claude Sonnet 5, le modèle du reste du générateur, photos à 640 px, réflexion moyenne : environ 0,10 USD par clic,
   * son « Oui » du 23/11/2026 (Opus 5.5 et 828 px coûtaient 0,20 à 0,35 USD, construits avant qu'elle ait lu le prix). */
  var MODEL = 'claude-sonnet-5', busy = false, prev = null, say = ''
  var SMALL = 'https://property.management.signature-sc.com/_next/image?w=640&q=75&url='
  var OURS = /^https:\/\/listing\.signature-sc\.com\/for-sale\//
  var EXAMPLES = JSON.stringify([
    { tagline: 'An exceptional waterfront villa at the most strategic point of the marina.', renovated: '2022',
      keys: [{ n: '150', u: 'ft', t: 'Private dock on the canal' }],
      story: { label: 'The location', lead: 'It stands where the Caribbean slips into the calm of the canals, at the most strategic point of the marina. Across the water there is only a shore of preserved tropical green, and a panorama no other property here can match.',
        text: 'Built in 2003 and masterfully renovated in 2022, Casa La Torre joins the charm of the coast to contemporary comfort: 7,535 sq ft of living space on an 8,944 sq ft lot, with 150 feet of private waterfront.' },
      chapters: [{ title: 'On the water', text: 'What sets this house apart is not its size. It is every detail that was drawn for people who love the sea.',
        points: ['150 ft of canal frontage, with a private dock', 'A 381 sq ft climate-controlled pool, with a water feature and a sun terrace', 'A 452 sq ft palapa, with a summer kitchen and a lounge'] },
        { title: 'Above,|*and beyond*', text: 'A home or a strategic asset: the pleasure of the sea, with what makes a house easy to own for many years.',
        points: ['A 3,035 sq ft rooftop with ocean views', 'A 36-panel solar energy system', 'A whole-house water softening system'] }],
      view: { label: 'The view', title: '270°|*of water.*' }, aerial: { cap: 'On the marina of Puerto Aventuras' },
      alts: ['The lounge on the dock', 'A master suite facing the canal'] },
    { tagline: 'A golf-front residence whose private grounds open onto the greens of Puerto Aventuras.',
      keys: [{ n: '30', t: 'Solar panels' }],
      chapters: [{ title: 'The heart,|*outdoors*', text: 'The outdoors is the true heart of the home: a private pool and a custom-built grill area, crafted for warm, intimate gatherings under the Caribbean sky.',
        points: ['A private pool', 'A custom grill area', 'A two-car garage and parking for three more vehicles'] }],
      view: { label: 'The view', title: 'Inside and out,|*as one.*' }, alts: ['The pool and the pergola, facing the greens'] }
  ], null, 1)
  var SYSTEM = [
    'You write the website page of a property for sale, for Signature Real Estate in Puerto Aventuras, Riviera Maya, Mexico. The page already shows what the listing says (price, bedrooms, bathrooms, living area, lot, description, highlights, photos); you write the blocks that only the website shows. The website is in American English.',
    '',
    'Facts come only from the listing text and from what the photos clearly show. Never invent a figure, a year, a size, a material, a brand, a view or an amenity. When the listing gives little for a block, keep the block short rather than fill it.',
    '',
    'Style: elegant and restrained, concrete, short sentences, no exclamation marks, no superlative the listing does not use. American spelling (color, neighbor, center). Never use the em dash character (U+2014) nor a spaced en dash: use a comma or a colon instead. Points are short phrases without a final period. In titles and in the name, *words* between asterisks are set in italics and | starts a new line, for instance "Five suites,|*on two levels*".',
    '',
    'The photos are numbered in the request: refer to a photo only by its number. Use each photo at most once across hero, chapters, view, walk and aerial.',
    '',
    'Fields:',
    '- name: the property\'s own name, the part after the first word in italics, like "Casa *La Torre*" or "Quinta Luna|*Penthouse*". Empty when the listing gives the property no proper name.',
    '- tagline: one sentence under the name, what makes this property itself.',
    '- renovated: the year of the last renovation, only if the listing states it, else empty.',
    '- hero: the opening photo, the most striking image of the property as a whole.',
    '- keys: at most 3 figures stated in the listing that bedrooms, bathrooms, living area and lot do not already give (a dock length, solar panels, parking spaces, AC units). n is the number only, u an optional unit, t the label. An empty list when there is none.',
    '- story: label (usually "The location"), lead (one or two sentences on where the property stands), text (when it was built, its sizes and what the place offers, from the listing).',
    '- chapters: three chapters, a fourth only when the listing has enough distinct matter. Each one: a short title, one to three sentences, 3 to 5 points, and up to 4 photos that show what the chapter tells (none when no photo fits).',
    '- view: one wide photo of the view, the pool, the garden or the water, a label (usually "The view") and a short title.',
    '- walk: up to 6 photos of other rooms and spaces, in a natural visiting order.',
    '- aerial: a photo taken from a drone or from above, only if there is one (else ""), and a short caption of where the property stands, like "On the marina of Puerto Aventuras".',
    '- amenities: the keys of the catalogue below that the listing text or the photos show. For an important feature missing from the catalogue: "custom::<group>::<English words>", group being interior, exterior, services or community.',
    '- alts: one caption for every photo, factual, a few words, no final period, like "The pool, facing the marina".',
    '',
    'Two published pages, for the tone and the format (their photos left out):',
    EXAMPLES,
    '',
    'Answer with the JSON object only.'
  ].join('\n')

  function catalogue() {
    return '\n\nAmenity catalogue, key (label):\n' + (window.AMENITY_GROUPS || []).map(function (g) {
      return g.key + ': ' + g.items.map(function (it) { return it.k + ' (' + it.en + ')' }).join(', ')
    }).join('\n')
  }
  function sentPhotos(list) {
    if (list.every(function (u) { return OURS.test(u) })) return list.slice(0, 100)
    var out = [], step = Math.max(1, (list.length - 1) / 19)
    for (var i = 0; i < Math.min(20, list.length); i++) { var u = list[Math.round(i * step)]; if (out.indexOf(u) < 0) out.push(u) }
    return out
  }
  function listingText(d) {
    var line = function (k, v) { return norm(v) ? k + ': ' + norm(v) + '\n' : '' }
    return 'THE LISTING, the only source of facts\n\n' + line('Title', d.title) + line('Subtitle', d.subtitle) + line('Location', d.location)
      + line('Bedrooms', d.beds) + line('Bathrooms', d.baths) + line('Year built', d.year) + line('Living area', d.construction) + line('Lot', d.lot)
      + '\nDescription:\n' + (d.description || '') + '\n\nHighlights:\n' + (d.highlights || []).map(function (h) { return '- ' + h }).join('\n')
  }
  function schema(n) {
    var ids = []; for (var i = 1; i <= n; i++) ids.push(String(i))
    var S = { type: 'string' }, id = { type: 'string', enum: ids }, idOrNone = { type: 'string', enum: [''].concat(ids) }
    var obj = function (p) { return { type: 'object', additionalProperties: false, required: Object.keys(p), properties: p } }
    var arr = function (it) { return { type: 'array', items: it } }
    return obj({
      name: S, tagline: S, renovated: S, hero: id, keys: arr(obj({ n: S, u: S, t: S })),
      story: obj({ label: S, lead: S, text: S }),
      chapters: arr(obj({ title: S, text: S, points: arr(S), photos: arr(id) })),
      view: obj({ photo: idOrNone, label: S, title: S }), walk: arr(id), aerial: obj({ photo: idOrNone, cap: S }),
      amenities: arr(S), alts: arr(obj({ photo: id, alt: S }))
    })
  }
  /* La réponse de Claude -> la section. Ce qui ne tient pas (une photo inconnue, une clé hors catalogue) tombe sans bruit */
  function fromClaude(j, sent, old) {
    var u = function (id) { return sent[Number(id) - 1] || '' }
    var us = function (a, max) { var out = []; (a || []).forEach(function (id) { var x = u(id); if (x && out.indexOf(x) < 0 && out.length < max) out.push(x) }); return out }
    var c = function (s) { return norm(String(s == null ? '' : s).replace(/\s*\u2014\s*/g, ', ').replace(/ \u2013 /g, ', ')) }
    var known = {}; (window.AMENITY_GROUPS || []).forEach(function (g) { g.items.forEach(function (it) { known[it.k] = 1 }) })
    var amen = []; (j.amenities || []).forEach(function (k) { k = norm(k); if ((known[k] || /^custom::(interior|exterior|services|community)::\S/.test(k)) && amen.indexOf(k) < 0) amen.push(k) })
    var alts = Object.assign({}, old.alts); (j.alts || []).forEach(function (a) { var x = u(a && a.photo); if (x && c(a.alt)) alts[x] = c(a.alt) })
    var sv = j.story || {}, vw = j.view || {}, ae = j.aerial || {}
    return {
      name: c(j.name), tagline: c(j.tagline), renovated: (/\b(19|20)\d\d\b/.exec(String(j.renovated || '')) || [''])[0], hero: u(j.hero), walk: us(j.walk, 6),
      keys: (j.keys || []).filter(function (k) { return k && c(k.n) }).slice(0, 3).map(function (k) { return { n: c(k.n), u: c(k.u), t: c(k.t) } }),
      story: { label: c(sv.label), lead: c(sv.lead), text: c(sv.text) },
      chapters: (j.chapters || []).slice(0, 5).map(function (ch) {
        return { title: c(ch.title), text: c(ch.text), points: (ch.points || []).map(c).filter(Boolean).join('\n'), photos: us(ch.photos, 4) }
      }),
      view: { photo: u(vw.photo), label: c(vw.label), title: c(vw.title) }, aerial: { photo: u(ae.photo), cap: c(ae.cap) },
      amenities: amen, alts: alts, hadAmenities: true
    }
  }
  function parse(text) {
    try { return JSON.parse(text) } catch (e) { }
    var a = text.indexOf('{'), b = text.lastIndexOf('}')
    try { return a >= 0 && b > a ? JSON.parse(text.slice(a, b + 1)) : null } catch (e) { return null }
  }
  async function ask(body) {
    var r = await apiFetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { ok: r.ok, status: r.status, d: await r.json().catch(function () { return {} }) }
  }
  async function prepare() {
    var list = imgs()
    if (!list.length) { say = 'Le listing n’a encore aucune photo : choisis-les dans la section Photos, puis relance.'; render(); return }
    if (toSite(st, list) && !confirm('La section a déjà du contenu. La remplacer par la proposition de Claude ?\n\nRien ne part avant « Publier », et « Revenir à avant la proposition » rend ce qui est écrit maintenant.')) return
    var my = turn, d = typeof formFields === 'function' ? formFields() : {}, sent = sentPhotos(list), content = []
    sent.forEach(function (x, i) {
      content.push({ type: 'text', text: 'Photo ' + (i + 1) })
      content.push({ type: 'image', source: { type: 'url', url: OURS.test(x) ? SMALL + encodeURIComponent(x) : x } })
    })
    content.push({ type: 'text', text: listingText(d) })
    var base = { model: MODEL, max_tokens: 16000, noFetch: true, system: SYSTEM + catalogue(), messages: [{ role: 'user', content: content }] }
    busy = true; say = ''; render()
    try {
      var res = await ask(Object.assign({ output_config: { format: { type: 'json_schema', schema: schema(sent.length) }, effort: 'medium' } }, base))
      /* Une option que l'API refuserait (la forme de la réponse, le repli) ne doit pas priver de la proposition */
      if (res.status === 400) res = await ask(base)
      if (my !== turn) return
      if (!res.ok) {
        var e = res.d.error
        throw new Error(res.status === 504 ? 'le serveur a mis trop de temps à répondre, relance dans un moment.' : ((e && (e.message || e)) || 'erreur ' + res.status) + '.')
      }
      var m = res.d
      if (m.stop_reason === 'refusal') throw new Error('Claude a refusé d’écrire cette fiche.')
      if (m.stop_reason === 'max_tokens') throw new Error('la réponse de Claude a été coupée avant la fin, relance.')
      var j = parse((m.content || []).filter(function (b) { return b.type === 'text' }).map(function (b) { return b.text }).join(''))
      if (!j || typeof j !== 'object') throw new Error('la réponse de Claude ne contient pas de fiche lisible, relance.')
      prev = JSON.parse(JSON.stringify(st))
      st = fromClaude(j, sent, st)
      say = 'Proposition de Claude, d’après le texte du listing et ' + sent.length + ' photos : relis chaque bloc, corrige ce qu’il faut, puis « Publier ».'
        + (sent.length < list.length ? ' Il a regardé ' + sent.length + ' photos sur ' + list.length + ' : publie d’abord le listing, rouvre-le avec « Modifier mon listing » et relance pour qu’il les voie toutes.' : '')
    } catch (err) {
      if (my !== turn) return
      say = 'La fiche n’a pas pu être préparée : ' + err.message + ' Rien n’a changé dans la section.'
    }
    busy = false; render()
  }

  window.Fiche = {
    load: function (d) { return load(d).catch(function () {}) },
    /* null : la fiche n'a pas été lue, on n'y touche pas ; { site: null } : plus rien à dire, la clé s'enlève */
    read: function () { return ready && lang === 'en' ? { site: toSite(st, imgs()) } : null },
    changed: function () { return ready && lang === 'en' && JSON.stringify(toSite(st, imgs())) !== baseline },
    saved: function () { if (ready) baseline = JSON.stringify(toSite(st, imgs())) },
    render: render
  }
})()
