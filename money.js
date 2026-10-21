/* Eagle Creek — Books and each project's Money section.
 *
 * Books (the Mac's Books screen): the overview (cash, bills to pay, what you're owed, profit),
 * every transaction, receipts waiting to be entered, lien waivers, the chart of accounts with
 * each account's activity, and reports (P&L, profit by project, balance sheet, A/P and A/R aging,
 * vendor payments and 1099s, money in and out).
 * A project's Money section: the summary, draws (your own projects), transactions, lien waivers
 * and its reports (job cost, draw reconciliation, P&L and the rest for that job).
 * All of it read from books.js, the Mac's own maths. Bills, invoices and deposits are entered on
 * the Mac; here a payment's lien waiver can be marked and its signed copy attached, and a
 * draw's status, notes and paperwork kept up to date from the site.
 */
'use strict';

Object.assign(ICONS, {
  bookClosed: '<path d="M5.5 4.5A1.5 1.5 0 0 1 7 3h12v15H7a1.5 1.5 0 0 0-1.5 1.5z"/><path d="M5.5 19.5A1.5 1.5 0 0 0 7 21h12v-3"/>',
  seal: '<path d="m12 3 2 1.6 2.5-.3.9 2.4 2.3 1.1-.4 2.5 1.2 2.2-1.9 1.7v2.5l-2.4.7-1.5 2-2.4-.8L12 21l-2.2-1.4-2.4.8-1.5-2-2.4-.7v-2.5L1.6 13.5l1.2-2.2-.4-2.5 2.3-1.1.9-2.4 2.5.3z" transform="translate(.6 .3) scale(.95)"/><path d="m8.5 12 2.4 2.4 4.6-4.8"/>',
  banknote: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
});

const signedMoney = (v, cents = true) => (v < -0.004 ? `(${fmt.money(-v, cents)})` : fmt.money(v, cents));
const profitTint = (v) => (v < -0.004 ? 'var(--danger)' : '');
const projectLabel = (id) => { const p = id ? project(id) : null; return p ? projectName(p) : 'Company'; };
const WAIVER_STATUS = {
  needed: ['Waiver needed', 'Needed', 'var(--danger)'], conditional: ['Conditional received', 'Conditional', 'var(--warning)'],
  unconditional: ['Unconditional received', 'Received', 'var(--success)'], notRequired: ['Not required', 'N/A', 'var(--stone)'],
};
const DRAW_STATUS = { planned: ['Planned', 'var(--stone)'], requested: ['Requested', 'var(--slate)'], inspected: ['Inspected', 'var(--slate)'], funded: ['Funded', 'var(--success)'] };
const TXN_TYPE_FILTERS = [
  ['all', 'All types', () => true], ['moneyOut', 'Money out', (t) => t === 'bill' || t === 'expense'], ['bills', 'Bills', (t) => t === 'bill'],
  ['expenses', 'Expenses', (t) => t === 'expense'], ['moneyIn', 'Money in', (t) => t === 'invoice' || t === 'deposit'], ['invoices', 'Invoices', (t) => t === 'invoice'],
  ['deposits', 'Deposits', (t) => t === 'deposit'], ['transfers', 'Transfers', (t) => t === 'transfer'], ['journal', 'Journal entries', (t) => t === 'journal'],
  ['credits', 'Credits & refunds', (t) => t === 'vendorCredit' || t === 'creditMemo' || t === 'refund'],
];
const TXN_STATUS_FILTERS = [
  ['all', 'Any status', () => true], ['open', 'Unpaid', (t) => txnOpen(t)], ['overdue', 'Overdue', (t) => txnOverdue(t)],
  ['paid', 'Paid', (t) => tracksBalance(t) && txnStatus(t) === 'paid'], ['void', 'Void', (t) => !!t.isVoid],
];
function dueText(t) {
  if (t.dueDate == null) return 'No due date';
  const days = dayDiff(new Date(), fromSec(t.dueDate));
  if (days < 0) return `${plural(-days, 'day')} overdue`;
  if (days === 0) return 'Due today';
  return `Due ${fmt.short(fromSec(t.dueDate))}`;
}
/** "Rehab – Materials", "Split (3 lines)" or "Checking → Savings" (ReportTables.categorySummary). */
function categorySummary(t) {
  const d = booksData();
  if (t.type === 'transfer') return `${d.account(t.accountID)?.name || '?'} → ${d.account(t.toAccountID)?.name || '?'}`;
  const ids = new Set((t.lines || []).map((l) => key(l.accountID)));
  if (ids.size > 1) return `Split (${(t.lines || []).length} lines)`;
  const only = (t.lines || [])[0];
  if (!only) return '';
  return only.accountID ? (d.account(only.accountID)?.name || 'Uncategorized') : 'Uncategorized';
}
const kvLine = (label, value, cls = '') => `<div class="kv"><span>${label}</span><span class="${cls}">${esc(value)}</span></div>`;
const kvTotal = (label, value, tint = '') => `<div class="kv"><span><b>${esc(label)}</b></span><span class="total-v" style="${tint ? `color:${tint}` : ''}">${esc(value)}</span></div>`;
const kvCard = (title, body, opts) => card(title, `<div style="padding:0 16px 6px">${body}</div>`, opts);

// ---------------------------------------------------------------------------
// Rows shared by the pages

function ledgerTxnRow(t, { showProject = true } = {}) {
  const st = txnStatus(t);
  const name = booksData().payeeName(t) || TXN_TYPES[t.type] || 'Transaction';
  const sub = [`${TXN_TYPES[t.type] || ''}${(t.number || '').trim() ? ` ${t.number.trim()}` : ''}`, showProject ? projectLabel(t.projectID) : '', categorySummary(t)].filter(Boolean).join(' · ');
  const open = txnOpen(t) && txnBalance(t) !== txnTotal(t);
  const left = creditLeft(t);
  const showPill = tracksBalance(t) || isCredit(t) || t.isVoid;
  return `<button class="row" data-act="txn-open" data-id="${esc(key(t.id))}">
    <div class="ev-time">${esc(fmt.short(fromSec(t.date)))}</div>
    <div class="main"><div class="t ${t.isVoid ? 'done-t' : ''}">${esc(name)}</div><div class="s">${esc(sub)}</div>${tagChips(t)}</div>
    <div class="end"><span class="amt">${esc(fmt.money(txnTotal(t), true))}</span>${open ? `<span>${esc(fmt.money(txnBalance(t), true))} due</span>` : left > 0.005 && left !== txnTotal(t) ? `<span>${esc(fmt.money(left, true))} left</span>` : ''}${showPill ? pill(TXN_STATUS[st][0], TXN_STATUS[st][1]) : ''}</div></button>`;
}

// ----- Eagle Creek Books (v1.3): tags, and money recorded in both the business and personal books

const txnTags = (t) => (Array.isArray(t?.tags) ? t.tags : []).map((x) => String(x || '').trim()).filter(Boolean);
const tagChips = (t) => { const tags = txnTags(t); return tags.length ? `<div class="tag-row">${tags.map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</div>` : ''; };
/** Every tag used in the books (or on one project's entries), A to Z. */
function booksTags(scope = 'all') {
  const set = new Set();
  for (const t of booksData().transactions) if (scope === 'all' || sameId(t.projectID, scope)) for (const x of txnTags(t)) set.add(x);
  return [...set].sort((a, b) => a.localeCompare(b));
}
/** Recorded in both sets of books by Eagle Creek Books' Business ↔ Personal. */
const isPaired = (t) => !!t?.pairID;
const PAIRED_NOTE = 'Eagle Creek Books recorded this in your personal books too. If you change the amount, how it was paid, or delete it, change the personal side in Eagle Creek Books as well.';
/** Eagle Creek Books and the Mac app open from links in a browser on the Mac they're installed on. */
const onMacDesktop = () => /Macintosh/.test(navigator.userAgent) && !/iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator.maxTouchPoints > 1);
const booksAppLink = (host, value) => `eaglecreekbooks://${host}${value ? `/${/^[0-9a-f-]{36}$/i.test(value) ? String(value).toUpperCase() : value}` : ''}`;

function billDueRow(t, { showProject = true } = {}) {
  const name = booksData().payeeName(t) || 'No vendor';
  const late = txnOverdue(t);
  return `<button class="row" data-act="txn-open" data-id="${esc(key(t.id))}">
    <div class="main"><div class="t">${esc(name)}</div><div class="s"><span class="${late ? 'alert-text' : ''}">${esc(dueText(t))}</span>${showProject ? ` · ${esc(projectLabel(t.projectID))}` : ''}</div></div>
    <div class="end"><span class="amt">${esc(fmt.money(txnBalance(t), true))}</span></div></button>`;
}

