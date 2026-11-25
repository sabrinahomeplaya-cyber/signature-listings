/*
 * The figures of a listing page come from her sheet « Listing - Property » (25/11/2026, her yes).
 *
 * Her reason: « si je reçois l'information d'un changement, je risque vraiment d'oublier de mettre à jour ». A price or
 * a figure changed in the sheet shows here, on the page she sends to her clients, without the generator.
 *
 * Every page carries one line, <script src="/feuille.js" defer></script>, and everything else is here. The page asks the
 * App what the sheet says for this listing, in this language, already written the way the generator writes it
 * (the rules live in the App: src/lib/annonces.ts, selonFeuille, with their tests). What the page says in its own
 * HTML stays as the fallback: if the App does not answer, or the listing has no row in the sheet, nothing changes.
 *
 * Only the frames the generator names are touched: a frame she renamed herself (« Balcony », « Suite + Garage »,
 * « Parking ») is hers and is left alone. An empty cell of the sheet leaves the figure of the listing.
 */
(function () {
  var m = location.pathname.match(/\/for-sale\/([\w-]+)\/(en|fr|es)(\/|$)/)
  if (!m || !window.fetch) return
  var API = 'https://property.management.signature-sc.com/partage/annonces?listing=' + m[1] + '&lang=' + m[2]

  /* The names the generator gives each frame, in its three languages (TEMPLATE_LABELS of generator.html) */
  var NAMES = {
    price: ['PRICE', 'PRIX', 'PRECIO'],
    beds: ['Bedrooms', 'Chambres', 'Recámaras'],
    baths: ['Bathrooms', 'Salles de bain', 'Baños'],
    year: ['Year built', 'Année', 'Año'],
    construction: ['Construction', 'Construcción', 'Living area'],
    lot: ['Lot size', 'Terrain', 'Terreno'],
    per: ['Price / sq ft', 'Prix / m² (Prix / sq ft)', 'Precio / m²'],
    hoa: ['Monthly HOA', 'Frais mensuels', 'Mantenimiento mensual'],
    predial: ['Annual Property Tax', 'Taxe annuelle', 'Predial anual']
  }
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim() }
  /* The frame of a figure: the element that holds the value, right after the one that holds exactly this name */
  function frame(key) {
    var all = document.querySelectorAll('div, span'), names = NAMES[key].map(function (n) { return n.toLowerCase() })
    for (var i = 0; i < all.length; i++) {
      var el = all[i]
      if (el.children.length || names.indexOf(norm(el.textContent).toLowerCase()) < 0) continue
      if (el.nextElementSibling) return el.nextElementSibling
    }
    return null
  }
  /* « 700 m² (7,535 sq ft) » : the generator writes the second measure in its own small frame, kept as it is */
  function put(el, text, second) {
    if (!el || !text) return
    var small = el.querySelector('span')
    if (second === undefined) { var cut = text.indexOf(' ('); if (cut > 0 && small) { second = text.slice(cut + 1); text = text.slice(0, cut) } }
    if (second && small) {
      if (norm(small.textContent) === norm(second) && norm(el.firstChild && el.firstChild.nodeValue) === norm(text)) return
      for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) { n.nodeValue = text + ' '; break }
      small.textContent = second
    } else {
      var whole = second ? text + ' ' + second : text
      if (norm(el.textContent) !== norm(whole)) el.textContent = whole
    }
  }

  function apply(c) {
    if (!c || c.absent || c.error || !c.price) return
    /* The price, and the price it had before: struck through, under it */
    var price = frame('price')
    if (price) {
      var before = norm(price.textContent), now = c.price + ' ' + (c.currency || 'USD')
      var old = price.nextElementSibling && /line-through/.test(price.nextElementSibling.className) ? price.nextElementSibling : null
      if (before !== now) price.textContent = now
      if (c.priceOld) {
        if (!old) {
          old = document.createElement('div')
          old.className = 'text-[10px] sm:text-base text-[#223256]/60 line-through mt-0.5'
          price.parentNode.insertBefore(old, price.nextSibling)
        }
        var struck = c.priceOld + ' ' + (c.currency || 'USD')
        if (norm(old.textContent) !== struck) old.textContent = struck
      } else if (old) old.parentNode.removeChild(old)
      /* The messages already written for WhatsApp and the email say the price too */
      var was = before.replace(/\s*[A-Z]{3}$/, '')
      if (was && was !== c.price) ['waBtn', 'visitBtn', 'mailBtn'].forEach(function (id) {
        var a = document.getElementById(id); if (!a || !a.href) return
        var h = a.getAttribute('href'), from = encodeURIComponent(was), to = encodeURIComponent(c.price)
        if (h.indexOf(from) >= 0) a.setAttribute('href', h.split(from).join(to))
      })
    }
    put(frame('beds'), c.beds); put(frame('baths'), c.baths); put(frame('year'), c.year)
    put(frame('construction'), c.construction); put(frame('lot'), c.lot)
    if (c.parSurface && c.parSurface.a) put(frame('per'), c.parSurface.a, c.parSurface.b ? '(' + c.parSurface.b + ')' : '')
    put(frame('hoa'), c.hoa); put(frame('predial'), c.predial)
  }

  fetch(API).then(function (r) { return r.ok ? r.json() : null }).then(apply).catch(function () {})
})()
