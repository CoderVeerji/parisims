/*************************************************************************************************
 * PARIS FASHION — DEAD STOCK TRACKER  ·  LEAN / SCALABLE REWRITE
 * -----------------------------------------------------------------------------------------------
 * WHAT CHANGED (vs the old Raw_* + full-ledger design)
 *   - NO raw paste tabs, NO growing all-transactions ledger, NO materialised Report tabs.
 *   - The database is now 6 small tabs that never grow unbounded:
 *       Items         one row per item  — opening + lifetime totals + current stock  (~#items)
 *       Txn           ONLY the last N days of cleaned transactions (aging/window analysis)
 *       Salesmen      one row per salesperson — lifetime sold / bought totals
 *       SalesmanBuys  one row per (salesperson × item) they ever purchased  (dead-stock blame)
 *       Imports       one row per import — type + date span + totals  (duplicate-paste guard)
 *       Unmatched     cleaning errors + integrity warnings (capped)
 *     plus Settings and Users (unchanged).
 *
 * FLOW
 *   1. First time  ->  paste "Stock"  ->  writes opening_stock + price into Items.
 *   2. Every week  ->  paste Purchase / Sales  ->  Items lifetime totals += , current_stock
 *                      recomputed, rows appended to Txn, Salesmen / SalesmanBuys updated,
 *                      Imports logged.  Txn rows older than N days are pruned (their data is
 *                      already folded into Items, so pruning is a plain delete).
 *   3. Sales Return / Purchase Return  ->  same flow, adjusts current_stock + salesman totals.
 *
 *   current_stock = opening + purchased - sold - purchase_return + sale_return
 *
 * IDEMPOTENCY
 *   Each import is an atomic ADD. An overlapping span of the same type is rejected before commit
 *   (see checkOverlap_). Accidental double paste of the same week is caught here. Use
 *   undoLastImport() to reverse the most recent import (works while its rows are still in Txn).
 *
 * HARD RULES kept: (1) never hardcode column indexes — buildHeaderMap_ / col_ ;
 *   (2) batch I/O only — every tab read once, written once ; (3) heavy compute on import ;
 *   (4) all writes server-side via google.script.run.
 *************************************************************************************************/

/* =============================== CONSTANTS ================================================== */

var TABS = {
  ITEMS:         'Items',
  TXN:           'Txn',
  SALESMEN:      'Salesmen',
  SALESMAN_BUYS: 'SalesmanBuys',
  IMPORTS:       'Imports',
  UNMATCHED:     'Unmatched',
  CANCELLED:     'CancelledBills',
  SETTINGS:      'Settings',
  USERS:         'Users'
};

var ITEM_HEADERS = ['item_key', 'details', 'group', 'opening_stock', 'purchased', 'sold',
                    'pur_return', 'sale_return', 'current_stock', 'last_purchase_date',
                    'last_sale_date', 'price', 'first_seen', 'updated_at',
                    'first_purchase_date', 'first_sale_date', 'purchase_entries', 'sale_entries',
                    'purchase_amount', 'sale_amount', 'suppliers'];

var TXN_HEADERS = ['import_id', 'txn_type', 'date', 'vch_no', 'party', 'salesman',
                   'item_details_raw', 'item_key', 'group', 'qty', 'unit', 'price', 'amount'];

// cleanGrid_ emits rows in this order (Txn without the import_id prefix).
var CLEAN_FIELDS = ['txn_type', 'date', 'vch_no', 'party', 'salesman', 'item_details_raw',
                    'item_key', 'group', 'qty', 'unit', 'price', 'amount'];

var SALESMEN_HEADERS      = ['salesman', 'sold_qty', 'sold_amount', 'bought_qty', 'bought_amount', 'updated_at'];
var SALESMAN_BUYS_HEADERS = ['salesman', 'item_key', 'details', 'group', 'qty', 'amount', 'last_date'];
var IMPORTS_HEADERS       = ['import_id', 'txn_type', 'date_from', 'date_to', 'rows', 'qty', 'amount', 'imported_by', 'imported_at', 'note'];
var UNMATCHED_HEADERS     = ['type', 'item_key', 'details', 'detail', 'src'];

// One row per cancelled bill LINE — mirrors TXN_HEADERS (a bill's original Txn row) plus who/when
// cancelled it, so a cancel can be fully reversed (restored) later. cancel_id groups every line
// of the same "cancel this bill number" action together.
var CANCELLED_HEADERS = ['cancel_id', 'import_id', 'txn_type', 'date', 'vch_no', 'party', 'salesman',
                         'item_details_raw', 'item_key', 'group', 'qty', 'unit', 'price', 'amount',
                         'cancelled_by', 'cancelled_at'];

// Login / roles
var USER_HEADERS = ['username', 'salt', 'password_hash', 'role', 'display_name', 'active', 'token', 'token_expires', 'permissions'];
var VALID_ROLES  = ['admin', 'staff'];
var TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;   // 30 days

// RBAC: admin always has every permission, no matter what's stored. A staff user's access is
// exactly their `permissions` cell (comma-separated keys) — blank means "not set yet", which
// falls back to DEFAULT_STAFF_PERMS so accounts created before this feature existed keep working
// unchanged. Users/Settings/Danger-zone stuff is intentionally NOT a grantable permission — only
// role === 'admin' can ever reach those, to prevent a staff account escalating itself.
var PERMISSION_DEFS = [
  { key: 'view_dashboard', label: 'View Dashboard' },
  { key: 'view_report',    label: 'View Full Report' },
  { key: 'view_unmatched', label: 'View Unmatched' },
  { key: 'import_data',    label: 'Import Data' },
  { key: 'cancel_bills',   label: 'Cancel / Restore Bills' }
];
var DEFAULT_STAFF_PERMS = ['view_dashboard', 'import_data'];

// Friendly "Import Data" dropdown label -> what it is.
var IMPORT_TARGETS = {
  'PURCHASE':        { txnType: 'PURCHASE',        settingKey: 'date_format_raw_purchase',       label: 'Purchase',        isStock: false, defaultFmt: 'DD-MM' },
  'SALES':           { txnType: 'SALE',            settingKey: 'date_format_raw_sales',          label: 'Sales',           isStock: false, defaultFmt: 'DD-MM' },
  'PURCHASE RETURN': { txnType: 'PURCHASE_RETURN', settingKey: 'date_format_raw_purchasereturn', label: 'Purchase Return', isStock: false, defaultFmt: 'DD-MM' },
  'SALES RETURN':    { txnType: 'SALE_RETURN',     settingKey: 'date_format_raw_salesreturn',    label: 'Sales Return',    isStock: false, defaultFmt: 'MM-DD' },
  'STOCK':           { txnType: null,              settingKey: null,                             label: 'Stock',           isStock: true,  defaultFmt: null }
};

var SETTINGS_DEFAULTS = {
  aging_window_days:             15,
  dead_stock_min_qty:            50,
  sell_through_threshold_pct:    20,
  txn_retention_days:            100,   // how many days of detail Txn keeps (also caps the window)
  date_format_raw_purchase:      'AUTO',
  date_format_raw_sales:         'AUTO',
  date_format_raw_purchasereturn:'AUTO',
  date_format_raw_salesreturn:   'AUTO'
};

var KEY_SEP        = ' || ';
var MAX_PASTE_ROWS = 80000;      // hard ceiling for one paste (a full month of a wholesaler's sales)
var MAX_UNMATCHED  = 3000;       // cap the Unmatched tab
var MAX_ITEMS_TO_UI = 5000;      // google.script.run silently nulls oversized payloads


/* =============================== MENU + WEB APP ENTRY ======================================= */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Paris Tools')
    .addItem('Setup / Repair sheets', 'menuSetupSheets')
    .addItem('Show data stats', 'menuStats')
    .addSeparator()
    .addItem('⚠ RESET — wipe all data (start fresh)', 'menuResetAll')
    .addToUi();
}

/** Serves the dashboard. */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Paris Fashion — Dead Stock Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


/* =============================== MENU HANDLERS ============================================= */

function menuSetupSheets() {
  setupSheets_();
  SpreadsheetApp.getUi().alert('Sheets ready. Settings seeded with defaults where missing.');
}

function menuStats() {
  var ss = SpreadsheetApp.getActive();
  var rows = function (t) { var s = ss.getSheetByName(t); return s ? Math.max(0, s.getLastRow() - 1) : 0; };
  SpreadsheetApp.getUi().alert(
    'Items:         ' + rows(TABS.ITEMS) + '\n' +
    'Txn (recent):  ' + rows(TABS.TXN) + '\n' +
    'Salesmen:      ' + rows(TABS.SALESMEN) + '\n' +
    'SalesmanBuys:  ' + rows(TABS.SALESMAN_BUYS) + '\n' +
    'Imports:       ' + rows(TABS.IMPORTS) + '\n' +
    'Unmatched:     ' + rows(TABS.UNMATCHED) + '\n' +
    'CancelledBills:' + rows(TABS.CANCELLED) + '\n' +
    'Users:         ' + rows(TABS.USERS));
}

/** RESET from the sheet menu — two confirmations so an accidental click does nothing. */
function menuResetAll() {
  var ui = SpreadsheetApp.getUi();
  var a = ui.alert('RESET — wipe all data?',
    'This empties Items, Txn, Salesmen, SalesmanBuys, Imports, Unmatched and CancelledBills.\n' +
    'Users (logins) and Settings are kept.\n\nContinue?', ui.ButtonSet.YES_NO);
  if (a !== ui.Button.YES) return;

  var p = ui.prompt('Confirm RESET', 'Type  RESET  in capitals to wipe all data:', ui.ButtonSet.OK_CANCEL);
  if (p.getSelectedButton() !== ui.Button.OK || String(p.getResponseText()).trim() !== 'RESET') {
    ui.alert('Cancelled — nothing was deleted.');
    return;
  }
  resetAll_(false);
  ui.alert('Done. All data cleared. Paste your opening Stock to start again.');
}

/**
 * EDITOR-ONLY hard reset — also clears the Users tab (you will have to re-run createDefaultUsers).
 * Not wired to any button. Run from the Apps Script editor only if you really mean it.
 */
function factoryReset_() {
  resetAll_(true);
}


/* =============================== SHEET SETUP =============================================== */

function setupSheets_() {
  var ss = SpreadsheetApp.getActive();
  Object.keys(TABS).forEach(function (k) {
    if (!ss.getSheetByName(TABS[k])) ss.insertSheet(TABS[k]);
  });

  ensureHeader_(TABS.ITEMS,         ITEM_HEADERS);
  ensureHeader_(TABS.TXN,           TXN_HEADERS);
  ensureHeader_(TABS.SALESMEN,      SALESMEN_HEADERS);
  ensureHeader_(TABS.SALESMAN_BUYS, SALESMAN_BUYS_HEADERS);
  ensureHeader_(TABS.IMPORTS,       IMPORTS_HEADERS);
  ensureHeader_(TABS.UNMATCHED,     UNMATCHED_HEADERS);
  ensureHeader_(TABS.CANCELLED,     CANCELLED_HEADERS);
  ensureHeader_(TABS.USERS,         USER_HEADERS);
  migrateUsersPermissionsColumn_();

  // Settings — seed any missing key, never overwrite an existing one.
  var sh = ss.getSheetByName(TABS.SETTINGS);
  var existing = {};
  if (sh.getLastRow() > 0) {
    sh.getRange(1, 1, sh.getLastRow(), 2).getValues().forEach(function (r) {
      if (r[0] !== '') existing[String(r[0]).trim().toLowerCase()] = true;
    });
  } else {
    sh.getRange(1, 1, 1, 2).setValues([['key', 'value']]).setFontWeight('bold');
  }
  var toAdd = [];
  Object.keys(SETTINGS_DEFAULTS).forEach(function (key) {
    if (!existing[key]) toAdd.push([key, SETTINGS_DEFAULTS[key]]);
  });
  if (toAdd.length) sh.getRange(sh.getLastRow() + 1, 1, toAdd.length, 2).setValues(toAdd);
}

/** Make sure a tab exists with exactly this header row (only writes when row 1 is empty/blank). */
function ensureHeader_(tabName, headers) {
  var sh = SpreadsheetApp.getActive().getSheetByName(tabName);
  if (!sh) return;
  if (sh.getLastRow() === 0 || String(sh.getRange(1, 1).getValue()).trim() === '') {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
}

/** ensureHeader_ only fills in a BLANK header row — it won't add a column to a Users sheet that
    already has the older 8-column header from before permissions existed. Self-heal that here. */
function migrateUsersPermissionsColumn_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(TABS.USERS);
  if (!sh || sh.getLastRow() === 0) return;
  var lastCol = sh.getLastColumn();
  var header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var has = header.some(function (h) { return String(h).trim().toLowerCase() === 'permissions'; });
  if (!has) sh.getRange(1, lastCol + 1).setValue('permissions').setFontWeight('bold');
}

/** Core reset. wipeUsers=true also clears logins. */
function resetAll_(wipeUsers) {
  setupSheets_();
  var ss = SpreadsheetApp.getActive();
  var dataTabs = [TABS.ITEMS, TABS.TXN, TABS.SALESMEN, TABS.SALESMAN_BUYS, TABS.IMPORTS, TABS.UNMATCHED, TABS.CANCELLED];
  if (wipeUsers) dataTabs.push(TABS.USERS);

  var headerFor = {};
  headerFor[TABS.ITEMS] = ITEM_HEADERS;
  headerFor[TABS.TXN] = TXN_HEADERS;
  headerFor[TABS.SALESMEN] = SALESMEN_HEADERS;
  headerFor[TABS.SALESMAN_BUYS] = SALESMAN_BUYS_HEADERS;
  headerFor[TABS.IMPORTS] = IMPORTS_HEADERS;
  headerFor[TABS.UNMATCHED] = UNMATCHED_HEADERS;
  headerFor[TABS.CANCELLED] = CANCELLED_HEADERS;
  headerFor[TABS.USERS] = USER_HEADERS;

  dataTabs.forEach(function (t) {
    var sh = ss.getSheetByName(t);
    if (!sh) return;
    sh.clearContents();
    var h = headerFor[t];
    sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });

  // Clear the opening-stock date so the next opening paste asks for a fresh one.
  var setSh = ss.getSheetByName(TABS.SETTINGS);
  if (setSh && setSh.getLastRow() > 0) {
    var sv = setSh.getRange(1, 1, setSh.getLastRow(), 2).getValues();
    for (var i = 0; i < sv.length; i++) {
      if (String(sv[i][0]).trim().toLowerCase() === 'opening_stock_as_of') { setSh.getRange(i + 1, 2).setValue(''); break; }
    }
  }
}

/** Web-app RESET (admin only). Same as the menu but triggered from Settings view. */
function resetAllData(confirmText, token) {
  var auth = checkAuth_(token, ['admin']);
  if (auth._err) return auth._err;
  if (String(confirmText).trim() !== 'RESET') {
    return { ok: false, message: 'Type RESET (capitals) to confirm.' };
  }
  resetAll_(false);
  return { ok: true };
}


/* =============================== SETTINGS ================================================= */

/** The date the opening-stock snapshot represents. Transactions before it must not touch stock. */
function getOpeningAsOf_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(TABS.SETTINGS);
  if (!sh || sh.getLastRow() === 0) return '';
  var vals = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim().toLowerCase() === 'opening_stock_as_of') return asIsoMaybe_(vals[i][1]);
  }
  return '';
}

