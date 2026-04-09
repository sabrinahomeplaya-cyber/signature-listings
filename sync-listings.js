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
 *   credentials.json (service account) in the same directory
 */

import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const CREDENTIALS_PATH   = path.join(__dirname, 'credentials.json');
const SHEET_ID           = '1tHk8rZ4dZb9NsVxVQrVTdxKFwNy6BUeGf-rsPUZ_BmM';
const SHEET_NAME         = 'For Sale';
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

// ─── GOOGLE AUTH ───────────────────────────────────────────────────────────────
function getAuth() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
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
      const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
      const data = await pdfParse(buffer);
      return data.text;
    } catch {
      console.warn(`  ⚠ Could not parse PDF "${name}" — using raw buffer length as placeholder`);
      return `[PDF — ${buffer.length} bytes — could not extract text]`;
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
  if (/^house/i.test(folderName))                    property_type = 'House';
  else if (/\bvilla\b/i.test(folderName))            property_type = 'House';
  else if (/\bpenthouse\b/i.test(folderName))        property_type = 'Condo';
  else if (/\b(condo|apartment|studio)\b/i.test(folderName)) property_type = 'Condo';
  else if (/\bland\b/i.test(folderName))             property_type = 'Land';

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
async function fetchSignatureListing(url) {
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
    for (const [, label, value] of divCells) {
      const l = label.trim().toLowerCase();
      const v = value.replace(/<[^>]+>/g, '').trim();
      if (!v) continue;
      if (l.includes('bedroom'))                                                result.beds          = result.beds          || v;
      if (l.includes('bathroom'))                                               result.baths         = result.baths         || v;
      if (l.includes('construction') || l.includes('living area'))             result.construction  = result.construction  || v;
      if (l.includes('lot') || l.includes('balcony') || l.includes('terrace')) result.lot           = result.lot           || v;
      if (l.includes('year') || l.includes('built') || l.includes('année'))    result.year_built    = result.year_built    || v;
      if (l.includes('price') && (l.includes('sq') || l.includes('m²') || l.includes('m2'))) result.price_per_sqft = result.price_per_sqft || v;
    }

    // ── 2. Financial row: <span ...>Label</span><span ...>Value</span>
    // Used for: Monthly HOA, Annual Property Tax (Predial)
    const spanCells = [...html.matchAll(
      /<span[^>]*>([^<]+)<\/span>\s*<span[^>]*>([^<]+)<\/span>/g
    )];
    for (const [, label, value] of spanCells) {
      const l = label.trim().toLowerCase();
      const v = value.trim();
      if (!v) continue;
      if (l.includes('hoa') || l.includes('mantenimiento') || l.includes('maintenance'))
        result.hoa     = result.hoa     || v;
      if (l.includes('tax') || l.includes('predial') || l.includes('impuesto'))
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
- ba: number of bathrooms — use 0.5 increments: 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, etc. A "half bath" or "toilet" counts as 0.5 (number or null)
- price_usd: price in USD, digits only, no $ or commas (number or null)
- price_mxn: price in MXN, digits only, no $ or commas (number or null)
- ground_floor: is this a ground floor unit? (true/false/null)
- penthouse: is this a penthouse? (true/false/null)
- rooftop: does it have a rooftop terrace? (true/false/null)
- unfurnished: is the property unfurnished? true only if explicitly stated (true/false/null)
- details: property name followed by key highlights separated by commas. Focus on: beachfront, golf front, marina view, ocean view, pool, rooftop, garage, solar panels, private cenote, furnished, unfurnished. MAX 150 chars. Example: "Casa Sol · Golf front, private pool, solar panels, 2-car garage"
- listings_link: any external MLS/portal URL (not signature-sc.com) found (string or null)
- signature_link: the listing.signature-sc.com URL if found in the document (string or null)

Return exactly this JSON with no extra keys:
{
  "property_type": null, "br": null, "ba": null,
  "price_usd": null, "price_mxn": null,
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
    model: 'claude-haiku-4-5-20251001', // cheaper model — extraction task doesn't need Sonnet
    max_tokens: 1024,
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
      property_type: null, br: null, ba: null,
      price_usd: null, price_mxn: null,
      ground_floor: null, penthouse: null, rooftop: null, unfurnished: null,
      details: null, listings_link: null, signature_link: null,
    };
  }
  return JSON.parse(jsonMatch[0]);
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
  const rawType = (d.property_type || '').toLowerCase().trim();
  row[COL.PROPERTY_TYPE] = PROPERTY_TYPE_MAP[rawType] ?? d.property_type ?? '';
  row[COL.BR]            = parseNum(L.beds)  ?? d.br ?? '';
  row[COL.BA]            = parseNum(L.baths) ?? d.ba ?? '';
  row[COL.BUILT]         = L.year_built || '';

  // ── Prices ─────────────────────────────────────────────────────────────────
  const price_usd = d.price_usd ?? parseNum(L.price) ?? null;
  row[COL.PRICE_USD] = price_usd ?? '';
  row[COL.PRICE_MXN] = d.price_mxn ?? '';

  // ── Areas — construction ───────────────────────────────────────────────────
  const constrRaw  = L.construction || '';
  const sqftMatch  = constrRaw.match(/([\d,]+)\s*sq[\s\-]?ft/i);
  const m2Match    = constrRaw.match(/([\d,]+)\s*m[²2]/i);
  const sqft       = sqftMatch ? parseFloat(sqftMatch[1].replace(/,/g,'')) : null;
  const m2direct   = m2Match   ? parseFloat(m2Match[1].replace(/,/g,''))   : null;
  const m2         = m2direct  ?? (sqft ? Math.round(sqft * 0.0929) : null);
  row[COL.M2]    = m2   ?? '';
  row[COL.SQ_FT] = sqft ?? '';

  // ── Areas — lot / balcony ──────────────────────────────────────────────────
  const lotRaw      = L.lot || '';
  const lotSqftM    = lotRaw.match(/([\d,]+)\s*sq[\s\-]?ft/i);
  const lotM2M      = lotRaw.match(/([\d,]+)\s*m[²2]/i);
  const lot_sqft    = lotSqftM ? parseFloat(lotSqftM[1].replace(/,/g,'')) : null;
  const lot_m2direct= lotM2M   ? parseFloat(lotM2M[1].replace(/,/g,''))   : null;
  const lot_m2      = lot_m2direct ?? (lot_sqft ? Math.round(lot_sqft * 0.0929) : null);
  row[COL.LOT_M2]   = lot_m2   ?? '';
  row[COL.LOT_SQFT] = lot_sqft ?? '';

  // ── Areas — totals (Condo/Studio only: Construction + Balcony/Terrace) ────
  // For Houses, adding construction + land is meaningless — leave blank
  const isCondo = ['condo', 'studio'].includes(rawType);
  row[COL.TOTAL_M2]   = (isCondo && m2   && lot_m2)   ? m2   + lot_m2   : '';
  row[COL.TOTAL_SQFT] = (isCondo && sqft && lot_sqft) ? sqft + lot_sqft : '';

  // ── Price per area ─────────────────────────────────────────────────────────
  const ppsqft_listing = parseNum(L.price_per_sqft);
  const price_per_sqft = ppsqft_listing ?? (price_usd && sqft ? Math.round(price_usd / sqft) : null);
  const price_per_m2   = price_usd && m2 ? Math.round(price_usd / m2) : null;
  row[COL.PRICE_PER_SQFT] = price_per_sqft ?? '';
  row[COL.PRICE_PER_M2]   = price_per_m2   ?? '';

  // ── Financials ─────────────────────────────────────────────────────────────
  row[COL.HOA]         = parseNum(L.hoa)     ?? '';
  row[COL.PREDIAL_MXN] = parseNum(L.predial) ?? '';

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

  console.log('🔑 Authenticating with Google…');
  const auth  = getAuth();
  const drive = google.drive({ version: 'v3', auth });
  const sheets = google.sheets({ version: 'v4', auth });

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
  const filterArg = process.argv[2] ? process.argv[2].toLowerCase() : null;
  if (filterArg) console.log(`🔎 Filter active: only folders containing "${filterArg}"\n`);

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
  existingRows.forEach((row, i) => {
    const driveLink = row[COL.DRIVE_LINK] || '';
    if (driveLink) driveLinkToRow.set(driveLink, {
      sheetRowIndex:  DATA_START_ROW + i,
      existingStatus: (row[COL.STATUS] || '').trim(),
      existingRow:    row,
    });
  });
  console.log(`   ${existingRows.length} existing row(s) in sheet\n`);

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
    const existing0   = driveLinkToRow.get(driveLink0);
    if (existing0 && ['Verified', 'Off Market'].includes(existing0.existingStatus)) {
      console.log(`   🔒 Status "${existing0.existingStatus}" — skipping (row ${existing0.sheetRowIndex})\n`);
      locked++;
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
        console.warn(`   ⚠ Unsupported MIME type "${contentFile.mimeType}" — skipping\n`);
        skipped++;
        continue;
      }

      const contextText = `Folder name: ${driveEntry.name}\nFile name: ${contentFile.name}\n\n${content}`;
      try {
        extracted = await extractWithClaude(contextText, driveEntry.name);
      } catch (err) {
        console.warn(`   ⚠ Claude extraction failed: ${err.message} — skipping\n`);
        skipped++;
        continue;
      }
    }

    // Resolve signature_link: Claude extraction first, then local folder match as fallback
    if (!extracted.signature_link) {
      const localUrl = matchLocalListing(driveEntry.name, localListingMap);
      if (localUrl) {
        extracted.signature_link = localUrl;
        console.log(`   🗂  Matched local listing: ${localUrl}`);
      } else {
        console.log(`   ℹ  No local listing match`);
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
    const existing   = driveLinkToRow.get(driveLink);
    const isNew      = !existing;

    const row = buildRow(extracted, driveEntry, {
      listing, isNew, ownerName, brokerName,
      existingStatus: existing?.existingStatus || '',
      existingRow:    existing?.existingRow    || [],
    });

    if (!isNew) {
      updates.push({ sheetRowIndex: existing.sheetRowIndex, row });
      console.log(`   ✏  Queued for update → row ${existing.sheetRowIndex}\n`);
    } else {
      appends.push(row);
      console.log(`   ➕ Queued for append\n`);
    }
  }

  // 5. Write to sheet
  if (updates.length > 0 || appends.length > 0) {
    console.log('💾 Writing to Google Sheets…');
    await writeRows(sheets, updates, appends);
  }

  // 6. Summary
  console.log('─'.repeat(50));
  console.log(`✅ Done.`);
  console.log(`   ${appends.length}  added`);
  console.log(`   ${updates.length}  updated`);
  console.log(`   ${locked}  locked (Verified / Off Market — not touched)`);
  console.log(`   ${skipped}  skipped (errors)`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
