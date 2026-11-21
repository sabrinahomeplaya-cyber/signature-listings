#!/usr/bin/env node
/**
 * sync-listings.js
 * Reads property files from Google Drive "02 Properties > 1. Puerto Aventuras > For Sale",
 * extracts fields via Claude API, and syncs to Google Sheets.
 *
 * Usage:
 *   node sync-listings.js
 *
 * Requirements:
 *   npm install googleapis @anthropic-ai/sdk pdf-parse
 *   the service account key at C:/Users/win10/.keys/service-account.json
 *   (override with GOOGLE_SA_KEYFILE)
 */

import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CONFIG ────────────────────────────────────────────────────────────────────
// The key lives OUTSIDE OneDrive, under a stable name: a rotation touches
// one file, and no private key sits in a synced folder.
const CREDENTIALS_PATH   = process.env.GOOGLE_SA_KEYFILE
  || 'C:/Users/win10/.keys/service-account.json';
const SHEET_ID           = '1tHk8rZ4dZb9NsVxVQrVTdxKFwNy6BUeGf-rsPUZ_BmM';
const SHEET_NAME         = 'For Sale';
const NIGHT              = process.argv.includes('--nuit');
// --essai: says what the run would do, row by row, without any Claude call and without writing to the sheet
const DRY                = process.argv.includes('--essai');
const DATA_START_ROW     = 5;   // 1-based, rows 1-4 are headers
const DRIVE_FOLDER_PATH    = ['1. Puerto Aventuras', '1. For Sale'];
const DRIVE_ROOT_FOLDER_ID = '1sQpqCmvJD6vR3T5LUTWiCoCW2oFQyxYm';

// Area derived from the Drive folder name → sheet dropdown value
const AREA_FROM_FOLDER = 'PA'; // "1. Puerto Aventuras" → "PA"

// Normalize Claude's property_type to valid sheet dropdown values
const PROPERTY_TYPE_MAP = {
  penthouse:  'Condo',
  villa:      'House',
  house:      'House',
  condo:      'Condo',
  apartment:  'Condo',
  hotel:      'Hotel',
  land:       'Land',
  commercial: 'Commercial',
};

// Classify folder role from name suffix: PersonName_O_SXXX = owner, PersonName_B_SXXX = broker
function classifyFolderRole(folderName) {
  if (/_O_S\d+/i.test(folderName)) return 'owner';
  if (/_B_S\d+/i.test(folderName)) return 'broker';
  return null;
}

// Extract person name from folder title:
//   "3BR - $759,000 USD - Bloom B - Geraldine_B_S315" → "Geraldine"
//   "House - 4BR - $1,800,000 USD - Casa Angelica - Martin_O_S717" → "Martin"
function parseNameFromFolder(folderName) {
  // New format: name ends with _O_SXXX or _B_SXXX
  const newFmt = folderName.match(/[-–\s]([A-Za-zÀ-ÿ][^_\-–]+?)_[OB]_S\d+\s*$/i);
  if (newFmt) return newFmt[1].trim();
  // Legacy fallback: name ends with _SXXX (no _O/_B yet)
  const codeMatch = folderName.match(/_S\d+\s*$/);
  if (!codeMatch) return null;
  const before   = folderName.slice(0, codeMatch.index);
  const lastDash = before.lastIndexOf(' - ');
  if (lastDash === -1) return null;
  return before.slice(lastDash + 3).trim();
}

// Column order in the sheet (A=0, B=1, …)
const COL = {
  AREA:             0,  // A
  PROPERTY_TYPE:    1,  // B
  BR:               2,  // C
  BA:               3,  // D
  BUILT:            4,  // E  ← year built
  PRICE_USD:        5,  // F
  PRICE_MXN:        6,  // G
  PRICE_PER_M2:     7,  // H  ← price per m²
  M2:               8,  // I  ← construction m²
  LOT_M2:           9,  // J  ← lot/balcony m²
  TOTAL_M2:         10, // K  ← construction + lot m²
  PRICE_PER_SQFT:   11, // L  ← price per sq ft
  SQ_FT:            12, // M  ← construction sq ft
  LOT_SQFT:         13, // N  ← lot/balcony sq ft
  TOTAL_SQFT:       14, // O  ← construction + lot sq ft
  HOA:              15, // P
  PREDIAL_MXN:      16, // Q
  GROUND_FLOOR:     17, // R
  PENTHOUSE:        18, // S
  ROOFTOP:          19, // T
  UNFURNISHED:      20, // U
  DETAILS:          21, // V
  LISTINGS_LINK:    22, // W
  SIGNATURE_LINK:   23, // X
  DRIVE_LINK:       24, // Y  ← unique key
  CREATED_DATE:     25, // Z
  STATUS:           26, // AA
  MAP_LOCATION:     27, // AB ← manual (preserved on update, never overwritten)
  OWNER_NAME:       28, // AC
  BROKER_NAME:      29, // AD
  // AE (30): Phone — manual, never touched
};
const TOTAL_MANAGED_COLS = 30; // A–AD (includes AB=27 which is preserved)
const TOTAL_COLS         = 31; // A–AE (to read Phone too)

// Price per m² (H) and per sq ft (L) are FORMULAS, not numbers (her request of 08/11/2026): the sheet
// recomputes them when a price or an area changes, also on Verified rows and rows typed by hand.
// Same rule as the generator: price / construction, m² first for H, sq ft first for L (1 m² = 10.764 sq ft).
// The same text works on every row thanks to ROW(). No decimal is written, and the separator follows
// the sheet's locale (set in main): the API reads a formula in that locale, fr_FR wants ';'.
const PRICE_PER_AREA_FORMULA = {
  M2:   '=LET(p;INDEX(F:F;ROW());m;INDEX(I:I;ROW());s;INDEX(M:M;ROW());IF(N(p)=0;"";IF(N(m)>0;ROUND(p/m);IF(N(s)>0;ROUND(p*10764/(s*1000));""))))',
  SQFT: '=LET(p;INDEX(F:F;ROW());m;INDEX(I:I;ROW());s;INDEX(M:M;ROW());IF(N(p)=0;"";IF(N(s)>0;ROUND(p/s);IF(N(m)>0;ROUND(p*1000/(m*10764));""))))',
};
let formulaSeparator = ';';
const priceFormula = kind => PRICE_PER_AREA_FORMULA[kind].replace(/;/g, formulaSeparator);

// ─── GOOGLE AUTH ───────────────────────────────────────────────────────────────
function getAuth() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      // Not readonly since 17/11/2026: the price of column F goes into the folder's name (syncPrice). The key can only
      // rename the folders shared with it as Editor; everything else in Drive stays read only in this script.
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  });
}

