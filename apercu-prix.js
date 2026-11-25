#!/usr/bin/env node
/**
 * apercu-prix.js : the price in the link preview of each listing follows her sheet (25/11/2026, her « OUI stp »).
 *
 * When she pastes the link of a listing in WhatsApp or Facebook, the preview shows the line the generator wrote in the
 * page the day it was published: « Puerto Aventuras, Riviera Maya · $1,500,000 USD ». feuille.js corrects the price once
 * the page is OPEN, but a preview never runs a script: it kept the old price.
 *
 * Each night, after sync-listings.js, this file asks the App what her sheet says for every published page
 * (the same answer feuille.js gets: /partage/annonces?listing=…, rules in the App, src/lib/annonces.ts), and rewrites that
 * one line where the price differs. It then records and sends those pages, and only those, so the site of the
 * listings is published again with the right previews.
 *
 *   node apercu-prix.js            does it
 *   node apercu-prix.js --essai    says what it would do, writes nothing
 *
 * Paused from her sheet: tab « Où se change quoi », the line « Aperçu WhatsApp », « Non » in column B.
 * It never forces anything: if the folder cannot be brought up to date, or the sending fails, it says so and stops.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API = 'https://property.management.signature-sc.com/partage/annonces?listing=';
const SHEET_ID = '1tHk8rZ4dZb9NsVxVQrVTdxKFwNy6BUeGf-rsPUZ_BmM';
const SWITCH = "'Où se change quoi'!A1:B40";
const LINE = /(og:description" content="[^"]*? · )([^"]*)/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const git = (...args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/* Her switch: « Non » beside « Aperçu WhatsApp » pauses the night rewrite. A sheet that cannot be read does not pause it. */
async function paused() {
  try {
    const { google } = await import('googleapis');
    const auth = new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_SA_KEYFILE || 'C:/Users/win10/.keys/service-account.json', scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const r = await google.sheets({ version: 'v4', auth }).spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: SWITCH });
    const row = (r.data.values || []).find(l => /^aper[çc]u whatsapp/i.test(String(l[0] || '')));
    return !!row && /^non\b/i.test(String(row[1] || '').trim());
  } catch (e) { console.log('   (switch not read: ' + e.message + ')'); return false; }
}

export async function apercus({ dry = false } = {}) {
  console.log('\n🔗 Link previews: the price of each listing against her sheet' + (dry ? ' (dry run)' : ''));
  if (await paused()) { console.log('   Paused from her sheet (« Non » beside « Aperçu WhatsApp »).'); return { changed: [] }; }
  if (!dry) {
    try { git('pull', '--ff-only'); }
    catch (e) { console.log('   The folder could not be brought up to date, nothing rewritten: ' + String(e.stderr || e.message).trim().split('\n')[0]); return { changed: [] }; }
  }
  const root = path.join(__dirname, 'for-sale'), changed = [], said = [];
  for (const slug of fs.readdirSync(root).sort()) {
    for (const lang of ['en', 'fr', 'es']) {
      const rel = `for-sale/${slug}/${lang}/index.html`, file = path.join(__dirname, rel);
      if (!fs.existsSync(file)) continue;
      const html = fs.readFileSync(file, 'utf8'), m = html.match(LINE);
      if (!m) continue;
      let c = null;
      try { const r = await fetch(API + slug + '&lang=' + lang); c = r.ok ? await r.json() : null; } catch { /* the App is silent: this page keeps its line */ }
      await sleep(120);
      if (!c || c.absent || c.error || !c.price) continue;
      const want = `${c.price} ${c.currency || 'USD'}`;
      if (m[2] === want) continue;
      said.push(`${slug}/${lang} : ${m[2]} → ${want}`);
      if (dry) continue;
      /* A page someone is working on (not recorded yet) is left to them */
      if (git('status', '--porcelain', '--', rel)) { said[said.length - 1] += '  (left alone: the page has changes not recorded yet)'; continue; }
      fs.writeFileSync(file, html.replace(LINE, (all, a) => a + want));
      changed.push(rel);
    }
  }
  if (!said.length) { console.log('   Every preview already says the price of her sheet.'); return { changed }; }
  said.forEach(s => console.log('   ' + s));
  if (dry || !changed.length) return { changed };
  try {
    git('add', '--', ...changed);
    git('commit', '-m', `Aperçu des liens : le prix de ${changed.length} page(s) suit sa feuille (passage du ${new Date().toISOString().slice(0, 10)})`, '--', ...changed);
    git('push');
    console.log(`   ${changed.length} page(s) rewritten, recorded and sent.`);
  } catch (e) { console.log('   Rewritten here, but NOT sent: ' + String(e.stderr || e.message).trim().split('\n')[0]); }
  return { changed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  apercus({ dry: process.argv.includes('--essai') }).catch(e => { console.error('Link previews:', e.message); process.exit(1); });
}
