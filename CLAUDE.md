# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **Google Apps Script web app** bound to a Google Sheet. It tracks **dead stock** for Paris Fashion (garment wholesaler, Delhi): the user pastes Busy-software exports (Stock once as opening balance, then Purchase / Sales / Purchase Return / Sales Return each week), and the app maintains an **incremental item ledger** — current stock, dead-stock aging, and per-salesperson accountability for selling **and** buying.

Two files only, no build system:
- `Code.gs` — entire backend. Sheet tabs are the database.
- `Index.html` — entire frontend. Single page, served by `doGet()` via `HtmlService`.

## Working on this codebase

There is **no local toolchain, no git, no npm, no test runner**. Development loop:

1. Edit `Code.gs` / `Index.html` here.
2. Paste into the Apps Script editor (Sheet → Extensions → Apps Script), Save.
3. Syntax-check `Code.gs` before handing it over: `cp Code.gs /tmp/c.js && node --check /tmp/c.js` (the `.gs` extension confuses `node --check` directly).
4. Test by running functions from the editor (▶ Run) and by opening the web app.
   - The **`/dev` deployment URL always runs the latest saved code** — no redeploy needed while iterating.
   - The **`/exec` URL** (what staff use) only updates after Deploy → Manage deployments → Edit → **New version**.
5. First-time setup in a fresh Sheet: run `createDefaultUsers()` from the editor (creates `owner`/`staff1` logins), then `menuSetupSheets` / reload the Sheet for the **Paris Tools** menu. Then paste the opening **Stock** export in the web app.

Web app deployment must be **Execute as: me (owner)**, **Access: anyone in the org with link** — non-technical staff import data with no Sheet access; all writes run under the owner's permission via `google.script.run`.

## Architecture — LEAN / INCREMENTAL (v3)

The database is **6 small tabs that never grow unbounded** (plus `Settings`, `Users`). No raw paste tabs, no all-time transaction ledger, no materialised report tabs.

| Tab | One row per… | Written by |
|---|---|---|
| `Items` | item (`ITEM_HEADERS`) — `opening_stock`, lifetime `purchased/sold/pur_return/sale_return`, denormalised `current_stock`, `last_purchase_date`, `last_sale_date`, `price` | `writeItemsMap_` |
| `Txn` | recent transaction (`TXN_HEADERS`, `import_id` prefix) — **only the last `txn_retention_days` (default 100)**; older rows pruned every import | `appendRows_` + `pruneTxn_` |
| `Salesmen` | salesperson — lifetime `sold_qty/amount`, `bought_qty/amount` | `applySalesmenDelta_` |
| `SalesmanBuys` | (salesperson × item) ever purchased — for dead-stock blame beyond the retention window | `applyBuysDelta_` |
| `Imports` | one import — `txn_type`, `date_from/to`, totals. **Duplicate/overlap-paste guard** (`checkOverlap_`) | `appendRows_` |
| `Unmatched` | cleaning error / integrity warning (capped `MAX_UNMATCHED`) | `persistUnmatched_` (stored) + derived in `computeDashboard_` |

**Invariant:** `Items` lifetime totals include **every** transaction ever imported (including those still in `Txn`). `Txn` is a detail cache for window analysis — never re-added. So:
- current stock / lifetime metrics → from `Items`
- windowed metrics (sold in last N days, "moved in window") → from `Txn` (retention ≥ window, so the window is capped at `txn_retention_days`)

`current_stock = opening_stock + purchased − sold − pur_return + sale_return` (`recalcStock_`).

### Pipeline

```
Paste (web app "Import Data")  →  importPastedData(typeLabel, pastedText, force, token)
   │
   ├─ STOCK  →  applyOpeningStock_        first run writes opening_stock+price into Items;
   │                                      later needs force=true (re-baseline), keeps lifetime totals
   │
   └─ PURCHASE / SALE / *_RETURN  →  commitTxnImport_
          cleanGrid_()                    rules A–F on the in-memory grid (no raw tab)
          span = min/max of parsed dates
          checkOverlap_()                 same type + overlapping span already in Imports → reject
          aggregate batch in memory       per item / per salesman / per (salesman×item) deltas
          apply → Items, Salesmen, SalesmanBuys   (each read once, written once)
          appendRows_(Txn) → pruneTxn_    append cleaned rows, delete rows past retention
          appendRows_(Imports)            log the span + totals
          persistUnmatched_()             replace this type's cleaning errors
```