function waiverRow(i, { showProject = true } = {}) {
  const [, short, color] = WAIVER_STATUS[i.required ? i.status : 'notRequired'] || WAIVER_STATUS.needed;
  const sub = [showProject ? projectLabel(i.projectID) : '', `Paid ${fmt.short(fromSec(i.date))}`, [METHODS[i.method] || '', (i.reference || '').trim()].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  return `<button class="row" data-act="waiver-open" data-txn="${esc(key(i.transactionID))}" data-payment="${esc(i.paymentID ? key(i.paymentID) : '')}">
    <div class="main"><div class="t">${esc(i.vendorName)}</div><div class="s">${esc(sub)}</div>${!i.required ? '<div class="s">Below the waiver minimum</div>' : i.waiver?.scope === 'final' ? '<div class="s">Final waiver</div>' : ''}</div>
    <div class="end"><span class="amt">${esc(fmt.money(i.amount, true))}</span>${pill(short, color)}</div></button>`;
}

/** Bars of money in and out by month (the Mac's Money In and Out chart). */
function cashChart(rows) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.moneyIn, r.moneyOut]));
  return `<div class="cash-chart">${rows.map((r) => `<div class="cc-col" title="${esc(`${fmt.month(r.month)}: in ${fmt.money(r.moneyIn)}, out ${fmt.money(r.moneyOut)}`)}">
      <div class="cc-bars"><i class="in" style="height:${Math.round(r.moneyIn / max * 100)}%"></i><i class="out" style="height:${Math.round(r.moneyOut / max * 100)}%"></i></div>
      <div class="cc-label">${esc(r.month.toLocaleDateString('en-US', { month: 'short' }))}</div></div>`).join('')}</div>
    <div class="cc-legend"><span><i class="in"></i>Money in</span><span><i class="out"></i>Money out</span></div>`;
}

// ---------------------------------------------------------------------------
// Books

const BOOKS_PAGES = [['overview', 'Overview'], ['bank', 'Bank'], ['transactions', 'Transactions'], ['receipts', 'Receipts'], ['waivers', 'Lien Waivers'], ['accounts', 'Accounts'], ['reports', 'Reports']];

function viewBooks(page, arg) {
  if (page === 'account') return viewAccount(arg);
  if (page === 'report') return viewReport(arg, 'all', '#/books/reports');
  if (page === 'bank' && arg) return viewFeedLine(arg);
  if (!BOOKS_PAGES.some(([k]) => k === page)) page = 'overview';
  const closed = booksData().settings.closedThrough;
  setHeader({ title: 'Books', sub: closed != null ? `Closed through ${fmt.date(fromSec(closed))}` : '' });
  const toReview = feedReviewCount();
  const nav = `<nav class="seg" aria-label="Books pages">${BOOKS_PAGES.map(([k, l]) => `<a href="#/books/${k}" class="${k === page ? 'on' : ''}">${segIcon(SECTION_ICONS[`books:${k}`] || SECTION_ICONS[k])}${k === 'bank' && toReview ? `${l} (${toReview})` : l}</a>`).join('')}</nav>`;
  let html = S.syncError ? banner(S.syncError) : '';
  if (!all('transaction').length && !all('books').length) {
    html += S.meta.lastSync ? '' : emptyState('bookClosed', 'Getting Your Books', 'Downloading from Supabase…');
  }
  const body = { overview: booksOverview, bank: bankFeedPage, transactions: () => transactionList('all'), receipts: receiptsPage, waivers: () => waiverList('all'), accounts: accountsPage, reports: () => reportList('all') }[page];
  return nav + html + body();
}

function booksOverview() {
  const d = booksData();
  const bal = (type) => d.accounts.filter((a) => a.type === type).reduce((s, a) => s + accountBalance(a.id), 0);
  const bank = money(bal('bank')), cards = money(bal('creditCard')), loans = money(bal('loan'));
  const bills = d.transactions.filter((t) => t.type === 'bill' && txnOpen(t)).sort((a, b) => (a.dueDate ?? a.date) - (b.dueDate ?? b.date));
  const overdue = bills.filter(txnOverdue);
  const invoices = d.transactions.filter((t) => t.type === 'invoice' && txnOpen(t));
  const profit = profitAndLoss(presetRange('thisYear')).netIncome;
  const owedToOwner = accountBalance(d.sys.dueToOwner);
  let html = `<div class="tiles four">
    ${tile('Cash in the Bank', fmt.money(bank), `Cards owe ${fmt.money(cards)}`, { accent: 'var(--forest)', tint: profitTint(bank) })}
    ${tile('Bills to Pay', fmt.money(bills.reduce((s, t) => s + txnBalance(t), 0)), overdue.length ? `${overdue.length} overdue` : `${bills.length} unpaid`, { accent: 'var(--leather)', tint: overdue.length ? 'var(--danger)' : '' })}
    ${tile('Owed to You', fmt.money(invoices.reduce((s, t) => s + txnBalance(t), 0)), plural(invoices.length, 'unpaid invoice'), { accent: 'var(--slate)' })}
    ${tile('Profit This Year', fmt.money(profit), 'Includes costs on houses not sold yet', { accent: 'var(--gold)', tint: profitTint(profit) })}
  </div>`;
  const notes = [];
  const toReview = feedReviewCount();
  if (toReview) notes.push(`<a href="#/books/bank">${esc(plural(toReview, 'bank line'))} to review</a>`);
  if (loans > 0.005) notes.push(esc(`Loans owed: ${fmt.money(loans)}`));
  if (owedToOwner > 0.005) notes.push(`<a href="#/trips/personal">The company owes you ${esc(fmt.money(owedToOwner, true))}</a>`);
  if (notes.length) html += `<p class="note" style="margin:-4px 4px 14px">${notes.join(' · ')}</p>`;
  const cash = cashByMonth(6);
  const last = cash[cash.length - 1];
  html += card('Money In and Out', cash.every((r) => !r.moneyIn && !r.moneyOut) ? '<div class="empty-line">The last six months show here once money moves.</div>'
    : `<div style="padding:0 16px 10px">${cashChart(cash)}${kvLine('Net this month', fmt.money(last.net), last.net < 0 ? 'alert-text' : '')}</div>`);
  const moneyAccounts = d.sorted.filter((a) => isMoneyAccountType(a.type) && !a.isArchived);
  html += card('Bank and Card Accounts', moneyAccounts.length ? moneyAccounts.map((a) => {
    const recs = (d.settings.reconciliations || []).filter((r) => sameId(r.accountID, a.id)).sort((x, y) => (y.statementDate || 0) - (x.statementDate || 0));
    const b = accountBalance(a.id);
    return `<a class="row" href="#/books/account/${esc(key(a.id))}">${icon(ACCOUNT_ICONS[a.type] || 'bank', 'ic glyph', '--tint:var(--forest)')}<div class="main"><div class="t">${esc(a.name || 'Unnamed account')}</div><div class="s">${esc(recs[0] ? `Reconciled through ${fmt.short(fromSec(recs[0].statementDate))}` : 'Not reconciled yet')}</div></div>
      <div class="end"><span class="amt" style="${b < 0 ? 'color:var(--danger)' : ''}">${esc(fmt.money(b, true))}</span></div>${icon('chev', 'ic chev')}</a>`;
  }).join('') : '<div class="empty-line">No bank or card accounts yet.</div>', { action: cardLink('All Accounts', '#/books/accounts') });
  html += card('Bills to Pay', bills.length ? bills.slice(0, 8).map((t) => billDueRow(t)).join('') + (bills.length > 8 ? `<div class="empty-line small">${bills.length - 8} more</div>` : '') : allClear('No unpaid bills.'),
    { action: bills.length ? `<button class="btn link" data-act="txn-show" data-scope="all" data-type="bills" data-status="open">See All</button>` : '' });
  const waivers = lienWaiverReport('all');
  const openW = waivers.items.filter((i) => !i.isComplete);
  html += card('Lien Waivers to Collect', openW.length ? openW.slice(0, 8).map((i) => waiverRow(i)).join('') + (openW.length > 8 ? `<div class="empty-line small">${openW.length - 8} more</div>` : '')
    : allClear(waivers.items.length ? 'Every waiver is in.' : 'No payments need a lien waiver yet.'), { action: cardLink('See All', '#/books/waivers') });
  // Eagle Creek Books (Mac, v1.3) keeps the books from these same records.
  html += card('Eagle Creek Books', `<p class="note" style="margin:0 0 ${onMacDesktop() ? 10 : 2}px">Bank and card feeds, reconciling, 1099s and the accountant package are in Eagle Creek Books on the Mac. It works on these same records, so receipts, trip costs and drives entered here show up there.</p>
    ${onMacDesktop() ? `<div class="btn-row"><a class="btn link-out" href="${esc(booksAppLink('banking'))}">Open Banking</a><a class="btn link-out" href="${esc(booksAppLink('section', 'taxes'))}">1099s</a></div>` : ''}`, { flush: false });
  return html;
}

// ----- Transactions

