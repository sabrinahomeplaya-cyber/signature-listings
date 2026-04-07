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

// Column order in the sheet (A=0, B=1, …)
// Columns that are script-managed:
const COL = {
  AREA:           0,   // A
  PROPERTY_TYPE:  1,   // B
  BR:             2,   // C
  BA:             3,   // D
  PRICE_USD:      4,   // E
  PRICE_MXN:      5,   // F
  M2:             6,   // G
  SQ_FT:          7,   // H
  HOA:            8,   // I
  PREDIAL_MXN:    9,   // J
  GROUND_FLOOR:   10,  // K
  PENTHOUSE:      11,  // L
  ROOFTOP:        12,  // M
  UNFURNISHED:    13,  // N
  DETAILS:        14,  // O
  LISTINGS_LINK:  15,  // P
  SIGNATURE_LINK: 16,  // Q
  DRIVE_LINK:     17,  // R  ← used as unique key
  CREATED_DATE:   18,  // S
  STATUS:         19,  // T
  MAP_LOCATION:   20,  // U
  // V (21): Owner name    — manual, never touched
  // W (22): Broker name   — manual, never touched
  // X (23): Phone Number  — manual, never touched
};
const TOTAL_MANAGED_COLS = 21;  // A–U
const TOTAL_COLS         = 24;  // A–X (to preserve manual cols on read)

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

// ─── CLAUDE EXTRACTION ─────────────────────────────────────────────────────────
const anthropic = new Anthropic(); // uses ANTHROPIC_API_KEY env var

const EXTRACTION_PROMPT = `You are a real estate data extraction assistant. From the document content below, extract the following fields and return ONLY valid JSON (no markdown, no explanation).

Fields to extract:
- area: neighborhood or zone name (string)
- property_type: e.g. "House", "Condo", "Villa", "Penthouse", "Land" (string)
- br: number of bedrooms (number or null)
- ba: number of bathrooms (number or null)
- price_usd: price in USD, digits only, no currency symbol (number or null)
- price_mxn: price in MXN, digits only, no currency symbol (number or null)
- m2: area in square meters, digits only (number or null)
- sq_ft: area in square feet, digits only (number or null)
- hoa: monthly HOA/maintenance fee, include currency and period e.g. "$1,250 MXN/month" (string or null)
- predial_mxn: annual property tax in MXN, digits only (number or null)
- ground_floor: is this a ground floor unit? (true/false/null)
- penthouse: is this a penthouse? (true/false/null)
- rooftop: does it have a rooftop? (true/false/null)
- unfurnished: is the property unfurnished? (true/false/null)
- details: brief summary of key features, max 200 chars (string or null)
- listings_link: any external MLS or listing portal URL found (string or null)
- signature_link: any listing.signature-sc.com URL found (string or null)
- map_location: address or GPS coordinates if found (string or null)
- status: e.g. "Active", "Under Contract", "Sold", "Off Market" — infer from context (string or null)

Return exactly this JSON structure with no extra keys:
{
  "area": null, "property_type": null, "br": null, "ba": null,
  "price_usd": null, "price_mxn": null, "m2": null, "sq_ft": null,
  "hoa": null, "predial_mxn": null, "ground_floor": null, "penthouse": null,
  "rooftop": null, "unfurnished": null, "details": null,
  "listings_link": null, "signature_link": null, "map_location": null, "status": null
}`;

async function extractWithClaude(fileContent, fileName) {
  const truncated = fileContent.slice(0, 12000); // stay within token limits
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `File name: ${fileName}\n\nDocument content:\n${truncated}`,
    }],
    system: EXTRACTION_PROMPT,
  });

  const raw = message.content.find(b => b.type === 'text')?.text || '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude returned no JSON');
  return JSON.parse(match[0]);
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