function setOpeningAsOf_(iso) {
  setupSheets_();
  var sh = SpreadsheetApp.getActive().getSheetByName(TABS.SETTINGS);
  var vals = sh.getRange(1, 1, Math.max(1, sh.getLastRow()), 2).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim().toLowerCase() === 'opening_stock_as_of') {
      sh.getRange(i + 1, 1, 1, 2).setNumberFormat('@');
      sh.getRange(i + 1, 2).setValue(iso);
      return;
    }
  }
  var row = sh.getLastRow() + 1;
  sh.getRange(row, 1, 1, 2).setNumberFormat('@');
  sh.getRange(row, 1, 1, 2).setValues([['opening_stock_as_of', iso]]);
}

function readSettings_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(TABS.SETTINGS);
  var out = {};
  Object.keys(SETTINGS_DEFAULTS).forEach(function (k) { out[k] = SETTINGS_DEFAULTS[k]; });

  if (sh && sh.getLastRow() > 0) {
    sh.getRange(1, 1, sh.getLastRow(), 2).getValues().forEach(function (r) {
      var key = String(r[0]).trim().toLowerCase();
      if (!key || !(key in SETTINGS_DEFAULTS)) return;
      if (typeof SETTINGS_DEFAULTS[key] === 'number') {
        var n = parseNum_(r[1]);
        if (n) out[key] = n;
      } else if (String(r[1]).trim() !== '') {
        out[key] = String(r[1]).trim().toUpperCase();   // AUTO / DD-MM / MM-DD
      }
    });
  }
  return out;
}


/* =============================== SMALL HELPERS =========================================== */

function norm_(s) { return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toUpperCase(); }

/** item_key = normalised(item details) || normalised(group). Size stays part of the details. */
function makeItemKey_(itemDetails, group) { return norm_(itemDetails) + KEY_SEP + norm_(group); }

/** Parse a number that may carry commas, ₹, parentheses-negatives, trailing text. Keeps sign. */
function parseNum_(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  var s = String(v).trim();
  if (s === '') return 0;
  var neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.replace(/[()]/g, ''); }
  s = s.replace(/,/g, '');
  var m = s.match(/-?\d+(\.\d+)?/);
  if (!m) return 0;
  var n = parseFloat(m[0]);
  if (isNaN(n)) return 0;
  return neg ? -Math.abs(n) : n;
}

function buildHeaderMap_(headerRow) {
  var map = {};
  for (var i = 0; i < headerRow.length; i++) {
    var h = String(headerRow[i] == null ? '' : headerRow[i]).trim().toLowerCase().replace(/\s+/g, ' ');
    if (h && !(h in map)) map[h] = i;
  }
  return map;
}

function col_(headerMap, aliases) {
  for (var i = 0; i < aliases.length; i++) {
    var a = aliases[i].trim().toLowerCase().replace(/\s+/g, ' ');
    if (a in headerMap) return headerMap[a];
  }
  return -1;
}

function round2_(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function toIso_(y, m, d) { return y + '-' + ('0' + m).slice(-2) + '-' + ('0' + d).slice(-2); }
function isoOfDate_(dt) { return toIso_(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()); }
function dateFromIso_(iso) { var p = String(iso).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
function todayMidnight_() { var t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); }
function nowStamp_() { var d = new Date(); return isoOfDate_(d) + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
function topKey_(obj) {
  var best = null, bestN = -1;
  Object.keys(obj || {}).forEach(function (k) { if (obj[k] > bestN) { bestN = obj[k]; best = k; } });
  return best;
}
function newImportId_() {
  return 'imp_' + isoOfDate_(new Date()).replace(/-/g, '') + '_' + Utilities.getUuid().slice(0, 6);
}


/* =============================== DATE DETECTION ========================================= */

function extractDateRange_(text) {
  var m = String(text).match(
    /from\s+(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})\s+to\s+(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/i);
  if (!m) return null;
  var y1 = +m[3] < 100 ? 2000 + +m[3] : +m[3];
  var y2 = +m[6] < 100 ? 2000 + +m[6] : +m[6];
  var startIso = toIso_(y1, +m[2], +m[1]);
  var endIso   = toIso_(y2, +m[5], +m[4]);
  if (startIso > endIso) { var t = startIso; startIso = endIso; endIso = t; }
  return { startIso: startIso, endIso: endIso };
}

function validYmd_(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  var dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function inRangeIso_(iso, range) {
  if (!range) return true;
  return iso >= range.startIso && iso <= range.endIso;
}

/**
 * Detect one cell's date. NEVER blind DD-MM. Returns { iso, fmt } or { iso:null, err }.
 */
function detectDate_(raw, fmt, range, tieFmt) {
  fmt = (fmt || 'AUTO').toUpperCase();

  if (raw instanceof Date) {
    var y = raw.getFullYear(), mo = raw.getMonth() + 1, da = raw.getDate();
    if (validYmd_(y, mo, da) && inRangeIso_(toIso_(y, mo, da), range)) return { iso: toIso_(y, mo, da), fmt: 'DATE' };
    if (validYmd_(y, da, mo) && inRangeIso_(toIso_(y, da, mo), range)) return { iso: toIso_(y, da, mo), fmt: 'DATE-SWAP' };
    if (validYmd_(y, mo, da)) return { iso: toIso_(y, mo, da), err: 'DATE_OUT_OF_RANGE' };
    return { iso: null, err: 'DATE_UNPARSEABLE' };
  }

  var s = String(raw == null ? '' : raw).trim();
  if (s === '') return { iso: null, err: 'DATE_BLANK' };

  var m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/);
  if (!m) return { iso: null, err: 'DATE_UNPARSEABLE' };

  var a = +m[1], b = +m[2], y = +m[3];
  if (y < 100) y += 2000;

  var ddmm = validYmd_(y, b, a) ? toIso_(y, b, a) : null;
  var mmdd = validYmd_(y, a, b) ? toIso_(y, a, b) : null;

  if (fmt === 'DD-MM') return ddmm && inRangeIso_(ddmm, range)
    ? { iso: ddmm, fmt: 'DD-MM' } : { iso: ddmm, err: 'DATE_OUT_OF_RANGE' };
  if (fmt === 'MM-DD') return mmdd && inRangeIso_(mmdd, range)
    ? { iso: mmdd, fmt: 'MM-DD' } : { iso: mmdd, err: 'DATE_OUT_OF_RANGE' };

  var ddmmOk = ddmm && inRangeIso_(ddmm, range);
  var mmddOk = mmdd && inRangeIso_(mmdd, range);
  if (ddmmOk && !mmddOk) return { iso: ddmm, fmt: 'DD-MM' };
  if (mmddOk && !ddmmOk) return { iso: mmdd, fmt: 'MM-DD' };
  if (ddmmOk && mmddOk) {
    return (String(tieFmt).toUpperCase() === 'MM-DD')
      ? { iso: mmdd, fmt: 'AMBIGUOUS-MM-DD' }
      : { iso: ddmm, fmt: 'AMBIGUOUS-DD-MM' };
  }
  if (!range && ddmm) return { iso: ddmm, fmt: 'DD-MM-NORANGE' };
  return { iso: null, err: 'DATE_OUT_OF_RANGE' };
}


/* =============================== PASTE PARSING ========================================= */

function parsePastedText_(text) {
  var lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  var rows = lines.map(function (l) { return l.split('\t'); });
  while (rows.length && rows[rows.length - 1].join('').trim() === '') rows.pop();
  while (rows.length && rows[0].join('').trim() === '') rows.shift();
  return rows;
}

/** Row index of the real header (the one containing "Item Details"), or -1. */
function findHeaderRow_(grid) {
  for (var i = 0; i < grid.length; i++) {
    var hit = grid[i].some(function (c) {
      return String(c).trim().toLowerCase().replace(/\s+/g, ' ') === 'item details';
    });
    if (hit) return i;
  }
  return -1;
}


/* =============================== RAW CLEANING (in-memory grid) ========================= */

/**
 * Clean a pasted grid into ledger rows (CLEAN_FIELDS order).
 * Rules: A skip junk headers, B fill-down blanks, C smart dates, D item key, F numbers.
 */
function cleanGrid_(grid, cfg, settings) {
  var result = { rows: [], errors: [], parsed: 0, blanksFilledDates: 0, detectedFmt: {}, dateRange: null };
  if (!grid || !grid.length) return result;

  var headerIdx = findHeaderRow_(grid);
  if (headerIdx === -1) {
    result.errors.push(['HEADER_NOT_FOUND', '', '', 'No row containing "Item Details" — nothing imported', cfg.txnType]);
    return result;
  }

  var preText = grid.slice(0, headerIdx).map(function (r) { return r.join(' '); }).join(' ');
  var range = extractDateRange_(preText) || extractDateRange_(grid.map(function (r) { return r.join(' '); }).join(' '));
  result.dateRange = range;

  var cfgFmt = String(settings[cfg.settingKey] || 'AUTO').toUpperCase();
  var effectiveFmt = (cfgFmt === 'AUTO' && !range && cfg.defaultFmt) ? cfg.defaultFmt : cfgFmt;

  var H = buildHeaderMap_(grid[headerIdx]);
  var c = {
    date:     col_(H, ['date']),
    vch:      col_(H, ['vch/bill no', 'vch no', 'voucher no', 'bill no', 'vch/bill']),
    party:    col_(H, ['particulars', 'party', "party's name"]),
    mobile:   col_(H, ['mobile', 'mobile no']),
    salesman: col_(H, ['salesman', 'sales man']),
    group:    col_(H, ['group', 'item group']),
    item:     col_(H, ['item details', 'item name', 'item']),
    qty:      col_(H, ['qty.', 'qty', 'quantity']),
    unit:     col_(H, ['unit', 'alt unit']),
    price:    col_(H, ['price', 'rate']),
    amount:   col_(H, ['amount', 'value'])
  };
  if (c.item === -1 || c.qty === -1) {
    result.errors.push(['COLUMNS_MISSING', '', '',
      'Could not map Item Details / Qty. Headers seen: ' + Object.keys(H).join(', '), cfg.txnType]);
    return result;
  }

  var carry = { date: '', vch: '', party: '', mobile: '', salesman: '', group: '' };
  var get = function (row, idx) { return idx === -1 ? '' : row[idx]; };

  for (var r = headerIdx + 1; r < grid.length; r++) {
    var row = grid[r];
    if (row.join('').trim() === '') continue;

    var firstNonEmpty = row.find(function (x) { return String(x).trim() !== ''; });
    if (/^(grand\s+)?total\b/i.test(String(firstNonEmpty || ''))) continue;
    if (String(get(row, c.item)).trim().toLowerCase().replace(/\s+/g, ' ') === 'item details') continue;

    ['date', 'vch', 'party', 'mobile', 'salesman', 'group'].forEach(function (f) {
      var idx = c[f];
      if (idx === -1) return;
      var cell = row[idx];
      if (cell == null || String(cell).trim() === '') row[idx] = carry[f];
      else carry[f] = cell;
    });

    var itemRaw = String(get(row, c.item)).trim();
    var qty = parseNum_(get(row, c.qty));
    if (itemRaw === '' && qty === 0) continue;

    var dRes = detectDate_(row[c.date], effectiveFmt, range, cfg.defaultFmt);
    if (row[c.date] == null || String(row[c.date]).trim() === '') result.blanksFilledDates++;
    if (dRes.err || !dRes.iso) {
      result.errors.push(['BAD_DATE:' + (dRes.err || 'UNKNOWN'),
        makeItemKey_(itemRaw, get(row, c.group)), itemRaw,
        'raw="' + row[c.date] + '"  vch=' + get(row, c.vch), cfg.txnType]);
      continue;
    }
    result.detectedFmt[dRes.fmt] = (result.detectedFmt[dRes.fmt] || 0) + 1;

    var groupRaw = String(get(row, c.group)).trim();
    result.rows.push([
      cfg.txnType,
      dRes.iso,
      String(get(row, c.vch)).trim(),
      String(get(row, c.party)).trim(),
      String(get(row, c.salesman)).trim(),
      itemRaw,
      makeItemKey_(itemRaw, groupRaw),
      groupRaw,
      qty,
      String(get(row, c.unit)).trim(),
      parseNum_(get(row, c.price)),
      parseNum_(get(row, c.amount))
    ]);
    result.parsed++;
  }
  return result;
}


/* =============================== TAB I/O HELPERS ====================================== */

/** Read a tab as an array of {field: value} objects using an alias map. Batch read, O(n). */
function readObjects_(tabName, aliasesByField) {
  var sh = SpreadsheetApp.getActive().getSheetByName(tabName);
  if (!sh || sh.getLastRow() < 2) return [];
  var v = sh.getDataRange().getValues();
  var H = buildHeaderMap_(v[0]);
  var idx = {};
  Object.keys(aliasesByField).forEach(function (f) { idx[f] = col_(H, aliasesByField[f]); });
  var out = [];
  for (var i = 1; i < v.length; i++) {
    if (String(v[i].join('')).trim() === '') continue;
    var o = {};
    Object.keys(idx).forEach(function (f) { o[f] = idx[f] === -1 ? '' : v[i][idx[f]]; });
    out.push(o);
  }
  return out;
}

/** Column indexes whose values must stay TEXT (ISO date strings Sheets would otherwise auto-parse). */
function textColsFromHeaders_(headers) {
  var out = [];
  headers.forEach(function (h, i) { if (/date|_at\b|_seen\b|expires/i.test(String(h))) out.push(i); });
  return out;
}

/** Overwrite a tab with header + rows in one write. Date columns are forced to text first. */
function writeGrid_(tabName, header, rows) {
  var sh = SpreadsheetApp.getActive().getSheetByName(tabName);
  if (!sh) sh = SpreadsheetApp.getActive().insertSheet(tabName);
  sh.clearContents();
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (rows.length) {
    textColsFromHeaders_(header).forEach(function (ci) {
      sh.getRange(2, ci + 1, rows.length, 1).setNumberFormat('@');
    });
    sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  }
  sh.setFrozenRows(1);
}

/** Append rows to the bottom of a tab (assumes header already present). Date columns forced to text. */
function appendRows_(tabName, rows) {
  if (!rows.length) return;
  var sh = SpreadsheetApp.getActive().getSheetByName(tabName);
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var start = sh.getLastRow() + 1;
  textColsFromHeaders_(header).forEach(function (ci) {
    sh.getRange(start, ci + 1, rows.length, 1).setNumberFormat('@');
  });
  sh.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
}

/** A cell that should be an ISO date string — tolerate a Date the user typed into the sheet. */
function asIsoMaybe_(v) {
  if (v instanceof Date) return isoOfDate_(v);
  return String(v == null ? '' : v).trim();
}

var ITEM_ALIASES = {
  item_key: ['item_key'], details: ['details', 'item details'], group: ['group', 'item group'],
  opening_stock: ['opening_stock'], purchased: ['purchased'], sold: ['sold'],
  pur_return: ['pur_return'], sale_return: ['sale_return'], current_stock: ['current_stock'],
  last_purchase_date: ['last_purchase_date'], last_sale_date: ['last_sale_date'],
  price: ['price'], first_seen: ['first_seen'], updated_at: ['updated_at'],
  first_purchase_date: ['first_purchase_date'], first_sale_date: ['first_sale_date'],
  purchase_entries: ['purchase_entries'], sale_entries: ['sale_entries'],
  purchase_amount: ['purchase_amount'], sale_amount: ['sale_amount'], suppliers: ['suppliers']
};

/** item_key -> record object (all numeric fields coerced). */
function readItemsMap_() {
  var map = {};
  readObjects_(TABS.ITEMS, ITEM_ALIASES).forEach(function (o) {
    var key = String(o.item_key).trim();
    if (!key) return;
    map[key] = {
      item_key: key,
      details: String(o.details || '').trim(),
      group: String(o.group || '').trim(),
      opening_stock: parseNum_(o.opening_stock),
      purchased: parseNum_(o.purchased),
      sold: parseNum_(o.sold),
      pur_return: parseNum_(o.pur_return),
      sale_return: parseNum_(o.sale_return),
      current_stock: parseNum_(o.current_stock),
      last_purchase_date: asIsoMaybe_(o.last_purchase_date),
      last_sale_date: asIsoMaybe_(o.last_sale_date),
      price: parseNum_(o.price),
      first_seen: asIsoMaybe_(o.first_seen),
      updated_at: asIsoMaybe_(o.updated_at),
      first_purchase_date: asIsoMaybe_(o.first_purchase_date),
      first_sale_date: asIsoMaybe_(o.first_sale_date),
      purchase_entries: parseNum_(o.purchase_entries),
      sale_entries: parseNum_(o.sale_entries),
      purchase_amount: parseNum_(o.purchase_amount),
      sale_amount: parseNum_(o.sale_amount),
      suppliers: String(o.suppliers || '').trim()
    };
  });
  return map;
}

function newItemRec_(key, details, group) {
  return {
    item_key: key, details: details || key.split(KEY_SEP)[0], group: group || key.split(KEY_SEP)[1] || '',
    opening_stock: 0, purchased: 0, sold: 0, pur_return: 0, sale_return: 0, current_stock: 0,
    last_purchase_date: '', last_sale_date: '', price: 0, first_seen: nowStamp_(), updated_at: nowStamp_(),
    first_purchase_date: '', first_sale_date: '', purchase_entries: 0, sale_entries: 0,
    purchase_amount: 0, sale_amount: 0, suppliers: ''
  };
}

/** Merge new supplier names into the denormalised, capped display string on an item. */
function mergeSuppliers_(existing, namesArr) {
  var set = {};
  String(existing || '').split(',').forEach(function (s) {
    s = s.trim();
    if (s && !/^\+\d+\s*more$/i.test(s)) set[s] = true;
  });
  (namesArr || []).forEach(function (n) { n = String(n || '').trim(); if (n) set[n] = true; });
  var names = Object.keys(set).sort();
  var MAX = 6;
  if (names.length > MAX) return names.slice(0, MAX).join(', ') + ' +' + (names.length - MAX) + ' more';
  return names.join(', ');
}

function recalcStock_(rec) {
  rec.current_stock = round2_(rec.opening_stock + rec.purchased - rec.sold - rec.pur_return + rec.sale_return);
}

function writeItemsMap_(map) {
  var rows = Object.keys(map).sort().map(function (k) {
    var r = map[k];
    return ITEM_HEADERS.map(function (h) { return r[h] == null ? '' : r[h]; });
  });
  writeGrid_(TABS.ITEMS, ITEM_HEADERS, rows);
}


/* =============================== IMPORT: WEB APP ENTRY =============================== */

/**
 * Called from the "Import Data" view. Runs as the OWNER (Execute as: me).
 * @param {string}  typeLabel  Purchase | Sales | Purchase Return | Sales Return | Stock
 * @param {string}  pastedText tab-separated, junk header lines allowed.
 * @param {boolean} force      true to overwrite an existing opening Stock.
 * @param {string}  asOf       YYYY-MM-DD the opening-stock snapshot represents (Stock imports only).
 * @param {string}  token      session token (admin or staff).
 * NOTE: signature kept stable — the frontend appends token as the LAST arg via authed().
 */
function importPastedData(typeLabel, pastedText, force, asOf, token) {
  try {
    var auth = checkAuth_(token, ['admin', 'staff'], 'import_data');
    if (auth._err) return auth._err;

    setupSheets_();
    var settings = readSettings_();

    var key = String(typeLabel || '').trim().toUpperCase();
    var target = IMPORT_TARGETS[key];
    if (!target) return { ok: false, message: 'Unknown import type: "' + typeLabel + '"' };
    if (!pastedText || !String(pastedText).trim()) return { ok: false, message: 'Nothing was pasted.' };

    var grid = parsePastedText_(pastedText);
    if (grid.length > MAX_PASTE_ROWS) {
      return { ok: false, message: 'That paste has ' + grid.length + ' lines — over the ' + MAX_PASTE_ROWS +
        ' limit. Export a shorter date range from Busy (e.g. one week or one fortnight at a time) and import those — ' +
        'do NOT split the same month into row-chunks, the overlapping dates would be rejected.' };
    }
    if (grid.length < 2) return { ok: false, message: 'Only ' + grid.length + ' line found — nothing to import.' };

    return target.isStock
      ? applyOpeningStock_(grid, settings, !!force, asOf, auth.user)
      : commitTxnImport_(grid, target, settings, auth.user);

  } catch (err) {
    return { ok: false, message: (err && err.message) ? err.message : String(err),
             stack: (err && err.stack) ? String(err.stack) : '' };
  }
}


/* =============================== OPENING STOCK ====================================== */

/**
 * Write opening_stock + price into Items from a Busy "Stock" export.
 * First run: Items is empty -> just create rows. Later: needs force=true (a re-baseline);
 * lifetime purchase/sale totals are kept, current_stock is recomputed.
 */
function applyOpeningStock_(grid, settings, force, asOf, user) {
  var headerIdx = findHeaderRow_(grid);
  if (headerIdx === -1) return { ok: false, message: 'No "Item Details" header row found in the Stock paste.' };

  var asOfIso = String(asOf || '').trim();
  if (asOfIso && !/^\d{4}-\d{2}-\d{2}$/.test(asOfIso)) {
    return { ok: false, message: 'Opening-stock date must be YYYY-MM-DD (got "' + asOfIso + '").' };
  }
  if (!asOfIso) asOfIso = getOpeningAsOf_() || isoOfDate_(todayMidnight_());

  var H = buildHeaderMap_(grid[headerIdx]);
  var sc = {
    item:  col_(H, ['item details', 'item name', 'item']),
    group: col_(H, ['group', 'item group']),
    qty:   col_(H, ['qty.', 'qty', 'quantity', 'closing qty', 'closing stock']),
    price: col_(H, ['price', 'rate', 'p. price', 'p.price', 'purc price', 'purc. price',
                    'purc price(alt)', 'purc. price(alt)', 'purchase price',
                    'sale price', 'sales price', 'sales price(alt)', 'sale price(alt)'])
  };
  if (sc.item === -1 || sc.qty === -1) {
    return { ok: false, message: 'Stock paste needs Item Details + Qty columns. Seen: ' + Object.keys(H).join(', ') };
  }

  var existing = readItemsMap_();
  var hadItems = Object.keys(existing).length > 0;
  if (hadItems && !force) {
    return {
      ok: false, needsConfirm: true,
      message: 'Items table mein pehle se ' + Object.keys(existing).length + ' items hain. ' +
               '"Reset opening" karne se sabka opening stock is paste se replace ho jayega ' +
               '(lifetime purchase/sale totals safe rahenge). Confirm?'
    };
  }

  // Aggregate the paste (sum duplicate item rows).
  var paste = {};
  for (var r = headerIdx + 1; r < grid.length; r++) {
    var row = grid[r];
    var itemRaw = String(sc.item === -1 ? '' : row[sc.item]).trim();
    if (itemRaw === '') continue;
    var first = row.find(function (x) { return String(x).trim() !== ''; });
    if (/^(grand\s+)?total\b/i.test(String(first || ''))) continue;
    if (itemRaw.toLowerCase().replace(/\s+/g, ' ') === 'item details') continue;

    var groupRaw = String(sc.group === -1 ? '' : row[sc.group]).trim();
    var k = makeItemKey_(itemRaw, groupRaw);
    var rec = paste[k] || (paste[k] = { qty: 0, price: 0, details: itemRaw, group: groupRaw });
    rec.qty += parseNum_(sc.qty === -1 ? 0 : row[sc.qty]);
    var p = parseNum_(sc.price === -1 ? 0 : row[sc.price]);
    if (p) rec.price = p;
  }

  var pasteKeys = Object.keys(paste);
  if (!pasteKeys.length) return { ok: false, message: 'No item rows found in the Stock paste.' };

  var created = 0, updated = 0;
  pasteKeys.forEach(function (k) {
    var p = paste[k];
    var rec = existing[k];
    if (!rec) { rec = existing[k] = newItemRec_(k, p.details, p.group); created++; }
    else updated++;
    rec.opening_stock = round2_(p.qty);
    if (p.price) rec.price = p.price;
    if (!rec.details && p.details) rec.details = p.details;
    if (!rec.group && p.group) rec.group = p.group;
    rec.updated_at = nowStamp_();
  });

  // Recompute current_stock for every item (opening changed).
  Object.keys(existing).forEach(function (k) { recalcStock_(existing[k]); });
  writeItemsMap_(existing);
  setOpeningAsOf_(asOfIso);

  // Log it.
  appendRows_(TABS.IMPORTS, [[
    newImportId_(), 'OPENING_STOCK', asOfIso, asOfIso, pasteKeys.length, '', '',
    user.username, nowStamp_(), (hadItems ? 're-baseline as of ' + asOfIso : 'opening as of ' + asOfIso)
  ]]);

  var totalItems = Object.keys(existing).length;
  return {
    ok: true, isStock: true, label: 'Stock',
    rowsParsed: pasteKeys.length,
    rowsWritten: totalItems,
    blankDatesFilled: 0, dateFormat: 'n/a (opening snapshot)', dateRange: 'as of ' + asOfIso,
    rowsAdded: created, rowsRemoved: 0,
    ledgerTotal: countRows_(TABS.TXN),
    items: totalItems,
    unmatchedCount: 0,
    openingAsOf: asOfIso,
    note: 'Opening as of ' + asOfIso + '. ' +
          (hadItems ? updated + ' updated, ' + created + ' new. ' : created + ' items created. ') +
          'Import transactions dated ' + asOfIso + ' or later.',
    errors: []
  };
}


/* =============================== IMPORT: COMMIT A TXN BATCH ========================= */

/** Any existing Imports row of the same type whose span overlaps [from,to]? */
function checkOverlap_(txnType, fromIso, toIso) {
  var rows = readObjects_(TABS.IMPORTS, {
    id: ['import_id'], type: ['txn_type'], from: ['date_from'], to: ['date_to'], at: ['imported_at']
  });
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].type).trim().toUpperCase() !== txnType) continue;
    var ef = asIsoMaybe_(rows[i].from), et = asIsoMaybe_(rows[i].to);
    if (!ef || !et) continue;
    if (ef <= toIso && fromIso <= et) {
      return { from: ef, to: et, at: String(rows[i].at), id: String(rows[i].id) };
    }
  }
  return null;
}

