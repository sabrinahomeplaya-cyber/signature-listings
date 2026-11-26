#!/usr/bin/env node
/**
 * reference-site.js : one page of reference per home, for the search engines (chantier 37, step 3.5, 26/11/2026).
 *
 * A home she publishes on the site has two pages: its fiche on the site (signature-sc.com/for-sale/<address>) and its
 * listing here (listing.signature-sc.com/for-sale/<slug>/en/). Her answer of 24/11/2026: the fiche of the site is the
 * reference, the listing stays and names it. Naming it is one line in the head of the listing,
 * <link rel="canonical" href="…">: a search engine then shows the fiche, and counts the listing's visits for it.
 *
 * Each night, after sync-listings.js, this file asks the App which homes are on the site and at which address
 * (/partage/annonces: her sheet, the box « Publier sur le site » and the column « Adresse sur le site »), and
 *   - writes that line in the ENGLISH page of each of them (the site is in English only until phase 5: a French or a
 *     Spanish listing has no page to name yet, it is left alone);
 *   - corrects it when her address changed;
 *   - takes it out of a listing that is no longer on the site.
 * It touches no other line, and only a line it wrote itself (data-site). It then records and sends those pages only.
 *
 *   node reference-site.js            does it
 *   node reference-site.js --essai    says what it would do, writes nothing
 *
 * ⚠️ OFF until the site is open: tab « Où se change quoi » of her sheet, the line « Référence Google des listings ».
 * It acts only on « Oui » there. A reference to an address that does not answer yet would send the search engines
 * to an empty page: the switch is turned on the day the site opens (phase 4), not before.
 * It never forces anything: if the folder cannot be brought up to date, or the sending fails, it says so and stops.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API = 'https://property.management.signature-sc.com/partage/annonces?frais=1';
const SITE = 'https://www.signature-sc.com/for-sale/';
const SHEET_ID = '1tHk8rZ4dZb9NsVxVQrVTdxKFwNy6BUeGf-rsPUZ_BmM';
const SWITCH = "'Où se change quoi'!A1:B40";
/* The line this file writes, whole, with the end of line that follows it */
const LINE = /[ \t]*<link rel="canonical" href="[^"]*" data-site>\r?\n/;
const git = (...args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/* Her switch: only « Oui » beside « Référence Google des listings » lets this file act. No line, a sheet that cannot be
   read, anything else: nothing is written. */
async function allowed() {
  try {
    const { google } = await import('googleapis');
    const auth = new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_SA_KEYFILE || 'C:/Users/win10/.keys/service-account.json', scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const r = await google.sheets({ version: 'v4', auth }).spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: SWITCH });
    const row = (r.data.values || []).find(l => /^r[ée]f[ée]rence google/i.test(String(l[0] || '')));
    return !!row && /^oui\b/i.test(String(row[1] || '').trim());
  } catch (e) { console.log('   (switch not read: ' + e.message + ')'); return false; }
}

/* The page with its line of reference set to `url`, or without it when `url` is empty */
export function withReference(html, url) {
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const bare = html.replace(LINE, '');
  if (!url) return bare;
  const line = `  <link rel="canonical" href="${url}" data-site>${eol}`;
  /* After the address of the page itself (og:url) when the page has one, else at the end of the head */
  const at = bare.match(/[ \t]*<meta property="og:url"[^>]*>\r?\n/);
  if (at) return bare.replace(at[0], at[0] + line);
  return bare.includes('</head>') ? bare.replace('</head>', line + '</head>') : bare;
}

export async function references({ dry = false, force = false } = {}) {
  console.log('\n🧭 Reference for the search engines: each listing names its fiche on the site' + (dry ? ' (dry run)' : ''));
  if (!force && !(await allowed())) { console.log('   Off in her sheet (« Référence Google des listings » is not on « Oui »): nothing written.'); return { changed: [] }; }
  let homes = null;
  try { const r = await fetch(API); const j = r.ok ? await r.json() : null; homes = j && Array.isArray(j.biens) && j.biens.length ? j.biens : null; } catch { /* the App is silent */ }
  if (!homes) { console.log('   The App did not say which homes are on the site: nothing written.'); return { changed: [] }; }
  if (!dry) {
    try { git('pull', '--ff-only'); }
    catch (e) { console.log('   The folder could not be brought up to date, nothing written: ' + String(e.stderr || e.message).trim().split('\n')[0]); return { changed: [] }; }
  }
  /* Only a home that has its fiche on the site, at a readable address */
  const address = {};
  for (const b of homes) if (b.fiche && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(b.adresse || ''))) address[b.slug] = b.adresse;
  const root = path.join(__dirname, 'for-sale'), changed = [], said = [];
  for (const slug of fs.readdirSync(root).sort()) {
    const rel = `for-sale/${slug}/en/index.html`, file = path.join(__dirname, rel);
    if (!fs.existsSync(file)) continue;
    const html = fs.readFileSync(file, 'utf8');
    const next = withReference(html, address[slug] ? SITE + address[slug] : '');
    if (next === html) continue;
    said.push(`${slug} : ${address[slug] ? 'names ' + SITE + address[slug] : 'no longer on the site, its reference is taken out'}`);
    if (dry) continue;
    /* A page someone is working on (not recorded yet) is left to them */
    if (git('status', '--porcelain', '--', rel)) { said[said.length - 1] += '  (left alone: the page has changes not recorded yet)'; continue; }
    fs.writeFileSync(file, next);
    changed.push(rel);
  }
  if (!said.length) { console.log('   Every listing of a home on the site already names its fiche.'); return { changed }; }
  said.forEach(s => console.log('   ' + s));
  if (dry || !changed.length) return { changed };
  try {
    git('add', '--', ...changed);
    git('commit', '-m', `Référence pour Google : ${changed.length} page(s) de listing désignent leur fiche du site (passage du ${new Date().toISOString().slice(0, 10)})`, '--', ...changed);
    git('push');
    console.log(`   ${changed.length} page(s) written, recorded and sent.`);
  } catch (e) { console.log('   Written here, but NOT sent: ' + String(e.stderr || e.message).trim().split('\n')[0]); }
  return { changed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  /* --essai --meme-eteint : what it would do if her switch were on (to read the list before she turns it on) */
  references({ dry: process.argv.includes('--essai'), force: process.argv.includes('--essai') && process.argv.includes('--meme-eteint') }).catch(e => { console.error('Reference for the search engines:', e.message); process.exit(1); });
}
