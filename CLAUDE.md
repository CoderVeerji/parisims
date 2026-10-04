# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **Google Apps Script web app** bound to a Google Sheet. It tracks **dead stock** for Paris Fashion (garment wholesaler, Delhi): the user pastes Busy-software exports (Stock once as opening balance, then Purchase / Sales / Purchase Return / Sales Return each week, plus occasional Stock Journal item-conversion vouchers), and the app maintains an **incremental item ledger** — current stock, dead-stock aging, and per-salesperson accountability for selling **and** buying. Admins can cancel/restore individual bills and manage staff logins with granular per-feature permissions (RBAC), all from the web app itself.

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

### Multi-firm deployment

**One Google Sheet = one fully isolated firm/company.** There is no tenant/company_id column anywhere — `Code.gs` is container-bound and reads/writes `SpreadsheetApp.getActive()` throughout, so a second firm **cannot** reuse this Sheet; it needs its own Sheet + its own Apps Script project + its own deployed web-app URL, set up via the same steps as above (step 5). This is a hard architectural property, not a missing feature.

- **Branding is per-Sheet and admin-editable** — `Settings!company_name` (Settings view → "Company name") drives the login `<h1>`, sidebar brand, footer and browser-tab title (`doGet()` reads it server-side for `.setTitle()`). A fresh copy of this project in a new Sheet needs zero code edits to show a different firm's name — just set it once in Settings.
- **`getPublicBranding()` is intentionally unauthenticated** (no `checkAuth_`) — the login page needs the company name before anyone has a token. It must never return anything beyond `company_name`; don't add sensitive fields to it.
- **"Switch Firm" (admin-only, topbar)** is a bookmark list, not a data switch — `Settings!firm_links_json` ({name,url} pairs the admin pastes in Settings → "Switch Firm"), surfaced via `getAppSettings`. Clicking an entry opens that firm's **separate** deployed URL in a new tab; the admin logs in there with that firm's own, separate `Users` tab. There is no way to show two firms' data in one page load — each deployed `/exec` URL is its own independent app.
- Rolling out a code change (bug fix, new feature) to multiple firms is **manual**: re-paste the updated `Code.gs`/`Index.html` into each firm's Apps Script editor and deploy a new version there. There's no shared library / central deploy across Sheets in this setup.

**Rollout checklist (do this once per firm, every time `Code.gs`/`Index.html` change):**
1. Confirm the change is finished here (GitHub `main` has it, `CLAUDE.md` updated if it touched architecture).
2. Open that firm's Sheet → Extensions → Apps Script.
3. Replace the whole `Code.gs` content, replace the whole `Index.html` content. Save.
4. `createDefaultUsers()` / `menuSetupSheets` are **not** needed again — self-healing (`ensureSettingsSheet_`, `migrateUsersPermissionsColumn_`, etc.) seeds any new tab/column/Settings key automatically on next use.
5. Quick smoke test on that firm's `/dev` URL: log in, open Dashboard, open whatever the change touched.
6. Deploy → Manage deployments → Edit → **New version** (the `/exec` URL staff use only updates here).
7. Repeat 2–6 for every other firm's Sheet.

## Architecture — LEAN / INCREMENTAL (v3)

The database is **7 small tabs that never grow unbounded** (plus `Settings`, `Users`). No raw paste tabs, no all-time transaction ledger, no materialised report tabs.

| Tab | One row per… | Written by |
|---|---|---|
| `Items` | item (`ITEM_HEADERS`) — `opening_stock`, lifetime `purchased/sold/pur_return/sale_return`, denormalised `current_stock`, `last_purchase_date`, `last_sale_date`, `price` | `writeItemsMap_` (bulk) / `writeItemsSubset_` (single bill) |
| `Txn` | recent transaction (`TXN_HEADERS`, `import_id` prefix) — **only the last `txn_retention_days` (default 100)**; older rows pruned every import | `appendRows_` + `pruneTxn_` |
| `Salesmen` | salesperson — lifetime `sold_qty/amount`, `bought_qty/amount` | `applySalesmenDelta_` |
| `SalesmanBuys` | (salesperson × item) ever purchased — for dead-stock blame beyond the retention window | `applyBuysDelta_` |
| `Imports` | one import — `txn_type`, `date_from/to`, totals. **Duplicate/overlap-paste guard** (`checkOverlap_`). A Stock Journal paste logs **two** rows (IN + OUT) under one shared `import_id` | `appendRows_` |
| `Unmatched` | cleaning error / integrity warning (capped `MAX_UNMATCHED`) | `persistUnmatched_` (stored) + derived in `computeDashboard_` |
| `CancelledBills` | archived line of a cancelled bill (mirrors `TXN_HEADERS` + `cancel_id`/`cancelled_by`/`cancelled_at`) — lets a cancel be restored later | `cancelBillByNumber` (self-heals via `ensureCancelledSheet_`) |