/**
 * Clean the paste, block overlaps, then atomically fold it into Items / Salesmen / SalesmanBuys,
 * append to Txn, prune old Txn, log to Imports.
 */
function commitTxnImport_(grid, target, settings, user) {
  var cfg = { txnType: target.txnType, settingKey: target.settingKey, label: target.label, defaultFmt: target.defaultFmt };
  var cleaned = cleanGrid_(grid, cfg, settings);

  if (!cleaned.rows.length) {
    persistUnmatched_(cfg.txnType, cleaned.errors);
    return {
      ok: false,
      message: 'No usable rows parsed from this ' + cfg.label + ' paste.' +
        (cleaned.errors.length ? ' ' + cleaned.errors.length + ' error row(s) — see Unmatched.' : '')
    };
  }

  // Drop rows dated before the opening-stock snapshot — they would corrupt current_stock.
  var asOf = getOpeningAsOf_();
  var skippedBefore = 0;
  if (asOf) {
    var kept = [];
    cleaned.rows.forEach(function (r) {
      if (r[1] < asOf) {
        skippedBefore++;
        cleaned.errors.push(['BEFORE_OPENING', r[6], r[5],
          'date ' + r[1] + ' is before the opening-stock date ' + asOf + ' — skipped (would double-count stock)', cfg.txnType]);
      } else kept.push(r);
    });
    cleaned.rows = kept;
  }
  if (!cleaned.rows.length) {
    persistUnmatched_(cfg.txnType, cleaned.errors);
    return { ok: false, message: 'Every row in this ' + cfg.label + ' paste is dated before the opening-stock date (' +
      asOf + '). Nothing imported. Export a range that starts on or after ' + asOf + '.' };
  }

  // Span from the actual parsed dates (not just the header line).
  var dates = cleaned.rows.map(function (r) { return r[1]; }).sort();
  var fromIso = dates[0], toIso = dates[dates.length - 1];

  var clash = checkOverlap_(cfg.txnType, fromIso, toIso);
  if (clash) {
    return {
      ok: false, duplicate: true,
      message: cfg.label + ' for ' + fromIso + ' → ' + toIso + ' overlaps an import already done on ' +
        clash.at + ' (span ' + clash.from + ' → ' + clash.to + '). Re-importing would double-count. ' +
        'Use "Undo last import" first, or export a non-overlapping span.'
    };
  }

  var importId = newImportId_();

  // ---- aggregate the batch in memory ----
  var itemDelta = {};     // item_key -> {dP,dS,dPR,dSR, lastPur, lastSale, firstPur, firstSale, purPrice,
                          //              dPurAmt, dSaleAmt, purEntries, saleEntries, suppliers, details, group}
  var smDelta   = {};     // salesman -> {soldQ, soldA, boughtQ, boughtA}
  var buyDelta  = {};     // salesman||item_key -> {salesman, item_key, qty, amount, last_date, details, group}
  var batchQty = 0, batchAmt = 0;

  cleaned.rows.forEach(function (row) {
    var type = row[0], dIso = row[1], party = row[3], sm = String(row[4]).trim() || '(blank)';
    var itemRaw = row[5], key = row[6], grp = row[7];
    var qty = parseNum_(row[8]), price = parseNum_(row[10]), amt = parseNum_(row[11]);
    batchQty += qty; batchAmt += amt;

    var d = itemDelta[key] || (itemDelta[key] = {
      dP: 0, dS: 0, dPR: 0, dSR: 0, lastPur: '', lastSale: '', firstPur: '', firstSale: '',
      purPrice: 0, dPurAmt: 0, dSaleAmt: 0, purEntries: 0, saleEntries: 0, suppliers: [],
      details: itemRaw, group: grp
    });
    if (!d.details && itemRaw) d.details = itemRaw;
    if (!d.group && grp) d.group = grp;

    if (type === 'PURCHASE') {
      d.dP += qty; if (dIso > d.lastPur) d.lastPur = dIso; if (!d.firstPur || dIso < d.firstPur) d.firstPur = dIso;
      if (price) d.purPrice = price;
      d.dPurAmt += amt; d.purEntries++;
      if (party) d.suppliers.push(String(party).trim());
      var s1 = smDelta[sm] || (smDelta[sm] = { soldQ: 0, soldA: 0, boughtQ: 0, boughtA: 0 });
      s1.boughtQ += qty; s1.boughtA += amt;
      var bk = sm + KEY_SEP + key;
      var b = buyDelta[bk] || (buyDelta[bk] = { salesman: sm, item_key: key, qty: 0, amount: 0, last_date: '', details: itemRaw, group: grp });
      b.qty += qty; b.amount += amt; if (dIso > b.last_date) b.last_date = dIso;
    } else if (type === 'SALE') {
      d.dS += qty; if (dIso > d.lastSale) d.lastSale = dIso; if (!d.firstSale || dIso < d.firstSale) d.firstSale = dIso;
      d.dSaleAmt += amt; d.saleEntries++;
      var s2 = smDelta[sm] || (smDelta[sm] = { soldQ: 0, soldA: 0, boughtQ: 0, boughtA: 0 });
      s2.soldQ += qty; s2.soldA += amt;
    } else if (type === 'PURCHASE_RETURN') {
      d.dPR += qty;
      var s3 = smDelta[sm] || (smDelta[sm] = { soldQ: 0, soldA: 0, boughtQ: 0, boughtA: 0 });
      s3.boughtQ -= qty; s3.boughtA -= amt;
    } else if (type === 'SALE_RETURN') {
      d.dSR += qty;
      var s4 = smDelta[sm] || (smDelta[sm] = { soldQ: 0, soldA: 0, boughtQ: 0, boughtA: 0 });
      s4.soldQ -= qty; s4.soldA -= amt;
    }
  });

  // ---- apply to Items ----
  var items = readItemsMap_();
  Object.keys(itemDelta).forEach(function (key) {
    var d = itemDelta[key];
    var rec = items[key] || (items[key] = newItemRec_(key, d.details, d.group));
    rec.purchased   = round2_(rec.purchased + d.dP);
    rec.sold        = round2_(rec.sold + d.dS);
    rec.pur_return  = round2_(rec.pur_return + d.dPR);
    rec.sale_return = round2_(rec.sale_return + d.dSR);
    rec.purchase_amount = round2_(rec.purchase_amount + d.dPurAmt);
    rec.sale_amount     = round2_(rec.sale_amount + d.dSaleAmt);
    rec.purchase_entries = (rec.purchase_entries || 0) + d.purEntries;
    rec.sale_entries      = (rec.sale_entries || 0) + d.saleEntries;
    if (d.lastPur && d.lastPur > rec.last_purchase_date)  rec.last_purchase_date = d.lastPur;
    if (d.lastSale && d.lastSale > rec.last_sale_date)    rec.last_sale_date = d.lastSale;
    if (d.firstPur && (!rec.first_purchase_date || d.firstPur < rec.first_purchase_date)) rec.first_purchase_date = d.firstPur;
    if (d.firstSale && (!rec.first_sale_date || d.firstSale < rec.first_sale_date))       rec.first_sale_date = d.firstSale;
    if (d.suppliers.length) rec.suppliers = mergeSuppliers_(rec.suppliers, d.suppliers);
    if (d.purPrice) rec.price = d.purPrice;
    if (!rec.details && d.details) rec.details = d.details;
    if (!rec.group && d.group) rec.group = d.group;
    rec.updated_at = nowStamp_();
    recalcStock_(rec);
  });
  writeItemsMap_(items);

  // ---- apply to Salesmen ----
  applySalesmenDelta_(smDelta);

  // ---- apply to SalesmanBuys ----
  applyBuysDelta_(buyDelta);

  // ---- append to Txn, then prune ----
  var txnRows = cleaned.rows.map(function (r) { return [importId].concat(r); });
  appendRows_(TABS.TXN, txnRows);
  var pruned = pruneTxn_(settings);

  // ---- log ----
  appendRows_(TABS.IMPORTS, [[
    importId, cfg.txnType, fromIso, toIso, cleaned.rows.length,
    round2_(batchQty), round2_(batchAmt), user.username, nowStamp_(), ''
  ]]);

  // ---- persist cleaning errors ----
  persistUnmatched_(cfg.txnType, cleaned.errors);

  return {
    ok: true, isStock: false, label: cfg.label, importId: importId,
    rowsParsed: cleaned.rows.length,
    blankDatesFilled: cleaned.blanksFilledDates,
    skippedBeforeOpening: skippedBefore,
    dateFormat: topKey_(cleaned.detectedFmt) || 'n/a',
    dateRange: fromIso + ' → ' + toIso,
    rowsAdded: cleaned.rows.length,
    rowsRemoved: pruned,
    ledgerTotal: countRows_(TABS.TXN),
    items: Object.keys(items).length,
    unmatchedCount: cleaned.errors.length,
    errors: cleaned.errors.slice(0, 50).map(function (e) { return { type: e[0], item: e[2] || e[1], detail: e[3] }; })
  };
}