// Shared Drive params — required for all Drive API calls when files live in a Shared Drive
const SD = { supportsAllDrives: true, includeItemsFromAllDrives: true };

// ─── DRIVE HELPERS ─────────────────────────────────────────────────────────────
async function resolveFolderPath(drive, folderNames, rootId = 'root') {
  let parentId = rootId;
  for (const name of folderNames) {
    const res = await drive.files.list({
      q: `'${parentId}' in parents and name = '${name.replace(/'/g,"\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 10,
      ...SD,
    });
    const folder = res.data.files?.[0];
    if (!folder) throw new Error(`Folder not found: "${name}" (parent: ${parentId})`);
    parentId = folder.id;
  }
  return parentId;
}

async function listFilesInFolder(drive, folderId) {
  const files = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, webViewLink, createdTime)',
      pageSize: 100,
      pageToken: pageToken || undefined,
      ...SD,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

async function readFileContent(drive, file) {
  const { id, mimeType, name } = file;

  // Google Docs → export as plain text
  if (mimeType === 'application/vnd.google-apps.document') {
    const res = await drive.files.export({ fileId: id, mimeType: 'text/plain', ...SD }, { responseType: 'text' });
    return res.data;
  }

  // Google Sheets → export as CSV
  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    const res = await drive.files.export({ fileId: id, mimeType: 'text/csv', ...SD }, { responseType: 'text' });
    return res.data;
  }

  // PDF → download binary then extract text
  if (mimeType === 'application/pdf') {
    const res = await drive.files.get({ fileId: id, alt: 'media', ...SD }, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(res.data);
    try {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      return result.text || null;
    } catch (e) {
      console.warn(`  ⚠ Could not parse PDF "${name}": ${e.message}`);
      return null;
    }
  }

  // Plain text / markdown / other text types
  if (mimeType.startsWith('text/') || mimeType === 'application/json') {
    const res = await drive.files.get({ fileId: id, alt: 'media', ...SD }, { responseType: 'text' });
    return res.data;
  }

  return null; // unsupported type
}

// ─── PARSE FROM FOLDER NAME ────────────────────────────────────────────────────
// Extract structured data when no document exists in the Drive folder.
// Examples:
//   "4BR - $1,450,000 USD - Quinta Luna Penthouse - Lori_O_S400"
//   "House - 3BR - $1,200,000 USD - Casa Maya - Elly_B_S718"
//   "0 Studios - $295,000 USD - Dolfinarium - Yoanna_O_S001"
function parseFromFolderName(folderName) {
  const lower = folderName.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // BR count
  const brMatch = folderName.match(/(\d+)\s*BR/i);
  const br = brMatch ? parseInt(brMatch[1]) : (lower.includes('studio') ? 0 : null);

  // Price USD — handle both "$1,200,000" and "$.850,000"
  const priceMatch = folderName.match(/\$\.?([\d,]+)/);
  const price_usd  = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : null;

  // Property type
  let property_type = null;
  if (/^house/i.test(folderName))                                   property_type = 'House';
  else if (/\bvilla\b/i.test(folderName))                          property_type = 'House';
  else if (/\bpenthouse\b/i.test(folderName))                      property_type = 'Condo';
  else if (/\btownhouse\b/i.test(folderName))                      property_type = 'Condo';
  else if (/\b(condo|apartment|studio)\b/i.test(folderName))       property_type = 'Condo';
  else if (/\bland\b/i.test(folderName))                           property_type = 'Land';

  // Property name — between last price token and person name before _SXXX
  // Try: after "USD - " or after "$ - "
  let property_name = null;
  const withUSD = folderName.match(/USD\s*[-–]\s*(.+?)\s*[-–]\s*[^-–]+?_[OBob]?_?[SR]\w*\d+/);
  if (withUSD) {
    property_name = withUSD[1].trim();
  } else {
    const afterPrice = folderName.match(/\$[\d,\.]+(?:\s*USD)?\s*[-–]\s*(.+?)\s*[-–]\s*[^-–]+?_[OBob]?_?[SR]\w*\d+/);
    if (afterPrice) property_name = afterPrice[1].trim();
  }

  const penthouse = /\bpenthouse\b/i.test(folderName) ? true : null;

  return { property_type, br, price_usd, property_name, penthouse };
}

// ─── LISTING OVERRIDES ─────────────────────────────────────────────────────────
// Load optional listing-overrides.json: { "keyword": "https://listing.signature-sc.com/..." }
// Use when Drive folder name has no words in common with the GitHub listing slug.
function loadListingOverrides() {
  const p = path.join(__dirname, 'listing-overrides.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function matchOverride(folderName, overrides) {
  const lower = folderName.toLowerCase();
  for (const [keyword, url] of Object.entries(overrides)) {
    if (lower.includes(keyword.toLowerCase())) return url;
  }
  return null;
}

// ─── LOCAL LISTING MAP ─────────────────────────────────────────────────────────
// Build a slug→URL map from the local for-sale/ directory
function buildLocalListingMap() {
  const forSaleDir = path.join(__dirname, 'for-sale');
  if (!fs.existsSync(forSaleDir)) return {};
  return Object.fromEntries(
    fs.readdirSync(forSaleDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => [d.name, `https://listing.signature-sc.com/for-sale/${d.name}/en/`])
  );
}

// Try to match a Drive folder name to a known local listing slug.
// Strategy: split each known slug into words, check all appear in the folder name.
// "House - 4BR - $.685,000 USD - Casa Sol - Sol_O_S701" → matches slug "casa-sol"
function matchLocalListing(folderName, localListingMap) {
  // Normalize folder name: lowercase, remove accents, keep only letters/digits/spaces
  const normalized = folderName.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();

  // Score each slug: count how many of its words appear in the folder name
  // Skip very short words (≤2 chars) to avoid false positives
  let bestSlug = null;
  let bestScore = 0;

  for (const slug of Object.keys(localListingMap)) {
    const words = slug.split('-').filter(w => w.length > 2);
    if (words.length === 0) continue;
    const matches = words.filter(w => normalized.includes(w)).length;
    const score   = matches / words.length; // 1.0 = all words matched
    if (score === 1.0 && matches > bestScore) {
      bestScore = matches;
      bestSlug  = slug;
    }
  }

  return bestSlug ? localListingMap[bestSlug] : null;
}

// ─── FETCH SIGNATURE SC LISTING ────────────────────────────────────────────────
// Try /fr/ first (displays m² natively), fall back to the original URL (/en/ or /es/)
async function fetchSignatureListing(url) {
  const frUrl = url.replace(/\/(en|es)\/$/, '/fr/');
  const urlsToTry = frUrl !== url ? [frUrl, url] : [url];

  for (const tryUrl of urlsToTry) {
    const result = await _fetchAndParse(tryUrl);
    if (result) return result;
  }
  return null;
}

async function _fetchAndParse(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();

    const result = {};

    // ── 1. Detail grid: <div class="text-xs ...">Label</div><div class="text-xl ...">Value</div>
    // Used for: Bedrooms, Bathrooms, Construction, Lot size, Year built
    const divCells = [...html.matchAll(
      /<div[^>]*\btext-xs\b[^>]*>([^<]+)<\/div>\s*<div[^>]*\btext-xl\b[^>]*>([^<]*)<\/div>/g
    )];
    const allLabels = [];
    for (const [, label, value] of divCells) {
      const l = label.trim().toLowerCase();
      const v = value.replace(/<[^>]+>/g, '').trim();
      if (v) allLabels.push(l);
      if (!v) continue;
      if (l.includes('bedroom') || l.includes('chambre'))                      result.beds          = result.beds          || v;
      if (l.includes('bathroom') || l.includes('salle'))                       result.baths         = result.baths         || v;
      if (l.includes('construction') || l.includes('living area'))             result.construction  = result.construction  || v;
      if (l.includes('parking') || l.includes('lot') || l.includes('balcony') || l.includes('terrace') || l.includes('terrasse') || l.includes('balcon') || l.includes('terrain')) result.lot = result.lot || v;
      if (l.includes('year') || l.includes('built') || l.includes('année'))    result.year_built    = result.year_built    || v;
      if (l.includes('price') && (l.includes('sq') || l.includes('m²') || l.includes('m2'))) result.price_per_sqft = result.price_per_sqft || v;
    }
    // Infer property type from detail grid labels
    const hasLot      = allLabels.some(l => l.includes('lot') || l.includes('land') || l.includes('terrain'));
    const hasBalcony  = allLabels.some(l => l.includes('balcony') || l.includes('balcon') || l.includes('terrasse') || l.includes('terrace') || l.includes('parking'));
    if      (hasLot && !hasBalcony) result.property_type = 'House';
    else if (hasBalcony && !hasLot) result.property_type = 'Condo';
    else if (hasLot  &&  hasBalcony) result.property_type = 'House';

    // ── 2. Financial row: <span ...>Label</span><span ...>Value</span>
    // Used for: Monthly HOA, Annual Property Tax (Predial)
    const spanCells = [...html.matchAll(
      /<span[^>]*>([^<]+)<\/span>\s*<span[^>]*>([^<]+)<\/span>/g
    )];
    for (const [, label, value] of spanCells) {
      const l = label.trim().toLowerCase();
      const v = value.trim();
      if (!v) continue;
      if (l.includes('hoa') || l.includes('mantenimiento') || l.includes('maintenance') || l.includes('frais'))
        result.hoa     = result.hoa     || v;
      if (l.includes('tax') || l.includes('predial') || l.includes('impuesto') || l.includes('taxe'))
        result.predial = result.predial || v;
    }

    // ── 3. Price from const listing = { price: "..." }
    const priceMatch = html.match(/price\s*:\s*["']([^"']+)["']/);
    if (priceMatch) result.price = priceMatch[1].trim();

    return result;
  } catch (e) {
    return null;
  }
}

// Parse numeric value from strings like "1,410 sq ft", "130 m²", "$1,200,000"
function parseNum(str) {
  if (!str) return null;
  const n = parseFloat(String(str).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

// Fix bathroom count: Claude sometimes returns 5.1 instead of 5.5 for "5 baths + 1 half bath".
// Rule: any decimal part between 0.01 and 0.49 is a misencoded half-bath → round up to .5
//       otherwise round to nearest 0.5 (e.g. 2.75 → 3.0, 2.0 → 2.0)
function fixBa(n) {
  if (n == null || n === '') return n;
  const num = parseFloat(n);
  if (isNaN(num)) return n;
  const decimal = num % 1;
  if (decimal > 0.01 && decimal < 0.49) return Math.floor(num) + 0.5;
  return Math.round(num * 2) / 2;
}

// ─── CLAUDE EXTRACTION ─────────────────────────────────────────────────────────
// Load Anthropic API key from env var or local key file
// Handles UTF-16LE (PowerShell default on Windows) and UTF-8 with/without BOM
function getAnthropicKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const keyFile = path.join(__dirname, 'anthropic.key');
  if (fs.existsSync(keyFile)) {
    const buf = fs.readFileSync(keyFile);
    let key;
    if (buf[0] === 0xFF && buf[1] === 0xFE) {
      key = buf.subarray(2).toString('utf16le');       // UTF-16LE (PowerShell echo)
    } else if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      key = buf.subarray(3).toString('utf8');           // UTF-8 with BOM
    } else {
      key = buf.toString('utf8');                    // plain UTF-8
    }
    return key.replace(/[^\x20-\x7E]/g, '').trim(); // strip non-printable ASCII
  }
  throw new Error('Anthropic API key not found. Set ANTHROPIC_API_KEY or create anthropic.key file.');
}
const anthropic = new Anthropic({ apiKey: getAnthropicKey() });

const EXTRACTION_PROMPT = `You are a real estate data extraction assistant. From the document content below, extract the following fields and return ONLY valid JSON (no markdown, no explanation).

Fields to extract:
- property_type: e.g. "House", "Condo", "Villa", "Penthouse", "Land" (string)
- br: number of bedrooms — INTEGER only, no text (number or null)
- ba: number of bathrooms — ONLY use multiples of 0.5: 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, etc. NEVER output 5.1, 4.1, 3.1 etc. A "half bath", "powder room" or "toilet" counts as +0.5. Round to nearest 0.5. Examples: "5 baths + 1 half bath" → 5.5, "5 bathrooms + service bath" → 5.5 (number or null)
- built: year of construction, 4-digit integer (number or null)
- price_usd: price in USD, digits only, no $ or commas (number or null)
- price_mxn: price in MXN, digits only, no $ or commas (number or null)
- m2: construction/living area in m² — digits only, no units (number or null)
- lot_m2: lot/land/balcony/terrace area in m² — digits only, no units (number or null)
- sqft: construction/living area in sq ft — digits only, no units (number or null)
- lot_sqft: lot/land/balcony/terrace area in sq ft — digits only, no units (number or null)
- hoa: monthly HOA/maintenance fee in USD, digits only (number or null)
- predial_mxn: annual property tax (predial) in MXN, digits only (number or null)
- ground_floor: is this a ground floor unit? (true/false/null)
- penthouse: is this a penthouse? (true/false/null)
- rooftop: does it have a rooftop terrace? (true/false/null)
- unfurnished: is the property unfurnished? true only if explicitly stated (true/false/null)
- details: property name followed by key highlights separated by commas. Focus on: beachfront, golf front, marina view, ocean view, pool, rooftop, garage, solar panels, private cenote, furnished, unfurnished. MAX 150 chars. Example: "Casa Sol · Golf front, private pool, solar panels, 2-car garage"
- listings_link: any external MLS/portal URL (not signature-sc.com) found (string or null)
- signature_link: the listing.signature-sc.com URL if found in the document (string or null)

Return exactly this JSON with no extra keys:
{
  "property_type": null, "br": null, "ba": null, "built": null,
  "price_usd": null, "price_mxn": null,
  "m2": null, "lot_m2": null, "sqft": null, "lot_sqft": null,
  "hoa": null, "predial_mxn": null,
  "ground_floor": null, "penthouse": null, "rooftop": null, "unfurnished": null,
  "details": null, "listings_link": null, "signature_link": null
}`;

// Strip any character with code point > 255 (causes ByteString errors in fetch)
function sanitizeForApi(str) {
  return Array.from(str).map(c => c.charCodeAt(0) > 255 ? ' ' : c).join('');
}

async function extractWithClaude(fileContent, fileName) {
  const truncated = sanitizeForApi(fileContent.slice(0, 12000));

  // Small delay to avoid Claude API rate limits
  await new Promise(r => setTimeout(r, 300));

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5', // cheaper model — extraction task doesn't need Sonnet
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `File name: ${sanitizeForApi(fileName)}\n\nDocument content:\n${truncated}`,
    }],
    system: EXTRACTION_PROMPT,
  });

  const raw = message.content.find(b => b.type === 'text')?.text || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    // Return empty extraction instead of throwing — unreadable docs shouldn't crash the row
    console.warn(`   ⚠ Claude returned no JSON — using empty extraction`);
    return {
      property_type: null, br: null, ba: null, built: null,
      price_usd: null, price_mxn: null,
      m2: null, lot_m2: null, sqft: null, lot_sqft: null,
      hoa: null, predial_mxn: null,
      ground_floor: null, penthouse: null, rooftop: null, unfurnished: null,
      details: null, listings_link: null, signature_link: null,
    };
  }
  const parsed = JSON.parse(jsonMatch[0]);
  console.log(`   🤖 Claude: br=${parsed.br} ba=${parsed.ba} m2=${parsed.m2} lot_m2=${parsed.lot_m2} price=${parsed.price_usd}`);
  return parsed;
}