function buildRow(extracted, driveFile) {
  const d = extracted;
  const row = new Array(TOTAL_MANAGED_COLS).fill('');
  row[COL.AREA]           = d.area           ?? '';
  row[COL.PROPERTY_TYPE]  = d.property_type  ?? '';
  row[COL.BR]             = d.br             ?? '';
  row[COL.BA]             = d.ba             ?? '';
  row[COL.PRICE_USD]      = d.price_usd      ?? '';
  row[COL.PRICE_MXN]      = d.price_mxn      ?? '';
  row[COL.M2]             = d.m2             ?? '';
  row[COL.SQ_FT]          = d.sq_ft          ?? '';
  row[COL.HOA]            = d.hoa            ?? '';
  row[COL.PREDIAL_MXN]    = d.predial_mxn    ?? '';
  row[COL.GROUND_FLOOR]   = d.ground_floor   === true ? 'TRUE' : d.ground_floor === false ? 'FALSE' : '';
  row[COL.PENTHOUSE]      = d.penthouse      === true ? 'TRUE' : d.penthouse      === false ? 'FALSE' : '';
  row[COL.ROOFTOP]        = d.rooftop        === true ? 'TRUE' : d.rooftop        === false ? 'FALSE' : '';
  row[COL.UNFURNISHED]    = d.unfurnished    === true ? 'TRUE' : d.unfurnished    === false ? 'FALSE' : '';
  row[COL.DETAILS]        = d.details        ?? '';
  row[COL.LISTINGS_LINK]  = d.listings_link  ?? '';
  row[COL.SIGNATURE_LINK] = d.signature_link ?? '';
  row[COL.DRIVE_LINK]     = driveFile.webViewLink;
  row[COL.CREATED_DATE]   = driveFile.createdTime ? driveFile.createdTime.slice(0, 10) : '';
  row[COL.STATUS]         = d.status         ?? '';
  row[COL.MAP_LOCATION]   = d.map_location   ?? '';
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

  // Separate subfolders from direct files — skip system/misc folders
  const SKIP_NAMES = ['I. PROJECTS', 'Mike Broker', 'index.html'];
  const FOLDER_MIME = 'application/vnd.google-apps.folder';

  const propertyFolders = items.filter(i => i.mimeType === FOLDER_MIME && !SKIP_NAMES.includes(i.name));
  const looseFiles      = items.filter(i => i.mimeType !== FOLDER_MIME);

  console.log(`   ${propertyFolders.length} property folder(s), ${looseFiles.length} loose file(s)\n`);

  // 3. Read existing sheet rows (to detect updates vs appends)
  console.log('📊 Reading existing sheet data…');
  const existingRows = await readSheetRows(sheets);
  // Build a map: driveLink → sheetRowIndex (1-based absolute row in sheet)
  const driveLinkToRow = new Map();
  existingRows.forEach((row, i) => {
    const driveLink = row[COL.DRIVE_LINK] || '';
    if (driveLink) driveLinkToRow.set(driveLink, DATA_START_ROW + i);
  });
  console.log(`   ${existingRows.length} existing row(s) in sheet\n`);

  // 4. Build work list: { driveEntry (folder or file), contentFile (file to read), label }
  const workList = [];

  // Property subfolders: find first readable doc inside each
  for (const folder of propertyFolders) {
    const children = await listFilesInFolder(drive, folder.id);
    const readable = children.find(c =>
      c.mimeType !== FOLDER_MIME &&
      (c.mimeType === 'application/vnd.google-apps.document' ||
       c.mimeType === 'application/vnd.google-apps.spreadsheet' ||
       c.mimeType === 'application/pdf' ||
       c.mimeType.startsWith('text/'))
    );
    if (readable) {
      workList.push({ driveEntry: folder, contentFile: readable });
    } else {
      console.warn(`📁 ${folder.name}\n   ⚠ No readable document inside — skipping\n`);
    }
  }

  // Loose files (not in a subfolder): use the file itself as driveEntry
  for (const file of looseFiles) {
    workList.push({ driveEntry: file, contentFile: file });
  }

  // 5. Process each work item
  const updates = [];
  const appends = [];
  let skipped = 0;

  for (const { driveEntry, contentFile } of workList) {
    process.stdout.write(`📁 ${driveEntry.name}\n   📄 ${contentFile.name} (${contentFile.mimeType})\n`);

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

    // Combine folder name + doc content so Claude has full context
    const contextText = `Folder name: ${driveEntry.name}\nFile name: ${contentFile.name}\n\n${content}`;

    let extracted;
    try {
      extracted = await extractWithClaude(contextText, driveEntry.name);
    } catch (err) {
      console.warn(`   ⚠ Claude extraction failed: ${err.message} — skipping\n`);
      skipped++;
      continue;
    }

    // Use the property FOLDER's link as the unique key (stable across doc edits)
    const row = buildRow(extracted, driveEntry);
    const driveLink = driveEntry.webViewLink;

    if (driveLinkToRow.has(driveLink)) {
      const sheetRowIndex = driveLinkToRow.get(driveLink);
      updates.push({ sheetRowIndex, row });
      console.log(`   ✏  Queued for update → row ${sheetRowIndex}\n`);
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
  console.log(`   ${appends.length}  propert${appends.length !== 1 ? 'ies' : 'y'} added`);
  console.log(`   ${updates.length}  propert${updates.length !== 1 ? 'ies' : 'y'} updated`);
  console.log(`   ${skipped}  skipped`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