function applySalesmenDelta_(smDelta) {
  if (!Object.keys(smDelta).length) return;
  var map = {};
  readObjects_(TABS.SALESMEN, {
    salesman: ['salesman'], sold_qty: ['sold_qty'], sold_amount: ['sold_amount'],
    bought_qty: ['bought_qty'], bought_amount: ['bought_amount']
  }).forEach(function (o) {
    var k = String(o.salesman).trim(); if (!k) return;
    map[k] = { sold_qty: parseNum_(o.sold_qty), sold_amount: parseNum_(o.sold_amount),
               bought_qty: parseNum_(o.bought_qty), bought_amount: parseNum_(o.bought_amount) };
  });
  Object.keys(smDelta).forEach(function (sm) {
    var d = smDelta[sm];
    var rec = map[sm] || (map[sm] = { sold_qty: 0, sold_amount: 0, bought_qty: 0, bought_amount: 0 });
    rec.sold_qty      = round2_(rec.sold_qty + d.soldQ);
    rec.sold_amount   = round2_(rec.sold_amount + d.soldA);
    rec.bought_qty    = round2_(rec.bought_qty + d.boughtQ);
    rec.bought_amount = round2_(rec.bought_amount + d.boughtA);
  });
  var rows = Object.keys(map).sort().map(function (sm) {
    var r = map[sm];
    return [sm, r.sold_qty, r.sold_amount, r.bought_qty, r.bought_amount, nowStamp_()];
  });
  writeGrid_(TABS.SALESMEN, SALESMEN_HEADERS, rows);
}

function applyBuysDelta_(buyDelta) {
  if (!Object.keys(buyDelta).length) return;
  var map = {};
  readObjects_(TABS.SALESMAN_BUYS, {
    salesman: ['salesman'], item_key: ['item_key'], details: ['details'], group: ['group'],
    qty: ['qty'], amount: ['amount'], last_date: ['last_date']
  }).forEach(function (o) {
    var k = String(o.salesman).trim() + KEY_SEP + String(o.item_key).trim();
    map[k] = { salesman: String(o.salesman).trim(), item_key: String(o.item_key).trim(),
               details: String(o.details || '').trim(), group: String(o.group || '').trim(),
               qty: parseNum_(o.qty), amount: parseNum_(o.amount), last_date: asIsoMaybe_(o.last_date) };
  });
  Object.keys(buyDelta).forEach(function (bk) {
    var d = buyDelta[bk];
    var rec = map[bk] || (map[bk] = { salesman: d.salesman, item_key: d.item_key, details: d.details,
                                      group: d.group, qty: 0, amount: 0, last_date: '' });
    rec.qty = round2_(rec.qty + d.qty);
    rec.amount = round2_(rec.amount + d.amount);
    if (d.last_date > rec.last_date) rec.last_date = d.last_date;
    if (!rec.details && d.details) rec.details = d.details;
  });
  var rows = Object.keys(map).sort().map(function (k) {
    var r = map[k];
    return [r.salesman, r.item_key, r.details, r.group, r.qty, r.amount, r.last_date];
  });
  writeGrid_(TABS.SALESMAN_BUYS, SALESMAN_BUYS_HEADERS, rows);
}

/** Delete Txn rows older than the retention window. Returns how many were removed. */
function pruneTxn_(settings) {
  var sh = SpreadsheetApp.getActive().getSheetByName(TABS.TXN);
  if (!sh || sh.getLastRow() < 2) return 0;
  var retention = Number(settings.txn_retention_days) || 100;
  var cutoffIso = isoOfDate_(new Date(todayMidnight_().getTime() - retention * 86400000));

  var v = sh.getDataRange().getValues();
  var H = buildHeaderMap_(v[0]);
  var dIdx = col_(H, ['date']);
  if (dIdx === -1) return 0;

  var kept = [];
  var removed = 0;
  for (var i = 1; i < v.length; i++) {
    if (String(v[i].join('')).trim() === '') continue;
    v[i][dIdx] = asIsoMaybe_(v[i][dIdx]);
    if (v[i][dIdx] >= cutoffIso) kept.push(v[i]);
    else removed++;
  }
  if (removed) writeGrid_(TABS.TXN, TXN_HEADERS, kept);
  return removed;
}

/** Replace the Unmatched rows for one source type with fresh cleaning errors (capped). */
function persistUnmatched_(srcType, errors) {
  var keep = readObjects_(TABS.UNMATCHED, {
    type: ['type'], item_key: ['item_key'], details: ['details'], detail: ['detail'], src: ['src']
  }).filter(function (o) { return String(o.src).trim().toUpperCase() !== String(srcType).trim().toUpperCase(); })
    .map(function (o) { return [o.type, o.item_key, o.details, o.detail, o.src]; });

  var fresh = (errors || []).map(function (e) { return [e[0], e[1], e[2], e[3], e[4] || srcType]; });
  var all = keep.concat(fresh).slice(0, MAX_UNMATCHED);
  writeGrid_(TABS.UNMATCHED, UNMATCHED_HEADERS, all);
}

function countRows_(tabName) {
  var sh = SpreadsheetApp.getActive().getSheetByName(tabName);
  return sh ? Math.max(0, sh.getLastRow() - 1) : 0;
}


/* =============================== UNDO LAST IMPORT ================================== */

/** Reverse the most recent Txn import (only while its rows are still in Txn). Admin only. */
function undoLastImport(token) {
  var auth = checkAuth_(token, ['admin']);
  if (auth._err) return auth._err;

  var impSh = SpreadsheetApp.getActive().getSheetByName(TABS.IMPORTS);
  if (!impSh || impSh.getLastRow() < 2) return { ok: false, message: 'No imports to undo.' };
  var iv = impSh.getDataRange().getValues();
  var IH = buildHeaderMap_(iv[0]);
  var ic = { id: col_(IH, ['import_id']), type: col_(IH, ['txn_type']), from: col_(IH, ['date_from']),
             to: col_(IH, ['date_to']), at: col_(IH, ['imported_at']) };

  var lastRowNo = -1, last = null;
  for (var i = 1; i < iv.length; i++) {
    if (String(iv[i][ic.id]).trim()) { lastRowNo = i; last = iv[i]; }
  }
  if (!last) return { ok: false, message: 'No imports to undo.' };

  var impId = String(last[ic.id]).trim();
  var impType = String(last[ic.type]).trim().toUpperCase();

  if (impType === 'OPENING_STOCK') {
    return { ok: false, message: 'The last import was an opening-stock baseline. Re-paste the correct Stock (Reset opening) instead of undo.' };
  }

  // Pull this import's rows out of Txn.
  var txnSh = SpreadsheetApp.getActive().getSheetByName(TABS.TXN);
  var tv = txnSh && txnSh.getLastRow() > 1 ? txnSh.getDataRange().getValues() : null;
  if (!tv) return { ok: false, message: 'Txn is empty — nothing to undo.' };
  var TH = buildHeaderMap_(tv[0]);
  var tc = { imp: col_(TH, ['import_id']), type: col_(TH, ['txn_type']), date: col_(TH, ['date']),
             sm: col_(TH, ['salesman']), raw: col_(TH, ['item_details_raw']), key: col_(TH, ['item_key']),
             group: col_(TH, ['group']), qty: col_(TH, ['qty']), price: col_(TH, ['price']), amount: col_(TH, ['amount']) };

  var mine = [], keep = [];
  for (var r = 1; r < tv.length; r++) {
    if (String(tv[r].join('')).trim() === '') continue;
    tv[r][tc.date] = asIsoMaybe_(tv[r][tc.date]);
    if (String(tv[r][tc.imp]).trim() === impId) mine.push(tv[r]);
    else keep.push(tv[r]);
  }
  if (!mine.length) {
    return { ok: false, message: 'That import (' + impId + ') is already pruned from Txn and cannot be auto-undone. Use RESET and re-import if the data is wrong.' };
  }

  // Reverse the same aggregation.
  var itemDelta = {}, smDelta = {}, buyDelta = {};
  mine.forEach(function (row) {
    var type = String(row[tc.type]).trim().toUpperCase();
    var sm = String(row[tc.sm]).trim() || '(blank)';
    var key = String(row[tc.key]).trim();
    var qty = parseNum_(row[tc.qty]), amt = parseNum_(row[tc.amount]);
    var d = itemDelta[key] || (itemDelta[key] = { dP: 0, dS: 0, dPR: 0, dSR: 0, dPurAmt: 0, dSaleAmt: 0, purEntries: 0, saleEntries: 0 });
    var s = smDelta[sm] || (smDelta[sm] = { soldQ: 0, soldA: 0, boughtQ: 0, boughtA: 0 });
    if (type === 'PURCHASE') {
      d.dP -= qty; d.dPurAmt -= amt; d.purEntries -= 1; s.boughtQ -= qty; s.boughtA -= amt;
      var bk = sm + KEY_SEP + key;
      var b = buyDelta[bk] || (buyDelta[bk] = { salesman: sm, item_key: key, qty: 0, amount: 0, last_date: '', details: '', group: '' });
      b.qty -= qty; b.amount -= amt;
    } else if (type === 'SALE') {
      d.dS -= qty; d.dSaleAmt -= amt; d.saleEntries -= 1; s.soldQ -= qty; s.soldA -= amt;
    } else if (type === 'PURCHASE_RETURN') {
      d.dPR -= qty; s.boughtQ += qty; s.boughtA += amt;
    } else if (type === 'SALE_RETURN') {
      d.dSR -= qty; s.soldQ += qty; s.soldA += amt;
    }
  });

  // Apply reversal to Items.
  var items = readItemsMap_();
  Object.keys(itemDelta).forEach(function (key) {
    var d = itemDelta[key];
    var rec = items[key];
    if (!rec) return;
    rec.purchased   = round2_(rec.purchased + d.dP);
    rec.sold        = round2_(rec.sold + d.dS);
    rec.pur_return  = round2_(rec.pur_return + d.dPR);
    rec.sale_return = round2_(rec.sale_return + d.dSR);
    rec.purchase_amount  = round2_((rec.purchase_amount || 0) + d.dPurAmt);
    rec.sale_amount      = round2_((rec.sale_amount || 0) + d.dSaleAmt);
    rec.purchase_entries = Math.max(0, (rec.purchase_entries || 0) + d.purEntries);
    rec.sale_entries      = Math.max(0, (rec.sale_entries || 0) + d.saleEntries);
    rec.updated_at = nowStamp_();
    recalcStock_(rec);
    // If this undo wiped out all purchase/sale history for the item, clear the denormalised "first" fields too.
    if (rec.purchased <= 0) { rec.first_purchase_date = ''; rec.purchase_entries = 0; rec.purchase_amount = 0; rec.suppliers = ''; }
    if (rec.sold <= 0) { rec.first_sale_date = ''; rec.sale_entries = 0; rec.sale_amount = 0; }
  });

  // Recompute last_purchase_date / last_sale_date for affected keys from the remaining Txn.
  var remainByKey = {};
  keep.forEach(function (row) {
    var key = String(row[tc.key]).trim();
    var type = String(row[tc.type]).trim().toUpperCase();
    var dIso = asIsoMaybe_(row[tc.date]);
    var e = remainByKey[key] || (remainByKey[key] = { pur: '', sale: '' });
    if (type === 'PURCHASE' && dIso > e.pur) e.pur = dIso;
    if (type === 'SALE' && dIso > e.sale) e.sale = dIso;
  });
  Object.keys(itemDelta).forEach(function (key) {
    var rec = items[key];
    if (!rec) return;
    var e = remainByKey[key] || { pur: '', sale: '' };
    rec.last_purchase_date = e.pur;
    rec.last_sale_date = e.sale;
  });
  writeItemsMap_(items);

  applySalesmenDelta_(smDelta);
  applyBuysDelta_(buyDelta);

  // Delete the Txn rows and the Imports row.
  writeGrid_(TABS.TXN, TXN_HEADERS, keep);
  impSh.deleteRow(lastRowNo + 1);

  return { ok: true, undone: impId, type: impType, rows: mine.length };
}