// ─── SHEETS HELPERS ────────────────────────────────────────────────────────────
function colLetter(index) {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function readSheetRows(sheets) {
  const lastCol = colLetter(TOTAL_COLS - 1);
  const range = `${SHEET_NAME}!A${DATA_START_ROW}:${lastCol}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  return res.data.values || [];
}

// opts: { listing, isNew, ownerName, brokerName, existingStatus, existingRow }
function buildRow(extracted, driveFile, opts = {}) {
  const d   = extracted;
  const L   = opts.listing || {};
  const exR = opts.existingRow || [];           // existing sheet row (for manual columns)
  const bool = (v) => v === true ? 'TRUE' : v === false ? 'FALSE' : '';

  const row = new Array(TOTAL_MANAGED_COLS).fill('');

  // ── Identity ───────────────────────────────────────────────────────────────
  row[COL.AREA]          = AREA_FROM_FOLDER;
  const rawType = (L.property_type || d.property_type || '').toLowerCase().trim();
  row[COL.PROPERTY_TYPE] = PROPERTY_TYPE_MAP[rawType] ?? (L.property_type || d.property_type) ?? '';
  row[COL.BR]    = parseNum(L.beds)  ?? d.br    ?? '';
  row[COL.BA]    = fixBa(parseNum(L.baths) ?? d.ba) ?? '';
  row[COL.BUILT] = L.year_built      || d.built || '';

  // ── Prices ─────────────────────────────────────────────────────────────────
  const price_usd = d.price_usd ?? parseNum(L.price) ?? null;
  row[COL.PRICE_USD] = price_usd ?? '';
  row[COL.PRICE_MXN] = d.price_mxn ?? '';

  // ── Areas — construction (listing page first, Claude PDF extraction as fallback) ──
  const constrRaw  = L.construction || '';
  const sqftMatch  = constrRaw.match(/([\d,]+)\s*sq[\s\-]?ft/i);
  const m2Match    = constrRaw.match(/([\d,]+)\s*m[²2]/i);
  const sqftListing   = sqftMatch ? parseFloat(sqftMatch[1].replace(/,/g,'')) : null;
  const m2Listing     = m2Match   ? parseFloat(m2Match[1].replace(/,/g,''))   : null;
  // Use listing page values first; fall back to Claude-extracted values from PDF
  const sqft       = sqftListing ?? d.sqft   ?? (m2Listing   ? Math.round(m2Listing   / 0.0929) : d.m2   ? Math.round(d.m2   / 0.0929) : null);
  const m2         = m2Listing   ?? d.m2     ?? (sqftListing  ? Math.round(sqftListing  * 0.0929) : d.sqft ? Math.round(d.sqft * 0.0929) : null);
  row[COL.M2]    = m2   ?? '';
  row[COL.SQ_FT] = sqft ?? '';

  // ── Areas — lot / balcony ──────────────────────────────────────────────────
  const lotRaw       = L.lot || '';
  const lotSqftM     = lotRaw.match(/([\d,]+)\s*sq[\s\-]?ft/i);
  const lotM2M       = lotRaw.match(/([\d,]+)\s*m[²2]/i);
  const lotSqftListing  = lotSqftM ? parseFloat(lotSqftM[1].replace(/,/g,'')) : null;
  const lotM2Listing    = lotM2M   ? parseFloat(lotM2M[1].replace(/,/g,''))   : null;
  const lot_sqft     = lotSqftListing ?? d.lot_sqft ?? (lotM2Listing    ? Math.round(lotM2Listing    / 0.0929) : d.lot_m2 ? Math.round(d.lot_m2 / 0.0929) : null);
  const lot_m2       = lotM2Listing   ?? d.lot_m2   ?? (lotSqftListing   ? Math.round(lotSqftListing   * 0.0929) : d.lot_sqft ? Math.round(d.lot_sqft * 0.0929) : null);
  row[COL.LOT_M2]   = lot_m2   ?? '';
  row[COL.LOT_SQFT] = lot_sqft ?? '';

  // ── Areas — totals (Condo/Studio only: Construction + Balcony/Terrace) ────
  // For Houses, adding construction + land is meaningless — leave blank
  const isCondo = ['condo', 'studio'].includes(rawType);
  row[COL.TOTAL_M2]   = (isCondo && m2   && lot_m2)   ? m2   + lot_m2   : '';
  row[COL.TOTAL_SQFT] = (isCondo && sqft && lot_sqft) ? sqft + lot_sqft : '';

  // ── Price per area: formulas, see PRICE_PER_AREA_FORMULA ───────────────────
  row[COL.PRICE_PER_SQFT] = priceFormula('SQFT');
  row[COL.PRICE_PER_M2]   = priceFormula('M2');

  // ── Financials (listing page first, Claude PDF extraction as fallback) ────
  row[COL.HOA]         = parseNum(L.hoa)     ?? d.hoa         ?? '';
  row[COL.PREDIAL_MXN] = parseNum(L.predial) ?? d.predial_mxn ?? '';

  // ── Features ───────────────────────────────────────────────────────────────
  row[COL.GROUND_FLOOR] = bool(d.ground_floor);
  row[COL.PENTHOUSE]    = bool(d.penthouse);
  row[COL.ROOFTOP]      = bool(d.rooftop);
  row[COL.UNFURNISHED]  = bool(d.unfurnished);

  // ── Links & meta ──────────────────────────────────────────────────────────
  row[COL.DETAILS]        = d.details       ?? '';
  row[COL.LISTINGS_LINK]  = d.listings_link ?? '';
  row[COL.SIGNATURE_LINK] = d.signature_link ?? '';
  row[COL.DRIVE_LINK]     = driveFile.webViewLink;
  row[COL.CREATED_DATE]   = driveFile.createdTime ? driveFile.createdTime.slice(0, 10) : '';
  row[COL.STATUS]         = opts.isNew ? 'New' : (opts.existingStatus || 'New');

  // MAP_LOCATION (AB=27) — preserve existing value, never overwrite
  row[COL.MAP_LOCATION] = exR[COL.MAP_LOCATION] || '';

  row[COL.OWNER_NAME]  = opts.ownerName  || '';
  row[COL.BROKER_NAME] = opts.brokerName || '';

  // If this row is a fallback (PDF unreadable), preserve any existing data for blank cells
  if (opts.preserveExisting && exR.length > 0) {
    const PRESERVED_COLS = [
      COL.PROPERTY_TYPE, COL.BR, COL.BA, COL.BUILT,
      COL.PRICE_USD, COL.PRICE_MXN, COL.PRICE_PER_M2,
      COL.M2, COL.LOT_M2, COL.TOTAL_M2,
      COL.PRICE_PER_SQFT, COL.SQ_FT, COL.LOT_SQFT, COL.TOTAL_SQFT,
      COL.HOA, COL.PREDIAL_MXN,
      COL.GROUND_FLOOR, COL.PENTHOUSE, COL.ROOFTOP, COL.UNFURNISHED,
      COL.DETAILS, COL.LISTINGS_LINK, COL.SIGNATURE_LINK,
    ];
    for (const col of PRESERVED_COLS) {
      if ((row[col] === '' || row[col] == null) && exR[col]) {
        row[col] = exR[col];
      }
    }
  }

  return row;
}

async function writeRows(sheets, updates, appends) {
  const requests = [];

  // UPDATE existing rows — only columns A:U, preserve V:X (manual)
  for (const { sheetRowIndex, row } of updates) {
    const range = `${SHEET_NAME}!A${sheetRowIndex}:${colLetter(TOTAL_MANAGED_COLS - 1)}${sheetRowIndex}`;
    requests.push({ range, values: [row] });
  }

  if (requests.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: requests },
    });
  }

  // APPEND new rows
  if (appends.length > 0) {
    const lastCol = colLetter(TOTAL_MANAGED_COLS - 1);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A${DATA_START_ROW}:${lastCol}`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: appends },
    });
  }
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  // Build local listing map once at startup
  const localListingMap = buildLocalListingMap();
  console.log(`🗂  Local listings found: ${Object.keys(localListingMap).length} (${Object.keys(localListingMap).join(', ')})\n`);
  const listingOverrides = loadListingOverrides();
  if (Object.keys(listingOverrides).length > 0)
    console.log(`📌 Listing overrides: ${Object.keys(listingOverrides).join(', ')}\n`);

  console.log('🔑 Authenticating with Google…');
  const auth  = getAuth();
  const drive = google.drive({ version: 'v3', auth });
  const sheets = google.sheets({ version: 'v4', auth });

  // Formula separator: ';' where the sheet's locale writes 1,5 (fr_FR, es_ES), ',' where it writes 1.5 (en_US, es_MX)
  const sheetLocale = (await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'properties.locale' })).data.properties?.locale || 'fr_FR';
  formulaSeparator = new Intl.NumberFormat(sheetLocale.replace('_', '-')).format(1.5).includes(',') ? ';' : ',';

  // 1a. Debug: list immediate children of root folder
  console.log(`🔍 Listing subfolders inside root ID ${DRIVE_ROOT_FOLDER_ID}…`);
  const debugRes = await drive.files.list({
    q: `'${DRIVE_ROOT_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 50,
    ...SD,
  });
  (debugRes.data.files || []).forEach(f => console.log(`   📁 "${f.name}" (${f.id})`));
  if (!debugRes.data.files?.length) console.log('   (no subfolders found — check sharing permissions)');

  // 1. Resolve folder
  console.log(`\n📂 Resolving folder: ${DRIVE_FOLDER_PATH.join(' > ')}…`);
  const folderId = await resolveFolderPath(drive, DRIVE_FOLDER_PATH, DRIVE_ROOT_FOLDER_ID);
  console.log(`   Folder ID: ${folderId}`);

  // 2. List items in "1. For Sale" (mix of property subfolders and loose files)
  const items = await listFilesInFolder(drive, folderId);
  console.log(`   Found ${items.length} item(s)\n`);

  if (items.length === 0) {
    console.log('No items to process. Exiting.');
    return;
  }

  // Property folders always contain a price pattern like "$629,000" or "$.850,000"
  // Utility folders (I. PROJECTS, Link Websites, etc.) do not — filter them out
  const FOLDER_MIME = 'application/vnd.google-apps.folder';

  // A property folder has a price in its name (e.g. "$759,000")
  const isPropertyFolder = (name) => /\$[\d,\.]+/.test(name);

  // We are already inside "1. For Sale" — no need to filter by _S/_R suffix here.
  // Only exclude folders without a price pattern (utility folders).
  // Optional CLI filter: node sync-listings.js "Casa Maya" → only matching folders
  // --nuit: the run of the scheduled task (her decision of 17/11/2026). It only ADDS: a new Drive folder or a listing
  // not yet in the sheet becomes a row in "New". A row already there is never rewritten, even in "New", so her
  // corrections stay until she sets it "Verified", and the night costs no Claude call for the rows she is checking.
  // The launch by hand (Sync Listings.bat) keeps doing everything, as before.
  const filterRaw = process.argv.slice(2).find(a => !a.startsWith('--'));
  const filterArg = filterRaw ? filterRaw.toLowerCase() : null;
  if (filterArg) console.log(`🔎 Filter active: only folders containing "${filterArg}"\n`);
  if (NIGHT) console.log('🌙 Night run: new folders only, existing rows untouched\n');

  const propertyFolders = items.filter(i => {
    if (i.mimeType !== FOLDER_MIME || !isPropertyFolder(i.name)) return false;
    if (filterArg && !i.name.toLowerCase().includes(filterArg)) return false;
    return true;
  });
  const looseFiles      = items.filter(i => i.mimeType !== FOLDER_MIME);

  console.log(`   ${propertyFolders.length} property folder(s), ${looseFiles.length} loose file(s)\n`);

  // 3. Read existing sheet rows (to detect updates vs appends)
  console.log('📊 Reading existing sheet data…');
  const existingRows = await readSheetRows(sheets);
  // Build a map: driveLink → { sheetRowIndex, existingStatus, existingRow }
  const driveLinkToRow = new Map();
  const sigLinkToRow   = new Map();
  existingRows.forEach((row, i) => {
    const driveLink = row[COL.DRIVE_LINK] || '';
    if (driveLink) driveLinkToRow.set(driveLink, {
      sheetRowIndex:  DATA_START_ROW + i,
      existingStatus: (row[COL.STATUS] || '').trim(),
      existingRow:    row,
    });
    const sigLink = (row[COL.SIGNATURE_LINK] || '').trim();
    if (sigLink) sigLinkToRow.set(sigLink, {
      sheetRowIndex:  DATA_START_ROW + i,
      existingStatus: (row[COL.STATUS] || '').trim(),
      existingRow:    row,
    });
  });
  console.log(`   ${existingRows.length} existing row(s) in sheet\n`);

  // A row may also be known by its LISTING, found before any Claude call (17/11/2026): a row born from the listing
  // that has no Drive link yet (Casa Blanca), or a second folder made for the same home (Villa Elegancia, folders of
  // 31/03 and 07/11). Without this, both became a second row. Whole words only: « Casa Solimán » must never take the
  // row of « casa-sol ». An override of listing-overrides.json is trusted as it is.
  function rowByListing(folderName) {
    const override = matchOverride(folderName, listingOverrides);
    const url = override || matchLocalListing(folderName, localListingMap);
    if (!url) return null;
    const slug  = (url.match(/for-sale\/([^/]+)/) || [])[1] || '';
    const words = ' ' + folderName.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
    const whole = slug.split('-').filter(w => w.length > 2).every(w => words.includes(' ' + w + ' '));
    return (override || whole) ? (sigLinkToRow.get(url) || null) : null;
  }

  // ── The price, between the folder's name and column F ─────────────────────────────────────────────────────────
  // Her question of 17/11/2026: « parfois je change d'un côté et j'oublie de le faire de l'autre ». Each side's last
  // seen price is kept in %LOCALAPPDATA%\Signature Sync\price-memory.json (outside this repository). Only the side
  // that moved is copied to the other; both moved: nothing is touched, and it is said at each run until she sets them
  // equal; a folder seen for the first time is only noted. Done on the rows this run does not rewrite (Verified and
  // Off Market, and every row at night), for the folder of column Y only. The site reads its price in F (the App,
  // lib/annonces.ts): one cell is enough everywhere. F is read UNFORMATTED: formatted in her locale, « 1 295 000,00 $ »
  // would not read as a number. A rename needs the folder shared as Editor with the key: until then it is said.
  const PRICE_DIR    = path.join(process.env.LOCALAPPDATA || __dirname, 'Signature Sync');
  const PRICE_MEMORY = path.join(PRICE_DIR, 'price-memory.json');
  let priceMemory = {};
  try { priceMemory = JSON.parse(fs.readFileSync(PRICE_MEMORY, 'utf8')); } catch { /* the first run */ }
  const priceF = ((await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!F${DATA_START_ROW}:F`, valueRenderOption: 'UNFORMATTED_VALUE' })).data.values || []).map(r => r[0]);
  const priceSaid = [];
  const usd = n => '$' + Math.round(n).toLocaleString('en-US');

  // The old price (column AJ « Ancien prix USD », the struck price of the site), her rules of 17/11/2026: when the price
  // goes DOWN, the price it had goes to AJ; only into an empty AJ, so a second change keeps the very first price, and
  // a value she typed herself (an error she corrected) is never written over. Column AJ is outside A to AD: the rows
  // this script rewrites never touch it.
  const OLD_PRICE_COL = 'AJ';
  const priceAJ = ((await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!${OLD_PRICE_COL}${DATA_START_ROW}:${OLD_PRICE_COL}`, valueRenderOption: 'UNFORMATTED_VALUE' })).data.values || []).map(r => r[0]);
  async function oldPrice(row, before) {
    const i = row - DATA_START_ROW, cur = priceAJ[i];
    if (cur !== undefined && cur !== null && String(cur).trim() !== '') return;
    console.log(`   💲 Old price ${usd(before)} → column ${OLD_PRICE_COL}`);
    if (DRY) return;
    await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!${OLD_PRICE_COL}${row}`, valueInputOption: 'RAW', requestBody: { values: [[before]] } });
    priceAJ[i] = before;
    priceSaid.push(`row ${row}: ${usd(before)} kept as the old price (column ${OLD_PRICE_COL})`);
  }

  async function syncPrice(folder, ex) {
    const inName  = parseFromFolderName(folder.name).price_usd || null;
    const raw     = priceF[ex.sheetRowIndex - DATA_START_ROW];
    const inSheet = typeof raw === 'number' && raw > 0 ? Math.round(raw) : null;
    const seen = priceMemory[folder.id];
    // Column F went down since the last run: the price it had becomes the old price
    if (seen && seen.sheet > 0 && inSheet && inSheet < seen.sheet) await oldPrice(ex.sheetRowIndex, seen.sheet);
    if (!inName || !inSheet) return;
    const keep = (name, sheet) => { priceMemory[folder.id] = { name, sheet }; };
    if (inName === inSheet) { keep(inName, inSheet); return; }
    if (!seen) {
      keep(inName, inSheet);
      priceSaid.push(`row ${ex.sheetRowIndex}: folder ${usd(inName)}, column F ${usd(inSheet)}: noted, the next change on one side goes to the other`);
      return;
    }
    const nameMoved = inName !== seen.name, sheetMoved = inSheet !== seen.sheet;
    if (nameMoved && !sheetMoved) {
      console.log(`   💲 Folder price ${usd(inName)} → column F (was ${usd(inSheet)})`);
      if (DRY) return;
      await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!F${ex.sheetRowIndex}`, valueInputOption: 'RAW', requestBody: { values: [[inName]] } });
      // The price lowered in the folder's name: the price F had becomes the old price
      if (inName < inSheet) await oldPrice(ex.sheetRowIndex, inSheet);
      keep(inName, inName);
      priceSaid.push(`row ${ex.sheetRowIndex}: column F set to ${usd(inName)}, as in the folder's name`);
    } else if (sheetMoved && !nameMoved) {
      // A function, not a string: « $1,295,000 » as a replacement string would read « $1 » as a group
      const next = folder.name.replace(/\$\.?[\d,]+/, () => usd(inSheet));
      console.log(`   💲 Column F ${usd(inSheet)} → folder's name (was ${usd(inName)})`);
      if (DRY) return;
      const can = (await drive.files.get({ fileId: folder.id, fields: 'capabilities(canRename)', supportsAllDrives: true })).data.capabilities?.canRename;
      if (!can) { priceSaid.push(`row ${ex.sheetRowIndex}: folder still ${usd(inName)}, column F ${usd(inSheet)}: the key may not rename this folder (share "For Sale" with it as Editor)`); return; }
      await drive.files.update({ fileId: folder.id, supportsAllDrives: true, requestBody: { name: next } });
      keep(inSheet, inSheet);
      priceSaid.push(`row ${ex.sheetRowIndex}: folder renamed with ${usd(inSheet)}, as in column F`);
    } else {
      priceSaid.push(`row ${ex.sheetRowIndex}: folder ${usd(inName)} and column F ${usd(inSheet)} both changed: nothing touched, set them equal`);
    }
  }

  // 4. Build work list: { driveEntry (folder or file), contentFile (file to read), label }
  const workList = [];

  // Property subfolders: find first readable doc, searching recursively up to 2 levels deep
  async function findReadableDoc(folderId) {
    const children = await listFilesInFolder(drive, folderId);
    const readable = children.find(c =>
      c.mimeType !== FOLDER_MIME &&
      (c.mimeType === 'application/vnd.google-apps.document' ||
       c.mimeType === 'application/vnd.google-apps.spreadsheet' ||
       c.mimeType === 'application/pdf' ||
       c.mimeType.startsWith('text/'))
    );
    if (readable) return readable;
    // Go one level deeper into subfolders
    const subFolders = children.filter(c => c.mimeType === FOLDER_MIME);
    for (const sub of subFolders) {
      const found = await findReadableDoc(sub.id);
      if (found) return found;
    }
    return null;
  }

  for (const folder of propertyFolders) {
    const readable = await findReadableDoc(folder.id);
    const role       = classifyFolderRole(folder.name);
    const personName = parseNameFromFolder(folder.name);
    const ownerName  = role === 'owner'  ? (personName || '') : '';
    const brokerName = role === 'broker' ? (personName || '') : '';
    console.log(`   👤 role: ${role || 'unknown'} | name: "${personName || '?'}" | owner="${ownerName}" broker="${brokerName}"`);
    if (!readable) console.log(`   ℹ  Empty folder — will extract from folder name`);
    // Always add to workList — empty folders use folder name parsing instead of Claude
    workList.push({ driveEntry: folder, contentFile: readable || null, ownerName, brokerName });
  }

  // Loose files (e.g. "Link Websites", "Info - Data") are utility docs — not properties, skip them
  if (looseFiles.length > 0) {
    console.log(`   ℹ Skipping ${looseFiles.length} loose file(s): ${looseFiles.map(f => f.name).join(', ')}\n`);
  }

  // 5. Process each work item
  const updates = [];
  const appends = [];
  let skipped = 0;
  let locked  = 0;

  for (const { driveEntry, contentFile, ownerName, brokerName } of workList) {
    process.stdout.write(`📁 ${driveEntry.name}\n`);

    // Check lock BEFORE any API call — Verified/Off Market rows cost nothing
    const driveLink0  = driveEntry.webViewLink;
    const existing0   = driveLinkToRow.get(driveLink0) || rowByListing(driveEntry.name);
    // The price first, on the rows left as they are below, and only for the folder of column Y (see syncPrice)
    const ownRow = driveLinkToRow.get(driveLink0);
    if (ownRow && (NIGHT || ['Verified', 'Off Market'].includes(ownRow.existingStatus))) {
      try { await syncPrice(driveEntry, ownRow); }
      catch (err) { priceSaid.push(`row ${ownRow.sheetRowIndex}: price not compared (${err.message})`); }
    }
    if (existing0 && ['Verified', 'Off Market'].includes(existing0.existingStatus)) {
      console.log(`   🔒 Status "${existing0.existingStatus}" — skipping (row ${existing0.sheetRowIndex})\n`);
      locked++;
      continue;
    }
    if (existing0 && NIGHT) {
      console.log(`   🌙 Already in the sheet (row ${existing0.sheetRowIndex}): left as it is\n`);
      locked++;
      continue;
    }
    if (DRY) {
      console.log(existing0 ? `   🧪 Would analyze and update row ${existing0.sheetRowIndex} (${existing0.existingStatus || 'no status'})\n` : '   🧪 Would analyze and ADD a new row\n');
      continue;
    }

    let extracted;

    if (!contentFile) {
      // ── Empty folder: extract directly from folder name ──
      console.log(`   📝 No document — parsing folder name`);
      const parsed = parseFromFolderName(driveEntry.name);
      extracted = {
        property_type:  parsed.property_type,
        br:             parsed.br,
        ba:             null,
        price_usd:      parsed.price_usd,
        price_mxn:      null,
        ground_floor:   null,
        penthouse:      parsed.penthouse,
        rooftop:        null,
        unfurnished:    null,
        details:        parsed.property_name || null,
        listings_link:  null,
        signature_link: null,
      };
    } else {
      // ── Normal flow: read document + Claude extraction ──
      console.log(`   📄 ${contentFile.name} (${contentFile.mimeType})`);
      let content;
      try {
        content = await readFileContent(drive, contentFile);
      } catch (err) {
        console.warn(`   ⚠ Could not read: ${err.message} — skipping\n`);
        skipped++;
        continue;
      }

      if (!content) {
        // PDF unreadable or unsupported MIME — fall back to folder name parsing + preserve existing
        console.log(`   📝 Could not read content — falling back to folder name`);
        const parsed = parseFromFolderName(driveEntry.name);
        extracted = {
          property_type:  parsed.property_type,
          br:             parsed.br,
          ba:             null,
          built:          null,
          price_usd:      parsed.price_usd,
          price_mxn:      null,
          m2:             null,
          lot_m2:         null,
          sqft:           null,
          lot_sqft:       null,
          hoa:            null,
          predial_mxn:    null,
          ground_floor:   false,
          penthouse:      parsed.penthouse || false,
          rooftop:        false,
          unfurnished:    false,
          details:        parsed.property_name || '',
          listings_link:  null,
          signature_link: null,
          _preserveExisting: true,   // flag: keep existing sheet data for blank fields
        };
        // Skip Claude — jump to row building
      } else {
        const contextText = `Folder name: ${driveEntry.name}\nFile name: ${contentFile.name}\n\n${content}`;
        try {
          extracted = await extractWithClaude(contextText, driveEntry.name);
        } catch (err) {
          console.warn(`   ⚠ Claude extraction failed: ${err.message} — skipping\n`);
          skipped++;
          continue;
        }
      } // closes else (content exists)
    } // closes else (contentFile exists)

    // Resolve signature_link: Claude extraction → override file → local folder match
    if (!extracted.signature_link) {
      const overrideUrl = matchOverride(driveEntry.name, listingOverrides);
      if (overrideUrl) {
        extracted.signature_link = overrideUrl;
        console.log(`   📌 Override match: ${overrideUrl}`);
      } else {
        const localUrl = matchLocalListing(driveEntry.name, localListingMap);
        if (localUrl) {
          extracted.signature_link = localUrl;
          console.log(`   🗂  Matched local listing: ${localUrl}`);
        } else {
          console.log(`   ℹ  No local listing match`);
        }
      }
    }

    // Fetch Signature SC listing page for reliable m2/sqft/HOA/Predial/BR/BA
    let listing = null;
    if (extracted.signature_link) {
      console.log(`   🌐 Fetching listing: ${extracted.signature_link}`);
      listing = await fetchSignatureListing(extracted.signature_link);
      if (listing) console.log(`   ✓ Listing data: beds=${listing.beds}, baths=${listing.baths}, constr=${listing.construction}`);
      else         console.log(`   ⚠ Could not fetch listing page`);
    }

    // Use the property FOLDER's link as the unique key (stable across doc edits)
    const driveLink  = driveEntry.webViewLink;
    const existing   = driveLinkToRow.get(driveLink) || existing0;
    const isNew      = !existing;

    const row = buildRow(extracted, driveEntry, {
      listing, isNew, ownerName, brokerName,
      existingStatus:   existing?.existingStatus || '',
      existingRow:      existing?.existingRow    || [],
      preserveExisting: extracted._preserveExisting || false,
    });

    if (!isNew) {
      updates.push({ sheetRowIndex: existing.sheetRowIndex, row });
      console.log(`   ✏  Queued for update → row ${existing.sheetRowIndex}\n`);
    } else {
      appends.push(row);
      console.log(`   ➕ Queued for append\n`);
    }
  }

  // 6. Second pass: GitHub listings not yet captured by Drive scan
  const handledSigLinks = new Set([
    ...appends.map(r => r[COL.SIGNATURE_LINK]).filter(Boolean),
    ...updates.map(({row}) => row[COL.SIGNATURE_LINK]).filter(Boolean),
    ...existingRows.map(r => (r[COL.SIGNATURE_LINK] || '').trim()).filter(Boolean),
  ]);

  const githubOnly = Object.entries(localListingMap)
    .filter(([slug, url]) => !handledSigLinks.has(url) && (!filterArg || slug.includes(filterArg)));

  if (githubOnly.length > 0) {
    console.log(`\n📦 ${githubOnly.length} GitHub listing(s) not yet in sheet — scanning…\n`);
    for (const [slug, url] of githubOnly) {
      process.stdout.write(`📁 ${slug} (GitHub-only)\n`);

      const existingGH = sigLinkToRow.get(url);
      if (existingGH && ['Verified', 'Off Market'].includes(existingGH.existingStatus)) {
        console.log(`   🔒 Status "${existingGH.existingStatus}" — skipping\n`);
        continue;
      }

      if (DRY) { console.log('   🧪 Would ADD a new row from the listing\n'); continue; }
      const listing = await fetchSignatureListing(url);
      if (!listing) { console.log(`   ⚠ Could not fetch listing page — skipping\n`); continue; }
      console.log(`   ✓ Listing: beds=${listing.beds}, baths=${listing.baths}, constr=${listing.construction}, type=${listing.property_type || '?'}`);

      const extracted = {
        property_type: listing.property_type || null,
        br: null, ba: null, built: null,
        price_usd: parseNum(listing.price), price_mxn: null,
        m2: null, lot_m2: null, sqft: null, lot_sqft: null,
        hoa: null, predial_mxn: null,
        ground_floor: null, penthouse: null, rooftop: null, unfurnished: null,
        details: null, listings_link: null, signature_link: url,
      };

      const fakeDrive = { webViewLink: '', createdTime: '' };
      const isNewGH   = !existingGH;
      const row = buildRow(extracted, fakeDrive, {
        listing, isNew: isNewGH,
        existingStatus: existingGH?.existingStatus || '',
        existingRow:    existingGH?.existingRow    || [],
      });

      if (!isNewGH) {
        updates.push({ sheetRowIndex: existingGH.sheetRowIndex, row });
        console.log(`   ✏  Queued for update → row ${existingGH.sheetRowIndex}\n`);
      } else {
        appends.push(row);
        console.log(`   ➕ Queued for append\n`);
      }
    }
  } else {
    console.log('\n✓ All GitHub listings already in sheet.\n');
  }

  // 7. Write to sheet
  if (updates.length > 0 || appends.length > 0) {
    console.log('💾 Writing to Google Sheets…');
    await writeRows(sheets, updates, appends);
  }

  // The prices seen this run, for the next one (a dry run keeps nothing)
  if (!DRY) { fs.mkdirSync(PRICE_DIR, { recursive: true }); fs.writeFileSync(PRICE_MEMORY, JSON.stringify(priceMemory, null, 1)); }

  // 8. Summary
  console.log('─'.repeat(50));
  console.log(`✅ Done.`);
  console.log(`   ${appends.length}  added`);
  console.log(`   ${updates.length}  updated`);
  console.log(`   ${locked}  locked (Verified / Off Market — not touched)`);
  console.log(`   ${skipped}  skipped (errors)`);
  if (priceSaid.length) { console.log('   💲 Prices, folder and column F:'); priceSaid.forEach(s => console.log(`      ${s}`)); }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