- **`undoLastImport(token)`** (admin) reverses the most recent Purchase/Sales/Return import by reading its rows back out of `Txn` (works only while they're still within retention). No arbitrary undo.
- **Reset:** `menuResetAll` (sheet menu, YES/NO then type-`RESET` prompt) or `resetAllData('RESET', token)` (admin Settings → Danger zone). Wipes the 6 data tabs, **keeps `Users` + `Settings`**. `factoryReset_()` (editor only) also wipes `Users`.

The dashboard (`getDashboardData` → `computeDashboard_`) recomputes live on every load — the lean tabs are small enough. Returns a trimmed, capped payload (see gotchas). **`getDashboardData`'s payload shape is a contract with `Index.html`** — keep it stable.

### The four hard rules (violating these breaks the app)

1. **Never hardcode column indexes.** `buildHeaderMap_()` builds a case-insensitive, whitespace-collapsed `{header → index}` map; `col_(map, [aliases])` resolves the first matching alias. Busy changes column order/names between exports — add aliases. Stock price aliases: `P. Price` / `Purc Price` / `Sale Price` / `Price` / `Rate`.
2. **Batch I/O only.** Read each tab once with `getValues()`, process in memory (plain objects/Maps, O(n)), write once with `setValues()`. No per-row `getRange`/`getValue`. `readObjects_` / `writeGrid_` / `appendRows_` are the helpers. Must stay well under the 6-minute limit.
3. **Heavy work runs on import.** The dashboard reads the lean tabs and computes a single pass.
4. **All writes go through `google.script.run`** (server-side). The frontend never touches Sheets APIs.

### Cleaning rules in `cleanGrid_` (rules A–F, operates on the pasted 2D grid — never a stored tab)

- **A** — skip junk header lines. Real header row = the one containing `Item Details` (`findHeaderRow_`).
- **B** — forward-fill blank voucher cells (`Date`, `Vch/Bill No`, `Particulars`, `Mobile`, `SALESMAN`, `Group`) from the last non-empty value above.
- **C** — **per-file date detection, never blind DD-MM.** `detectDate_` reads the export's `From d-m-yyyy to d-m-yyyy` line for a valid range, tries DD-MM and MM-DD, keeps whichever falls in range. **Sales Return exports default MM-DD; everything else DD-MM** (only used when no range line). Out-of-range → `Unmatched`. `Settings` keys `date_format_raw_*` (AUTO/DD-MM/MM-DD) override.
- **D** — `item_key = norm(item_details) + ' || ' + norm(group)`, `norm` = trim + collapse whitespace + uppercase. **Size is part of Item Details — never strip it** (`10080P L` ≠ `10080P M`). Safety net: `computeDashboard_` flags any name under >1 group as `GROUP_MISMATCH`.
- **E** — negative stock is valid → status `NEGATIVE`, don't crash.
- **F** — `parseNum_` strips commas / ₹, handles `(...)` negatives, keeps sign.

### Status logic (`computeDashboard_`, per item, over `Items`)

`NEGATIVE` (stock<0) → `DEAD` (stock>0, `days_since_purchase ≥ aging_window_days`, **lifetime** sell-through < `sell_through_threshold_pct`, **lifetime** net-purchased ≥ `dead_stock_min_qty`) → `STALE` (stock>0, no `Txn` movement in window) → `SLOW` (lifetime sales but low sell-through, stock>0) → `CLEARED` (stock=0) → `SELLING`. `stuck_value = current_stock × price`; DEAD pinned on top, sorted by stuck_value desc.
*(Changed from v2: DEAD now uses lifetime net-purchased / sell-through, not windowed — old dead stock stays visible as DEAD instead of decaying to STALE.)*

### Auth (`Code.gs` LOGIN + ROLES section) — unchanged from v2

- `Users` tab: `username | salt | password_hash | role | display_name | active | token | token_expires`. SHA-256 + per-user salt. Create users only via `addUser(...)` / `createDefaultUsers()` from the editor.
- Roles: `admin` (everything) and `staff` (Dashboard + Import Data only). `Index.html` `NAV[].roles` drives nav visibility.
- Token in the `Users` row (30-day TTL) + browser `localStorage` (`pf_auth_v1`). Every backend fn calls **`checkAuth_(token, allowedRoles)` first** — role re-read from the sheet, never trusted from the client. Frontend appends the token as the **last argument** via `authed()`.

### Frontend (`Index.html`)

- React 18 + Babel standalone, Chart.js 4.4, SweetAlert2 11, Font Awesome — all `cdnjs`. **No jQuery / DataTables.** Tables = native `NativeTable` (search + sort + pagination in React state).
- `ErrorBoundary` wraps the app and each view — a crash shows a message, never a blank page.
- Views: Dashboard, Item View, Salesperson · Sales (windowed), Salesperson · Purchases (all-time, from `SalesmanBuys`), Unmatched, Import Data (+ recent-imports table + **Undo last import**), Settings (+ **Danger zone → Reset all data**).
- Currency Indian format via `inr()`. Navy theme, CSS variables, mobile-first.

## Gotchas

- **`google.script.run` silently returns `null` for oversized payloads.** `getDashboardData` trims item fields and caps `items` at `MAX_ITEMS_TO_UI` (5000, dead-first). If the dashboard shows "No data yet" with a big `Items` tab, reduce the payload — don't assume the tab is empty.
- **ISO date strings vs Sheets auto-parse.** Dates are stored as `YYYY-MM-DD` text. `writeGrid_` / `appendRows_` force `@` (text) format on any column whose header matches `/date|_at|_seen|expires/`; reads go through `asIsoMaybe_` (tolerates a `Date` a human typed in). If you add a date-bearing column, make sure its header name matches that regex.
- **Overlap guard.** An import of the same `txn_type` whose date span overlaps a logged import is rejected (`checkOverlap_`) — no double counting. To redo a week: `undoLastImport` (if recent) or re-export a clean non-overlapping span. There is **no** "reverse the aggregates" path for old (pruned) imports — that's what RESET is for.
- **Re-baselining opening stock** (`applyOpeningStock_` with `force`): replaces `opening_stock` + `price` for items present in the paste, keeps lifetime totals, recomputes `current_stock` for all. Items absent from the new paste keep their old opening.
- `_`-suffixed functions are private server helpers (not callable from `google.script.run`).
- `Settings` tab is the single source of truth for the numeric thresholds (admin Settings view) + `txn_retention_days` + per-file `date_format_*` (sheet only). Thresholds apply on the next dashboard load — nothing to rebuild.
- Old v2 tabs (`Raw_*`, `Transactions`, `Stock`, `Report`, `SalesmanReport`) are **not** used or touched by v3 — delete them manually or start in a fresh Sheet.
- Out of scope until asked: arbitrary (non-last) import undo, monthly sales buckets / windows longer than retention, holidays, push alerts.