/* =============================== CANCEL / RESTORE A BILL ================================== */
// Cancel a whole voucher (bill number) some customer/supplier bill got cancelled for — pulls every
// Txn row with that vch_no out, reverses their effect on Items/Salesmen/SalesmanBuys (same delta
// math as undoLastImport, just scoped to the matched rows instead of a whole import), and archives
// the removed rows into CancelledBills so they can be restored later. Only reaches bills whose rows
// are still inside the Txn retention window (same limitation as undoLastImport).

/** Find every Txn row matching a bill/voucher number (optionally scoped to one txn_type). */
function findTxnRowsByBill_(billNo, txnType) {
  var bill = String(billNo || '').trim().toLowerCase();
  var typeFilter = String(txnType || '').trim().toUpperCase();
  var out = { ok: true, matched: [], kept: [], tc: null };
  if (!bill) { out.ok = false; out.message = 'Enter a bill/voucher number.'; return out; }

  var sh = SpreadsheetApp.getActive().getSheetByName(TABS.TXN);
  if (!sh || sh.getLastRow() < 2) { out.ok = false; out.message = 'Txn is empty — nothing to cancel.'; return out; }
  var tv = sh.getDataRange().getValues();
  var TH = buildHeaderMap_(tv[0]);
  var tc = { imp: col_(TH, ['import_id']), type: col_(TH, ['txn_type']), date: col_(TH, ['date']),
             vch: col_(TH, ['vch_no']), party: col_(TH, ['party']), sm: col_(TH, ['salesman']),
             raw: col_(TH, ['item_details_raw']), key: col_(TH, ['item_key']), group: col_(TH, ['group']),
             qty: col_(TH, ['qty']), unit: col_(TH, ['unit']), price: col_(TH, ['price']), amount: col_(TH, ['amount']) };
  out.tc = tc;

  for (var i = 1; i < tv.length; i++) {
    if (String(tv[i].join('')).trim() === '') continue;
    tv[i][tc.date] = asIsoMaybe_(tv[i][tc.date]);
    var rowVch = String(tv[i][tc.vch] == null ? '' : tv[i][tc.vch]).trim().toLowerCase();
    var rowType = String(tv[i][tc.type]).trim().toUpperCase();
    var isMatch = rowVch === bill && (!typeFilter || typeFilter === 'ALL' || rowType === typeFilter);
    if (isMatch) out.matched.push(tv[i]); else out.kept.push(tv[i]);
  }
  if (!out.matched.length) {
    out.ok = false;
    out.message = 'No transactions found with bill/voucher number "' + billNo + '"' +
      (typeFilter && typeFilter !== 'ALL' ? ' (' + typeFilter + ')' : '') +
      ' in the recent detail window. Older bills outside the Txn retention window cannot be auto-cancelled this way.';
  }
  return out;
}

/** Summarise what cancelling a bill number would affect, WITHOUT changing anything — for a confirm step. */
function previewBillCancel(billNo, txnType, token) {
  var auth = checkAuth_(token, ['admin', 'staff'], 'cancel_bills');
  if (auth._err) return auth._err;
  setupSheets_(); // self-heal: makes sure the CancelledBills tab exists on sheets set up before this feature

  var found = findTxnRowsByBill_(billNo, txnType);
  if (!found.ok) return { ok: false, message: found.message };
  var tc = found.tc;

  var types = {}, items = {}, qty = 0, amount = 0, minDate = '', maxDate = '';
  found.matched.forEach(function (row) {
    types[String(row[tc.type]).trim().toUpperCase()] = true;
    var key = String(row[tc.key]).trim();
    items[key] = String(row[tc.raw]).trim() || key;
    qty += parseNum_(row[tc.qty]);
    amount += parseNum_(row[tc.amount]);
    var d = row[tc.date];
    if (!minDate || d < minDate) minDate = d;
    if (!maxDate || d > maxDate) maxDate = d;
  });

  return {
    ok: true, bill_no: String(billNo).trim(), rows: found.matched.length,
    types: Object.keys(types), items: Object.keys(items).map(function (k) { return items[k]; }),
    qty: round2_(qty), amount: round2_(amount), date_from: minDate, date_to: maxDate
  };
}

/** Actually cancel a bill number: reverse its effect and archive the rows for restore. Admin only. */
function cancelBillByNumber(billNo, txnType, token) {
  var auth = checkAuth_(token, ['admin', 'staff'], 'cancel_bills');
  if (auth._err) return auth._err;
  setupSheets_();

  var found = findTxnRowsByBill_(billNo, txnType);
  if (!found.ok) return { ok: false, message: found.message };
  var tc = found.tc;

  // Reverse the same delta math as undoLastImport, scoped to just the matched rows.
  var itemDelta = {}, smDelta = {}, buyDelta = {};
  found.matched.forEach(function (row) {
    var type = String(row[tc.type]).trim().toUpperCase();
    var sm = String(row[tc.sm]).trim() || '(blank)';
    var key = String(row[tc.key]).trim();
    var qty = parseNum_(row[tc.qty]), amt = parseNum_(row[tc.amount]);
    var d = itemDelta[key] || (itemDelta[key] = { dP: 0, dS: 0, dPR: 0, dSR: 0, dPurAmt: 0, dSaleAmt: 0, purEntries: 0, saleEntries: 0 });
    var s = smDelta[sm] || (smDelta[sm] = { soldQ: 0, soldA: 0, boughtQ: 0, boughtA: 0 });
    if (type === 'PURCHASE') {
      d.dP -= qty; d.dPurAmt -= amt; d.purEntries -= 1; s.boughtQ -= qty; s.boughtA -= amt;
      var bk = sm + KEY_SEP + key;
      var b = buyDelta[bk] || (buyDelta[bk] = { salesman: sm, item_key: key, qty: 0, amount: 0, last_date: '', details: '', group: '' });
      b.qty -= qty; b.amount -= amt;
    } else if (type === 'SALE') {
      d.dS -= qty; d.dSaleAmt -= amt; d.saleEntries -= 1; s.soldQ -= qty; s.soldA -= amt;
    } else if (type === 'PURCHASE_RETURN') {
      d.dPR -= qty; s.boughtQ += qty; s.boughtA += amt;
    } else if (type === 'SALE_RETURN') {
      d.dSR -= qty; s.soldQ += qty; s.soldA += amt;
    }
  });

  var items = readItemsMap_();
  Object.keys(itemDelta).forEach(function (key) {
    var d = itemDelta[key];
    var rec = items[key];
    if (!rec) return;
    rec.purchased   = round2_(rec.purchased + d.dP);
    rec.sold        = round2_(rec.sold + d.dS);
    rec.pur_return  = round2_(rec.pur_return + d.dPR);
    rec.sale_return = round2_(rec.sale_return + d.dSR);
    rec.purchase_amount  = round2_((rec.purchase_amount || 0) + d.dPurAmt);
    rec.sale_amount      = round2_((rec.sale_amount || 0) + d.dSaleAmt);
    rec.purchase_entries = Math.max(0, (rec.purchase_entries || 0) + d.purEntries);
    rec.sale_entries      = Math.max(0, (rec.sale_entries || 0) + d.saleEntries);
    rec.updated_at = nowStamp_();
    recalcStock_(rec);
    if (rec.purchased <= 0) { rec.first_purchase_date = ''; rec.purchase_entries = 0; rec.purchase_amount = 0; rec.suppliers = ''; }
    if (rec.sold <= 0) { rec.first_sale_date = ''; rec.sale_entries = 0; rec.sale_amount = 0; }
  });

  // Recompute last_purchase_date / last_sale_date for affected keys from the remaining Txn.
  var remainByKey = {};
  found.kept.forEach(function (row) {
    var key = String(row[tc.key]).trim();
    var type = String(row[tc.type]).trim().toUpperCase();
    var dIso = row[tc.date];
    var e = remainByKey[key] || (remainByKey[key] = { pur: '', sale: '' });
    if (type === 'PURCHASE' && dIso > e.pur) e.pur = dIso;
    if (type === 'SALE' && dIso > e.sale) e.sale = dIso;
  });
  Object.keys(itemDelta).forEach(function (key) {
    var rec = items[key];
    if (!rec) return;
    var e = remainByKey[key] || { pur: '', sale: '' };
    rec.last_purchase_date = e.pur;
    rec.last_sale_date = e.sale;
  });
  writeItemsMap_(items);

  applySalesmenDelta_(smDelta);
  applyBuysDelta_(buyDelta);

  // Remove the matched rows from Txn.
  writeGrid_(TABS.TXN, TXN_HEADERS, found.kept);

  // Archive the matched rows so they can be restored.
  var cancelId = 'canc_' + isoOfDate_(new Date()).replace(/-/g, '') + '_' + Utilities.getUuid().slice(0, 6);
  var stamp = nowStamp_();
  var archiveRows = found.matched.map(function (row) {
    return [cancelId].concat(row).concat([auth.user.username, stamp]);
  });
  appendRows_(TABS.CANCELLED, archiveRows);

  return { ok: true, cancel_id: cancelId, bill_no: String(billNo).trim(), rows: found.matched.length };
}

/** List currently-cancelled bills, one row per cancel action (grouped by cancel_id). Admin only. */
function getCancelledBills(token) {
  var auth = checkAuth_(token, ['admin', 'staff'], 'cancel_bills');
  if (auth._err) return auth._err;
  setupSheets_();

  var rows = readObjects_(TABS.CANCELLED, {
    cancel_id: ['cancel_id'], txn_type: ['txn_type'], date: ['date'], vch_no: ['vch_no'],
    party: ['party'], salesman: ['salesman'], item_details_raw: ['item_details_raw'],
    group: ['group'], qty: ['qty'], amount: ['amount'], cancelled_by: ['cancelled_by'], cancelled_at: ['cancelled_at']
  });

  var byId = {};
  rows.forEach(function (o) {
    var id = String(o.cancel_id).trim();
    if (!id) return;
    var g = byId[id] || (byId[id] = {
      cancel_id: id, bill_no: String(o.vch_no || '').trim(), types: {}, items: [],
      rows: 0, qty: 0, amount: 0, date_from: '', date_to: '',
      cancelled_by: String(o.cancelled_by || ''), cancelled_at: String(o.cancelled_at || '')
    });
    g.types[String(o.txn_type).trim().toUpperCase()] = true;
    g.items.push(String(o.item_details_raw || '').trim());
    g.rows++;
    g.qty = round2_(g.qty + parseNum_(o.qty));
    g.amount = round2_(g.amount + parseNum_(o.amount));
    var d = asIsoMaybe_(o.date);
    if (!g.date_from || d < g.date_from) g.date_from = d;
    if (!g.date_to || d > g.date_to) g.date_to = d;
  });

  var bills = Object.keys(byId).map(function (id) {
    var g = byId[id];
    return {
      cancel_id: g.cancel_id, bill_no: g.bill_no, types: Object.keys(g.types), items: g.items,
      rows: g.rows, qty: g.qty, amount: g.amount, date_from: g.date_from, date_to: g.date_to,
      cancelled_by: g.cancelled_by, cancelled_at: g.cancelled_at
    };
  }).sort(function (a, b) { return a.cancelled_at < b.cancelled_at ? 1 : -1; });

  return { ok: true, bills: bills };
}