**Invariant:** `Items` lifetime totals include **every** transaction ever imported (including those still in `Txn`). `Txn` is a detail cache for window analysis — never re-added. So:
- current stock / lifetime metrics → from `Items`
- windowed metrics (sold in last N days, "moved in window") → from `Txn` (retention ≥ window, so the window is capped at `txn_retention_days`)

`current_stock = opening_stock + purchased − sold − pur_return + sale_return` (`recalcStock_`).

### Pipeline

```
Paste (web app "Import Data")  →  importPastedData(typeLabel, pastedText, force, asOf, token)
   │
   ├─ STOCK          →  applyOpeningStock_      first run writes opening_stock+price into Items;
   │                                            later needs force=true (re-baseline), keeps lifetime totals
   │
   ├─ STOCK JOURNAL  →  commitStockJournalImport_   item-conversion voucher, no party/salesman — see below
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

- **`undoLastImport(token)`** (admin) reverses the most recent import by reading its rows back out of `Txn` (works only while they're still within retention). A Stock Journal import logs two `Imports` rows (IN + OUT) under one `import_id` — undo deletes both. No arbitrary (non-last) undo.
- **Reset:** `menuResetAll` (sheet menu, YES/NO then type-`RESET` prompt) or `resetAllData('RESET', token)` (admin Settings → Danger zone). Wipes the 7 data tabs, **keeps `Users` + `Settings`**. `factoryReset_()` (editor only) also wipes `Users`.

The dashboard (`getDashboardData` → `computeDashboard_`) recomputes live on every load — the lean tabs are small enough. Returns a trimmed, capped payload (see gotchas). **`getDashboardData`'s payload shape is a contract with `Index.html`** — keep it stable.

### Stock Journal (item conversion)

A "Stock Journal" voucher converts one item into another (rework a dead size into a selling one) — no party/salesman involved. Busy's export has NO Party/Salesman column and repeats `Unit`/`Price`/`Amount` once for the **Generated** side and once for the **Consumed** side, so `buildHeaderMap_` (first-occurrence-wins) can't resolve the second trio by name — `cleanStockJournalGrid_` resolves it **positionally** (fixed offset from whichever `Qty.` column anchors that side) and sanity-checks the header text (`headerLooksLike_`) before trusting it. This is a deliberate, narrow exception to hard rule #1 below, scoped to this one export shape only.

Generated rows become `STOCK_JOURNAL_IN` (folded into `Items` exactly like a `PURCHASE`); Consumed rows become `STOCK_JOURNAL_OUT` (exactly like a `SALE`). Because of that, every place in `Code.gs` that branches on `type === 'PURCHASE'` / `'SALE'` for reversal or windowing (`undoLastImport`, `cancelBillByNumber`, `restoreCancelledBill`, `computeDashboard_`, `getItemHistory`) also checks `|| type === 'STOCK_JOURNAL_IN'` / `'_OUT'` — **if you add a new such branch, widen it too**, or Stock Journal rows will silently fall through. `getItemReport` needs no such widening — it only reads `Items`' lifetime totals, which are already journal-inclusive.

### Cancel / restore a bill

`previewBillCancel` → `cancelBillByNumber` / `restoreCancelledBill` reverse or re-apply one bill's rows (matched by `vch_no`, then narrowed to one physical bill via `billGroupKey_` = type+date+party+salesman, since two different bills can share a voucher number). Unlike a bulk import, a single bill only ever touches a handful of items, so these three functions deliberately **do not** use `readItemsMap_`/`writeItemsMap_` (a full-sheet read+rewrite) — they use `readItemsSubset_`/`writeItemsSubset_`, which locate each affected item's row with `findItemRowByKey_` (a `TextFinder` search that runs server-side and never pulls the whole `Items` sheet into memory) and write back only those rows. Matched `Txn`/`CancelledBills` rows are removed with `deleteSheetRows_` (targeted `deleteRow()` calls, highest row number first) instead of a full-sheet rewrite. **This is the one deliberate, documented exception to hard rule #2** — scoped to these single-bill operations; `commitTxnImport_`/`commitStockJournalImport_`/`undoLastImport` still use the full read-once/write-once map for their (potentially many-item) batches, which is correct there.

### The four hard rules (violating these breaks the app)

1. **Never hardcode column indexes.** `buildHeaderMap_()` builds a case-insensitive, whitespace-collapsed `{header → index}` map; `col_(map, [aliases])` resolves the first matching alias. Busy changes column order/names between exports — add aliases. Stock price aliases: `P. Price` / `Purc Price` / `Sale Price` / `Price` / `Rate`.
2. **Batch I/O only.** Read each tab once with `getValues()`, process in memory (plain objects/Maps, O(n)), write once with `setValues()`. No per-row `getRange`/`getValue`. `readObjects_` / `writeGrid_` / `appendRows_` are the helpers. Must stay well under the 6-minute limit. **Exception:** cancel/restore a single bill touches only a few items — see "Cancel / restore a bill" below for the targeted `TextFinder`/`deleteRow()` approach used there instead.
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

### Auth + RBAC (`Code.gs` LOGIN + ROLES / USER MANAGEMENT sections)

- `Users` tab: `username | salt | password_hash | role | display_name | active | token | token_expires | permissions`. SHA-256 + per-user salt. Create the first logins via `createDefaultUsers()` / `addUser_(...)` from the editor; after that, admins can create/edit users from the **Users** view in the app (`listUsers` / `createUserFromApp` / `setUserPermissions` / `setUserRole` / `setUserActive` / `adminResetPassword`, all admin-only).
- Roles: `admin` (always full access, ignores `permissions`) and `staff` (access = exactly their `permissions` cell). `PERMISSION_DEFS` (`Code.gs`) = `view_dashboard`, `view_report`, `view_unmatched`, `import_data`, `cancel_bills` — granted per staff user, togglable from the Users view. A blank `permissions` cell (pre-RBAC account) falls back to `DEFAULT_STAFF_PERMS` = `['view_dashboard', 'import_data']` (`readUserPerms_`), and `migrateUsersPermissionsColumn_` self-heals a `Users` sheet that predates this column. **Users/Settings/Danger-zone/Undo-import are hardcoded `['admin']`-only** — never staff-grantable, to prevent self-escalation.
- `checkAuth_(token, allowedRoles, requiredPerm)` — every backend fn calls this first. Role is re-read from the sheet, never trusted from the client; `requiredPerm` is skipped for `admin`, enforced for `staff`. `Index.html`'s `NAV[]` entries carry an optional `perm` field — `Shell`'s `navItems` filter hides a nav item from a staff user who lacks it (admin always sees everything).
- Token in the `Users` row (30-day TTL) + browser `localStorage` (`pf_auth_v1`). Frontend appends the token as the **last argument** via `authed()`.
- `addUser_` (trailing underscore) is **not** reachable via `google.script.run` from the browser — only `createUserFromApp` (which re-validates admin + does the username-exists check) is. Never make raw user-creation public again.

### Frontend (`Index.html`)

- React 18 + Babel standalone, Chart.js 4.4, SweetAlert2 11, Font Awesome, SheetJS (`xlsx`) — all `cdnjs`. **No jQuery / DataTables.** Tables = native `NativeTable` (search + sort + per-column Excel-style filter + pagination, all in React state).
- `ErrorBoundary` wraps the app and each view — a crash shows a message, never a blank page.
- Views (role/permission-gated via `NAV[].roles`/`.perm`): Dashboard, Full Report (`getItemReport` — purchase/sale/supplier/pending-balance wide table + sell-through "return candidate" check), Cancelled Bills (cancel a bill by number, pick the right physical bill when the number is shared, restore any time), Unmatched, Import Data (+ recent-imports table + **Undo last import**, admin only), Users (admin only — create/edit logins, roles, permissions), Settings (admin only, + **Danger zone → Reset all data**). Clicking any item row opens a drill-down modal (`showItemDetail` → `getItemHistory`) with its lifetime summary + recent `Txn` history.
- Bilingual UI (English / Hinglish) via `LangCtx`/`useLang()`/`L(en, hi)` and a top-bar toggle — every new user-facing string should go through `L()`.
- Popovers (per-column filter, multi-select filters) render via `ReactDOM.createPortal` to `document.body` with `position:fixed` (`usePopoverPosition`) so they aren't clipped by `.tbl-scroll`'s `overflow`. They close on outside scroll, but explicitly ignore scroll events whose target is inside the popover's own panel (`panelRef`) — don't remove that check, it's what stops the panel closing itself while the user scrolls its own checkbox list.
- Currency Indian format via `inr()`. Navy theme, CSS variables, mobile-first.

## Gotchas

- **`google.script.run` silently returns `null` for oversized payloads.** `getDashboardData` trims item fields and caps `items` at `MAX_ITEMS_TO_UI` (5000, dead-first). If the dashboard shows "No data yet" with a big `Items` tab, reduce the payload — don't assume the tab is empty.
- **ISO date strings vs Sheets auto-parse.** Dates are stored as `YYYY-MM-DD` text. `writeGrid_` / `appendRows_` force `@` (text) format on any column whose header matches `/date|_at|_seen|expires/`; reads go through `asIsoMaybe_` (tolerates a `Date` a human typed in). If you add a date-bearing column, make sure its header name matches that regex.
- **Overlap guard.** An import of the same `txn_type` whose date span overlaps a logged import is rejected (`checkOverlap_`) — no double counting. To redo a week: `undoLastImport` (if recent) or re-export a clean non-overlapping span. There is **no** "reverse the aggregates" path for old (pruned) imports — that's what RESET is for.
- **Re-baselining opening stock** (`applyOpeningStock_` with `force`): replaces `opening_stock` + `price` for items present in the paste, keeps lifetime totals, recomputes `current_stock` for all. Items absent from the new paste keep their old opening.
- `_`-suffixed functions are private server helpers (not callable from `google.script.run`).
- `Settings` tab is the single source of truth for the numeric thresholds (admin Settings view) + `txn_retention_days` + per-file `date_format_*` (sheet only, incl. `date_format_raw_stockjournal`) + `company_name` / `firm_links_json` (see "Multi-firm deployment" above). Thresholds apply on the next dashboard load — nothing to rebuild.
- **`readSettings_()` upper-cases every non-numeric setting by default** (right for `AUTO`/`DD-MM`/`MM-DD`). If you add a new free-text `SETTINGS_DEFAULTS` key (a display name, a JSON blob, anything case-sensitive), add it to `SETTINGS_KEEP_CASE` too, or it'll come back mangled (`company_name` → `COMPANY NAME`, JSON keys upper-cased and unparseable).
- Old v2 tabs (`Raw_*`, `Transactions`, `Stock`, `Report`, `SalesmanReport`) are **not** used or touched by v3 — delete them manually or start in a fresh Sheet.
- **Don't call `setupSheets_()` on a hot path.** It touches all 9 tabs (existence + header checks), runs `migrateUsersPermissionsColumn_()`, and seeds `Settings` — fine once per import/user-creation, far too slow to call on every dashboard/cancel/report request. Use the lighter targeted self-heal instead: `ensureCancelledSheet_()` (just `CancelledBills`) or `ensureSettingsSheet_()` (just `Settings`, also returns the sheet). If a new per-request endpoint needs a tab to exist, add a similarly narrow `ensureXSheet_()` rather than reaching for `setupSheets_()`.
- **CSS rule order can silently kill `position:sticky`.** Two rules targeting the same selector (e.g. `table.ntable thead th`) cascade in **source order** regardless of which one is wrapped in a `@media` block — a later unconditional rule overrides an earlier conditional one even when that media query matches. The sticky table-header rule lives inside `@media (min-width:641px)`; don't add a later unconditional `table.ntable thead th { position: ... }` rule below it, or headers will stop sticking on scroll (this already happened once — the fix was deleting a stray `position:relative` from the later rule).
- Out of scope until asked: arbitrary (non-last) import undo, monthly sales buckets / windows longer than retention, holidays, push alerts.
