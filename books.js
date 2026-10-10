/* Eagle Creek — the books, worked out the Mac's way.
 *
 * The chart of accounts (the synced `books` record, or the Mac's default chart when it has
 * never been edited), the ledger (Engine/Ledger.swift: every bill, expense, invoice, deposit,
 * transfer and journal entry turned into balanced postings) and what's built on it: job cost
 * by budget line (Engine/ProjectFinancials.swift), the P&L, balance sheet, aging, lien waivers,
 * 1099 payments and cash by month (Engine/Reports.swift). Same rules and rounding as the Mac,
 * so every number here matches what the Mac shows. Nothing here changes the books.
 */
'use strict';

// ----- Ids that come out the same on every Mac (StableID in Models/Accounting.swift)

function stableID(text) {
  const M = (1n << 64n) - 1n;
  const P = 0x100000001b3n;
  let h1 = 0xcbf29ce484222325n;
  let h2 = 0x6c62272e07bb0142n;
  for (const byte of new TextEncoder().encode(text)) {
    h1 = ((h1 ^ BigInt(byte)) * P) & M;
    h2 = ((h2 ^ BigInt(byte)) * P) & M;
    h2 ^= h2 >> 29n;
  }
  h1 ^= h2 >> 17n;
  const b = [];
  for (let i = 0; i < 8; i++) b.push(Number((h1 >> BigInt(i * 8)) & 0xffn));
  for (let i = 0; i < 8; i++) b.push(Number((h2 >> BigInt(i * 8)) & 0xffn));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const chartID = (number) => stableID(`eaglecreek.account.${number}`);

// ----- Account types (AccountType, AccountSection, CostGroup)

const ACCOUNT_TYPES = ['bank', 'creditCard', 'accountsReceivable', 'otherAsset', 'fixedAsset', 'accountsPayable', 'otherLiability', 'loan',
  'equity', 'income', 'jobCost', 'expense', 'otherIncome', 'otherExpense'];
const ACCOUNT_TYPE_LABEL = {
  bank: 'Bank', creditCard: 'Credit Card', accountsReceivable: 'Accounts Receivable', otherAsset: 'Other Asset', fixedAsset: 'Fixed Asset',
  accountsPayable: 'Accounts Payable', otherLiability: 'Other Liability', loan: 'Loan', equity: 'Equity', income: 'Income', jobCost: 'Job Cost',
  expense: 'Expense', otherIncome: 'Other Income', otherExpense: 'Other Expense',
};
function typeSection(type) {
  switch (type) {
    case 'creditCard': case 'accountsPayable': case 'otherLiability': case 'loan': return 'liabilities';
    case 'bank': case 'accountsReceivable': case 'otherAsset': case 'fixedAsset': return 'assets';
    case 'equity': return 'equity';
    case 'income': return 'income';
    case 'jobCost': return 'jobCosts';
    case 'otherIncome': return 'otherIncome';
    case 'otherExpense': return 'otherExpenses';
    default: return 'expenses';
  }
}
const SECTION_LABEL = {
  assets: 'Assets', liabilities: 'Liabilities', equity: 'Equity', income: 'Income', jobCosts: 'Job Costs',
  expenses: 'Overhead Expenses', otherIncome: 'Other Income', otherExpenses: 'Other Expenses',
};
const DEBIT_NORMAL = new Set(['bank', 'accountsReceivable', 'otherAsset', 'fixedAsset', 'jobCost', 'expense', 'otherExpense']);
const isBalanceSheetType = (type) => ['assets', 'liabilities', 'equity'].includes(typeSection(type));
const isMoneyAccountType = (type) => type === 'bank' || type === 'creditCard';
const COST_GROUPS = { acquisition: 'Acquisition', rehab: 'Rehab', financing: 'Loan Costs', holding: 'Holding Costs', selling: 'Selling Costs', other: 'Other Project Costs' };
const SYSTEM_ROLES = ['accountsReceivable', 'accountsPayable', 'salesTaxPayable', 'openingBalanceEquity', 'retainedEarnings', 'uncategorizedIncome',
  'uncategorizedExpense', 'uncategorizedAsset', 'retainageReceivable', 'retainagePayable', 'payrollClearing', 'dueToOwner'];
const ROLE_NUMBER = {
  accountsReceivable: '1100', accountsPayable: '2000', salesTaxPayable: '2200', openingBalanceEquity: '3800', retainedEarnings: '3900',
  uncategorizedIncome: '4900', uncategorizedExpense: '6900', uncategorizedAsset: '1900', retainageReceivable: '1150', retainagePayable: '2050',
  payrollClearing: '2500', dueToOwner: '2600',
};

// The Mac's starting chart (DefaultChart.accounts()).
const DEFAULT_CHART = [
  ['1000', 'Operating Checking', 'bank'], ['1010', 'Savings', 'bank'],
  ['1100', 'Accounts Receivable', 'accountsReceivable', null, 'accountsReceivable'],
  ['1150', 'Retainage Receivable', 'otherAsset', null, 'retainageReceivable'],
  ['1200', 'Earnest Money Deposits', 'otherAsset'], ['1900', 'Uncategorized Asset', 'otherAsset', null, 'uncategorizedAsset'],
  ['2000', 'Accounts Payable', 'accountsPayable', null, 'accountsPayable'],
  ['2050', 'Retainage Payable', 'otherLiability', null, 'retainagePayable'],
  ['2100', 'Business Credit Card', 'creditCard'], ['2200', 'Sales Tax Payable', 'otherLiability', null, 'salesTaxPayable'],
  ['2300', 'Rehab Loans', 'loan'], ['2400', 'Private Money Loans', 'loan'],
  ['2500', 'Payroll Clearing', 'otherLiability', null, 'payrollClearing'],
  ['2600', 'Owed to Owner (Paid Personally)', 'otherLiability', null, 'dueToOwner'],
  ['3000', 'Owner Contributions', 'equity'], ['3100', 'Owner Distributions', 'equity'],
  ['3800', 'Opening Balance Equity', 'equity', null, 'openingBalanceEquity'], ['3900', 'Retained Earnings', 'equity', null, 'retainedEarnings'],
  ['4000', 'Property Sales', 'income'], ['4100', 'Rental Income', 'income'], ['4200', 'Construction & Service Income', 'income'],
  ['4900', 'Uncategorized Income', 'income', null, 'uncategorizedIncome'],
  ['5000', 'Purchase Price', 'jobCost', 'acquisition'], ['5010', 'Buy-Side Closing Costs', 'jobCost', 'acquisition'],
  ['5020', 'Acquisition & Assignment Fees', 'jobCost', 'acquisition'],
  ['5100', 'Rehab – Labor & Subcontractors', 'jobCost', 'rehab'], ['5110', 'Rehab – Materials', 'jobCost', 'rehab'],
  ['5120', 'Permits & Inspections', 'jobCost', 'rehab'], ['5130', 'Equipment Rental & Dumpsters', 'jobCost', 'rehab'],
  ['5140', 'Plans, Engineering & Survey', 'jobCost', 'rehab'], ['5145', 'Impact, Tap & Utility Fees', 'jobCost', 'rehab'],
  ['5150', 'Field Labor – Your Crew', 'jobCost', 'rehab'],
  ['5200', 'Loan Interest', 'jobCost', 'financing'], ['5210', 'Loan Points & Lender Fees', 'jobCost', 'financing'],
  ['5220', 'Draw & Inspection Fees', 'jobCost', 'financing'],
  ['5300', 'Property Taxes', 'jobCost', 'holding'], ['5310', 'Property Insurance', 'jobCost', 'holding'],
  ['5320', 'Utilities', 'jobCost', 'holding'], ['5330', 'Lawn, HOA & Maintenance', 'jobCost', 'holding'],
  ['5400', 'Sale Commissions', 'jobCost', 'selling'], ['5410', 'Sell-Side Closing Costs', 'jobCost', 'selling'],
  ['5420', 'Staging, Photos & Marketing', 'jobCost', 'selling'], ['5900', 'Other Job Costs', 'jobCost', 'other'],
  ['6000', 'Office, Software & Subscriptions', 'expense'], ['6100', 'Vehicle & Fuel', 'expense'], ['6200', 'Marketing & Deal Finding', 'expense'],
  ['6300', 'Legal & Accounting', 'expense'], ['6400', 'Bank & Merchant Fees', 'expense'], ['6500', 'Business Insurance', 'expense'],
  ['6600', 'Education & Dues', 'expense'], ['6700', 'Meals & Travel', 'expense'], ['6710', 'Travel – Air, Lodging & Car', 'expense'],
  ['6720', 'Business Meals (50%)', 'expense'], ['6730', 'Vehicle Mileage', 'expense'], ['6800', 'Shop & Office Labor', 'expense'],
  ['6900', 'Uncategorized Expense', 'expense', null, 'uncategorizedExpense'],
  ['7000', 'Other Income', 'otherIncome'], ['8000', 'Other Expenses', 'otherExpense'],
];
const ADDED_IN_V04 = ['1150', '2050', '2500', '5140', '5145', '5150', '6800', '6710', '6720', '6730'];
let defaultChartCache = null;
function defaultChart() {
  defaultChartCache = defaultChartCache || DEFAULT_CHART.map(([number, name, type, costGroup, systemRole]) => ({
    id: chartID(number), number, name, type, costGroup: costGroup || null, systemRole: systemRole || null, detail: '', lastFour: '',
    isArchived: false, openingBalance: 0, openingBalanceDate: null,
  }));
  return defaultChartCache.map((a) => ({ ...a }));
}

function readAccount(a) {
  return {
    id: String(a?.id || ''), number: String(a?.number ?? ''), name: String(a?.name ?? ''),
    type: ACCOUNT_TYPES.includes(a?.type) ? a.type : 'expense',
    costGroup: COST_GROUPS[a?.costGroup] ? a.costGroup : null, systemRole: SYSTEM_ROLES.includes(a?.systemRole) ? a.systemRole : null,
    detail: a?.detail || '', lastFour: a?.lastFour || '', isArchived: !!a?.isArchived,
    openingBalance: Number(a?.openingBalance) || 0, openingBalanceDate: a?.openingBalanceDate ?? null,
  };
}
const accountDisplayName = (a) => { const n = (a.name || '').trim() || 'Unnamed account'; return a.number ? `${a.number} · ${n}` : n; };

/** The books settings and chart, as the Mac would load them (Books + ensureDefaultAccounts). */
function booksSettings() {
  const rec = all('books').slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
  let accounts = Array.isArray(rec?.accounts) ? rec.accounts.map(readAccount).filter((a) => a.id) : defaultChart();
  if (rec && !Array.isArray(rec.accounts)) accounts = defaultChart();
  const deleted = new Set((rec?.deletedAccountIDs || []).map(key));
  const has = (id) => accounts.some((a) => sameId(a.id, id));
  const defaults = defaultChart();
  for (const number of ADDED_IN_V04) {
    const t = defaults.find((a) => a.number === number);
    if (deleted.has(key(t.id)) || has(t.id)) continue;
    if (t.systemRole && accounts.some((a) => a.systemRole === t.systemRole)) continue;
    accounts.push(t);
  }
  for (const role of SYSTEM_ROLES) {
    if (accounts.some((a) => a.systemRole === role)) continue;
    const t = defaults.find((a) => a.systemRole === role);
    const at = accounts.find((a) => sameId(a.id, t.id));
    if (at) at.systemRole = role; else accounts.push(t);
  }
  return {
    accounts,
    defaultBankAccountID: rec ? (rec.defaultBankAccountID ?? null) : chartID('1000'),
    lienWaiverThreshold: Number(rec?.lienWaiverThreshold) || 0,
    invoiceDueDays: rec?.invoiceDueDays ?? 15,
    closedThrough: rec?.closedThrough ?? null,
    reconciliations: rec?.reconciliations || [],
  };
}

// ----- The ledger (Engine/Ledger.swift)

function ledgerPostings(t, sys, payee) {
  if (t.isVoid) return [];
  const out = [];
  let seq = 0;
  const add = (accountID, amount, o = {}) => {
    const rounded = money(amount);
    if (Math.abs(rounded) < 0.005) return;
    seq += 1;
    out.push({
      id: `${String(t.id).toUpperCase()}-${seq}`, transactionID: t.id, paymentID: o.paymentID || null, type: t.type,
      date: o.date ?? t.date ?? 0, accountID: accountID || sys.uncategorizedAsset, amount: rounded, projectID: t.projectID || null,
      contactID: t.contactID || null, budgetItemID: o.budgetItemID || null, memo: o.memo || t.memo || '', number: o.number ?? (t.number || ''),
      payee, isCleared: !!o.cleared, isOpeningBalance: false,
    });
  };
  const lines = t.lines || [];
  const pays = t.payments || [];
  switch (t.type) {
    case 'bill':
      for (const l of lines) add(l.accountID || sys.uncategorizedExpense, l.amount, { memo: l.memo, budgetItemID: l.budgetItemID });
      add(sys.accountsPayable, -txnDue(t));
      add(sys.retainagePayable, -txnRetainage(t), { memo: 'Retainage held' });
      for (const p of pays) {
        add(sys.accountsPayable, p.amount, { date: p.date, memo: p.memo, paymentID: p.id, number: p.reference || '' });
        add(p.accountID || sys.defaultBank, -(Number(p.amount) || 0), { date: p.date, memo: p.memo, paymentID: p.id, number: p.reference || '', cleared: p.isCleared });
      }
      break;
    case 'expense':
      for (const l of lines) add(l.accountID || sys.uncategorizedExpense, l.amount, { memo: l.memo, budgetItemID: l.budgetItemID });
      add(t.accountID || sys.defaultBank, -txnTotal(t), { cleared: t.isCleared });
      break;
    case 'invoice':
      for (const l of lines) add(l.accountID || sys.uncategorizedIncome, -(Number(l.amount) || 0), { memo: l.memo, budgetItemID: l.budgetItemID });
      add(sys.salesTaxPayable, -txnTax(t), { memo: 'Sales tax' });
      add(sys.accountsReceivable, txnDue(t));
      add(sys.retainageReceivable, txnRetainage(t), { memo: 'Retainage held' });
      for (const p of pays) {
        add(p.accountID || sys.defaultBank, p.amount, { date: p.date, memo: p.memo, paymentID: p.id, number: p.reference || '', cleared: p.isCleared });
        add(sys.accountsReceivable, -(Number(p.amount) || 0), { date: p.date, memo: p.memo, paymentID: p.id, number: p.reference || '' });
      }
      break;
    case 'deposit':
      for (const l of lines) add(l.accountID || sys.uncategorizedIncome, -(Number(l.amount) || 0), { memo: l.memo, budgetItemID: l.budgetItemID });
      add(t.feeAccountID || sys.uncategorizedExpense, t.feesWithheld || 0, { memo: 'Fees withheld' });
      add(t.accountID || sys.defaultBank, money(txnTotal(t) - money(t.feesWithheld || 0)), { cleared: t.isCleared });
      break;
    case 'transfer': {
      const amount = txnTotal(t);
      add(t.accountID || sys.defaultBank, -amount, { cleared: t.isCleared });
      add(t.toAccountID || sys.uncategorizedAsset, amount, { cleared: t.toCleared });
      break;
    }
    case 'journal': {
      for (const l of lines) add(l.accountID || sys.uncategorizedExpense, l.amount, { memo: l.memo, budgetItemID: l.budgetItemID, cleared: t.isCleared });
      const imbalance = money(lines.reduce((s, l) => s + money(l.amount), 0));
      add(sys.uncategorizedAsset, -imbalance, { memo: 'Out of balance' });
      break;
    }
    default: break;
  }
  return out;
}

const JAN_1_2000 = 946_684_800;

/** Everything the money screens need, worked out once per change (the Mac's BooksData). */
function booksData() {
  const m = fresh();
  if (m.books) return m.books;
  const settings = booksSettings();
  const byID = new Map(settings.accounts.map((a) => [key(a.id), a]));
  const find = (role) => (settings.accounts.find((a) => a.systemRole === role)?.id) || chartID(ROLE_NUMBER[role]);
  const sys = Object.fromEntries(SYSTEM_ROLES.map((r) => [r, find(r)]));
  sys.defaultBank = settings.defaultBankAccountID || settings.accounts.find((a) => a.type === 'bank' && !a.isArchived)?.id || chartID('1000');
  const order = new Map(ACCOUNT_TYPES.map((t, i) => [t, i]));
  const sorted = settings.accounts.slice().sort((a, b) => {
    const ra = order.get(a.type) ?? 0, rb = order.get(b.type) ?? 0;
    if (ra !== rb) return ra - rb;
    if (a.number !== b.number) {
      if (!a.number) return 1;
      if (!b.number) return -1;
      return a.number.localeCompare(b.number, 'en', { numeric: true });
    }
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  });
  const rank = new Map(sorted.map((a, i) => [key(a.id), i]));
  const names = new Map(all('contact').map((c) => [key(c.id), contactDisplayName(c)]));
  const transactions = all('transaction').filter((t) => t && t.type);
  const postings = [];
  for (const a of settings.accounts) {
    if (Math.abs(a.openingBalance) < 0.005 || !isBalanceSheetType(a.type)) continue;
    const debit = money(DEBIT_NORMAL.has(a.type) ? a.openingBalance : -a.openingBalance);
    const date = a.openingBalanceDate ?? JAN_1_2000;
    const base = { transactionID: a.id, paymentID: null, type: 'journal', date, projectID: null, contactID: null, budgetItemID: null, number: '', payee: '', isCleared: true, isOpeningBalance: true };
    postings.push({ ...base, id: `${String(a.id).toUpperCase()}-open`, accountID: a.id, amount: debit, memo: 'Opening balance' });
    postings.push({ ...base, id: `${String(a.id).toUpperCase()}-open-equity`, accountID: sys.openingBalanceEquity, amount: money(-debit), memo: `Opening balance – ${a.name}` });
  }
  for (const t of transactions) {
    const payee = (t.contactID && names.get(key(t.contactID))) || t.payee || '';
    postings.push(...ledgerPostings(t, sys, payee));
  }
  postings.sort((a, b) => (a.date - b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  m.books = {
    settings, accounts: settings.accounts, sorted, sys, transactions, postings, names,
    account: (id) => (id ? byID.get(key(id)) || null : null),
    accountName: (id) => { if (!id) return 'Uncategorized'; const a = byID.get(key(id)); return a ? accountDisplayName(a) : 'Deleted account'; },
    rank: (id) => rank.get(key(id)) ?? Number.MAX_SAFE_INTEGER,
    payeeName: (t) => (t.contactID && names.get(key(t.contactID))) || t.payee || '',
  };
  return m.books;
}

// ----- Ranges and filters (DateRange, ProjectFilter)

const RANGE_ALL = { start: null, end: null };
const inRange = (r, sec) => (r.start == null || sec >= r.start) && (r.end == null || sec < r.end);
const rangeThrough = (day) => ({ start: null, end: toSec(addDays(sod(day), 1)) });
const matchesFilter = (filter, projectID) => (filter === 'all' ? true : filter === 'company' ? !projectID : sameId(projectID, filter));
const DATE_PRESETS = {
  thisMonth: 'This month', lastMonth: 'Last month', thisQuarter: 'This quarter', thisYear: 'This year', lastYear: 'Last year',
  last12Months: 'Last 12 months', allDates: 'All dates',
};
function presetRange(preset, now = new Date()) {
  const y = now.getFullYear(), mo = now.getMonth();
  const at = (yy, mm) => toSec(new Date(yy, mm, 1));
  switch (preset) {
    case 'thisMonth': return { start: at(y, mo), end: at(y, mo + 1) };
    case 'lastMonth': return { start: at(y, mo - 1), end: at(y, mo) };
    case 'thisQuarter': { const q = Math.floor(mo / 3) * 3; return { start: at(y, q), end: at(y, q + 3) }; }
    case 'thisYear': return { start: at(y, 0), end: at(y + 1, 0) };
    case 'lastYear': return { start: at(y - 1, 0), end: at(y, 0) };
    case 'last12Months': { const end = addDays(sod(now), 1); return { start: toSec(addMonths(end, -12)), end: toSec(end) }; }
    default: return RANGE_ALL;
  }
}

/** Debit-positive balance of each account (Ledger.balances). */
function ledgerBalances(postings, range = RANGE_ALL, filter = 'all') {
  const totals = new Map();
  for (const p of postings) {
    if (!inRange(range, p.date) || !matchesFilter(filter, p.projectID)) continue;
    const k = key(p.accountID);
    totals.set(k, (totals.get(k) || 0) + p.amount);
  }
  for (const [k, v] of totals) totals.set(k, money(v));
  return totals;
}
const naturalBalance = (debit, type) => (!type ? debit : DEBIT_NORMAL.has(type) ? debit : -debit);
function accountBalance(accountID, { range = RANGE_ALL, filter = 'all' } = {}) {
  const d = booksData();
  let debit = 0;
  for (const p of d.postings) if (sameId(p.accountID, accountID) && inRange(range, p.date) && matchesFilter(filter, p.projectID)) debit += p.amount;
  return money(naturalBalance(debit, d.account(accountID)?.type));
}

// ----- Reports (Engine/Reports.swift)

function reportSection(section, totals, extra = []) {
  const d = booksData();
  const lines = [];
  for (const a of d.sorted) {
    if (typeSection(a.type) !== section) continue;
    const debit = totals.get(key(a.id));
    if (debit == null || Math.abs(debit) < 0.005) continue;
    lines.push({ id: a.id, name: accountDisplayName(a), amount: naturalBalance(debit, a.type) });
  }
  if (section === 'assets') {
    for (const [k, debit] of totals) if (Math.abs(debit) >= 0.005 && !d.account(k)) lines.push({ id: k, name: 'Deleted account', amount: debit });
  }
  lines.push(...extra.filter((l) => Math.abs(l.amount) >= 0.005));
  return { id: section, title: SECTION_LABEL[section], lines, total: money(lines.reduce((s, l) => s + l.amount, 0)) };
}

function profitAndLoss(range, filter = 'all') {
  const totals = ledgerBalances(booksData().postings, range, filter);
  const r = {
    income: reportSection('income', totals), jobCosts: reportSection('jobCosts', totals), expenses: reportSection('expenses', totals),
    otherIncome: reportSection('otherIncome', totals), otherExpenses: reportSection('otherExpenses', totals),
  };
  r.grossProfit = money(r.income.total - r.jobCosts.total);
  r.netOperatingIncome = money(r.grossProfit - r.expenses.total);
  r.netIncome = money(r.netOperatingIncome + r.otherIncome.total - r.otherExpenses.total);
  return r;
}

function netIncomeOf(range, filter = 'all') {
  const d = booksData();
  let total = 0;
  for (const p of d.postings) {
    if (!inRange(range, p.date) || !matchesFilter(filter, p.projectID)) continue;
    const a = d.account(p.accountID);
    if (!a || isBalanceSheetType(a.type)) continue;
    total -= p.amount;
  }
  return money(total);
}

function balanceSheet(asOf = new Date(), filter = 'all') {
  const d = booksData();
  const through = rangeThrough(asOf);
  const totals = ledgerBalances(d.postings, through, filter);
  const yearStart = toSec(new Date(asOf.getFullYear(), 0, 1));
  const retained = netIncomeOf({ start: null, end: yearStart }, filter);
  const thisYear = netIncomeOf({ start: yearStart, end: through.end }, filter);
  const r = {
    assets: reportSection('assets', totals), liabilities: reportSection('liabilities', totals),
    equity: reportSection('equity', totals, [
      { id: 'prior', name: 'Retained earnings (prior years)', amount: retained },
      { id: 'current', name: 'Net income this year', amount: thisYear },
    ]),
    retainedEarnings: retained, netIncomeThisYear: thisYear,
  };
  r.totalAssets = r.assets.total;
  r.totalLiabilitiesAndEquity = money(r.liabilities.total + r.equity.total);
  r.isBalanced = Math.abs(r.totalAssets - r.totalLiabilitiesAndEquity) < 0.02;
  return r;
}

const AGING_BUCKETS = ['Current', '1–30 Days', '31–60 Days', '61–90 Days', 'Over 90'];
const agingBucket = (days) => (days < 1 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4);
/** Who owes what, by how late (AgingReport). kind: 'payables' (bills) or 'receivables' (invoices). */
function agingReport(kind, asOf = new Date(), filter = 'all') {
  const d = booksData();
  const type = kind === 'payables' ? 'bill' : 'invoice';
  const cutoff = rangeThrough(asOf);
  const today = sod(asOf);
  const items = [];
  for (const t of d.transactions) {
    if (t.type !== type || t.isVoid || !inRange(cutoff, t.date || 0) || !matchesFilter(filter, t.projectID)) continue;
    const paid = (t.payments || []).filter((p) => inRange(cutoff, p.date || 0)).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const balance = money(txnDue(t) - paid);
    if (balance <= 0.005) continue;
    const due = t.dueDate ?? t.date ?? 0;
    const days = dayDiff(fromSec(due), today);
    const name = d.payeeName(t);
    items.push({ id: t.id, contactID: t.contactID || null, name: name || 'No name', number: t.number || '', date: t.date, dueDate: due, daysPastDue: days, balance, projectID: t.projectID || null });
  }
  items.sort((a, b) => a.dueDate - b.dueDate);
  const grouped = new Map();
  for (const i of items) {
    const k = i.contactID ? key(i.contactID) : `name:${i.name.toLowerCase()}`;
    const row = grouped.get(k) || { id: k, contactID: i.contactID, name: i.name, buckets: [0, 0, 0, 0, 0], total: 0, items: [] };
    row.buckets[agingBucket(i.daysPastDue)] += i.balance;
    row.total += i.balance;
    row.items.push(i);
    grouped.set(k, row);
  }
  const rows = [...grouped.values()].map((r) => ({ ...r, buckets: r.buckets.map(money), total: money(r.total) }))
    .sort((a, b) => (a.total === b.total ? (a.name < b.name ? -1 : 1) : b.total - a.total));
  return { kind, items, rows, totals: [0, 1, 2, 3, 4].map((i) => money(rows.reduce((s, r) => s + r.buckets[i], 0))), total: money(rows.reduce((s, r) => s + r.total, 0)) };
}

/** Whether a payment needs a lien waiver (LienWaiverReport.isRequired). */
function waiverRequired(contact, amount, waiver, threshold) {
  if (!contact || !contact.requiresLienWaivers) return false;
  if ((waiver?.status || 'needed') === 'notRequired') return false;
  return amount > 0.005 && amount + 0.005 >= threshold;
}
function lienWaiverReport(filter = 'all') {
  const d = booksData();
  const threshold = d.settings.lienWaiverThreshold;
  const items = [];
  const finals = new Map();
  for (const t of d.transactions) {
    if (!(t.type === 'bill' || t.type === 'expense') || !matchesFilter(filter, t.projectID)) continue;
    const contact = t.contactID ? get(t.contactID) : null;
    const pays = t.isVoid ? [] : t.type === 'bill'
      ? (t.payments || []).map((p) => ({ id: p.id, date: p.date, amount: Number(p.amount) || 0, method: p.method || 'check', reference: p.reference || '', waiver: p.waiver || {} }))
      : [{ id: null, date: t.date, amount: txnTotal(t), method: t.method || 'check', reference: t.number || '', waiver: t.waiver || {} }];
    for (const p of pays) {
      if (Math.abs(p.amount) < 0.005) continue;
      const required = waiverRequired(contact, p.amount, p.waiver, threshold);
      if (!required && !contact?.requiresLienWaivers) continue;
      const name = d.payeeName(t) || 'No name';
      const status = p.waiver.status || 'needed';
      items.push({
        id: `${t.id}-${p.id || 'expense'}`, transactionID: t.id, paymentID: p.id, date: p.date || 0, contactID: t.contactID || null, vendorName: name,
        projectID: t.projectID || null, amount: p.amount, method: p.method, reference: p.reference, waiver: p.waiver, status, required,
        isMissing: required && status === 'needed', awaitingUnconditional: required && status === 'conditional',
        isComplete: !required || status === 'unconditional' || status === 'notRequired',
      });
      if (!contact?.requiresLienWaivers || !t.projectID) continue;
      const k = `${key(t.projectID)}|${t.contactID ? key(t.contactID) : name}`;
      const row = finals.get(k) || { id: k, projectID: t.projectID, contactID: t.contactID || null, vendorName: name, paid: 0, hasFinal: false };
      row.paid = money(row.paid + p.amount);
      if (p.waiver.scope === 'final' && status === 'unconditional') row.hasFinal = true;
      finals.set(k, row);
    }
  }
  items.sort((a, b) => (a.date === b.date ? a.vendorName.localeCompare(b.vendorName) : b.date - a.date));
  const missing = items.filter((i) => i.isMissing);
  const awaiting = items.filter((i) => i.awaitingUnconditional);
  return {
    items, finals: [...finals.values()].sort((a, b) => a.vendorName.localeCompare(b.vendorName, 'en', { sensitivity: 'base' })),
    missing, awaiting, missingAmount: money(missing.reduce((s, i) => s + i.amount, 0)), openCount: items.filter((i) => !i.isComplete).length,
  };
}

const threshold1099 = (year) => (year <= 2025 ? 600 : 2000);
/** Payments to each vendor in a range, with what goes on a 1099-NEC (VendorPaymentsReport). */
function vendorPaymentsReport(range, filter = 'all') {
  const d = booksData();
  const year = fromSec(range.end != null ? range.end - 1 : range.start ?? stamp()).getFullYear();
  const threshold = threshold1099(year);
  const grouped = new Map();
  for (const t of d.transactions) {
    if (!(t.type === 'bill' || t.type === 'expense') || !matchesFilter(filter, t.projectID)) continue;
    const pays = t.isVoid ? [] : t.type === 'bill'
      ? (t.payments || []).map((x) => ({ date: x.date, amount: money(x.amount), method: x.method, accountID: x.accountID }))
      : [{ date: t.date, amount: txnTotal(t), method: t.method, accountID: t.accountID }];
    for (const p of pays) {
      if (!inRange(range, p.date || 0) || Math.abs(p.amount) < 0.005) continue;
      const contact = t.contactID ? get(t.contactID) : null;
      const name = d.payeeName(t);
      const k = t.contactID ? key(t.contactID) : `name:${name.toLowerCase()}`;
      const row = grouped.get(k) || { id: k, contactID: t.contactID || null, name: name || 'No name', total: 0, byCard: 0, count: 0, is1099: !!contact?.is1099, w9OnFile: !!contact?.w9OnFile };
      row.total = money(row.total + p.amount);
      if (p.method === 'card' || d.account(p.accountID)?.type === 'creditCard') row.byCard = money(row.byCard + p.amount);
      row.count += 1;
      grouped.set(k, row);
    }
  }
  const rows = [...grouped.values()].map((r) => ({ ...r, reportable: money(r.total - r.byCard) }))
    .map((r) => ({ ...r, needs1099: r.is1099 && r.reportable >= threshold }))
    .sort((a, b) => (a.total === b.total ? (a.name < b.name ? -1 : 1) : b.total - a.total));
  return { rows, threshold, year, total: money(rows.reduce((s, r) => s + r.total, 0)) };
}

/** Money in and out of bank accounts by month; bank-to-bank transfers aren't counted (CashReport). */
function cashByMonth(months = 12, filter = 'all', now = new Date()) {
  const d = booksData();
  const banks = new Set(d.accounts.filter((a) => a.type === 'bank').map((a) => key(a.id)));
  const bankToBank = new Set(d.transactions.filter((t) => t.type === 'transfer' && banks.has(key(t.accountID)) && banks.has(key(t.toAccountID))).map((t) => key(t.id)));
  const rows = [];
  for (let off = months - 1; off >= 0; off--) {
    const start = new Date(now.getFullYear(), now.getMonth() - off, 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    const r = { start: toSec(start), end: toSec(end) };
    let moneyIn = 0, moneyOut = 0;
    for (const p of d.postings) {
      if (!banks.has(key(p.accountID)) || !inRange(r, p.date) || !matchesFilter(filter, p.projectID)) continue;
      if (p.isOpeningBalance || bankToBank.has(key(p.transactionID))) continue;
      if (p.amount > 0) moneyIn += p.amount; else moneyOut -= p.amount;
    }
    rows.push({ month: start, moneyIn: money(moneyIn), moneyOut: money(moneyOut), net: money(moneyIn - moneyOut) });
  }
  return rows;
}

// ----- Job cost (Engine/ProjectFinancials.swift)

/** Share of a bill that's been paid; expenses and posted crew labor count as paid. */
function paidRatio(t) {
  if (t.type === 'expense' || t.type === 'journal') return 1;
  if (t.type === 'bill') { const total = txnTotal(t); return total > 0.005 ? Math.min(1, Math.max(0, txnPaid(t) / total)) : 0; }
  return 0;
}
/** Bills, expenses and crew-labor journal lines on a project. */
function projectCosts(projectID) {
  const d = booksData();
  const out = [];
  for (const t of d.transactions) {
    if (!sameId(t.projectID, projectID) || t.isVoid) continue;
    if (t.type === 'bill' || t.type === 'expense') { out.push(t); continue; }
    if (t.type !== 'journal') continue;
    const lines = (t.lines || []).filter((l) => d.account(l.accountID)?.type === 'jobCost');
    if (lines.length) out.push({ ...t, lines });
  }
  return out;
}

/** Budget vs billed by line (JobCostReport, the parts the budget uses). */
function jobCost(p) {
  const d = booksData();
  const ids = new Set((p.budget || []).map((b) => key(b.id)));
  const billed = new Map(), paid = new Map(), sources = new Map();
  let unlinked = 0;
  for (const t of projectCosts(p.id)) {
    const ratio = paidRatio(t);
    for (const l of t.lines || []) {
      const amount = Number(l.amount) || 0;
      const item = key(l.budgetItemID);
      if (item && ids.has(item)) {
        billed.set(item, (billed.get(item) || 0) + amount);
        paid.set(item, (paid.get(item) || 0) + amount * ratio);
        if (!sources.has(item)) sources.set(item, []);
        sources.get(item).push({ transaction: t, line: l });
      } else if (d.account(l.accountID)?.costGroup === 'rehab') {
        unlinked += amount;
      }
    }
  }
  const billedByItem = new Map();
  for (const [k, v] of billed) if (Math.abs(money(v)) >= 0.005) billedByItem.set(k, money(v));
  const billedOnLines = money([...billed.values()].reduce((s, v) => s + money(v), 0));
  const unlinkedRehab = money(unlinked);
  return { billedByItem, paidByItem: new Map([...paid].map(([k, v]) => [k, money(v)])), sources, unlinkedRehab, billedOnLines, rehabBilled: money(billedOnLines + unlinkedRehab) };
}

const budgetItemTotal = (b) => (b.quantity ?? 1) * (Number(b.unitCost) || 0);
/** The budget's totals (DealAnalysis: rehabBase, contingency, rehabTotal). */
function budgetTotals(p) {
  const sum = (p.budget || []).reduce((s, b) => s + budgetItemTotal(b), 0);
  const units = p.units || [];
  const estimate = p.kind === 'newBuild' && sum <= 0 ? units.reduce((s, u) => s + (Number(u.sqft) || 0), 0) * Math.max(0, Number(p.development?.buildCostPerSqft) || 0) : 0;
  const base = sum + estimate;
  const contingency = base * (p.contingencyPct ?? 10) / 100;
  return { lines: sum, estimate, base, contingency, total: base + contingency };
}
/** Square feet of finished living space (Project.livingArea). */
function livingArea(p) {
  if (p.kind === 'newBuild') { const s = (p.units || []).reduce((t, u) => t + (Number(u.sqft) || 0), 0); if (s > 0) return s; }
  return Number(p.property?.sqft) || 0;
}
/** Spent against the budget: each line's larger of typed actual and billed, plus billed work not on a line (BudgetMath.spent). */
function budgetSpent(p, billedByItem, billedTotal) {
  const ids = new Set((p.budget || []).map((b) => key(b.id)));
  let onLinesBilled = 0;
  for (const [k, v] of billedByItem) if (ids.has(k)) onLinesBilled += v;
  const onLines = (p.budget || []).reduce((s, b) => s + Math.max(Number(b.actualCost) || 0, billedByItem.get(key(b.id)) || 0), 0);
  return money(onLines + (billedTotal - onLinesBilled));
}

/** What's been billed, paid and held on a subcontract or PO (CommitmentMath.totals). */
function commitmentTotals(c) {
  const d = booksData();
  const retainageAccount = d.sys.retainagePayable;
  const t0 = { revised: commitmentAmount(c), billed: 0, paid: 0, retainageHeld: 0, retainageReleased: 0, openBalance: 0, bills: [] };
  for (const t of d.transactions) {
    if (!sameId(t.commitmentID, c.id) || t.isVoid || !(t.type === 'bill' || t.type === 'expense')) continue;
    t0.bills.push(t);
    for (const l of t.lines || []) {
      if (sameId(l.accountID, retainageAccount)) t0.retainageReleased += Number(l.amount) || 0;
      else t0.billed += Number(l.amount) || 0;
    }
    t0.retainageHeld += txnRetainage(t);
    if (t.type === 'bill') { t0.paid += txnPaid(t); t0.openBalance += txnBalance(t); } else t0.paid += txnTotal(t);
  }
  for (const k of ['billed', 'paid', 'retainageHeld', 'retainageReleased', 'openBalance']) t0[k] = money(t0[k]);
  t0.retainageOutstanding = money(t0.retainageHeld - t0.retainageReleased);
  t0.remaining = money(t0.revised - t0.billed);
  t0.percentBilled = t0.revised > 0 ? t0.billed / t0.revised : 0;
  return t0;
}
const commitmentIsCommitted = (c) => ['issued', 'signed', 'complete'].includes(c.status);