/** Undo a cancel: forward-apply the archived rows back into Items/Salesmen/SalesmanBuys and Txn. */
function restoreCancelledBill(cancelId, token) {
  var auth = checkAuth_(token, ['admin', 'staff'], 'cancel_bills');
  if (auth._err) return auth._err;
  var id = String(cancelId || '').trim();
  if (!id) return { ok: false, message: 'Missing cancel id.' };

  var sh = SpreadsheetApp.getActive().getSheetByName(TABS.CANCELLED);
  if (!sh || sh.getLastRow() < 2) return { ok: false, message: 'Nothing to restore.' };
  var cv = sh.getDataRange().getValues();
  var CH = buildHeaderMap_(cv[0]);
  var cc = { id: col_(CH, ['cancel_id']), imp: col_(CH, ['import_id']), type: col_(CH, ['txn_type']),
             date: col_(CH, ['date']), vch: col_(CH, ['vch_no']), party: col_(CH, ['party']), sm: col_(CH, ['salesman']),
             raw: col_(CH, ['item_details_raw']), key: col_(CH, ['item_key']), group: col_(CH, ['group']),
             qty: col_(CH, ['qty']), unit: col_(CH, ['unit']), price: col_(CH, ['price']), amount: col_(CH, ['amount']) };

  var matched = [], keep = [];
  for (var i = 1; i < cv.length; i++) {
    if (String(cv[i].join('')).trim() === '') continue;
    cv[i][cc.date] = asIsoMaybe_(cv[i][cc.date]);
    if (String(cv[i][cc.id]).trim() === id) matched.push(cv[i]); else keep.push(cv[i]);
  }
  if (!matched.length) return { ok: false, message: 'That cancelled bill was not found (already restored?).' };

  // Forward-apply the same way a fresh import would — mirrors commitTxnImport_'s aggregation.
  var itemDelta = {}, smDelta = {}, buyDelta = {};
  matched.forEach(function (row) {
    var type = String(row[cc.type]).trim().toUpperCase();
    var dIso = row[cc.date];
    var party = String(row[cc.party] || '').trim();
    var sm = String(row[cc.sm]).trim() || '(blank)';
    var itemRaw = String(row[cc.raw] || '').trim();
    var key = String(row[cc.key]).trim();
    var grp = String(row[cc.group] || '').trim();
    var qty = parseNum_(row[cc.qty]), price = parseNum_(row[cc.price]), amt = parseNum_(row[cc.amount]);

    var d = itemDelta[key] || (itemDelta[key] = {
      dP: 0, dS: 0, dPR: 0, dSR: 0, lastPur: '', lastSale: '', firstPur: '', firstSale: '',
      purPrice: 0, dPurAmt: 0, dSaleAmt: 0, purEntries: 0, saleEntries: 0, suppliers: [], details: itemRaw, group: grp
    });
    if (type === 'PURCHASE') {
      d.dP += qty; if (dIso > d.lastPur) d.lastPur = dIso; if (!d.firstPur || dIso < d.firstPur) d.firstPur = dIso;
      if (price) d.purPrice = price;
      d.dPurAmt += amt; d.purEntries++;
      if (party) d.suppliers.push(party);
      var s1 = smDelta[sm] || (smDelta[sm] = { soldQ: 0, soldA: 0, boughtQ: 0, boughtA: 0 });
      s1.boughtQ += qty; s1.boughtA += amt;
      var bk = sm + KEY_SEP + key;
      var b = buyDelta[bk] || (buyDelta[bk] = { salesman: sm, item_key: key, qty: 0, amount: 0, last_date: '', details: itemRaw, group: grp });
      b.qty += qty; b.amount += amt; if (dIso > b.last_date) b.last_date = dIso;
    } else if (type === 'SALE') {
      d.dS += qty; if (dIso > d.lastSale) d.lastSale = dIso; if (!d.firstSale || dIso < d.firstSale) d.firstSale = dIso;
      d.dSaleAmt += amt; d.saleEntries++;
      var s2 = smDelta[sm] || (smDelta[sm] = { soldQ: 0, soldA: 0, boughtQ: 0, boughtA: 0 });
      s2.soldQ += qty; s2.soldA += amt;
    } else if (type === 'PURCHASE_RETURN') {
      d.dPR += qty;
      var s3 = smDelta[sm] || (smDelta[sm] = { soldQ: 0, soldA: 0, boughtQ: 0, boughtA: 0 });
      s3.boughtQ -= qty; s3.boughtA -= amt;
    } else if (type === 'SALE_RETURN') {
      d.dSR += qty;
      var s4 = smDelta[sm] || (smDelta[sm] = { soldQ: 0, soldA: 0, boughtQ: 0, boughtA: 0 });
      s4.soldQ -= qty; s4.soldA -= amt;
    }
  });

  var items = readItemsMap_();
  Object.keys(itemDelta).forEach(function (key) {
    var d = itemDelta[key];
    var rec = items[key] || (items[key] = newItemRec_(key, d.details, d.group));
    rec.purchased   = round2_(rec.purchased + d.dP);
    rec.sold        = round2_(rec.sold + d.dS);
    rec.pur_return  = round2_(rec.pur_return + d.dPR);
    rec.sale_return = round2_(rec.sale_return + d.dSR);
    rec.purchase_amount  = round2_((rec.purchase_amount || 0) + d.dPurAmt);
    rec.sale_amount      = round2_((rec.sale_amount || 0) + d.dSaleAmt);
    rec.purchase_entries = (rec.purchase_entries || 0) + d.purEntries;
    rec.sale_entries      = (rec.sale_entries || 0) + d.saleEntries;
    if (d.purPrice) rec.price = d.purPrice;
    if (d.lastPur && d.lastPur > rec.last_purchase_date) rec.last_purchase_date = d.lastPur;
    if (d.lastSale && d.lastSale > rec.last_sale_date) rec.last_sale_date = d.lastSale;
    if (d.firstPur && (!rec.first_purchase_date || d.firstPur < rec.first_purchase_date)) rec.first_purchase_date = d.firstPur;
    if (d.firstSale && (!rec.first_sale_date || d.firstSale < rec.first_sale_date)) rec.first_sale_date = d.firstSale;
    if (d.suppliers.length) rec.suppliers = mergeSuppliers_(rec.suppliers, d.suppliers);
    rec.updated_at = nowStamp_();
    recalcStock_(rec);
  });
  writeItemsMap_(items);

  applySalesmenDelta_(smDelta);
  applyBuysDelta_(buyDelta);

  // Put the rows back into Txn (original import_id kept for traceability), then let the normal
  // retention prune run — if the bill is now older than the retention window it drops straight
  // back out of the detail cache, same as any other old transaction (lifetime totals still hold it).
  var txnRows = matched.map(function (row) {
    return [row[cc.imp], row[cc.type], row[cc.date], row[cc.vch], row[cc.party], row[cc.sm],
            row[cc.raw], row[cc.key], row[cc.group], row[cc.qty], row[cc.unit], row[cc.price], row[cc.amount]];
  });
  appendRows_(TABS.TXN, txnRows);
  pruneTxn_(readSettings_());

  // Remove the restored rows from CancelledBills.
  writeGrid_(TABS.CANCELLED, CANCELLED_HEADERS, keep);

  return { ok: true, restored: matched.length, bill_no: String(matched[0][cc.vch] || '').trim() };
}


/* =============================== DASHBOARD COMPUTE ================================ */

/**
 * Build the full dashboard payload from the lean tabs. O(Items + recent Txn).
 * Window metrics come from Txn (retention >= window). Aging dates come from Items (lifetime).
 */
function computeDashboard_(windowDays, settings) {
  settings = settings || readSettings_();
  var retention = Number(settings.txn_retention_days) || 100;
  windowDays = Math.min(Number(windowDays) || settings.aging_window_days, retention);

  var today = todayMidnight_();
  var cutoffIso = isoOfDate_(new Date(today.getTime() - windowDays * 86400000));

  /* ---- 1. Items ---- */
  var itemsMap = readItemsMap_();

  /* ---- 2. Txn window pass ---- */
  var win = {};          // item_key -> {soldQ, purQ, prQ, srQ, moved, sellers:{}, buyers:{}}
  var smSalesWin = {};   // salesman -> {qty, amount, items:{key:{details,group,qty,amount}}}
  var txnSh = SpreadsheetApp.getActive().getSheetByName(TABS.TXN);
  if (txnSh && txnSh.getLastRow() > 1) {
    var tv = txnSh.getDataRange().getValues();
    var TH = buildHeaderMap_(tv[0]);
    var tc = { type: col_(TH, ['txn_type']), date: col_(TH, ['date']), sm: col_(TH, ['salesman']),
               raw: col_(TH, ['item_details_raw']), key: col_(TH, ['item_key']), group: col_(TH, ['group']),
               qty: col_(TH, ['qty']), amount: col_(TH, ['amount']) };
    for (var i = 1; i < tv.length; i++) {
      var row = tv[i];
      var key = String(row[tc.key]).trim();
      if (!key) continue;
      if (asIsoMaybe_(row[tc.date]) < cutoffIso) continue;
      var type = String(row[tc.type]).trim().toUpperCase();
      var qty = parseNum_(row[tc.qty]), amt = parseNum_(row[tc.amount]);
      var sm = String(row[tc.sm]).trim() || '(blank)';
      var w = win[key] || (win[key] = { soldQ: 0, purQ: 0, prQ: 0, srQ: 0, soldAmt: 0, purAmt: 0, moved: false, sellers: {}, buyers: {} });
      w.moved = true;
      if (type === 'PURCHASE') { w.purQ += qty; w.purAmt += amt; w.buyers[sm] = true; }
      else if (type === 'SALE') {
        w.soldQ += qty; w.soldAmt += amt; w.sellers[sm] = true;
        var s = smSalesWin[sm] || (smSalesWin[sm] = { qty: 0, amount: 0, items: {} });
        s.qty += qty; s.amount += amt;
        var it = s.items[key] || (s.items[key] = { item_key: key, details: String(row[tc.raw]).trim(), group: String(row[tc.group]).trim(), qty: 0, amount: 0 });
        it.qty += qty; it.amount += amt;
      }
      else if (type === 'PURCHASE_RETURN') w.prQ += qty;
      else if (type === 'SALE_RETURN') { w.srQ += qty; w.soldAmt -= amt;
        var s2 = smSalesWin[sm] || (smSalesWin[sm] = { qty: 0, amount: 0, items: {} });
        s2.qty -= qty; s2.amount -= amt;
        var it2 = s2.items[key] || (s2.items[key] = { item_key: key, details: String(row[tc.raw]).trim(), group: String(row[tc.group]).trim(), qty: 0, amount: 0 });
        it2.qty -= qty; it2.amount -= amt;
      }
    }
  }

  /* ---- 3. per-item output ---- */
  var items = [];
  var groupDead = {};
  var totalStockValue = 0;
  var byNameGroups = {};   // norm(details) -> {group:true}
  var summary = { deadCount: 0, negativeCount: 0, staleCount: 0, slowCount: 0,
                  sellingCount: 0, clearedCount: 0, deadValue: 0, negativeValue: 0 };

  Object.keys(itemsMap).forEach(function (key) {
    var rec = itemsMap[key];
    var w = win[key] || null;

    var netPurchLife = rec.purchased - rec.pur_return;
    var netSoldLife  = rec.sold - rec.sale_return;
    var sellThrough  = netPurchLife > 0 ? (netSoldLife / netPurchLife * 100) : (netSoldLife > 0 ? 100 : 0);

    var lastPur  = rec.last_purchase_date || null;
    var lastSale = rec.last_sale_date || null;
    var daysSincePur  = lastPur  ? Math.floor((today - dateFromIso_(lastPur)) / 86400000)  : null;
    var daysSinceSale = lastSale ? Math.floor((today - dateFromIso_(lastSale)) / 86400000) : null;

    var cur = rec.current_stock;
    var price = rec.price;
    var movedInWindow = !!(w && w.moved);

    var status;
    if (cur < 0) {
      status = 'NEGATIVE';
    } else if (cur === 0) {
      status = 'CLEARED';
    } else if (daysSincePur != null && daysSincePur >= settings.aging_window_days &&
               sellThrough < settings.sell_through_threshold_pct && netPurchLife >= settings.dead_stock_min_qty) {
      status = 'DEAD';
    } else if (!movedInWindow) {
      status = 'STALE';
    } else if (netSoldLife <= 0) {
      // In stock, purchased recently (so it counts as "moved"), but not a single piece has ever
      // sold — that is NOT "selling". Without this check it fell through to the SELLING default.
      status = 'STALE';
    } else if (sellThrough < settings.sell_through_threshold_pct && netPurchLife >= settings.dead_stock_min_qty) {
      status = 'SLOW';
    } else {
      status = 'SELLING';
    }

    var stuck = round2_(cur * price);

    items.push({
      item_key: key, details: rec.details, group: rec.group,
      current_stock: round2_(cur),
      net_purchased: round2_(netPurchLife), net_sold: round2_(netSoldLife),
      purchased: round2_(rec.purchased), sold: round2_(rec.sold),
      pur_return: round2_(rec.pur_return), sale_return: round2_(rec.sale_return),
      sell_through_pct: round2_(sellThrough),
      days_since_purchase: daysSincePur, days_since_sale: daysSinceSale,
      last_purchase_date: lastPur || '', last_sale_date: lastSale || '',
      price: round2_(price), stuck_value: stuck, status: status,
      purchased_in_window: round2_(w ? (w.purQ - w.prQ) : 0),
      purchased_in_window_amount: round2_(w ? w.purAmt : 0),
      sold_in_window: round2_(w ? (w.soldQ - w.srQ) : 0),
      sold_in_window_amount: round2_(w ? w.soldAmt : 0),
      buyers: w ? Object.keys(w.buyers) : [],
      sellers: w ? Object.keys(w.sellers) : []
    });

    summary[status.toLowerCase() + 'Count'] = (summary[status.toLowerCase() + 'Count'] || 0) + 1;
    if (status === 'DEAD') { summary.deadValue += stuck; groupDead[rec.group] = (groupDead[rec.group] || 0) + stuck; }
    if (status === 'NEGATIVE') summary.negativeValue += stuck;
    if (cur > 0) totalStockValue += stuck;

    var nm = norm_(rec.details);
    (byNameGroups[nm] || (byNameGroups[nm] = {}))[norm_(rec.group)] = true;
  });

  items.sort(function (x, y) {
    var dx = x.status === 'DEAD' ? 1 : 0, dy = y.status === 'DEAD' ? 1 : 0;
    if (dx !== dy) return dy - dx;
    return y.stuck_value - x.stuck_value;
  });

  /* ---- 4. Salesman · Sales (windowed) ---- */
  var itemStatusByKey = {};
  items.forEach(function (it) { itemStatusByKey[it.item_key] = it; });

  var salesmanSales = Object.keys(smSalesWin).map(function (sm) {
    var s = smSalesWin[sm];
    var list = Object.keys(s.items).map(function (k) {
      return { item_key: k, details: s.items[k].details, group: s.items[k].group,
               qty: round2_(s.items[k].qty), amount: round2_(s.items[k].amount) };
    }).sort(function (a, b) { return b.amount - a.amount; });
    return { salesman: sm, total_qty: round2_(s.qty), total_amount: round2_(s.amount),
             item_count: list.length, top_items: list.slice(0, 10), items: list };
  }).sort(function (a, b) { return b.total_amount - a.total_amount; });

  /* ---- 5. Salesman · Purchases (all-time, from SalesmanBuys) ---- */
  var smTotals = {};
  readObjects_(TABS.SALESMEN, {
    salesman: ['salesman'], bought_qty: ['bought_qty'], bought_amount: ['bought_amount']
  }).forEach(function (o) {
    smTotals[String(o.salesman).trim()] = { qty: parseNum_(o.bought_qty), amount: parseNum_(o.bought_amount) };
  });

  var buysBySm = {};
  readObjects_(TABS.SALESMAN_BUYS, {
    salesman: ['salesman'], item_key: ['item_key'], details: ['details'], group: ['group'],
    qty: ['qty'], amount: ['amount']
  }).forEach(function (o) {
    var sm = String(o.salesman).trim(); if (!sm) return;
    var key = String(o.item_key).trim();
    var it = itemStatusByKey[key] || {};
    (buysBySm[sm] || (buysBySm[sm] = [])).push({
      item_key: key,
      details: String(o.details || '').trim() || (it.details || key.split(KEY_SEP)[0]),
      group: String(o.group || '').trim() || (it.group || ''),
      qty: round2_(parseNum_(o.qty)), amount: round2_(parseNum_(o.amount)),
      status: it.status || 'UNKNOWN',
      days_since_purchase: it.days_since_purchase != null ? it.days_since_purchase : null,
      current_stock: it.current_stock != null ? it.current_stock : null,
      stuck_value: it.stuck_value != null ? it.stuck_value : null
    });
  });

  var salesmanPurchases = Object.keys(buysBySm).map(function (sm) {
    var list = buysBySm[sm].sort(function (a, b) { return (b.stuck_value || 0) - (a.stuck_value || 0); });
    var deadList = list.filter(function (x) { return x.status === 'DEAD' || x.status === 'STALE'; });
    var tot = smTotals[sm] || { qty: 0, amount: 0 };
    return {
      salesman: sm, total_qty: round2_(tot.qty), total_amount: round2_(tot.amount),
      item_count: list.length, dead_count: deadList.length,
      dead_value: round2_(deadList.reduce(function (s, x) { return s + (x.stuck_value || 0); }, 0)),
      items: list, dead_items: deadList
    };
  }).sort(function (a, b) { return b.dead_value - a.dead_value; });

  /* ---- 6. Unmatched: stored cleaning errors + derived integrity checks ---- */
  var unmatched = readObjects_(TABS.UNMATCHED, {
    type: ['type'], item_key: ['item_key'], details: ['details'], detail: ['detail']
  }).map(function (o) {
    return { type: String(o.type).trim(), item_key: String(o.item_key).trim(),
             details: String(o.details).trim(), detail: String(o.detail).trim() };
  });
  Object.keys(byNameGroups).forEach(function (nm) {
    var groups = Object.keys(byNameGroups[nm]).filter(function (g) { return g !== ''; });
    if (groups.length > 1) unmatched.push({ type: 'GROUP_MISMATCH', item_key: nm, details: nm,
      detail: 'Same item name under ' + groups.length + ' groups: ' + groups.join('  |  ') });
  });

  var groupDeadValue = Object.keys(groupDead).map(function (g) {
    return { group: g || '(no group)', dead_value: round2_(groupDead[g]) };
  }).sort(function (a, b) { return b.dead_value - a.dead_value; });

  var soldInWindow = 0;
  Object.keys(smSalesWin).forEach(function (sm) { soldInWindow += smSalesWin[sm].amount; });

  summary.deadValue = round2_(summary.deadValue);
  summary.negativeValue = round2_(summary.negativeValue);
  summary.totalStockValue = round2_(totalStockValue);
  summary.soldInWindow = round2_(soldInWindow);
  summary.windowDays = windowDays;
  summary.retentionDays = retention;

  return {
    items: items, salesmanSales: salesmanSales, salesmanPurchases: salesmanPurchases,
    unmatched: unmatched, groupDeadValue: groupDeadValue,
    summary: summary, settings: settings, windowDays: windowDays
  };
}