function txnFilter(scope) {
  S.ui.txnFilters = S.ui.txnFilters || {};
  return (S.ui.txnFilters[scope] = S.ui.txnFilters[scope] || { type: 'all', status: 'all', preset: 'allDates', tag: '', q: '', limit: 100 });
}
function filteredTransactions(scope) {
  const f = txnFilter(scope);
  const d = booksData();
  const type = TXN_TYPE_FILTERS.find((x) => x[0] === f.type) || TXN_TYPE_FILTERS[0];
  const status = TXN_STATUS_FILTERS.find((x) => x[0] === f.status) || TXN_STATUS_FILTERS[0];
  const range = presetRange(f.preset);
  const q = f.q.trim().toLowerCase();
  return d.transactions.filter((t) => {
    if (scope !== 'all' && !sameId(t.projectID, scope)) return false;
    if (!type[2](t.type) || !status[2](t) || !inRange(range, t.date || 0)) return false;
    if (f.tag && !txnTags(t).includes(f.tag)) return false;
    if (!q) return true;
    const hay = [d.payeeName(t), t.number, t.memo, TXN_TYPES[t.type], txnTotal(t).toFixed(2), ...(t.lines || []).map((l) => l.memo), ...(t.lines || []).map((l) => d.account(l.accountID)?.name), t.projectID ? projectLabel(t.projectID) : '', ...txnTags(t)];
    return hay.some((x) => String(x || '').toLowerCase().includes(q));
  }).sort((a, b) => (b.date || 0) - (a.date || 0) || (a.id < b.id ? -1 : 1));
}
function transactionResults(scope) {
  const f = txnFilter(scope);
  const list = filteredTransactions(scope);
  const filtered = f.type !== 'all' || f.status !== 'all' || f.preset !== 'allDates' || f.tag || f.q.trim();
  if (!list.length) {
    return filtered ? emptyState('search', 'Nothing Matches', 'Try a different type, status, date range or search.', `<button class="btn" data-act="txn-clear" data-scope="${esc(scope)}">Clear Filters</button>`)
      : emptyState('bookClosed', 'No Transactions Yet', scope === 'all' ? 'Bills, expenses, deposits and invoices entered on the Mac show here.' : 'Bills, expenses, deposits and invoices for this project show here once they’re entered on the Mac.');
  }
  const toPay = list.filter((t) => t.type === 'bill' && txnOpen(t));
  const toCollect = list.filter((t) => t.type === 'invoice' && txnOpen(t));
  const parts = [plural(list.length, 'transaction')];
  if (!['all', 'transfers', 'journal'].includes(f.type)) parts.push(`Total ${fmt.money(list.filter((t) => !t.isVoid && t.type !== 'transfer' && t.type !== 'journal').reduce((s, t) => s + txnTotal(t), 0), true)}`);
  if (toPay.length) parts.push(`To pay ${fmt.money(toPay.reduce((s, t) => s + txnBalance(t), 0), true)} (${toPay.length})`);
  if (toCollect.length) parts.push(`To collect ${fmt.money(toCollect.reduce((s, t) => s + txnBalance(t), 0), true)} (${toCollect.length})`);
  let html = `<p class="note" style="margin:-4px 4px 10px">${esc(parts.join(' · '))}</p>`;
  const shown = list.slice(0, f.limit);
  const months = new Map();
  for (const t of shown) { const k = fmt.month(fromSec(t.date)); if (!months.has(k)) months.set(k, []); months.get(k).push(t); }
  for (const [m, arr] of months) html += `<div class="day-label">${esc(m)}</div><section class="card flush">${arr.map((t) => ledgerTxnRow(t, { showProject: scope === 'all' })).join('')}</section>`;
  if (shown.length < list.length) html += `<button class="btn block" data-act="txn-more" data-scope="${esc(scope)}">Show ${Math.min(100, list.length - shown.length)} More</button>`;
  return html;
}
function transactionList(scope) {
  const f = txnFilter(scope);
  const sel = (name, options, value) => `<select class="input" data-act="txn-filter" data-scope="${esc(scope)}" data-field="${name}">${options.map(([k, l]) => `<option value="${k}" ${k === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  // Tags come from Eagle Creek Books (v1.3): filter by one when there are any.
  const tags = booksTags(scope);
  if (f.tag && !tags.includes(f.tag)) tags.push(f.tag);
  return `<div class="search">${icon('search')}<input class="input" id="txn-search" data-scope="${esc(scope)}" type="search" placeholder="Name, number, memo, tag, amount" value="${esc(f.q)}" autocomplete="off"></div>
    <div class="filters">${sel('type', TXN_TYPE_FILTERS, f.type)}${sel('status', TXN_STATUS_FILTERS, f.status)}${sel('preset', Object.entries(DATE_PRESETS), f.preset)}${tags.length ? sel('tag', [['', 'All tags'], ...tags.map((x) => [x, x])], f.tag || '') : ''}</div>
    <div id="txn-results">${transactionResults(scope)}</div>`;
}

// ----- Receipts waiting on the Mac

function receiptsPage() {
  const list = all('file').filter((f) => f.needsReview).sort((a, b) => ((b.receiptScan?.date ?? b.documentDate ?? 0) - (a.receiptScan?.date ?? a.documentDate ?? 0)));
  let html = `<div class="page-bar"><span class="count">${list.length ? `${list.length} to enter on the Mac` : 'Nothing waiting'}</span><button class="btn primary sm" data-act="receipt">${icon('camera')}Snap a Receipt</button></div>`;
  if (!list.length) return html + emptyState('receipt', 'No Receipts Waiting', 'Snap a receipt here (or with the receipt button on Projects). It waits in Books › Receipts on the Mac, where Enter as Expense reads the store, date and total.');
  html += `<section class="card flush">${list.map((f) => {
    const scan = f.receiptScan || {};
    const title = (scan.vendor || '').trim() || fileTitle(f);
    const bits = [scan.date != null ? fmt.date(fromSec(scan.date)) : fmt.date(fileDate(f)), scan.total ? fmt.money(scan.total, true) : '', f.projectID ? projectLabel(f.projectID) : '', isPending(f) ? 'Waiting to upload' : ''].filter(Boolean);
    return `<button class="row" data-act="open-file" data-id="${esc(key(f.id))}">${isImage(f) ? `<span class="mini-thumb" data-thumb="${esc(key(f.id))}">${icon('image')}</span>` : icon('doc', 'ic glyph', '--tint:var(--sage)')}
      <div class="main"><div class="t">${esc(title)}</div><div class="s">${esc(bits.join(' · '))}</div></div>${icon('chev', 'ic chev')}</button>`;
  }).join('')}</section>`;
  return html + '<p class="note" style="margin:0 4px 14px">Each one is entered on the Mac with Enter as Expense, or filed without one.</p>';
}

// ----- Lien waivers

function waiverList(scope) {
  const report = lienWaiverReport(scope);
  const showAll = prefs.get(`waivers-all-${scope === 'all' ? 'all' : 'project'}`, false);
  const q = (S.ui.waiverSearch || '').trim().toLowerCase();
  const items = (showAll ? report.items : report.items.filter((i) => !i.isComplete))
    .filter((i) => !q || i.vendorName.toLowerCase().includes(q) || projectLabel(i.projectID).toLowerCase().includes(q));
  const finalsMissing = report.finals.filter((r) => !r.hasFinal);
  const bits = [report.missing.length ? `<span class="alert-text">${report.missing.length} missing, ${esc(fmt.money(report.missingAmount))}</span>` : 'Nothing missing'];
  if (report.awaiting.length) bits.push(`<span style="color:var(--warning)">${report.awaiting.length} conditional only</span>`);
  if (finalsMissing.length) bits.push(`<span style="color:var(--warning)">${finalsMissing.length} without a final</span>`);
  let html = `<div class="page-bar"><span class="count small">${bits.join(' · ')}</span><label class="check-label"><input type="checkbox" data-act="toggle-pref" data-pref="waivers-all-${scope === 'all' ? 'all' : 'project'}" ${showAll ? 'checked' : ''}>Show all</label></div>`;
  if (scope === 'all' && report.items.length > 8) html += `<div class="search">${icon('search')}<input class="input" id="waiver-search" type="search" placeholder="Vendor or project" value="${esc(S.ui.waiverSearch || '')}" autocomplete="off"></div>`;
  if (!items.length) {
    html += emptyState('seal', report.items.length ? 'Every Waiver Is In' : 'No Waiver Payments Yet', report.items.length ? 'Nothing is missing. Turn on Show all to see every payment.' : 'Payments to trades marked “Gives lien waivers” show here. Turn that on for a trade in Contacts.');
  } else html += `<section class="card flush">${items.map((i) => waiverRow(i, { showProject: scope === 'all' })).join('')}</section>`;
  if (finalsMissing.length) {
    html += card('No Final Waiver Yet', finalsMissing.map((r) => `<div class="row static"><div class="main"><div class="t">${esc(r.vendorName || 'No name')}</div><div class="s">${esc(projectLabel(r.projectID))}</div></div><div class="end"><span class="amt">${esc(fmt.money(r.paid))}</span><span>paid</span></div></div>`).join(''));
  }
  return html;
}

function findPayment(t, paymentID) {
  if (!paymentID) return t.type === 'expense' ? { id: null, date: t.date, amount: txnTotal(t), method: t.method, reference: t.number, waiver: t.waiver || {} } : null;
  const p = (t.payments || []).find((x) => sameId(x.id, paymentID));
  return p ? { id: p.id, date: p.date, amount: money(p.amount), method: p.method, reference: p.reference, waiver: p.waiver || {} } : null;
}

function sheetWaiver(txnID, paymentID) {
  const t = get(txnID);
  const pay = t && findPayment(t, paymentID);
  if (!pay) return;
  const w = { status: 'needed', scope: 'progress', ...pay.waiver };
  const vendor = booksData().payeeName(t) || 'No name';
  const doc = w.documentID ? get(w.documentID) : null;
  openSheet(`${sheetHead('Lien Waiver', `${vendor} · ${projectLabel(t.projectID)}`)}
    <form id="waiver-form" data-txn="${esc(key(t.id))}" data-payment="${esc(pay.id ? key(pay.id) : '')}" data-doc="${esc(w.documentID || '')}">
      <section class="card"><div style="margin:-4px 0">
        ${kvLine('Paid', `${fmt.date(fromSec(pay.date))} · ${fmt.money(pay.amount, true)}`)}
        ${kvLine('Paid by', [METHODS[pay.method] || 'Check', (pay.reference || '').trim()].filter(Boolean).join(' '))}
        ${kvLine('For', txnLabel(t))}
      </div></section>
      <div class="form-section"><div class="fs-head">Waiver</div>
        <div class="chips status-chips" style="margin:0">${Object.entries(WAIVER_STATUS).map(([k, [l, , c]]) => `<button type="button" data-act="waiver-status" data-status="${k}" class="${k === w.status ? 'on' : ''}" style="--c:${c}">${l}</button>`).join('')}</div>
        <input type="hidden" name="status" value="${esc(w.status)}"></div>
      <div class="form-section"><div class="fs-head">Type</div><div class="segmented">${[['progress', 'Progress'], ['final', 'Final']].map(([k, l]) => `<button type="button" data-act="waiver-scope" data-scope="${k}" class="${(w.scope || 'progress') === k ? 'on' : ''}">${l}</button>`).join('')}</div><input type="hidden" name="scope" value="${esc(w.scope || 'progress')}">
        <div class="fs-foot">Final is the last waiver for the job, once their work is done and paid.</div></div>
      <div class="form-section"><div class="fs-head">Signed Waiver</div>
        <div id="waiver-doc">${doc ? `<section class="card flush">${fileRow(doc)}</section>` : '<p class="note" style="margin:0 4px 8px">No signed copy attached yet.</p>'}</div>
        <div class="btn-row"><button type="button" class="btn" data-act="waiver-attach" data-capture="1">${icon('camera')}Camera</button><button type="button" class="btn" data-act="waiver-attach">${icon('folder')}Choose File</button></div></div>
      <div class="sheet-actions"><button type="button" class="btn" data-act="sheet-close">Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </form>`);
}

// ----- Accounts and their activity

function accountsPage() {
  const d = booksData();
  const year = presetRange('thisYear');
  const showArchived = prefs.get('show-archived-accounts', false);
  let html = '';
  for (const section of Object.keys(SECTION_LABEL)) {
    const balanceSheet = ['assets', 'liabilities', 'equity'].includes(section);
    const rows = d.sorted.filter((a) => typeSection(a.type) === section).map((a) => ({ a, v: accountBalance(a.id, { range: balanceSheet ? RANGE_ALL : year }) }))
      .filter(({ a, v }) => !a.isArchived || showArchived || Math.abs(v) >= 0.005);
    if (!rows.length) continue;
    html += card(`${SECTION_LABEL[section]}${balanceSheet ? '' : ' (this year)'}`, rows.map(({ a, v }) => `<a class="row" href="#/books/account/${esc(key(a.id))}">
      ${icon(ACCOUNT_ICONS[a.type] || 'bookClosed', 'ic glyph', `--tint:${ACCOUNT_SECTION_TINTS[section] || 'var(--clay)'}`)}
      <div class="main"><div class="t">${esc(accountDisplayName(a))}${a.isArchived ? ' <span class="muted small">· Archived</span>' : ''}</div><div class="s">${esc(ACCOUNT_TYPE_LABEL[a.type])}${a.costGroup && a.type === 'jobCost' ? ` · ${esc(COST_GROUPS[a.costGroup])}` : ''}</div></div>
      <div class="end"><span class="amt" style="${v < -0.004 ? 'color:var(--danger)' : ''}">${esc(fmt.money(v, true))}</span></div>${icon('chev', 'ic chev')}</a>`).join(''));
  }
  html += `<label class="check-label" style="margin:0 4px 14px"><input type="checkbox" data-act="toggle-pref" data-pref="show-archived-accounts" ${showArchived ? 'checked' : ''}>Show archived accounts</label>`;
  return html;
}

function viewAccount(id) {
  const d = booksData();
  const a = d.account(id);
  setHeader({ title: a ? (a.name || 'Unnamed account') : 'Account', sub: a ? [a.number, ACCOUNT_TYPE_LABEL[a.type]].filter(Boolean).join(' · ') : '', back: '#/books/accounts' });
  if (!a) return emptyState('bookClosed', 'Not in the Chart', 'This account may have been deleted on the Mac.');
  const balanceSheet = isBalanceSheetType(a.type);
  let running = 0;
  const rows = [];
  for (const p of d.postings) {
    if (!sameId(p.accountID, a.id)) continue;
    const change = naturalBalance(p.amount, a.type);
    running = money(running + change);
    rows.push({ p, change, balance: running });
  }
  const year = accountBalance(a.id, { range: presetRange('thisYear') });
  let html = `<div class="tiles" style="grid-template-columns:repeat(2,1fr)">
    ${tile(balanceSheet ? 'Balance' : 'All Time', fmt.money(running, true), plural(rows.length, 'entry', 'entries'), { accent: 'var(--spruce)', tint: profitTint(running) })}
    ${tile('This Year', fmt.money(year, true), (a.detail || '').trim() ? a.detail.trim() : '', { accent: 'var(--gold)' })}</div>`;
  if (!rows.length) return html + emptyState('bookClosed', 'No Activity Yet', 'Entries to this account show here, newest first.');
  const limit = S.ui.registerLimit?.[key(a.id)] || 150;
  const shown = rows.slice().reverse().slice(0, limit);
  html += `<section class="card flush">${shown.map(({ p, change, balance }) => {
    const t = p.isOpeningBalance ? null : get(p.transactionID);
    const name = p.payee || (p.isOpeningBalance ? 'Opening balance' : (TXN_TYPES[p.type] || ''));
    const label = p.isOpeningBalance ? '' : p.paymentID ? `${p.type === 'invoice' ? 'Invoice payment' : p.type === 'bill' ? 'Bill payment' : 'Refund'}${p.number ? ` · ${p.number}` : ''}` : `${TXN_TYPES[p.type] || ''}${p.number ? ` ${p.number}` : ''}`;
    const sub = [label, (p.memo || '').trim(), p.projectID ? projectLabel(p.projectID) : ''].filter(Boolean).join(' · ');
    return `<${t ? `button class="row" data-act="txn-open" data-id="${esc(key(t.id))}"` : 'div class="row static"'}>
      <div class="ev-time">${esc(fmt.short(fromSec(p.date)))}</div>
      <div class="main"><div class="t">${esc(name || '—')}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div>
      <div class="end"><span class="amt" style="${change < 0 ? 'color:var(--muted)' : ''}">${esc(change < 0 ? `−${fmt.money(-change, true)}` : `+${fmt.money(change, true)}`)}</span><span>${esc(fmt.money(balance, true))}</span></div></${t ? 'button' : 'div'}>`;
  }).join('')}</section>`;
  if (shown.length < rows.length) html += `<button class="btn block" data-act="register-more" data-id="${esc(key(a.id))}">Show Older</button>`;
  return html;
}

// ----- Reports (Engine/Reports.swift)

const REPORTS = {
  pl: ['Profit & Loss', 'chart', 'Income less costs for a span of dates.'],
  byProject: ['Profit by Project', 'folder', 'Income, costs and profit for each project, and the company’s overhead.'],
  bs: ['Balance Sheet', 'bank', 'What you own and owe on a date.'],
  ap: ['Bills to Pay (A/P Aging)', 'doc', 'Unpaid bills by how late they are.'],
  ar: ['Owed to You (A/R Aging)', 'mail', 'Unpaid invoices by how late they are.'],
  vendors: ['Vendor Payments & 1099s', 'people', 'What each vendor was paid, and who gets a 1099-NEC.'],
  cash: ['Money In and Out', 'banknote', 'Bank money in and out by month, for the last year.'],
  jobCost: ['Job Cost (Budget vs Actual)', 'hammer', 'Each budget line against what’s billed and paid.'],
  drawRecon: ['Draw Reconciliation', 'banknote', 'Lender draws received next to the work billed and paid.'],
};
const COMPANY_REPORTS = ['pl', 'byProject', 'bs', 'ap', 'ar', 'vendors', 'cash'];
const projectReports = (p) => ['jobCost', ...(p.kind === 'clientJob' ? [] : ['drawRecon']), 'pl', 'ap', 'vendors'];

function reportList(scope) {
  const p = scope === 'all' ? null : project(scope);
  const kinds = p ? projectReports(p) : COMPANY_REPORTS;
  const href = (k) => (p ? `#/project/${key(p.id)}/reports` : `#/books/report/${k}`);
  return `<section class="card flush">${kinds.map((k) => `<${p ? `button class="row" data-act="project-report" data-project="${esc(key(p.id))}" data-kind="${k}"` : `a class="row" href="${href(k)}"`}>${icon(REPORTS[k][1], 'ic glyph', '--tint:var(--plum)')}
    <div class="main"><div class="t">${esc(REPORTS[k][0])}</div><div class="s">${esc(REPORTS[k][2])}</div></div>${icon('chev', 'ic chev')}</${p ? 'button' : 'a'}>`).join('')}</section>`;
}

function reportOptions(kind) {
  S.ui.reportOpts = S.ui.reportOpts || {};
  return (S.ui.reportOpts[kind] = S.ui.reportOpts[kind] || { preset: kind === 'vendors' ? 'thisYear' : 'thisYear', filter: 'all', asOf: fmt.inputDate(new Date()) });
}
function reportControls(kind, scope) {
  const o = reportOptions(kind);
  const parts = [];
  if (['pl', 'byProject', 'vendors'].includes(kind)) parts.push(`<select class="input" data-act="report-opt" data-kind="${kind}" data-field="preset">${Object.entries(DATE_PRESETS).map(([k, l]) => `<option value="${k}" ${k === o.preset ? 'selected' : ''}>${l}</option>`).join('')}</select>`);
  if (['bs', 'ap', 'ar'].includes(kind)) parts.push(`<label class="inline-date"><span>As of</span><input class="input" type="date" data-act="report-opt" data-kind="${kind}" data-field="asOf" value="${esc(o.asOf)}"></label>`);
  if (scope === 'all' && ['pl', 'bs', 'ap', 'ar', 'vendors'].includes(kind)) {
    const jobs = projects().slice().sort((a, b) => projectName(a).localeCompare(projectName(b)));
    parts.push(`<select class="input" data-act="report-opt" data-kind="${kind}" data-field="filter"><option value="all">All projects and company</option><option value="company" ${o.filter === 'company' ? 'selected' : ''}>Company overhead only</option>${jobs.map((p) => `<option value="${esc(key(p.id))}" ${o.filter === key(p.id) ? 'selected' : ''}>${esc(projectName(p))}</option>`).join('')}</select>`);
  }
  return parts.length ? `<div class="filters">${parts.join('')}</div>` : '';
}

function sectionCard(section, { negative = false } = {}) {
  if (!section.lines.length) return '';
  return kvCard(section.title, section.lines.map((l) => kvLine(esc(l.name), fmt.money(negative ? -l.amount : l.amount, true))).join('') + kvTotal(`Total ${section.title.toLowerCase()}`, fmt.money(section.total, true)));
}

function reportBody(kind, scope) {
  const o = reportOptions(kind);
  const filter = scope === 'all' ? (o.filter || 'all') : scope;
  const asOf = parseInputDate(o.asOf) || new Date();
  if (kind === 'pl') {
    const r = profitAndLoss(presetRange(o.preset), filter);
    if (![r.income, r.jobCosts, r.expenses, r.otherIncome, r.otherExpenses].some((s) => s.lines.length)) return emptyState('chart', 'Nothing in These Dates', 'Try a wider date range.');
    return sectionCard(r.income) + sectionCard(r.jobCosts) + kvCard('Gross Profit', kvTotal('Income less job costs', fmt.money(r.grossProfit, true), profitTint(r.grossProfit)))
      + sectionCard(r.expenses) + sectionCard(r.otherIncome) + sectionCard(r.otherExpenses)
      + kvCard('Net Income', kvTotal('Net income', fmt.money(r.netIncome, true), profitTint(r.netIncome)));
  }
  if (kind === 'byProject') {
    const range = presetRange(o.preset);
    const cols = [...projects().map((p) => ({ id: p.id, name: projectName(p) })), { id: 'company', name: 'Company overhead' }];
    const rows = cols.map((c) => ({ ...c, r: profitAndLoss(range, c.id === 'company' ? 'company' : c.id) }))
      .filter(({ id, r }) => id === 'company' || [r.income, r.jobCosts, r.expenses, r.otherIncome, r.otherExpenses].some((s) => s.lines.length));
    const total = profitAndLoss(range, 'all');
    return `<section class="card flush">${rows.map(({ id, name, r }) => `<${id === 'company' ? 'div class="row static"' : `a class="row" href="#/project/${esc(key(id))}/billing"`}>
      <div class="main"><div class="t">${esc(name)}</div><div class="s">Income ${esc(fmt.money(r.income.total + r.otherIncome.total))} · Costs ${esc(fmt.money(r.jobCosts.total + r.expenses.total + r.otherExpenses.total))}</div></div>
      <div class="end"><span class="amt" style="${r.netIncome < 0 ? 'color:var(--danger)' : ''}">${esc(fmt.money(r.netIncome))}</span><span>net</span></div></${id === 'company' ? 'div' : 'a'}>`).join('')}</section>`
      + kvCard('Total', kvLine('Income', fmt.money(total.income.total + total.otherIncome.total, true)) + kvLine('Job costs', fmt.money(total.jobCosts.total, true)) + kvLine('Overhead and other expenses', fmt.money(total.expenses.total + total.otherExpenses.total, true)) + kvTotal('Net income', fmt.money(total.netIncome, true), profitTint(total.netIncome)));
  }
  if (kind === 'bs') {
    const r = balanceSheet(asOf, filter);
    return sectionCard(r.assets) + sectionCard(r.liabilities) + sectionCard(r.equity)
      + kvCard('Check', kvLine('Total assets', fmt.money(r.totalAssets, true)) + kvLine('Liabilities and equity', fmt.money(r.totalLiabilitiesAndEquity, true)) + (r.isBalanced ? '' : kvLine('Out of balance by', fmt.money(r.totalAssets - r.totalLiabilitiesAndEquity, true), 'alert-text')));
  }
  if (kind === 'ap' || kind === 'ar') {
    const r = agingReport(kind === 'ap' ? 'payables' : 'receivables', asOf, filter);
    if (!r.rows.length) return emptyState('checkCircle', kind === 'ap' ? 'No Unpaid Bills' : 'Nothing Owed to You', 'Nothing was open on that date.');
    let html = `<div class="tiles aging">${AGING_BUCKETS.map((b, i) => tile(b, fmt.money(r.totals[i]), '', { accent: i === 0 ? 'var(--forest)' : i >= 3 ? 'var(--danger)' : 'var(--warning)' })).join('')}</div>`;
    for (const row of r.rows) {
      html += card(row.name, row.items.map((i) => agingItemRow(i, kind, scope)).join(''),
        { action: `<span class="card-total">${esc(fmt.money(row.total, true))}</span>` });
    }
    return html + kvCard('Total', kvTotal(kind === 'ap' ? 'Bills to pay' : 'Owed to you', fmt.money(r.total, true)));
  }
  if (kind === 'vendors') {
    const r = vendorPaymentsReport(presetRange(o.preset), filter);
    if (!r.rows.length) return emptyState('people', 'No Vendor Payments', 'Nothing was paid to vendors in these dates.');
    const need = r.rows.filter((x) => x.needs1099);
    const noW9 = need.filter((x) => !x.w9OnFile);
    let html = '';
    if (noW9.length) html += banner(`${plural(noW9.length, 'vendor')} over the ${fmt.money(r.threshold)} 1099 line ${noW9.length === 1 ? 'has' : 'have'} no W-9 on file: ${noW9.slice(0, 3).map((x) => x.name).join(', ')}${noW9.length > 3 ? '…' : ''}.`);
    html += `<p class="note" style="margin:-4px 4px 10px">${esc(`${plural(need.length, 'vendor')} ${need.length === 1 ? 'gets' : 'get'} a 1099-NEC for ${r.year} (paid ${fmt.money(r.threshold)} or more, not counting card payments).`)}</p>`;
    html += `<section class="card flush">${r.rows.map((x) => `<${x.contactID ? `a class="row" href="#/contact/${esc(key(x.contactID))}"` : 'div class="row static"'}><div class="main"><div class="t">${esc(x.name)}</div><div class="s">${esc([plural(x.count, 'payment'), x.byCard ? `${fmt.money(x.byCard)} by card` : '', x.is1099 ? (x.w9OnFile ? 'W-9 on file' : 'No W-9') : 'No 1099'].filter(Boolean).join(' · '))}</div></div>
      <div class="end"><span class="amt">${esc(fmt.money(x.total, true))}</span>${x.needs1099 ? pill('1099', x.w9OnFile ? 'var(--forest)' : 'var(--warning)') : ''}</div></${x.contactID ? 'a' : 'div'}>`).join('')}</section>`;
    return html + kvCard('Total', kvTotal('Paid to vendors', fmt.money(r.total, true)));
  }
  if (kind === 'cash') {
    const rows = cashByMonth(12, filter);
    return card('Last 12 Months', `<div style="padding:0 16px 10px">${cashChart(rows)}</div>`) + `<section class="card flush">${rows.slice().reverse().map((r) => `<div class="row static"><div class="main"><div class="t">${esc(fmt.month(r.month))}</div><div class="s">In ${esc(fmt.money(r.moneyIn))} · Out ${esc(fmt.money(r.moneyOut))}</div></div><div class="end"><span class="amt" style="${r.net < 0 ? 'color:var(--danger)' : ''}">${esc(fmt.money(r.net))}</span><span>net</span></div></div>`).join('')}</section>`;
  }
  const p = project(scope);
  if (kind === 'jobCost' && p) return jobCostReport(p);
  if (kind === 'drawRecon' && p) return drawReconReport(p);
  return '';
}

/** One bill or invoice on an aging report, or a credit not used yet (it counts against them). */
function agingItemRow(i, kind, scope) {
  const late = !i.isCredit && i.daysPastDue > 0;
  const what = i.isCredit ? (kind === 'ap' ? 'Vendor credit' : 'Credit memo') : (kind === 'ap' ? 'Bill' : 'Invoice');
  const when = i.isCredit ? 'Not used yet' : late ? `${plural(i.daysPastDue, 'day')} late` : `Due ${fmt.short(fromSec(i.dueDate))}`;
  return `<button class="row" data-act="txn-open" data-id="${esc(key(i.id))}"><div class="main"><div class="t">${esc(`${what}${i.number ? ` ${i.number}` : ''}`)}</div><div class="s">${esc([fmt.date(fromSec(i.date)), when, scope === 'all' ? projectLabel(i.projectID) : ''].filter(Boolean).join(' · '))}</div></div><div class="end"><span class="amt" style="${late ? 'color:var(--danger)' : ''}">${esc(fmt.money(i.balance, true))}</span></div></button>`;
}

function viewReport(kind, scope, back) {
  if (!REPORTS[kind]) kind = 'pl';
  setHeader({ title: REPORTS[kind][0], sub: scope === 'all' ? 'Company' : projectLabel(scope), back });
  return reportControls(kind, scope) + `<div id="report-body">${reportBody(kind, scope)}</div>`;
}

function jobCostReport(p) {
  const jc = jobCost(p);
  const t = budgetTotals(p);
  if (!(p.budget || []).length) return emptyState('hammer', 'No Budget Yet', 'Job cost compares each budget line with what’s billed against it. Set up the budget on the Mac.');
  let html = '';
  for (const c of budgetCategories(p)) {
    const lines = (p.budget || []).filter((b) => (b.category ?? 'General') === c);
    html += card(c, lines.map((b) => {
      const total = budgetItemTotal(b);
      const billed = jc.billedByItem.get(key(b.id)) || 0;
      const paid = jc.paidByItem.get(key(b.id)) || 0;
      const over = billed > total + 0.5;
      return `<button class="row" data-act="budget-line" data-project="${esc(key(p.id))}" data-id="${esc(key(b.id))}"><div class="main"><div class="t">${esc((b.name || '').trim() || '(unnamed item)')}</div>
        <div class="s">Budget ${esc(fmt.money(total))} · Billed <span class="${over ? 'alert-text' : ''}">${esc(fmt.money(billed))}</span> · Paid ${esc(fmt.money(paid))}${b.percentComplete ? ` · ${Math.round(b.percentComplete)}% done` : ''}</div></div>
        <div class="end"><span class="amt" style="${over ? 'color:var(--danger)' : ''}">${esc(signedMoney(money(total - billed), false))}</span><span>${over ? 'over' : 'left'}</span></div></button>`;
    }).join(''));
  }
  // On a quick rehab estimate the total is the estimate's; the lines are as they stand so far.
  const budgetLines = t.quick ? kvLine('Budget lines so far (not used yet)', fmt.money(t.lines)) + kvLine('Quick estimate', fmt.money(t.base)) : kvLine('Budget lines', fmt.money(t.base));
  html += kvCard('Totals', budgetLines + kvLine('Contingency', fmt.money(t.contingency)) + kvTotal(t.quick ? 'Budget (estimate)' : 'Budget', fmt.money(t.total))
    + kvLine('Billed on lines', fmt.money(jc.billedOnLines)) + (jc.unlinkedRehab ? kvLine('Billed, not on a line', fmt.money(jc.unlinkedRehab)) : '') + kvTotal('Left in the budget', fmt.money(money(t.total - jc.rehabBilled)), profitTint(t.total - jc.rehabBilled)));
  return html;
}

function drawReconReport(p) {
  const m = projectMoney(p);
  const deal = dealNumbers(p);
  if (!deal.draws.length) return emptyState('banknote', 'No Draw Schedule', 'The draw schedule is set up on the Mac (Money › Draws).');
  let html = `<section class="card flush">${deal.draws.map((line, i) => {
    const r = m.drawLines[i];
    return `<div class="row static"><div class="main"><div class="t">${esc(line.title)}</div>
      <div class="s">Scheduled ${esc(fmt.money(r.scheduled))} · Funded ${esc(fmt.money(r.fundedGross))}${r.fees ? ` (less ${esc(fmt.money(r.fees))} fees)` : ''}</div>
      <div class="s">Work billed ${esc(fmt.money(r.workBilled))} · Paid ${esc(fmt.money(r.workPaid))}</div></div>
      <div class="end">${pill(DRAW_STATUS[line.status]?.[0] || 'Planned', DRAW_STATUS[line.status]?.[1] || 'var(--stone)')}</div></div>`;
  }).join('')}</section>`;
  html += kvCard('Totals', kvLine('Scheduled', fmt.money(m.drawLines.reduce((s, r) => s + r.scheduled, 0))) + kvLine('Funded', fmt.money(m.drawsReceived)) + kvLine('Lender fees kept', fmt.money(m.drawFees))
    + kvLine('Received after fees', fmt.money(m.drawsNet)) + kvLine('Rehab paid', fmt.money(m.rehabPaid)) + kvTotal(m.drawCashPosition < 0 ? 'Paid ahead of the draws' : 'Draw cash not yet spent', fmt.money(Math.abs(m.drawCashPosition)), m.drawCashPosition < 0 ? 'var(--danger)' : ''));
  return html;
}

// ---------------------------------------------------------------------------
// A project's Money section

function projectBilling(p) {
  const m = projectMoney(p);
  const pid = key(p.id);
  let html = '<div class="tiles four">';
  html += tile('Spent to Date', fmt.money(m.totalCosts), 'All costs entered', { accent: 'var(--gold)' });
  html += tile('Unpaid Bills', fmt.money(m.openBills), m.overdueBillCount ? `${m.overdueBillCount} of ${m.openBillCount} overdue` : `${m.openBillCount} open`, { accent: 'var(--leather)', tint: m.overdueBillCount ? 'var(--danger)' : '' });
  if (p.kind === 'clientJob') {
    const f = clientFinancials(p);
    const overdue = all('transaction').some((t) => sameId(t.projectID, p.id) && t.type === 'invoice' && txnOverdue(t));
    html += tile('Client Owes', fmt.money(f.openInvoices), f.retainageReceivable > 0 ? `Plus ${fmt.money(f.retainageReceivable)} retainage` : `${fmt.money(f.received)} received`, { accent: 'var(--slate)', tint: overdue ? 'var(--danger)' : '' });
  } else {
    html += tile('Draws Received', fmt.money(m.drawsReceived), `${fmt.money(m.drawFees)} kept in fees`, { accent: 'var(--forest)' });
  }
  html += tile('Waivers Needed', String(m.missingWaivers), fmt.money(m.missingWaiverAmount), { accent: 'var(--olive)', tint: m.missingWaivers ? 'var(--danger)' : '' });
  html += '</div>';
  const bills = all('transaction').filter((t) => sameId(t.projectID, p.id) && t.type === 'bill' && txnOpen(t)).sort((a, b) => (a.dueDate ?? a.date) - (b.dueDate ?? b.date));
  html += card('Bills to Pay', bills.length ? bills.slice(0, 8).map((t) => billDueRow(t, { showProject: false })).join('') : allClear('No unpaid bills.'), { action: bills.length ? `<button class="btn link" data-act="txn-show" data-scope="${esc(pid)}" data-type="bills" data-status="open">See All</button>` : '' });
  const waivers = lienWaiverReport(p.id);
  const openW = waivers.items.filter((i) => !i.isComplete);
  html += card('Lien Waivers to Collect', openW.length ? openW.slice(0, 8).map((i) => waiverRow(i, { showProject: false })).join('') : allClear(waivers.items.length ? 'Every waiver is in.' : 'No payments need a lien waiver yet.'), { action: cardLink('See All', `#/project/${pid}/lienWaivers`) });
  if (p.kind === 'clientJob') {
    const f = clientFinancials(p);
    html += kvCard('Contract vs Cost', kvLine('Contract (with approved changes)', fmt.money(f.contractTotal)) + kvLine('Budgeted cost', fmt.money(f.estimatedCost)) + kvLine('Cost to date', fmt.money(f.costToDate))
      + kvLine('Committed to subs and suppliers', fmt.money(f.committed)) + kvLine('Cost to finish', fmt.money(f.costToComplete))
      + kvTotal('Projected profit', `${fmt.money(f.projectedProfit)} (${(f.projectedMargin * 100).toFixed(1)}%)`, profitTint(f.projectedProfit))
      + kvLine(f.overUnderBilled >= 0 ? 'Billed ahead of the work' : 'Work not yet billed', fmt.money(Math.abs(f.overUnderBilled))));
  } else {
    const groups = m.groups.filter((g) => g.estimate || g.actual);
    html += card('Budget vs Actual', `<div class="bva"><div class="bva-row head"><span></span><span>Budget</span><span>Actual</span><span>Under (Over)</span></div>${groups.map((g) => `<div class="bva-row"><span>${esc(g.label)}</span><span>${esc(fmt.money(g.estimate))}</span><span>${esc(fmt.money(g.actual))}</span><span style="${g.variance < -0.005 ? 'color:var(--danger)' : ''}">${esc(signedMoney(g.variance, false))}</span></div>`).join('')}
      <div class="bva-row total"><span>Total</span><span>${esc(fmt.money(m.estimateTotal))}</span><span>${esc(fmt.money(m.actualTotal))}</span><span style="${m.estimateTotal - m.actualTotal < -0.005 ? 'color:var(--danger)' : ''}">${esc(signedMoney(money(m.estimateTotal - m.actualTotal), false))}</span></div>
      <p class="note">Budget is the deal estimate. Over is in parentheses.</p></div>`, { action: `<button class="btn link" data-act="project-report" data-project="${esc(pid)}" data-kind="jobCost">See Report</button>` });
  }
  const top = m.costsByAccount.slice().sort((a, b) => b.amount - a.amount);
  html += kvCard('Costs by Account', top.length ? top.slice(0, 9).map((x) => kvLine(esc(x.name), fmt.money(x.amount))).join('') + (top.length > 9 ? kvLine('Everything else', fmt.money(top.slice(9).reduce((s, x) => s + x.amount, 0))) : '') + kvTotal('Total', fmt.money(m.totalCosts))
    : '<div class="empty-line" style="padding:4px 0 10px">Nothing entered yet.</div>');
  const recent = all('transaction').filter((t) => sameId(t.projectID, p.id)).sort((a, b) => (b.date || 0) - (a.date || 0)).slice(0, 10);
  html += card('Recent Activity', recent.length ? recent.map((t) => ledgerTxnRow(t, { showProject: false })).join('') : '<div class="empty-line">Nothing entered for this project yet.</div>', { action: recent.length ? cardLink('See All', `#/project/${pid}/transactions`) : '' });
  return html;
}

function projectDraws(p) {
  const deal = dealNumbers(p);
  const m = projectMoney(p);
  const work = p.kind === 'flip' ? 'Rehab' : 'Construction';
  let html = `<div class="tiles four">
    ${tile(`${work} Holdback`, fmt.money(deal.holdback), plural(deal.draws.length, 'draw') + ' planned')}
    ${tile('Funded to Date', fmt.money(deal.fundedToDate), '', { accent: 'var(--forest)' })}
    ${tile('Holdback Remaining', fmt.money(deal.remainingHoldback), 'Still to come from the lender', { accent: 'var(--slate)' })}
    ${tile('Draw Cash Not Yet Spent', fmt.money(m.drawCashPosition), m.drawCashPosition < 0 ? "You've paid ahead of the draws" : `After ${fmt.money(m.drawFees)} in lender fees`, { accent: 'var(--forest)', tint: profitTint(m.drawCashPosition) })}
  </div>`;
  if (m.hasUnrecordedFunding) html += banner('A draw is marked funded but isn’t in the books yet. Record Draw Received on the Mac so the loan balance stays right.');
  if (deal.usesRehabEstimate && deal.draws.length) html += banner('The deal uses the quick rehab estimate, so the draws have no amounts yet. Each draw is sized from its budget lines once they’re used (on the Mac: Budget › Use Budget Lines).', 'var(--slate)');
  if (!deal.draws.length) return html + emptyState('banknote', 'No Draw Schedule', 'Set up the draws on the Mac (Money › Draws › Load Standard Draw Plan). Each one shows here with what’s been funded and billed.');
  deal.draws.forEach((line, i) => {
    const r = m.drawLines[i];
    const files = all('file').filter((f) => sameId(f.drawID, line.id) && sameId(f.projectID, p.id)).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    const st = DRAW_STATUS[line.status] || DRAW_STATUS.planned;
    let funded = '';
    if (line.status === 'funded' || r.isFunded) {
      funded = `Funded${r.receivedDate ? ` ${fmt.date(fromSec(r.receivedDate))}` : ''}${r.fundedGross ? ` · ${fmt.money(r.fundedGross)}` : ''}${r.fees ? ` (${fmt.money(r.fees)} fees)` : ''}`;
    }
    let body = '<div style="padding:0 16px">';
    body += kvLine('Work value', fmt.money(line.total)) + kvLine('Lender funds', fmt.money(line.financed)) + kvLine('Lender funds to date', fmt.money(line.cumulativeFinanced));
    if (line.milestone.trim()) body += kvLine('Release when', line.milestone.trim());
    if (line.targetDate) body += kvLine('Target', `${trimNum(line.weeksAfterClose)} weeks after closing · ${fmt.date(line.targetDate)}`);
    if (funded) body += kvLine('Funded', funded.replace(/^Funded ?/, '') || 'Yes');
    else {
      if (line.requestedDate != null) body += kvLine('Requested', fmt.date(fromSec(line.requestedDate)));
      body += kvLine('Request', fmt.money(line.requestAmount) + (line.requestedAmount ? '' : ' (scheduled)'));
    }
    body += kvLine('Work billed / paid', `${fmt.money(r.workBilled)} / ${fmt.money(r.workPaid)}`);
    if (line.inspectionNotes.trim()) body += `<div class="kv"><span>Notes</span><span style="white-space:pre-wrap">${esc(line.inspectionNotes)}</span></div>`;
    body += '</div>';
    if (files.length) body += `<div class="grid draw-files" style="margin:4px 16px 10px">${files.map((f) => thumbCell(f, `draw:${key(line.id)}`)).join('')}</div>`;
    body += `<details class="draw-items"><summary>${plural(line.items.length, 'budget item')} in this draw</summary>${line.items.length ? line.items.map((b) => `<div class="kv"><span>${esc((b.name || '').trim() || 'Untitled')} <span class="muted small">${esc(b.category ?? '')}</span></span><span>${esc(fmt.money(budgetItemTotal(b)))}</span></div>`).join('') + (line.contingency > 0.5 ? `<div class="kv"><span class="muted">Contingency allocation</span><span>${esc(fmt.money(line.contingency))}</span></div>` : '') : '<p class="note">No budget items assigned.</p>'}</details>`;
    body += `<div class="btn-row" style="padding:0 16px 14px"><button class="btn sm" data-act="draw-edit" data-project="${esc(key(p.id))}" data-id="${esc(key(line.id))}">${icon('edit')}Update</button><button class="btn sm" data-act="draw-attach" data-project="${esc(key(p.id))}" data-id="${esc(key(line.id))}">${icon('camera')}Add Photos</button></div>`;
    html += `<section class="card flush"><div class="card-head"><h2>${icon('banknote', 'ic head-ic')}${esc(line.title)}</h2>${pill(st[0], st[1])}</div>${body}</section>`;
  });
  if (deal.unassignedItems.length) html += `<p class="note" style="margin:0 4px 14px">${plural(deal.unassignedItems.length, 'budget line')} ${deal.unassignedItems.length === 1 ? "isn't" : "aren't"} in a draw yet.</p>`;
  return html;
}

function sheetDraw(projectID, drawID) {
  const p = project(projectID);
  const x = (p?.draws || []).find((d) => sameId(d.id, drawID));
  if (!x) return;
  const line = dealNumbers(p).draws.find((d) => sameId(d.id, drawID));
  const funded = x.status === 'funded';
  openSheet(`${sheetHead(line.title, projectName(p))}
    <form id="draw-form" data-project="${esc(key(p.id))}" data-id="${esc(key(x.id))}">
      <div class="form-section"><div class="fs-head">Status</div>
        ${funded ? '<p class="note" style="margin:0 4px">Funded. That comes from the deposit recorded on the Mac.</p>' : `<div class="segmented">${['planned', 'requested', 'inspected'].map((k) => `<button type="button" data-act="draw-status" data-status="${k}" class="${(x.status || 'planned') === k ? 'on' : ''}">${DRAW_STATUS[k][0]}</button>`).join('')}</div>`}
        <input type="hidden" name="status" value="${esc(x.status || 'planned')}"></div>
      <div class="form-section"><div class="form-card">
        ${funded ? '' : `<label class="field"><span>Request amount</span><input name="requestedAmount" type="number" inputmode="decimal" step="0.01" min="0" value="${x.requestedAmount ? esc(x.requestedAmount) : ''}" placeholder="${esc(fmt.money(line.financed))} scheduled"></label>`}
        <label class="field"><span>Inspection notes</span><textarea name="inspectionNotes" rows="2" placeholder="Inspection notes, holdbacks, conditions">${esc(x.inspectionNotes || '')}</textarea></label>
      </div><div class="fs-foot">Requested or Inspected sets today as the request date, as on the Mac.</div></div>
      <div class="sheet-actions"><button type="button" class="btn" data-act="sheet-close">Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </form>`);
}

function projectTransactions(p) { return transactionList(key(p.id)); }
function projectWaivers(p) { return waiverList(key(p.id)); }
function projectReportsPage(p) {
  const kind = S.ui.projectReport?.[key(p.id)];
  if (kind && REPORTS[kind]) {
    return `<div class="page-bar"><button class="btn link" data-act="project-report" data-project="${esc(key(p.id))}" data-kind="">${icon('back')}All Reports</button><span class="count small">${esc(REPORTS[kind][0])}</span></div>`
      + reportControls(kind, key(p.id)) + `<div id="report-body">${reportBody(kind, key(p.id))}</div>`;
  }
  return reportList(key(p.id));
}

Object.assign(PROJECT_PAGES, {
  billing: ['Summary', (p) => projectBilling(p)],
  draws: ['Draws', (p) => projectDraws(p)],
  transactions: ['Transactions', (p) => projectTransactions(p)],
  lienWaivers: ['Lien Waivers', (p) => projectWaivers(p)],
  reports: ['Reports', (p) => projectReportsPage(p)],
});

// ---------------------------------------------------------------------------
// Edits made from the field: a payment's lien waiver, a draw's status and notes

Object.assign(RECORD_OPS, {
  setWaiver(t, { paymentID, waiver }) {
    if (paymentID) {
      const pay = (t.payments || []).find((x) => sameId(x.id, paymentID));
      if (pay) pay.waiver = { ...(pay.waiver || {}), ...waiver };
    } else t.waiver = { ...(t.waiver || {}), ...waiver };
    for (const k of ['documentID', 'receivedDate']) {
      const target = paymentID ? (t.payments || []).find((x) => sameId(x.id, paymentID))?.waiver : t.waiver;
      if (target && target[k] == null) delete target[k];
    }
  },
  updateDraw(p, { id, status, inspectionNotes, requestedAmount, requestedDate }) {
    const x = (p.draws || []).find((d) => sameId(d.id, id));
    if (!x) return;
    if (status && x.status !== 'funded') x.status = status;
    if (inspectionNotes != null) x.inspectionNotes = inspectionNotes;
    if (requestedAmount != null && x.status !== 'funded') x.requestedAmount = requestedAmount;
    if (requestedDate != null && x.requestedDate == null) x.requestedDate = requestedDate;
  },
});

Object.assign(ACTIONS, {
  'txn-filter': () => {},
  'txn-clear': (el) => { S.ui.txnFilters[el.dataset.scope] = null; render(); },
  'txn-more': (el) => { txnFilter(el.dataset.scope).limit += 100; $('#txn-results').innerHTML = transactionResults(el.dataset.scope); },
  'txn-show': (el) => {
    const scope = el.dataset.scope;
    S.ui.txnFilters = S.ui.txnFilters || {};
    S.ui.txnFilters[scope] = { type: el.dataset.type || 'all', status: el.dataset.status || 'all', preset: 'allDates', q: '', limit: 100 };
    location.hash = scope === 'all' ? '#/books/transactions' : `#/project/${scope}/transactions`;
  },
  'register-more': (el) => { S.ui.registerLimit = { ...(S.ui.registerLimit || {}), [el.dataset.id]: (S.ui.registerLimit?.[el.dataset.id] || 150) + 300 }; render(); },
  'report-opt': () => {},
  'project-report': (el) => {
    S.ui.projectReport = { ...(S.ui.projectReport || {}), [el.dataset.project]: el.dataset.kind || null };
    const target = `#/project/${el.dataset.project}/reports`;
    if (location.hash !== target) location.hash = target; else render();
    window.scrollTo(0, 0);
  },
  'waiver-open': (el) => sheetWaiver(el.dataset.txn, el.dataset.payment || null),
  'waiver-status': (el) => {
    const f = $('#waiver-form');
    f.elements.status.value = el.dataset.status;
    $$('[data-act="waiver-status"]', f).forEach((b) => b.classList.toggle('on', b === el));
    sheetDirty = true;
  },
  'waiver-scope': (el) => {
    const f = $('#waiver-form');
    f.elements.scope.value = el.dataset.scope;
    $$('[data-act="waiver-scope"]', f).forEach((b) => b.classList.toggle('on', b === el));
    sheetDirty = true;
  },
  'waiver-attach': (el) => {
    const f = $('#waiver-form');
    const t = get(f.dataset.txn);
    if (!t) return;
    pickFiles({ accept: el.dataset.capture ? 'image/*' : 'image/*,application/pdf', capture: !!el.dataset.capture, multiple: false }, async (files) => {
      const ids = [];
      await addFiles(files, { projectID: t.projectID || null, category: 'lienWaiver', contactID: t.contactID || null, transactionID: t.id, ids });
      const form = $('#waiver-form');
      if (!ids.length || !form) return;
      form.dataset.doc = ids[0];
      const doc = get(ids[0]);
      $('#waiver-doc', form).innerHTML = doc ? `<section class="card flush">${fileRow(doc)}</section>` : '';
      if (form.elements.status.value === 'needed') $(`[data-act="waiver-status"][data-status="unconditional"]`, form).click();
      sheetDirty = true;
    });
  },
  'draw-edit': (el) => sheetDraw(el.dataset.project, el.dataset.id),
  'draw-status': (el) => {
    const f = $('#draw-form');
    f.elements.status.value = el.dataset.status;
    $$('[data-act="draw-status"]', f).forEach((b) => b.classList.toggle('on', b === el));
    sheetDirty = true;
  },
  'draw-attach': (el) => {
    const p = project(el.dataset.project);
    if (!p) return;
    pickFiles({ accept: 'image/*,application/pdf', capture: false, multiple: true }, async (files) => {
      const pdfOnly = [...files].every((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
      await addFiles(files, { projectID: p.id, category: pdfOnly ? 'drawPaperwork' : 'progressPhoto', drawID: el.dataset.id });
    });
  },
});

// Filters and searches redraw only the list, so typing isn't interrupted.
document.addEventListener('input', (e) => {
  if (e.target.id === 'txn-search') {
    const scope = e.target.dataset.scope;
    const f = txnFilter(scope);
    f.q = e.target.value; f.limit = 100;
    $('#txn-results').innerHTML = transactionResults(scope);
  }
  if (e.target.id === 'waiver-search') {
    S.ui.waiverSearch = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const input = $('#waiver-search');
    if (input) { input.focus(); input.setSelectionRange(pos, pos); }
  }
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset?.act === 'txn-filter') {
    const f = txnFilter(el.dataset.scope);
    f[el.dataset.field] = el.value; f.limit = 100;
    $('#txn-results').innerHTML = transactionResults(el.dataset.scope);
  }
  if (el.dataset?.act === 'report-opt') {
    reportOptions(el.dataset.kind)[el.dataset.field] = el.value;
    const r = route();
    const scope = r.name === 'project' ? key(r.a) : 'all';
    $('#report-body').innerHTML = reportBody(el.dataset.kind, scope);
  }
});

document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (f.id === 'waiver-form') {
    e.preventDefault();
    e.stopImmediatePropagation();
    const status = f.elements.status.value;
    const t = get(f.dataset.txn);
    const pay = t && findPayment(t, f.dataset.payment || null);
    if (!pay) { closeSheet(); return; }
    const waiver = { status, scope: f.elements.scope.value || 'progress' };
    if (f.dataset.doc) waiver.documentID = f.dataset.doc;
    // Received waivers keep the day they came in (setWaiverStatus on the Mac).
    if (status === 'conditional' || status === 'unconditional') waiver.receivedDate = pay.waiver.receivedDate ?? stamp();
    const saved = await editRecord('transaction', t.id, [{ op: 'setWaiver', paymentID: f.dataset.payment ? pay.id : null, waiver }]);
    closeSheet();
    if (saved) toast('Saved');
  }
  if (f.id === 'draw-form') {
    e.preventDefault();
    e.stopImmediatePropagation();
    const status = f.elements.status.value;
    const op = { op: 'updateDraw', id: f.dataset.id, inspectionNotes: f.elements.inspectionNotes.value };
    if (status !== 'funded') {
      op.status = status;
      if (status !== 'planned') op.requestedDate = stamp();
      if (f.elements.requestedAmount) op.requestedAmount = money(Number(f.elements.requestedAmount.value) || 0);
    }
    const saved = await editProject(f.dataset.project, [op]);
    closeSheet();
    if (saved) toast('Saved');
  }
}, true);