/* =============================== DASHBOARD API ================================== */

function getDashboardData(windowDays, token) {
  var auth = checkAuth_(token, ['admin', 'staff'], 'view_dashboard');
  if (auth._err) return auth._err;

  var settings = readSettings_();
  var w = Number(windowDays) || settings.aging_window_days;
  var res = computeDashboard_(w, settings);

  var itemsTotal = res.items.length;
  var itemsOut = (itemsTotal > MAX_ITEMS_TO_UI ? res.items.slice(0, MAX_ITEMS_TO_UI) : res.items)
    .map(function (it) {
      return {
        item_key: it.item_key, details: it.details, group: it.group, status: it.status,
        current_stock: it.current_stock, net_purchased: it.net_purchased,
        net_sold: it.net_sold, sell_through_pct: it.sell_through_pct,
        days_since_purchase: it.days_since_purchase, days_since_sale: it.days_since_sale,
        price: it.price, stuck_value: it.stuck_value,
        last_purchase_date: it.last_purchase_date, last_sale_date: it.last_sale_date,
        purchased_in_window: it.purchased_in_window, purchased_in_window_amount: it.purchased_in_window_amount,
        sold_in_window: it.sold_in_window, sold_in_window_amount: it.sold_in_window_amount,
        buyers: it.buyers, sellers: it.sellers
      };
    });

  return {
    ok: true,
    user: { username: auth.user.username, role: auth.user.role, display_name: auth.user.display_name },
    windowDays: res.windowDays,
    settings: settings,
    summary: res.summary,
    groupDeadValue: res.groupDeadValue,
    unmatched: res.unmatched.slice(0, 2000),
    unmatchedTotal: res.unmatched.length,
    items: itemsOut,
    itemsTotal: itemsTotal,
    itemsTruncated: itemsTotal > MAX_ITEMS_TO_UI,
    salesmanSales: res.salesmanSales.map(function (s) {
      return { salesman: s.salesman, total_qty: s.total_qty, total_amount: s.total_amount,
               item_count: s.item_count, top_items: s.top_items };
    }),
    salesmanPurchases: res.salesmanPurchases.map(function (p) {
      return { salesman: p.salesman, total_qty: p.total_qty, total_amount: p.total_amount,
               item_count: p.item_count, dead_count: p.dead_count, dead_value: p.dead_value,
               dead_items: p.dead_items.slice(0, 40), items: p.items.slice(0, 15) };
    }),
    generatedAt: new Date().toLocaleString()
  };
}

/**
 * Full drill-down for one item: lifetime summary (kitna aaya / kitna bika / kitna bacha) +
 * every recent transaction (from Txn — retention window only) so the user can see WHEN it moved.
 * Admin + staff.
 */
function getItemHistory(itemKey, token) {
  var auth = checkAuth_(token, ['admin', 'staff']);
  if (auth._err) return auth._err;

  var key = String(itemKey || '').trim();
  if (!key) return { ok: false, message: 'No item specified.' };

  var settings = readSettings_();
  var items = readItemsMap_();
  var rec = items[key];
  if (!rec) return { ok: false, message: 'Item not found (it may have been reset).' };

  var today = todayMidnight_();
  var daysSincePur  = rec.last_purchase_date ? Math.floor((today - dateFromIso_(rec.last_purchase_date)) / 86400000) : null;
  var daysSinceSale = rec.last_sale_date     ? Math.floor((today - dateFromIso_(rec.last_sale_date)) / 86400000)     : null;

  var txns = [];
  var purchasedInTxn = 0;
  var txnSh = SpreadsheetApp.getActive().getSheetByName(TABS.TXN);
  if (txnSh && txnSh.getLastRow() > 1) {
    var tv = txnSh.getDataRange().getValues();
    var TH = buildHeaderMap_(tv[0]);
    var tc = { type: col_(TH, ['txn_type']), date: col_(TH, ['date']), vch: col_(TH, ['vch_no']),
               party: col_(TH, ['party']), sm: col_(TH, ['salesman']), key: col_(TH, ['item_key']),
               qty: col_(TH, ['qty']), unit: col_(TH, ['unit']), price: col_(TH, ['price']), amount: col_(TH, ['amount']) };
    for (var i = 1; i < tv.length; i++) {
      var row = tv[i];
      if (String(row[tc.key]).trim() !== key) continue;
      var type = String(row[tc.type]).trim().toUpperCase();
      var qty = parseNum_(row[tc.qty]);
      if (type === 'PURCHASE') purchasedInTxn += qty;
      txns.push({
        type: type, date: asIsoMaybe_(row[tc.date]), vch_no: String(row[tc.vch]).trim(),
        party: String(row[tc.party]).trim(), salesman: String(row[tc.sm]).trim(),
        qty: round2_(qty), unit: String(row[tc.unit]).trim(),
        price: round2_(parseNum_(row[tc.price])), amount: round2_(parseNum_(row[tc.amount]))
      });
    }
  }
  txns.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (a.vch_no < b.vch_no ? 1 : -1); });

  return {
    ok: true,
    item: {
      item_key: key, details: rec.details, group: rec.group,
      opening_stock: round2_(rec.opening_stock),
      purchased: round2_(rec.purchased), sold: round2_(rec.sold),
      pur_return: round2_(rec.pur_return), sale_return: round2_(rec.sale_return),
      net_purchased: round2_(rec.purchased - rec.pur_return), net_sold: round2_(rec.sold - rec.sale_return),
      current_stock: round2_(rec.current_stock), price: round2_(rec.price),
      stuck_value: round2_(rec.current_stock * rec.price),
      last_purchase_date: rec.last_purchase_date || '', last_sale_date: rec.last_sale_date || '',
      days_since_purchase: daysSincePur, days_since_sale: daysSinceSale
    },
    txns: txns.slice(0, 500),
    txnTotal: txns.length,
    olderHistoryExists: (rec.purchased - purchasedInTxn) > 0.01,
    retentionDays: settings.txn_retention_days
  };
}

/**
 * Full purchase/sale report — one row per item, wide format (supplier, entry counts, first/last
 * dates, avg rate, pending balance). Admin only. Separate call from getDashboardData so the
 * normal dashboard payload stays lean; this is loaded on demand when the Report view is opened.
 */
function getItemReport(token) {
  var auth = checkAuth_(token, ['admin', 'staff'], 'view_report');
  if (auth._err) return auth._err;

  var settings = readSettings_();
  var items = readItemsMap_();
  var today = todayMidnight_();

  // All-time (salesman × item) buyers, so the report can filter/aggregate "salesman-wise".
  var salesmenByItem = {};
  readObjects_(TABS.SALESMAN_BUYS, { salesman: ['salesman'], item_key: ['item_key'] }).forEach(function (o) {
    var key = String(o.item_key).trim(), sm = String(o.salesman).trim();
    if (!key || !sm) return;
    (salesmenByItem[key] || (salesmenByItem[key] = {}))[sm] = true;
  });

  var rows = Object.keys(items).map(function (key) {
    var rec = items[key];
    var daysSincePurchase = rec.last_purchase_date ? Math.floor((today - dateFromIso_(rec.last_purchase_date)) / 86400000) : null;
    var daysSinceSale     = rec.last_sale_date     ? Math.floor((today - dateFromIso_(rec.last_sale_date)) / 86400000)     : null;
    var netPurch = rec.purchased - rec.pur_return;
    var netSold  = rec.sold - rec.sale_return;
    var sellThrough = netPurch > 0 ? (netSold / netPurch * 100) : (netSold > 0 ? 100 : 0);
    var cur = rec.current_stock;

    // Simplified status (no Txn window scan here — "recent movement" is approximated from the
    // item's own last purchase/sale dates against the aging window). Same colour meaning as
    // elsewhere in the app: DEAD > STALE > SLOW > CLEARED > SELLING, NEGATIVE overrides all.
    var status;
    var movedRecently = (daysSincePurchase != null && daysSincePurchase <= settings.aging_window_days) ||
                        (daysSinceSale != null && daysSinceSale <= settings.aging_window_days);
    if (cur < 0) {
      status = 'NEGATIVE';
    } else if (cur === 0) {
      status = 'CLEARED';
    } else if (daysSincePurchase != null && daysSincePurchase >= settings.aging_window_days &&
               sellThrough < settings.sell_through_threshold_pct && netPurch >= settings.dead_stock_min_qty) {
      status = 'DEAD';
    } else if (!movedRecently) {
      status = 'STALE';
    } else if (netSold <= 0) {
      // Purchased recently (so it counts as "moved"), but not a single piece has ever sold —
      // that is NOT "selling". Without this it fell through to the SELLING default.
      status = 'STALE';
    } else if (sellThrough < settings.sell_through_threshold_pct && netPurch >= settings.dead_stock_min_qty) {
      status = 'SLOW';
    } else {
      status = 'SELLING';
    }

    return {
      item_key: key, group: rec.group, details: rec.details,
      suppliers: rec.suppliers || '',
      salesmen: Object.keys(salesmenByItem[key] || {}).sort(),
      purchase_qty: round2_(rec.purchased),
      purchase_entries: rec.purchase_entries || 0,
      first_purchase_date: rec.first_purchase_date || '',
      last_purchase_date: rec.last_purchase_date || '',
      purchase_return_qty: round2_(rec.pur_return),
      net_purchase_qty: round2_(netPurch),
      sale_qty: round2_(rec.sold),
      sale_rate_avg: rec.sold > 0 ? round2_(rec.sale_amount / rec.sold) : 0,
      sale_entries: rec.sale_entries || 0,
      first_sale_date: rec.first_sale_date || '',
      last_sale_date: rec.last_sale_date || '',
      pending_balance: round2_(cur),
      price: round2_(rec.price),
      pending_value: round2_(cur * rec.price),
      days_since_purchase: daysSincePurchase,
      days_since_sale: daysSinceSale,
      status: status
    };
  });

  // Most-recently-active items first; if truncated for payload size, these are the useful ones.
  rows.sort(function (a, b) {
    var da = a.last_purchase_date || '0000-00-00', db = b.last_purchase_date || '0000-00-00';
    return da < db ? 1 : da > db ? -1 : 0;
  });

  var total = rows.length;
  var truncated = total > MAX_ITEMS_TO_UI;
  if (truncated) rows = rows.slice(0, MAX_ITEMS_TO_UI);

  return {
    ok: true, rows: rows, total: total, truncated: truncated,
    settings: { aging_window_days: settings.aging_window_days, dead_stock_min_qty: settings.dead_stock_min_qty,
                sell_through_threshold_pct: settings.sell_through_threshold_pct }
  };
}

/** Recent imports for the Import Data view (last 15). Admin + staff. */
function getImportHistory(token) {
  var auth = checkAuth_(token, ['admin', 'staff'], 'import_data');
  if (auth._err) return auth._err;
  var rows = readObjects_(TABS.IMPORTS, {
    id: ['import_id'], type: ['txn_type'], from: ['date_from'], to: ['date_to'],
    rows: ['rows'], by: ['imported_by'], at: ['imported_at'], note: ['note']
  });
  return {
    ok: true,
    imports: rows.slice(-15).reverse().map(function (o) {
      return { id: String(o.id), type: String(o.type), from: String(o.from), to: String(o.to),
               rows: parseNum_(o.rows), by: String(o.by), at: String(o.at), note: String(o.note || '') };
    })
  };
}


/* =============================== LOGIN + ROLES ================================== */

function sha256_(s) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return raw.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

/** Turn a stored `permissions` cell into an array, falling back to DEFAULT_STAFF_PERMS for a
    blank cell (accounts created before permissions existed keep their current access). Admins
    don't use this at all — role === 'admin' always has full access regardless of this list. */
function readUserPerms_(role, rawCell) {
  var raw = String(rawCell || '').trim();
  if (raw) return raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  return String(role).toLowerCase() === 'staff' ? DEFAULT_STAFF_PERMS.slice() : [];
}

/**
 * Create/update a user (sets salt+hash, upserts by username). Trailing underscore = NOT
 * reachable via google.script.run from the browser — only from the Apps Script editor's Run
 * button, or from another server-side function like createUserFromApp / createDefaultUsers.
 * From the editor:  addUser_('owner', 'MyPass123', 'admin', 'Owner')
 * `permissionsCsv` is only meaningful for role='staff' — pass '' to leave/reset to defaults.
 */
function addUser_(username, password, role, displayName, permissionsCsv) {
  setupSheets_();
  var sh = SpreadsheetApp.getActive().getSheetByName(TABS.USERS);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, USER_HEADERS.length).setValues([USER_HEADERS]).setFontWeight('bold');
  }
  var uname = String(username || '').trim();
  if (!uname || !password) throw new Error('addUser_(username, password, role, displayName) — username and password required');
  var r = (String(role || 'staff').toLowerCase() === 'admin') ? 'admin' : 'staff';
  var salt = Utilities.getUuid();
  var hash = sha256_(salt + '::' + String(password));
  var name = displayName || uname;
  var perms = String(permissionsCsv || '').trim();

  var vals = sh.getDataRange().getValues();
  var uCol = col_(buildHeaderMap_(vals[0]), ['username']);
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][uCol]).trim().toLowerCase() === uname.toLowerCase()) {
      sh.getRange(i + 1, 1, 1, USER_HEADERS.length).setValues([[uname, salt, hash, r, name, true, '', '', perms]]);
      return 'Updated user "' + uname + '" (' + r + ')';
    }
  }
  sh.appendRow([uname, salt, hash, r, name, true, '', '', perms]);
  return 'Added user "' + uname + '" (' + r + ')';
}

/**
 * ONE-CLICK SETUP — hit ▶ Run from the editor.
 *   Admin -> owner / paris@2026     Staff -> staff1 / staff@2026
 * CHANGE THESE PASSWORDS after first login.
 */
function createDefaultUsers() {
  var msg = [];
  msg.push(addUser_('owner',  'paris@2026', 'admin', 'Owner', ''));
  msg.push(addUser_('staff1', 'staff@2026', 'staff', 'Team', DEFAULT_STAFF_PERMS.join(',')));
  Logger.log(msg.join('\n'));
  return msg.join('\n');
}

function login(username, password) {
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(TABS.USERS);
    if (!sh || sh.getLastRow() < 2) return { ok: false, message: 'No users configured yet. The owner must run createDefaultUsers() from the script editor.' };

    var vals = sh.getDataRange().getValues();
    var H = buildHeaderMap_(vals[0]);
    var ci = { u: col_(H, ['username']), salt: col_(H, ['salt']), hash: col_(H, ['password_hash']),
               role: col_(H, ['role']), name: col_(H, ['display_name']), active: col_(H, ['active']),
               tok: col_(H, ['token']), exp: col_(H, ['token_expires']), perms: col_(H, ['permissions']) };
    var uname = String(username || '').trim().toLowerCase();

    for (var i = 1; i < vals.length; i++) {
      if (String(vals[i][ci.u]).trim().toLowerCase() !== uname) continue;
      if (String(vals[i][ci.active]).toLowerCase() === 'false') return { ok: false, message: 'That account is disabled.' };

      var got = sha256_(String(vals[i][ci.salt]) + '::' + String(password));
      if (got !== String(vals[i][ci.hash])) return { ok: false };

      var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
      sh.getRange(i + 1, ci.tok + 1).setValue(token);
      sh.getRange(i + 1, ci.exp + 1).setValue(new Date(Date.now() + TOKEN_TTL_MS));
      var role = String(vals[i][ci.role] || 'staff').toLowerCase();
      return { ok: true, token: token,
               role: role,
               display_name: String(vals[i][ci.name] || vals[i][ci.u]),
               username: String(vals[i][ci.u]),
               permissions: readUserPerms_(role, ci.perms === -1 ? '' : vals[i][ci.perms]) };
    }
    return { ok: false };
  } catch (err) {
    return { ok: false, message: String(err && err.message ? err.message : err) };
  }
}

function logout(token) {
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(TABS.USERS);
    if (!sh || sh.getLastRow() < 2 || !token) return { ok: true };
    var vals = sh.getDataRange().getValues();
    var H = buildHeaderMap_(vals[0]);
    var tCol = col_(H, ['token']), eCol = col_(H, ['token_expires']);
    for (var i = 1; i < vals.length; i++) {
      if (String(vals[i][tCol]) === String(token)) {
        sh.getRange(i + 1, tCol + 1).setValue('');
        sh.getRange(i + 1, eCol + 1).setValue('');
        break;
      }
    }
  } catch (e) { /* ignore */ }
  return { ok: true };
}

function authUser_(token) {
  if (!token) return null;
  var sh = SpreadsheetApp.getActive().getSheetByName(TABS.USERS);
  if (!sh || sh.getLastRow() < 2) return null;
  var vals = sh.getDataRange().getValues();
  var H = buildHeaderMap_(vals[0]);
  var ci = { u: col_(H, ['username']), role: col_(H, ['role']), name: col_(H, ['display_name']),
             active: col_(H, ['active']), tok: col_(H, ['token']), exp: col_(H, ['token_expires']),
             perms: col_(H, ['permissions']) };
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][ci.tok]) !== String(token)) continue;
    if (String(vals[i][ci.active]).toLowerCase() === 'false') return null;
    var exp = vals[i][ci.exp];
    if (exp && new Date(exp).getTime() < Date.now()) return null;
    var role = String(vals[i][ci.role] || 'staff').toLowerCase();
    return { username: String(vals[i][ci.u]),
             role: role,
             display_name: String(vals[i][ci.name] || vals[i][ci.u]),
             permissions: readUserPerms_(role, ci.perms === -1 ? '' : vals[i][ci.perms]) };
  }
  return null;
}

/**
 * @param {string}   token
 * @param {string[]} [allowedRoles]  e.g. ['admin','staff'] — reject anyone else outright.
 * @param {string}   [requiredPerm]  e.g. 'view_report' — admin always passes; a staff user must
 *                                   have this key in their `permissions` list.
 */
function checkAuth_(token, allowedRoles, requiredPerm) {
  var u = authUser_(token);
  if (!u) return { _err: { ok: false, authError: true, message: 'Please sign in again.' } };
  if (allowedRoles && allowedRoles.indexOf(u.role) < 0) {
    return { _err: { ok: false, forbidden: true, message: 'Your role (' + u.role + ') is not allowed to do this.' } };
  }
  if (requiredPerm && u.role !== 'admin' && u.permissions.indexOf(requiredPerm) < 0) {
    return { _err: { ok: false, forbidden: true,
      message: 'You do not have permission to do this. Ask an admin to grant "' + requiredPerm + '" in Users.' } };
  }
  return { user: u };
}


/* =============================== USER MANAGEMENT API (admin only) ============================
   Lets an admin create logins / change roles / activate-deactivate / reset passwords from the
   web app itself — no more needing the Apps Script editor for anything but the very first
   createDefaultUsers() run. Always keeps at least one active admin account (can't lock yourself
   out of the app). */

function countActiveAdmins_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(TABS.USERS);
  if (!sh || sh.getLastRow() < 2) return 0;
  var vals = sh.getDataRange().getValues();
  var H = buildHeaderMap_(vals[0]);
  var ci = { role: col_(H, ['role']), active: col_(H, ['active']) };
  var n = 0;
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i].join('')).trim() === '') continue;
    if (String(vals[i][ci.role] || '').toLowerCase() === 'admin' && String(vals[i][ci.active]).toLowerCase() !== 'false') n++;
  }
  return n;
}

/** List every user (never returns salt / password_hash / token). Admin only. */
function listUsers(token) {
  var auth = checkAuth_(token, ['admin']);
  if (auth._err) return auth._err;
  var sh = SpreadsheetApp.getActive().getSheetByName(TABS.USERS);
  if (!sh || sh.getLastRow() < 2) return { ok: true, users: [], you: auth.user.username, availablePermissions: PERMISSION_DEFS };
  var vals = sh.getDataRange().getValues();
  var H = buildHeaderMap_(vals[0]);
  var ci = { u: col_(H, ['username']), role: col_(H, ['role']), name: col_(H, ['display_name']),
             active: col_(H, ['active']), perms: col_(H, ['permissions']) };
  var users = [];
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i].join('')).trim() === '') continue;
    var role = String(vals[i][ci.role] || 'staff').toLowerCase();
    users.push({
      username: String(vals[i][ci.u]).trim(),
      role: role,
      display_name: String(vals[i][ci.name] || ''),
      active: String(vals[i][ci.active]).toLowerCase() !== 'false',
      permissions: readUserPerms_(role, ci.perms === -1 ? '' : vals[i][ci.perms])
    });
  }
  users.sort(function (a, b) { return a.username < b.username ? -1 : (a.username > b.username ? 1 : 0); });
  return { ok: true, users: users, you: auth.user.username, availablePermissions: PERMISSION_DEFS };
}

/** Create a new login, or update an existing one's password/role/display name/permissions. Admin only. */
function createUserFromApp(username, password, role, displayName, permissions, token) {
  var auth = checkAuth_(token, ['admin']);
  if (auth._err) return auth._err;
  var uname = String(username || '').trim();
  if (!uname) return { ok: false, message: 'Username is required.' };
  if (!/^[a-zA-Z0-9_.@-]+$/.test(uname)) return { ok: false, message: 'Username can only use letters, numbers and _ . @ -' };
  if (!password || String(password).length < 4) return { ok: false, message: 'Password must be at least 4 characters.' };
  var r = (String(role || 'staff').toLowerCase() === 'admin') ? 'admin' : 'staff';
  var permsCsv = Array.isArray(permissions) ? permissions.join(',') : '';

  var sh = SpreadsheetApp.getActive().getSheetByName(TABS.USERS);
  var existed = false;
  setupSheets_();
  if (sh && sh.getLastRow() > 1) {
    var vals = sh.getDataRange().getValues();
    var uCol = col_(buildHeaderMap_(vals[0]), ['username']);
    for (var i = 1; i < vals.length; i++) {
      if (String(vals[i][uCol]).trim().toLowerCase() === uname.toLowerCase()) { existed = true; break; }
    }
  }
  addUser_(uname, password, r, displayName, permsCsv);
  return { ok: true, username: uname, updated: existed };
}

/** Change a staff user's granted permissions (view/import/cancel-bills etc). Admin only — never
    touches role, so it can't be used to self-escalate. Admin accounts ignore this entirely. */
function setUserPermissions(username, permissions, token) {
  var auth = checkAuth_(token, ['admin']);
  if (auth._err) return auth._err;
  var uname = String(username || '').trim();
  var permsCsv = (Array.isArray(permissions) ? permissions : String(permissions || '').split(','))
    .map(function (s) { return String(s).trim(); }).filter(Boolean).join(',');

  var sh = SpreadsheetApp.getActive().getSheetByName(TABS.USERS);
  if (!sh || sh.getLastRow() < 2) return { ok: false, message: 'No users.' };
  var vals = sh.getDataRange().getValues();
  var H = buildHeaderMap_(vals[0]);
  var ci = { u: col_(H, ['username']), perms: col_(H, ['permissions']) };
  if (ci.perms === -1) {
    migrateUsersPermissionsColumn_();
    return setUserPermissions(username, permissions, token); // retry once, column now exists
  }
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][ci.u]).trim().toLowerCase() !== uname.toLowerCase()) continue;
    sh.getRange(i + 1, ci.perms + 1).setValue(permsCsv);
    return { ok: true, username: uname, permissions: permsCsv ? permsCsv.split(',') : [] };
  }
  return { ok: false, message: 'User not found.' };
}

/** Change an existing user's role. Refuses to demote the last active admin. Admin only. */
function setUserRole(username, role, token) {
  var auth = checkAuth_(token, ['admin']);
  if (auth._err) return auth._err;
  var uname = String(username || '').trim();
  var r = (String(role || 'staff').toLowerCase() === 'admin') ? 'admin' : 'staff';

  var sh = SpreadsheetApp.getActive().getSheetByName(TABS.USERS);
  if (!sh || sh.getLastRow() < 2) return { ok: false, message: 'No users.' };
  var vals = sh.getDataRange().getValues();
  var H = buildHeaderMap_(vals[0]);
  var ci = { u: col_(H, ['username']), role: col_(H, ['role']), active: col_(H, ['active']) };
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][ci.u]).trim().toLowerCase() !== uname.toLowerCase()) continue;
    var curRole = String(vals[i][ci.role] || '').toLowerCase();
    var isActive = String(vals[i][ci.active]).toLowerCase() !== 'false';
    if (curRole === 'admin' && r !== 'admin' && isActive && countActiveAdmins_() <= 1) {
      return { ok: false, message: 'Cannot demote the last active admin — make someone else admin first.' };
    }
    sh.getRange(i + 1, ci.role + 1).setValue(r);
    return { ok: true, username: uname, role: r };
  }
  return { ok: false, message: 'User not found.' };
}

/** Activate/deactivate a login. Refuses to lock out your own account or the last active admin. */
function setUserActive(username, active, token) {
  var auth = checkAuth_(token, ['admin']);
  if (auth._err) return auth._err;
  var uname = String(username || '').trim();
  var wantActive = !!active;
  if (!wantActive && uname.toLowerCase() === String(auth.user.username).toLowerCase()) {
    return { ok: false, message: 'You cannot deactivate your own account while signed in as it.' };
  }

  var sh = SpreadsheetApp.getActive().getSheetByName(TABS.USERS);
  if (!sh || sh.getLastRow() < 2) return { ok: false, message: 'No users.' };
  var vals = sh.getDataRange().getValues();
  var H = buildHeaderMap_(vals[0]);
  var ci = { u: col_(H, ['username']), role: col_(H, ['role']), active: col_(H, ['active']),
             tok: col_(H, ['token']), exp: col_(H, ['token_expires']) };
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][ci.u]).trim().toLowerCase() !== uname.toLowerCase()) continue;
    var curRole = String(vals[i][ci.role] || '').toLowerCase();
    var wasActive = String(vals[i][ci.active]).toLowerCase() !== 'false';
    if (!wantActive && curRole === 'admin' && wasActive && countActiveAdmins_() <= 1) {
      return { ok: false, message: 'Cannot deactivate the last active admin.' };
    }
    sh.getRange(i + 1, ci.active + 1).setValue(wantActive);
    if (!wantActive) { sh.getRange(i + 1, ci.tok + 1).setValue(''); sh.getRange(i + 1, ci.exp + 1).setValue(''); }
    return { ok: true, username: uname, active: wantActive };
  }
  return { ok: false, message: 'User not found.' };
}

/** Reset a user's password (new salt+hash) and force their existing session to re-login. Admin only. */
function adminResetPassword(username, newPassword, token) {
  var auth = checkAuth_(token, ['admin']);
  if (auth._err) return auth._err;
  var uname = String(username || '').trim();
  if (!newPassword || String(newPassword).length < 4) return { ok: false, message: 'Password must be at least 4 characters.' };

  var sh = SpreadsheetApp.getActive().getSheetByName(TABS.USERS);
  if (!sh || sh.getLastRow() < 2) return { ok: false, message: 'No users.' };
  var vals = sh.getDataRange().getValues();
  var H = buildHeaderMap_(vals[0]);
  var ci = { u: col_(H, ['username']), salt: col_(H, ['salt']), hash: col_(H, ['password_hash']),
             tok: col_(H, ['token']), exp: col_(H, ['token_expires']) };
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][ci.u]).trim().toLowerCase() !== uname.toLowerCase()) continue;
    var salt = Utilities.getUuid();
    var hash = sha256_(salt + '::' + String(newPassword));
    sh.getRange(i + 1, ci.salt + 1).setValue(salt);
    sh.getRange(i + 1, ci.hash + 1).setValue(hash);
    sh.getRange(i + 1, ci.tok + 1).setValue('');
    sh.getRange(i + 1, ci.exp + 1).setValue('');
    return { ok: true, username: uname };
  }
  return { ok: false, message: 'User not found.' };
}


/* =============================== SETTINGS API (admin only) ===================== */

function getAppSettings(token) {
  var auth = checkAuth_(token, ['admin']);
  if (auth._err) return auth._err;
  var s = readSettings_();
  return {
    ok: true,
    aging_window_days: s.aging_window_days,
    dead_stock_min_qty: s.dead_stock_min_qty,
    sell_through_threshold_pct: s.sell_through_threshold_pct,
    txn_retention_days: s.txn_retention_days,
    opening_stock_as_of: getOpeningAsOf_()
  };
}

function saveSettings(patch, token) {
  var auth = checkAuth_(token, ['admin']);
  if (auth._err) return auth._err;
  setupSheets_();

  var allowed = ['aging_window_days', 'dead_stock_min_qty', 'sell_through_threshold_pct'];
  var sh = SpreadsheetApp.getActive().getSheetByName(TABS.SETTINGS);
  var vals = sh.getDataRange().getValues();
  var rowOf = {};
  vals.forEach(function (r, idx) { if (r[0] !== '') rowOf[String(r[0]).trim().toLowerCase()] = idx + 1; });

  allowed.forEach(function (k) {
    if (!patch || patch[k] == null || patch[k] === '') return;
    var n = parseNum_(patch[k]);
    if (rowOf[k]) sh.getRange(rowOf[k], 2).setValue(n);
    else sh.appendRow([k, n]);
  });

  // Thresholds take effect on the next dashboard load (computed live). No rebuild needed.
  return { ok: true };
}
