/* Eagle Creek — Trips, mileage, days in the US, and money you put in yourself.
 *
 * Trips (the Mac's Trips & Mileage): where, when, why and for which jobs; every cost tagged to
 * the trip; drives; and the proof (boarding passes, folios, rental agreements). Costs are
 * ordinary expenses in the books, sorted the way the Mac sorts them (Engine/TravelBooks.swift):
 * flights, hotels, cars, parking to Travel; meals to Business Meals (usually 50% deductible).
 * Receipts in Canadian dollars are turned into US dollars at that day's Bank of Canada rate,
 * and the original amount and rate are kept on the expense.
 * Paid with your own card or cash: either the company pays you back (Owed to Owner, as on the
 * Mac) or you keep it in as a contribution: a journal entry moves it from Owed to Owner to Owner
 * Contributions. Its id comes from the expense's, so there's only ever one per expense.
 * Mileage in kilometres or miles (stored in miles, at the IRS rate per mile). Days in the US are
 * counted from trips and any other stays, for the US day-count tests.
 */
'use strict';

Object.assign(ICONS, {
  airplane: '<path d="M10.5 13.5 4 11.2l1.3-1.3 7.3.9 3.7-3.7a1.8 1.8 0 0 1 2.6 2.6l-3.7 3.7.9 7.3-1.3 1.3-2.3-6.5-3.3 3.3.3 2.1-1 1-1.4-2.9-2.9-1.4 1-1 2.1.3z"/>',
  car: '<path d="M4 16v-3.5l1.8-4.6A2 2 0 0 1 7.7 6.6h8.6a2 2 0 0 1 1.9 1.3l1.8 4.6V16"/><path d="M3 16h18v2.5H3z"/><circle cx="7.5" cy="13" r="1"/><circle cx="16.5" cy="13" r="1"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 3.8 5.2 3.8 8.5s-1.2 6.1-3.8 8.5c-2.6-2.4-3.8-5.2-3.8-8.5s1.2-6.1 3.8-8.5z"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 14.5h2"/><path d="M6 6l9-3 1.5 3"/>',
  paperclip: '<path d="m19 11.5-7.4 7.4a4.6 4.6 0 0 1-6.5-6.5l7.8-7.8a3 3 0 0 1 4.3 4.3l-7.8 7.8a1.5 1.5 0 0 1-2.1-2.1l7-7"/>',
});

// ----- What a receipt is for (ReceiptKind) and where it goes (TravelBooks.category)

const RECEIPT_KINDS = [
  ['meals', 'Meals'], ['lodging', 'Lodging'], ['airfare', 'Airfare'], ['carRental', 'Car rental'], ['fuel', 'Fuel'],
  ['parking', 'Parking & tolls'], ['materials', 'Materials & supplies'], ['office', 'Office & software'], ['other', 'Other'],
];
const kindLabel = (k) => (RECEIPT_KINDS.find((x) => x[0] === k) || RECEIPT_KINDS[8])[1];
function travelCategory(kind, projectID) {
  const d = booksData();
  const use = (number) => { const a = d.account(chartID(number)); return a && !a.isArchived ? a.id : null; };
  switch (kind) {
    case 'materials': return projectID ? use('5110') : null;
    case 'fuel': return use('6100');
    case 'lodging': case 'airfare': case 'carRental': case 'parking': return use('6710') || use('6700');
    case 'meals': return use('6720') || use('6700');
    case 'office': return use('6000');
    default: return projectID ? (use('5100') || d.sys.uncategorizedExpense) : null;
  }
}
const mealsAccountID = () => chartID('6720');

// ----- Money you paid yourself: paid back, or kept in as a contribution

/** Owner Contributions (3000), or another equity account for money put in. */
function contributionAccount() {
  const d = booksData();
  const a = d.account(chartID('3000'));
  if (a && !a.isArchived && a.type === 'equity') return a.id;
  return d.sorted.find((x) => x.type === 'equity' && !x.isArchived && /contribut|capital|paid.?in/i.test(x.name))?.id || null;
}
const contributionID = (expenseID) => stableID(`${key(expenseID)}:contribution`);
function contributionFor(expenseID) { const t = get(contributionID(expenseID)); return t && !t.isVoid ? t : null; }
const paidPersonally = (t) => sameId(t.accountID, booksData().sys.dueToOwner);
function booksClosedOn(sec) {
  const closed = booksData().settings.closedThrough;
  return closed != null && sod(fromSec(sec)) <= sod(fromSec(closed));
}
// Reconciled in Eagle Creek Books: the entry's date, account and amount are fixed everywhere.
const isReconciled = (t) => !!t && (t.reconciledAt != null || t.toReconciledAt != null || (t.payments || []).some((p) => p.reconciledAt != null));
const reconciledMessage = () => 'This entry is part of a finished reconciliation in Eagle Creek Books, so its date, account and amount are fixed and it can\'t be deleted. The memo, category and trip can still change.';
function closedMessage() {
  return `The books are closed through ${fmt.date(fromSec(booksData().settings.closedThrough))}. Use a later date, or move the closed date back on the Mac (Settings › Books).`;
}

/** The journal entry that keeps a personal purchase in as a contribution (Owed to Owner → Owner Contributions). */
function contributionEntry(expense, existing = null) {
  const d = booksData();
  const total = txnTotal(expense);
  const who = (expense.payee || '').trim() || d.payeeName(expense) || 'a purchase';
  const t = existing ? clone(existing) : {
    id: contributionID(expense.id), type: 'journal', createdAt: stamp(), number: '', method: 'other', payments: [], taxPct: 0, feesWithheld: 0,
    isVoid: false, terms: '', billTo: '', waiver: { status: 'needed', scope: 'progress' }, isCleared: false, toCleared: false, retainageHeld: 0,
    isDeposit: false, depositApplied: 0, billedCosts: [], tags: [],
  };
  t.payee = 'Owner contribution';
  t.date = expense.date;
  if (expense.projectID) t.projectID = expense.projectID; else delete t.projectID;
  // Not tagged with the trip: the Mac adds up everything tagged with a trip as its cost.
  delete t.tripID;
  t.memo = `Paid personally and kept in as a contribution: ${who}`;
  const ids = (t.lines || []).map((l) => l.id);
  t.lines = [
    { id: ids[0] || newId(), accountID: d.sys.dueToOwner, memo: `Owed to owner: ${who}`, quantity: 1, rate: 0, amount: total, taxable: true, isDepositCredit: false },
    // The contribution account, or (when it's been archived since) the one the entry already uses.
    { id: ids[1] || newId(), accountID: contributionAccount() || (existing?.lines || [])[1]?.accountID || null, memo: `Contribution: ${who}`, quantity: 1, rate: 0, amount: -total, taxable: true, isDepositCredit: false },
  ];
  return t;
}
async function setContributed(expense, on) {
  const existing = get(contributionID(expense.id));
  if (on) await saveRecord('transaction', contributionEntry(expense, existing));
  else if (existing) await deleteRecord('transaction', contributionID(expense.id));
}

// ----- Canadian dollars (Bank of Canada daily rate; the ECB's through Frankfurter as a backup)

const fxCache = (() => { let c = {}; try { c = JSON.parse(localStorage.getItem('ec-fx') || '{}'); } catch { /* fine */ } return c; })();
function rememberRate(day, r) {
  fxCache[day] = r;
  fxCache.last = r;
  try { localStorage.setItem('ec-fx', JSON.stringify(fxCache)); } catch { /* fine */ }
}
/** US dollars per Canadian dollar on a day (the last published rate on or before it). */
async function cadRate(day) {
  if (fxCache[day]) return fxCache[day];
  const today = fmt.inputDate(new Date());
  const end = day > today ? today : day;
  const start = fmt.inputDate(addDays(parseInputDate(end), -10));
  try {
    const res = await fetch(`https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?start_date=${start}&end_date=${end}`, { cache: 'no-store' });
    if (res.ok) {
      const obs = ((await res.json()).observations || []).filter((o) => o.d <= end && Number(o.FXUSDCAD?.v) > 0);
      const last = obs[obs.length - 1];
      if (last) {
        const r = { rate: Math.round(1e6 / Number(last.FXUSDCAD.v)) / 1e6, source: 'Bank of Canada', date: last.d };
        rememberRate(day, r);
        return r;
      }
    }
  } catch { /* try the backup */ }
  try {
    const res = await fetch(`https://api.frankfurter.dev/v2/rate/cad/usd?date=${end}`, { cache: 'no-store' });
    if (res.ok) {
      const j = await res.json();
      const rate = Number(j.rate ?? j.rates?.USD);
      if (rate > 0) {
        const r = { rate: Math.round(rate * 1e6) / 1e6, source: 'European Central Bank', date: j.date || end };
        rememberRate(day, r);
        return r;
      }
    }
  } catch { /* offline */ }
  throw new Error('No rate');
}
const cadNote = (cad, rate, source, date) => `CA$${cad.toFixed(2)} at ${rate.toFixed(4)} US$/CA$${source ? ` (${source}${date ? `, ${fmt.short(parseInputDate(date) || new Date())}` : ''})` : ''}`;
/** The Canadian amount and rate kept on an expense line, if it was entered in CAD. */
function cadOf(t) {
  for (const l of t.lines || []) {
    const m = /CA\$([\d,]+\.\d{2}) at ([\d.]+) US\$\/CA\$/.exec(l.memo || '');
    if (m) return { cad: Number(m[1].replace(/,/g, '')), rate: Number(m[2]) };
  }
  return null;
}

// ----- Trips

const tripTitle = (t) => (t?.title || '').trim() || ((t?.destination || '').trim() ? `Trip to ${t.destination.trim()}` : 'Untitled trip');
function tripDates(t) {
  const a = sod(fromSec(t.startDate)), b = sod(fromSec(t.endDate ?? t.startDate));
  if (sameDay(a, b)) return fmt.date(a);
  if (a.getFullYear() === b.getFullYear()) return a.getMonth() === b.getMonth() ? `${fmt.short(a)} – ${b.getDate()}, ${b.getFullYear()}` : `${fmt.short(a)} – ${fmt.date(b)}`;
  return `${fmt.date(a)} – ${fmt.date(b)}`;
}
const allTrips = () => all('trip').slice().sort((a, b) => ((b.startDate || 0) - (a.startDate || 0)) || tripTitle(a).localeCompare(tripTitle(b)));
const allMileage = () => all('mileage').slice().sort((a, b) => ((b.date || 0) - (a.date || 0)) || ((b.updatedAt || 0) - (a.updatedAt || 0)));
const mileageExpenseIDs = () => new Set(all('mileage').map((m) => key(m.postedTransactionID)).filter(Boolean));
const tripExpenses = (id) => { const skip = mileageExpenseIDs(); return all('transaction').filter((t) => sameId(t.tripID, id) && !t.isVoid && t.type !== 'journal' && !skip.has(key(t.id))).sort((a, b) => (a.date || 0) - (b.date || 0)); };
// Drives as listed: oldest first, and within a day by odometer reading, smallest first (drives
// with no reading after those with one, in the order saved).
const driveOrder = (a, b) => {
  const da = fromSec(a.date || 0), db = fromSec(b.date || 0);
  if (!sameDay(da, db)) return (a.date || 0) - (b.date || 0);
  const oa = Number(a.odometerStart) || Number(a.odometerEnd) || 0, ob = Number(b.odometerStart) || Number(b.odometerEnd) || 0;
  if (oa && ob && oa !== ob) return oa - ob;
  if (!!oa !== !!ob) return oa ? -1 : 1;
  return (a.updatedAt || 0) - (b.updatedAt || 0);
};
const tripMileage = (id) => all('mileage').filter((m) => sameId(m.tripID, id)).sort(driveOrder);
const receiptsFor = (txnID) => all('file').filter((f) => sameId(f.transactionID, txnID));

/** A trip's costs (TripMath.summary): expenses with meals apart, mileage, what you paid yourself. */
function tripSummary(id) {
  const s = { expenses: 0, meals: 0, mileage: 0, miles: 0, paidPersonally: 0, contributed: 0, receiptsMissing: 0 };
  for (const t of tripExpenses(id)) {
    const total = txnTotal(t);
    s.expenses += total;
    s.meals += (t.lines || []).filter((l) => sameId(l.accountID, mealsAccountID())).reduce((x, l) => x + (Number(l.amount) || 0), 0);
    if (paidPersonally(t)) { s.paidPersonally += total; if (contributionFor(t.id)) s.contributed += total; }
    if (!receiptsFor(t.id).length) s.receiptsMissing += 1;
  }
  for (const m of tripMileage(id)) {
    s.miles += totalMiles(m);
    const v = mileageAmount(m);
    s.mileage += v;
    if (m.personalVehicle !== false) s.paidPersonally += v;
  }
  for (const k of ['expenses', 'meals', 'mileage', 'paidPersonally', 'contributed']) s[k] = money(s[k]);
  s.total = money(s.expenses + s.mileage);
  return s;
}

// ----- Mileage (MileageMath)

const KM_PER_MILE = 1.609344;
// Miles unless km is picked on the Mileage page (remembered on this device). The key changed in
// 1.19.2, when the default went from km to miles, so an old km setting doesn't carry over.
const distanceUnit = () => prefs.get('distance-unit-2', 'mi');
const IRS_RATES = [['2024-01-01', 0.67], ['2025-01-01', 0.70], ['2026-01-01', 0.725], ['2026-07-01', 0.76]];
function mileageRate(sec) {
  const d = fromSec(sec);
  const k = fmt.inputDate(d);
  const extra = (booksData().settings.mileageRates || []).map((r) => { const s = fromSec(r.start); return [`${s.getUTCFullYear()}-${String(s.getUTCMonth() + 1).padStart(2, '0')}-${String(s.getUTCDate()).padStart(2, '0')}`, Number(r.rate) || 0]; });
  const rates = [...IRS_RATES, ...extra].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let rate = rates[0][1];
  for (const [start, r] of rates) if (start <= k) rate = r;
  return rate;
}
const totalMiles = (m) => (m.roundTrip ? (Number(m.miles) || 0) * 2 : (Number(m.miles) || 0));
const mileageAmount = (m) => (m.personalVehicle === false ? 0 : money(totalMiles(m) * mileageRate(m.date)));
const tenths = (v) => (Math.round(v * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 });
const distanceText = (miles, unit = distanceUnit()) => (unit === 'km' ? `${tenths(miles * KM_PER_MILE)} km` : `${tenths(miles)} mi`);
const centsText = (rate) => `${tenths(rate * 100)}¢`;
function mileagePosted(m) { const t = m.postedTransactionID ? get(m.postedTransactionID) : null; return t && !t.isVoid ? t : null; }
/** Where the odometer was left before a drive on `date` (a stamp), on the same trip (or, with no
 *  trip, among drives on no trip), in miles: the highest ending
 *  reading on the latest day that has one, so drives entered out of order on the same day don't
 *  matter, while an older car under the same name (two rentals both called "Rental") doesn't win
 *  over a newer one. The same vehicle's when one is named, otherwise any vehicle's; never above
 *  `below` (the drive's own ending reading, when typed). 0 when there's none. Shown as a hint in
 *  Odometer start, never filled in. */
function lastOdometer({ vehicle = '', date = 0, skipID = null, below = 0, tripID = null } = {}) {
  const v = vehicle.trim().toLowerCase();
  const end = (x) => Number(x.odometerEnd) || 0;
  // A drive on a trip only looks at that trip's drives (a rental is that trip's car); a drive on
  // no trip (your own vehicle) only at other drives on no trip.
  const sameTrip = (x) => (tripID ? sameId(x.tripID, tripID) : !x.tripID);
  const rows = allMileage().filter((x) => end(x) > 0 && sameTrip(x)
    && !(skipID && sameId(x.id, skipID))
    && (!date || (x.date || 0) <= date)
    && (!below || end(x) <= below + 0.1)
    && (!v || (x.vehicle || '').trim().toLowerCase() === v));
  if (!rows.length) return 0;
  const day = fromSec(rows[0].date); // newest first
  return Math.max(...rows.filter((x) => sameDay(fromSec(x.date), day)).map(end));
}
function mileageMemo(m) {
  const parts = [`${tenths(totalMiles(m))} mi × ${centsText(mileageRate(m.date))}`];
  const from = (m.from || '').trim(), to = (m.to || '').trim();
  if (from || to) parts.push([from, to].filter(Boolean).join(m.roundTrip ? ' ⇄ ' : ' → '));
  if ((m.purpose || '').trim()) parts.push(m.purpose.trim());
  return parts.join(' · ');
}
function mileageAccountID() {
  const d = booksData();
  for (const n of ['6730', '6100']) { const a = d.account(chartID(n)); if (a && !a.isArchived) return a.id; }
  return d.sys.uncategorizedExpense;
}
/** A drive in your own vehicle as an expense owed back to you (TravelBooks.mileageExpense). */
function mileageExpense(m, existing = null) {
  const t = existing ? clone(existing) : newExpenseShell(stableID(`${key(m.id)}:mileage`));
  t.date = m.date;
  t.accountID = booksData().sys.dueToOwner;
  t.method = 'other';
  t.payee = `Mileage${(m.vehicle || '').trim() ? ` – ${m.vehicle.trim()}` : ''}`;
  if (m.projectID) t.projectID = m.projectID; else delete t.projectID;
  if (m.tripID) t.tripID = m.tripID; else delete t.tripID;
  const amount = mileageAmount(m);
  const line = (t.lines || [])[0] || { id: newId(), quantity: 1, taxable: true, isDepositCredit: false };
  t.lines = [{ ...line, accountID: line.accountID || mileageAccountID(), memo: mileageMemo(m), amount, rate: amount, quantity: 1 }];
  return t;
}

function newExpenseShell(id = newId()) {
  return {
    id, type: 'expense', createdAt: stamp(), payee: '', number: '', date: stamp(), method: 'card', lines: [], payments: [], memo: '', taxPct: 0,
    feesWithheld: 0, isVoid: false, terms: '', billTo: '', waiver: { status: 'needed', scope: 'progress' }, isCleared: false, toCleared: false,
    retainageHeld: 0, isDeposit: false, depositApplied: 0, billedCosts: [], tags: [],
  };
}

// ----- Days in the US

const dayStr = (d) => fmt.inputDate(d);
/** Every day counted as a day in the US, from trips marked in the US and other stays. */
function usStays() {
  return all('usStay').map((s) => {
    const trip = s.tripID ? get(s.tripID) : null;
    const start = trip && all('trip').includes(trip) ? trip.startDate : s.arrive;
    const end = trip && all('trip').includes(trip) ? (trip.endDate ?? trip.startDate) : (s.leave ?? s.arrive);
    return { stay: s, trip: trip && all('trip').includes(trip) ? trip : null, start: sod(fromSec(start)), end: sod(fromSec(Math.max(start, end))) };
  }).filter((x) => !Number.isNaN(x.start.getTime())).sort((a, b) => b.start - a.start);
}
function usDaySet() {
  const days = new Set();
  for (const s of usStays()) for (let d = s.start, n = 0; d <= s.end && n < 400; d = addDays(d, 1), n++) days.add(dayStr(d));
  return days;
}
function usDayCounts() {
  const days = usDaySet();
  const today = dayStr(new Date());
  const y = new Date().getFullYear();
  const byYear = (yr, upto = null) => [...days].filter((d) => d.startsWith(`${yr}-`) && (!upto || d <= upto)).length;
  const cur = byYear(y, today), planned = byYear(y) - cur, prior = byYear(y - 1), prior2 = byYear(y - 2);
  const yearAgo = dayStr(addDays(new Date(), -364));
  const last365 = [...days].filter((d) => d >= yearAgo && d <= today).length;
  return { year: y, cur, planned, prior, prior2, last365, weighted: cur + prior / 3 + prior2 / 6, days };
}
const stayFor = (tripID) => all('usStay').find((s) => sameId(s.tripID, tripID)) || null;

// ---------------------------------------------------------------------------
// Pages

const TRIP_PAGES = [['list', 'Trips'], ['mileage', 'Mileage'], ['usdays', 'Days in the US'], ['personal', 'Paid Personally']];

function viewTrips(page) {
  if (!TRIP_PAGES.some(([k]) => k === page)) page = 'list';
  setHeader({ title: 'Trips & Mileage', actions: `<button class="icon-btn" data-act="trip-new" aria-label="New trip" title="New trip">${icon('plus')}</button>` });
  const nav = `<nav class="seg" aria-label="Travel pages">${TRIP_PAGES.map(([k, l]) => `<a href="#/trips/${k}" class="${k === page ? 'on' : ''}">${segIcon(SECTION_ICONS[k])}${l}</a>`).join('')}</nav>`;
  const body = { list: tripsList, mileage: mileagePage, usdays: usDaysPage, personal: personalPage }[page];
  return nav + (S.syncError ? banner(S.syncError) : '') + body();
}

function tripRow(t) {
  const s = tripSummary(t.id);
  const sub = [tripDates(t), (t.destination || '').trim()].filter(Boolean).join(' · ');
  const today = sod(new Date());
  const now = sod(fromSec(t.startDate)) <= today && sod(fromSec(t.endDate ?? t.startDate)) >= today;
  return `<a class="row" href="#/trip/${esc(key(t.id))}">${icon('airplane', 'ic glyph', `--tint:${now ? 'var(--forest)' : 'var(--slate)'}`)}
    <div class="main"><div class="t">${esc(tripTitle(t))}${now ? ' <span class="small" style="color:var(--forest)">· Now</span>' : ''}</div><div class="s">${esc(sub)}</div>
      ${s.receiptsMissing ? `<div class="s" style="color:var(--warning)">${plural(s.receiptsMissing, 'expense')} without a receipt</div>` : !(t.purpose || '').trim() ? '<div class="s" style="color:var(--warning)">No business purpose yet</div>' : ''}</div>
    <div class="end"><span class="amt">${esc(fmt.money(s.total, true))}</span></div>${icon('chev', 'ic chev')}</a>`;
}

function tripsList() {
  const trips = allTrips();
  const add = `<button class="btn primary" data-act="trip-new">${icon('plus')}New Trip</button>`;
  if (!trips.length) return emptyState('airplane', 'No Trips Yet', 'Start a trip when you head down: snap each receipt into it as you go (hotel, meals, rental car, flights), log your drives, and keep boarding passes and folios with it. It syncs to Trips & Mileage on the Mac.', `<div style="margin-top:14px">${add}</div>`);
  const today = sod(new Date());
  const current = trips.filter((t) => sod(fromSec(t.endDate ?? t.startDate)) >= today).sort((a, b) => a.startDate - b.startDate);
  const past = trips.filter((t) => sod(fromSec(t.endDate ?? t.startDate)) < today);
  let html = '';
  const y = new Date().getFullYear();
  const yearTrips = trips.filter((t) => fromSec(t.startDate).getFullYear() === y);
  const yearTotal = money(yearTrips.reduce((s, t) => s + tripSummary(t.id).total, 0));
  const counts = usDayCounts();
  html += `<div class="tiles">
    ${tile(`Trips in ${y}`, String(yearTrips.length), fmt.money(yearTotal), { accent: 'var(--slate)' })}
    ${tile('Days in the US', String(counts.cur), counts.planned ? `+${counts.planned} planned` : `in ${y} so far`, { accent: 'var(--clay)' })}
    ${tile('Company Owes You', fmt.money(accountBalance(booksData().sys.dueToOwner)), 'Paid personally', { accent: 'var(--leather)' })}
  </div>`;
  if (current.length) html += card('Coming Up and Now', current.map(tripRow).join(''));
  const byYear = new Map();
  for (const t of past) { const yr = fromSec(t.startDate).getFullYear(); if (!byYear.has(yr)) byYear.set(yr, []); byYear.get(yr).push(t); }
  for (const [yr, arr] of byYear) html += card(`${yr}`, arr.map(tripRow).join(''));
  return html;
}

function viewTrip(id) {
  const t = get(id);
  if (!t || !all('trip').includes(t)) {
    setHeader({ title: 'Trip', back: '#/trips' });
    return emptyState('airplane', 'Not on This Device', 'This trip may have been deleted on the Mac.');
  }
  const tid = esc(key(t.id));
  setHeader({ title: tripTitle(t), sub: [tripDates(t), (t.destination || '').trim()].filter(Boolean).join(' · '), back: '#/trips',
    actions: `<button class="icon-btn" data-act="trip-edit" data-id="${tid}" aria-label="Edit trip">${icon('edit')}</button>` });
  const s = tripSummary(t.id);
  let html = `<div class="actions" style="grid-template-columns:repeat(4,1fr)">
    <button class="action" data-act="expense-snap" data-trip="${tid}">${icon('camera')}Snap Receipt</button>
    <button class="action" data-act="expense-new" data-trip="${tid}">${icon('receipt')}Add Expense</button>
    <button class="action" data-act="drive-new" data-trip="${tid}">${icon('car')}Log a Drive</button>
    <button class="action" data-act="trip-proof" data-id="${tid}">${icon('paperclip')}Add Proof</button>
  </div>`;
  html += `<div class="tiles four">
    ${tile('Trip Total', fmt.money(s.total, true), 'Expenses and mileage', { accent: 'var(--slate)' })}
    ${tile('Meals', fmt.money(s.meals, true), 'Usually 50% deductible', { accent: 'var(--slate)' })}
    ${tile('Mileage', fmt.money(s.mileage, true), distanceText(s.miles), { accent: 'var(--slate)' })}
    ${tile('Paid Personally', fmt.money(s.paidPersonally, true), s.receiptsMissing ? `${s.receiptsMissing} without a receipt` : s.contributed ? `${fmt.money(s.contributed)} kept in as contributions` : 'Every expense has a receipt', { accent: 'var(--slate)', tint: s.receiptsMissing ? 'var(--warning)' : '' })}
  </div>`;
  if (!(t.purpose || '').trim()) html += `<div class="banner" style="--c:var(--warning)">${icon('warn')}<div>Write down the business purpose. Travel is deductible when the main reason for the trip is business. <a href="#" data-act="trip-edit" data-id="${tid}">Add it</a>.</div></div>`;
  let about = '';
  if ((t.purpose || '').trim()) about += `<div class="kv"><span>Purpose</span><span style="white-space:pre-wrap">${esc(t.purpose.trim())}</span></div>`;
  const jobs = (t.projectIDs || []).map((pid) => project(pid)).filter(Boolean);
  if (jobs.length) about += `<div class="kv"><span>Projects</span><span>${jobs.map((p) => `<a href="#/project/${esc(key(p.id))}">${esc(projectName(p))}</a>`).join(', ')}</span></div>`;
  const stay = stayFor(t.id);
  about += `<div class="kv"><span>Days in the US</span><span>${stay ? `${dayDiff(sod(fromSec(t.startDate)), sod(fromSec(t.endDate ?? t.startDate))) + 1} counted` : '<a href="#" data-act="trip-count-days" data-id="' + tid + '">Count these days</a>'}</span></div>`;
  if ((t.notes || '').trim()) about += `<div class="kv"><span>Notes</span><span style="white-space:pre-wrap">${esc(t.notes)}</span></div>`;
  html += kvCard('Trip', about, { action: `<button class="btn link" data-act="trip-edit" data-id="${tid}">Edit</button>` });
  const expenses = tripExpenses(t.id);
  html += card(`Expenses (${expenses.length})`, expenses.length ? expenses.map((x) => expenseRow(x)).join('') : '<div class="empty-line">Flights, hotels, rental cars, meals and fuel for this trip. Snap the receipt and it’s kept with the expense.</div>');
  const drives = tripMileage(t.id);
  html += card(`Mileage (${drives.length})`, drives.length ? drives.map(driveRow).join('') : '<div class="empty-line">Driving to the airport, or around town while you’re there? Log each drive.</div>', { action: `<button class="btn link" data-act="drive-new" data-trip="${tid}">${icon('plus')}Drive</button>` });
  const proof = filesFor('recordID', t.id);
  html += card(`Proof of Travel (${proof.length})`, proof.length ? proof.map(fileRow).join('') : '<div class="empty-line">Boarding passes, itineraries, hotel folios, rental agreements, meeting notes.</div>', { action: `<button class="btn link" data-act="trip-proof" data-id="${tid}">${icon('plus')}Add</button>` });
  html += `<p class="note" style="margin:0 4px 14px">The Mac's Trips & Mileage makes the Trip Report for your accountant from all of this.</p>`;
  return html;
}

function paidWithLabel(t) {
  if (paidPersonally(t)) return contributionFor(t.id) ? 'Contributed' : 'Owed to you';
  const a = booksData().account(t.accountID);
  return a ? a.name : 'Company account';
}
function expenseRow(t, { showTrip = false } = {}) {
  const d = booksData();
  const cad = cadOf(t);
  const line = (t.lines || [])[0];
  const cat = (t.lines || []).length > 1 ? `Split (${t.lines.length} lines)` : line?.accountID ? (d.account(line.accountID)?.name || 'Uncategorized') : 'Uncategorized';
  const trip = showTrip && t.tripID ? get(t.tripID) : null;
  const noReceipt = !receiptsFor(t.id).length;
  const personal = paidPersonally(t);
  const label = paidWithLabel(t);
  const color = personal ? (label === 'Contributed' ? 'var(--forest)' : 'var(--leather)') : 'var(--stone)';
  return `<button class="row" data-act="expense-open" data-id="${esc(key(t.id))}">${icon(expenseIcon(t), 'ic glyph', `--tint:${color}`)}
    <div class="main"><div class="t">${esc((t.payee || '').trim() || d.payeeName(t) || 'No vendor')}</div>
      <div class="s">${esc([fmt.short(fromSec(t.date)), cat, trip ? tripTitle(trip) : ''].filter(Boolean).join(' · '))}</div>
      <div class="s"><span class="dot-label" style="--c:${color}">${esc(label)}</span>${noReceipt ? ' · <span style="color:var(--warning)">No receipt</span>' : ''}</div></div>
    <div class="end"><span class="amt">${esc(fmt.money(txnTotal(t), true))}</span>${cad ? `<span>${esc(`CA$${cad.cad.toFixed(2)}`)}</span>` : ''}</div></button>`;
}
/** What an expense was for, as an icon: the kind picked here, else its category or vendor. */
function expenseIcon(t) {
  const memo = ((t.lines || [])[0]?.memo || '');
  const kind = RECEIPT_KINDS.find(([, l]) => memo.startsWith(l));
  if (kind) return RECEIPT_KIND_ICONS[kind[0]];
  if ((t.lines || []).some((l) => sameId(l.accountID, mealsAccountID()))) return 'forkKnife';
  return iconMatch(`${t.payee || ''} ${booksData().payeeName(t) || ''}`, EXPENSE_VENDOR_ICONS, 'receipt');
}
function driveRow(m) {
  const posted = mileagePosted(m);
  const route = [(m.from || '').trim(), (m.to || '').trim()].filter(Boolean).join(m.roundTrip ? ' ⇄ ' : ' → ');
  const amount = mileageAmount(m);
  return `<button class="row" data-act="drive-open" data-id="${esc(key(m.id))}">${icon('car', 'ic glyph', '--tint:var(--slate)')}
    <div class="main"><div class="t">${esc(route || (m.purpose || '').trim() || 'Drive')}</div><div class="s">${esc([fmt.date(fromSec(m.date)), distanceText(totalMiles(m)), (m.vehicle || '').trim(), m.personalVehicle === false ? 'Company vehicle' : ''].filter(Boolean).join(' · '))}</div></div>
    <div class="end"><span class="amt">${amount ? esc(fmt.money(amount, true)) : '—'}</span>${m.personalVehicle === false ? '' : posted ? pill(contributionFor(posted.id) ? 'Contributed' : 'In the books', contributionFor(posted.id) ? 'var(--forest)' : 'var(--success)') : pill('Not posted', 'var(--warning)')}</div></button>`;
}

// ----- Mileage page

function mileagePage() {
  const list = allMileage();
  const unit = distanceUnit();
  const y = new Date().getFullYear();
  const thisYear = list.filter((m) => fromSec(m.date).getFullYear() === y);
  const unposted = list.filter((m) => m.personalVehicle !== false && !mileagePosted(m) && mileageAmount(m) > 0);
  let html = `<div class="page-bar"><div class="segmented" style="width:150px">${[['mi', 'Miles'], ['km', 'km']].map(([k, l]) => `<button data-act="distance-unit" data-unit="${k}" class="${unit === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <button class="btn primary sm" data-act="drive-new">${icon('plus')}Drive</button></div>`;
  if (!list.length) return html + emptyState('car', 'No Drives Yet', 'Log each business drive in your own vehicle: where, how far, and why. It’s claimed at the IRS rate per mile, and you choose whether the company pays you back or you keep it in as a contribution.');
  html += `<div class="tiles">
    ${tile(`Driven in ${y}`, distanceText(thisYear.reduce((s, m) => s + totalMiles(m), 0)), plural(thisYear.length, 'drive'), { accent: 'var(--slate)' })}
    ${tile(`Claimable in ${y}`, fmt.money(thisYear.reduce((s, m) => s + mileageAmount(m), 0)), `IRS rate ${centsText(mileageRate(stamp()))}/mi`, { accent: 'var(--forest)' })}
    ${tile('Not Posted Yet', fmt.money(unposted.reduce((s, m) => s + mileageAmount(m), 0)), plural(unposted.length, 'drive'), { accent: unposted.length ? 'var(--warning)' : 'var(--olive)' })}
  </div>`;
  if (unposted.length) html += `<div class="banner" style="--c:var(--slate)">${icon('car')}<div>${plural(unposted.length, 'drive')} ${unposted.length === 1 ? "isn't" : "aren't"} in the books yet. <div class="btn-row wrap" style="margin-top:8px"><button class="btn sm" data-act="drive-post-all" data-as="owner">${icon('wallet')}Post: Pay Me Back</button>${contributionAccount() ? `<button class="btn sm" data-act="drive-post-all" data-as="contribution">${icon('handCoin')}Post as My Contribution</button>` : ''}</div></div></div>`;
  return html + `<section class="card flush">${list.slice(0, 200).sort(driveOrder).map(driveRow).join('')}</section>`;
}

// ----- Days in the US page

function usDaysPage() {
  const c = usDayCounts();
  let html = `<div class="tiles">
    ${tile(`In ${c.year} So Far`, String(c.cur), c.planned ? `+${c.planned} more planned` : 'Days in the US', { accent: 'var(--clay)' })}
    ${tile('Last 365 Days', String(c.last365), 'Days in the US', { accent: 'var(--slate)' })}
    ${tile('Weighted 3 Years', (Math.floor(c.weighted * 10) / 10).toLocaleString('en-US'), 'The test line is 183', { accent: c.cur >= 31 && c.weighted >= 183 ? 'var(--danger)' : c.weighted >= 150 ? 'var(--warning)' : 'var(--olive)', tint: c.cur >= 31 && c.weighted >= 183 ? 'var(--danger)' : '' })}
  </div>`;
  let status;
  if (c.cur >= 31 && c.weighted >= 183) status = banner('The weighted total is 183 or more and you’ve been in the US 31+ days this year, so the IRS substantial presence test is met. You can still be treated as a nonresident if an exception applies, such as filing Form 8840 (closer connection to Canada) or the Canada–US tax treaty. Talk to your cross-border accountant.', 'var(--danger)');
  else {
    const left = Math.max(0, Math.ceil(183 - c.weighted));
    status = `<div class="banner" style="--c:var(--slate)">${icon('globe')}<div>${c.cur < 31 ? `Under 31 days in the US this year, so the substantial presence test isn't met this year. ` : ''}${left} more day${left === 1 ? '' : 's'} in the US this year would bring the weighted total to 183.</div></div>`;
  }
  html += status;
  html += `<p class="note" style="margin:-4px 4px 14px">The US counts any part of a day as a day. The weighted total is this year's days, plus a third of last year's and a sixth of the year before's. A day count matters for other rules too (like provincial health coverage), so it's kept from every stay, business or not. This isn't tax advice.</p>`;
  html += `<div class="page-bar"><span class="count">Stays</span><button class="btn primary sm" data-act="stay-new">${icon('plus')}Days in the US</button></div>`;
  const stays = usStays();
  if (!stays.length) html += emptyState('globe', 'No Days Counted Yet', 'Trips are counted when you start them here. Add any other time in the US (a holiday, a personal visit) too, so the count is complete.');
  else {
    const byYear = new Map();
    for (const s of stays) { const y = s.start.getFullYear(); if (!byYear.has(y)) byYear.set(y, []); byYear.get(y).push(s); }
    for (const [y, arr] of byYear) {
      html += card(`${y} (${[...c.days].filter((d) => d.startsWith(`${y}-`)).length} days)`, arr.map((s) => {
        const n = dayDiff(s.start, s.end) + 1;
        const label = s.trip ? tripTitle(s.trip) : ((s.stay.note || '').trim() || 'Time in the US');
        const range = sameDay(s.start, s.end) ? fmt.date(s.start) : `${fmt.short(s.start)} – ${fmt.date(s.end)}`;
        return `<button class="row" data-act="stay-open" data-id="${esc(key(s.stay.id))}">${icon(s.trip ? 'airplane' : 'globe', 'ic glyph', '--tint:var(--clay)')}
          <div class="main"><div class="t">${esc(label)}</div><div class="s">${esc(range)}${s.trip ? ' · Business trip' : ''}</div></div>
          <div class="end"><span class="amt">${plural(n, 'day')}</span></div></button>`;
      }).join(''));
    }
  }
  const uncounted = allTrips().filter((t) => !stayFor(t.id));
  if (uncounted.length) {
    html += card('Trips Not Counted', uncounted.slice(0, 12).map((t) => `<div class="row static">${icon('airplane', 'ic glyph', '--tint:var(--stone)')}<div class="main"><div class="t">${esc(tripTitle(t))}</div><div class="s">${esc(tripDates(t))}</div></div>
      <button class="btn sm" data-act="trip-count-days" data-id="${esc(key(t.id))}">${icon('check')}Count</button></div>`).join(''));
  }
  return html;
}

// ----- Paid personally: owed back or contributed

function personalPage() {
  const d = booksData();
  const owed = accountBalance(d.sys.dueToOwner);
  const contrib = contributionAccount();
  const y = new Date().getFullYear();
  const year = presetRange('thisYear');
  const contributedYear = contrib ? accountBalance(contrib, { range: year }) : 0;
  const personal = d.transactions.filter((t) => t.type === 'expense' && !t.isVoid && paidPersonally(t)).sort((a, b) => (b.date || 0) - (a.date || 0));
  const paidYear = money(personal.filter((t) => fromSec(t.date).getFullYear() === y).reduce((s, t) => s + txnTotal(t), 0));
  let html = `<div class="tiles">
    ${tile('Company Owes You', fmt.money(owed, true), owed > 0.005 ? 'Pay yourself back on the Mac' : 'Nothing owed', { accent: 'var(--leather)' })}
    ${tile(`Contributed in ${y}`, fmt.money(contributedYear, true), contrib ? (d.account(contrib)?.name || 'Owner Contributions') : 'No contributions account', { accent: 'var(--forest)' })}
    ${tile(`Paid Personally in ${y}`, fmt.money(paidYear, true), plural(personal.filter((t) => fromSec(t.date).getFullYear() === y).length, 'purchase'), { accent: 'var(--slate)' })}
  </div>`;
  html += `<div class="page-bar"><span class="count small">Paid with your own card or cash: the company pays you back, or you keep it in as a contribution. Tap one to switch it.</span><button class="btn primary sm" data-act="expense-new">${icon('plus')}Purchase</button></div>`;
  if (!contrib) html += banner('There’s no Owner Contributions account in the chart of accounts, so purchases can only be owed back. Add an equity account named Owner Contributions on the Mac.');
  else if (owed > 0.005) html += `<button class="btn block" data-act="contribute-amount" style="margin-bottom:14px">${icon('wallet')}Turn What's Owed to You into a Contribution…</button>`;
  const orphans = d.transactions.filter((t) => t.type === 'journal' && !t.isVoid && t.payee === 'Owner contribution' && t.memo?.startsWith('Paid personally and kept in') && !personal.some((p) => sameId(contributionID(p.id), t.id)));
  if (orphans.length) html += banner(`${plural(orphans.length, 'contribution')} ${orphans.length === 1 ? 'is' : 'are'} left from expenses deleted or voided on the Mac. Open ${orphans.length === 1 ? 'it' : 'them'} in Books to delete.`);
  if (!personal.length) return html + emptyState('wallet', 'Nothing Paid Personally', 'When you pay for something with your own card or cash, add it to a trip (or Books) and pick “My own card or cash”.');
  return html + `<section class="card flush">${personal.slice(0, 200).map((t) => expenseRow(t, { showTrip: true })).join('')}</section>`;
}

// ---------------------------------------------------------------------------
// Sheets

function sheetTrip(id) {
  const existing = id ? get(id) : null;
  const t = existing ? clone(existing) : { startDate: toSec(localNoon(new Date())), endDate: toSec(localNoon(new Date())), title: '', destination: '', purpose: '', projectIDs: [], notes: '' };
  const counted = existing ? !!stayFor(existing.id) : true;
  const jobs = projects().filter((p) => statusGroup(p.status) !== 'closed' || (t.projectIDs || []).some((x) => sameId(x, p.id))).sort((a, b) => projectName(a).localeCompare(projectName(b)));
  openSheet(`${sheetHead(existing ? 'Edit Trip' : 'New Trip')}
    <form id="trip-form" data-id="${esc(existing ? key(existing.id) : '')}">
      <div class="form-section"><div class="form-card">
        <label class="field"><span>Destination</span><input name="destination" value="${esc(t.destination || '')}" placeholder="Tulsa, OK"></label>
        <div class="two"><label class="field"><span>Leave</span><input name="startDate" type="date" value="${fmt.inputDate(fromSec(t.startDate))}" required></label>
          <label class="field"><span>Back</span><input name="endDate" type="date" value="${fmt.inputDate(fromSec(t.endDate ?? t.startDate))}" required></label></div>
        <label class="field"><span>Business purpose</span><textarea name="purpose" rows="2" placeholder="Walk the Birch St flip with the GC, meet the lender, look at two deals">${esc(t.purpose || '')}</textarea></label>
        <label class="field"><span>Title (optional)</span><input name="title" value="${esc(t.title || '')}" placeholder="${esc(tripTitle({ destination: t.destination }) || 'October site visit')}"></label>
      </div><div class="fs-foot">The IRS wants the business purpose written down. Travel is deductible when the main reason for the trip is business.</div></div>
      ${jobs.length ? `<div class="form-section"><div class="fs-head">Projects</div><div class="chips" style="margin:0">${jobs.map((p) => `<label class="chip-check"><input type="checkbox" name="projectIDs" value="${esc(p.id)}" ${(t.projectIDs || []).some((x) => sameId(x, p.id)) ? 'checked' : ''}><span>${esc(projectName(p))}</span></label>`).join('')}</div></div>` : ''}
      <div class="form-section"><div class="form-card">
        <label class="toggle">Count these days as days in the US<input type="checkbox" name="usDays" ${counted ? 'checked' : ''}></label>
        <label class="field"><span>Notes</span><textarea name="notes" rows="1">${esc(t.notes || '')}</textarea></label>
      </div></div>
      <div class="sheet-actions">${existing ? `<button type="button" class="btn danger" data-act="trip-delete" data-id="${esc(key(existing.id))}" aria-label="Delete" style="flex:0 0 52px">${icon('trash')}</button>` : ''}<button type="button" class="btn" data-act="sheet-close">Cancel</button><button type="submit" class="btn primary">${existing ? 'Save' : 'Start Trip'}</button></div>
    </form>`, (el) => { if (!existing) setTimeout(() => $('[name=destination]', el)?.focus(), 250); });
}

function sheetStay(id) {
  const s = id ? get(id) : null;
  const trip = s?.tripID ? get(s.tripID) : null;
  if (trip && all('trip').includes(trip)) {
    openSheet(`${sheetHead('Days in the US', tripTitle(trip))}
      <p class="note" style="margin:0 4px 12px">These days come from the trip's dates (${esc(tripDates(trip))}). Change the dates on the trip.</p>
      <div class="btn-row"><a class="btn" href="#/trip/${esc(key(trip.id))}" data-act="sheet-close">Open Trip</a><button class="btn danger" data-act="stay-delete" data-id="${esc(key(s.id))}">Don't Count</button></div>`);
    return;
  }
  const arrive = s ? fmt.inputDate(fromSec(s.arrive)) : fmt.inputDate(new Date());
  const leave = s ? fmt.inputDate(fromSec(s.leave ?? s.arrive)) : fmt.inputDate(new Date());
  openSheet(`${sheetHead(s ? 'Days in the US' : 'Add Days in the US')}
    <form id="stay-form" data-id="${esc(s ? key(s.id) : '')}">
      <div class="form-section"><div class="form-card">
        <div class="two"><label class="field"><span>Arrived</span><input name="arrive" type="date" value="${arrive}" required></label><label class="field"><span>Left</span><input name="leave" type="date" value="${leave}" required></label></div>
        <label class="field"><span>What for</span><input name="note" value="${esc(s?.note || '')}" placeholder="Holiday in Arizona"></label>
      </div><div class="fs-foot">Both the day you arrive and the day you leave count.</div></div>
      <div class="sheet-actions">${s ? `<button type="button" class="btn danger" data-act="stay-delete" data-id="${esc(key(s.id))}" aria-label="Delete" style="flex:0 0 52px">${icon('trash')}</button>` : ''}<button type="button" class="btn" data-act="sheet-close">Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </form>`);
}

/** Add or change an expense: what it was for, in US or Canadian dollars, and who paid. */
function sheetExpense({ id = null, tripID = null, files = [] } = {}) {
  const d = booksData();
  const existing = id ? get(id) : null;
  if (existing && mileageExpenseIDs().has(key(existing.id))) { const m = all('mileage').find((x) => sameId(x.postedTransactionID, existing.id)); if (m) { sheetDrive({ id: m.id }); return; } }
  if (existing && ((existing.lines || []).length > 1 || existing.type !== 'expense')) { sheetExpenseInfo(existing); return; }
  const trip = get(existing?.tripID || tripID);
  const t = existing ? clone(existing) : newExpenseShell();
  const line = (t.lines || [])[0] || {};
  const cad = existing ? cadOf(existing) : null;
  const currency = cad ? 'CAD' : existing ? 'USD' : prefs.get('expense-currency', 'USD');
  const amount = cad ? cad.cad : existing ? txnTotal(existing) : '';
  const today = sod(new Date());
  let date = existing ? fromSec(existing.date) : today;
  if (!existing && trip && !(sod(fromSec(trip.startDate)) <= today && today <= sod(fromSec(trip.endDate ?? trip.startDate)))) date = fromSec(trip.startDate);
  const tripJobs = (trip?.projectIDs || []).map((x) => project(x)).filter(Boolean);
  const projectID = existing ? existing.projectID : tripJobs.length === 1 ? tripJobs[0].id : null;
  const kindGuess = existing ? (RECEIPT_KINDS.find(([k, l]) => (line.memo || '').startsWith(l)) || [])[0] || '' : '';
  // A contribution already recorded keeps its choice even if the account was archived since.
  const contrib = contributionAccount() || (existing && contributionFor(existing.id) ? (contributionFor(existing.id).lines || [])[1]?.accountID : null);
  const personalOn = existing ? paidPersonally(existing) : null;
  const paid = existing ? (personalOn ? (contributionFor(existing.id) ? 'contribution' : 'owner') : key(existing.accountID)) : prefs.get('expense-paid-with', 'owner');
  const moneyAccounts = d.sorted.filter((a) => isMoneyAccountType(a.type) && !a.isArchived);
  const paidOptions = [
    ['owner', 'My own card or cash · company pays me back'],
    ...(contrib ? [['contribution', 'My own card or cash · my contribution']] : []),
    ...moneyAccounts.map((a) => [key(a.id), `${a.name}${a.lastFour ? ` ···${a.lastFour}` : ''}`]),
  ];
  // Paid from an account that isn't in the list (archived, or not a bank or card): keep it.
  if (existing && !personalOn && !paidOptions.some(([v]) => v === key(existing.accountID))) paidOptions.push([key(existing.accountID), d.accountName(existing.accountID)]);
  const cats = d.sorted.filter((a) => (['expense', 'jobCost', 'otherExpense'].includes(a.type) && !a.isArchived) || sameId(a.id, line.accountID));
  const jobs = projects().filter((p) => statusGroup(p.status) !== 'closed' || sameId(p.id, projectID)).sort((a, b) => projectName(a).localeCompare(projectName(b)));
  const receipts = existing ? receiptsFor(existing.id) : [];
  S.ui.expenseFiles = [...files];
  openSheet(`${sheetHead(existing ? 'Expense' : 'New Expense', trip ? tripTitle(trip) : 'No trip')}
    <form id="expense-form" data-id="${esc(existing ? key(existing.id) : '')}" data-trip="${esc(trip ? key(trip.id) : '')}" data-new-id="${esc(t.id)}">
      <div class="form-section"><div class="fs-head">Receipt</div>
        <div id="receipt-strip" class="receipt-strip">${receipts.map((f) => thumbCell(f, '')).join('')}</div>
        <div class="btn-row"><button type="button" class="btn" data-act="expense-receipt" data-capture="1">${icon('camera')}Camera</button><button type="button" class="btn" data-act="expense-receipt">${icon('image')}Photo or PDF</button></div></div>
      <div class="form-section"><div class="fs-head">What it was for</div>
        <div class="chips" style="margin:0">${RECEIPT_KINDS.filter(([k]) => k !== 'materials' || projectID).map(([k, l]) => `<button type="button" data-act="expense-kind" data-kind="${k}" class="${k === kindGuess ? 'on' : ''}">${icon(RECEIPT_KIND_ICONS[k], 'ic chip-ic')}${l}</button>`).join('')}</div>
        <input type="hidden" name="kind" value="${esc(kindGuess)}"></div>
      <div class="form-section"><div class="form-card">
        <label class="field"><span>Vendor</span><input name="payee" value="${esc(t.payee || '')}" placeholder="Hilton Garden Inn, Delta, Enterprise…" autocomplete="off"></label>
        <div class="two"><label class="field"><span>Date</span><input name="date" type="date" value="${fmt.inputDate(date)}" required></label>
          <label class="field"><span>Amount</span><input name="amount" type="number" inputmode="decimal" step="0.01" min="0" value="${amount === '' ? '' : Number(amount).toFixed(2)}" placeholder="0.00" required></label></div>
        <div class="segmented" style="margin-bottom:12px">${[['USD', 'US dollars'], ['CAD', 'Canadian dollars']].map(([k, l]) => `<button type="button" data-act="expense-currency" data-currency="${k}" class="${currency === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <input type="hidden" name="currency" value="${currency}">
        <div class="fx ${currency === 'CAD' ? '' : 'hidden'}">
          <label class="field"><span>Exchange rate (US$ per CA$)</span><input name="rate" type="number" inputmode="decimal" step="0.0001" min="0" value="${cad ? cad.rate.toFixed(4) : ''}"></label>
          <p class="note" id="fx-note" style="margin:-4px 0 12px"></p>
        </div>
      </div></div>
      <div class="form-section"><div class="form-card">
        <label class="field"><span>Paid with</span><select name="paidWith">${paidOptions.map(([v, l]) => `<option value="${esc(v)}" ${v === paid ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <p class="note" id="paid-note" style="margin:-4px 0 12px"></p>
        <label class="field"><span>Category</span><select name="accountID"><option value="">Uncategorized</option>${line.accountID && !cats.some((a) => sameId(a.id, line.accountID)) ? `<option value="${esc(line.accountID)}" selected>${esc(d.accountName(line.accountID))}</option>` : ''}${cats.map((a) => `<option value="${esc(a.id)}" ${sameId(a.id, line.accountID) ? 'selected' : ''}>${esc(accountDisplayName(a))}</option>`).join('')}</select></label>
        <label class="field"><span>Project</span><select name="projectID"><option value="">Company (no project)</option>${jobs.map((p) => `<option value="${esc(p.id)}" ${sameId(p.id, projectID) ? 'selected' : ''}>${esc(projectName(p))}</option>`).join('')}</select></label>
        <label class="field"><span>Notes</span><textarea name="memo" rows="1" placeholder="Who you met, what it was for">${esc(t.memo || '')}</textarea></label>
      </div>${existing && isPaired(existing) ? `<div class="fs-foot">${esc(PAIRED_NOTE)}</div>` : ''}</div>
      <div class="sheet-actions">${existing ? `<button type="button" class="btn danger" data-act="expense-delete" data-id="${esc(key(existing.id))}" aria-label="Delete" style="flex:0 0 52px">${icon('trash')}</button>` : ''}<button type="button" class="btn" data-act="sheet-close">Cancel</button><button type="submit" class="btn primary">${existing ? 'Save' : 'Add Expense'}</button></div>
    </form>`, (el) => {
    const f = $('#expense-form', el);
    let rateTouched = !!cad;
    const showFiles = () => {
      const strip = $('#receipt-strip', f);
      $$('.pending', strip).forEach((x) => x.remove());
      for (const file of S.ui.expenseFiles) {
        const url = /^image\//.test(file.type) ? URL.createObjectURL(file) : '';
        strip.insertAdjacentHTML('beforeend', `<span class="thumb pending">${url ? `<img src="${url}" alt="">` : icon('doc')}<span class="badge">New</span></span>`);
      }
    };
    const update = () => {
      const isCAD = f.elements.currency.value === 'CAD';
      $('.fx', f).classList.toggle('hidden', !isCAD);
      const amt = Number(f.elements.amount.value) || 0;
      const rate = Number(f.elements.rate.value) || 0;
      if (isCAD) {
        const note = $('#fx-note', f);
        const src = f.dataset.fxSource ? ` · ${f.dataset.fxSource}` : '';
        note.innerHTML = amt && rate ? `= <b>${esc(fmt.money(amt * rate, true))}</b> US in the books${esc(src)}` : esc(f.dataset.fxSource || '');
      }
      const pw = f.elements.paidWith.value;
      $('#paid-note', f).textContent = pw === 'owner' ? 'The company owes you this. Pay yourself back from the Mac, or switch it to a contribution any time.'
        : pw === 'contribution' ? 'Kept in the LLC as money you put in (Owner Contributions). Nothing is owed back.' : '';
      $$('[data-act="expense-kind"][data-kind="materials"]', f).forEach((b) => b.classList.toggle('hidden', !f.elements.projectID.value));
    };
    const getRate = async () => {
      if (f.elements.currency.value !== 'CAD' || rateTouched) { update(); return; }
      const day = f.elements.date.value || fmt.inputDate(new Date());
      f.dataset.fxSource = 'Getting the Bank of Canada rate…';
      update();
      try {
        const r = await cadRate(day);
        if (rateTouched || !document.body.contains(f)) return;
        f.elements.rate.value = r.rate.toFixed(4);
        f.dataset.fxSource = `${r.source}, ${fmt.short(parseInputDate(r.date))}`;
        f.dataset.fxRaw = JSON.stringify(r);
      } catch {
        const last = fxCache.last;
        if (last && !f.elements.rate.value) f.elements.rate.value = last.rate.toFixed(4);
        f.dataset.fxSource = last ? `Couldn't reach the Bank of Canada; using the last rate (${fmt.short(parseInputDate(last.date))}). Change it if you know the day's rate.` : "Couldn't reach the Bank of Canada. Type the rate from your card statement or bank.";
        f.dataset.fxRaw = last ? JSON.stringify({ ...last, source: 'Bank of Canada (last known)' }) : '';
      }
      update();
    };
    f.addEventListener('input', (e) => { if (e.target.name === 'rate') { rateTouched = true; f.dataset.fxSource = 'Rate typed in'; f.dataset.fxRaw = ''; } update(); });
    f.addEventListener('change', (e) => { if (e.target.name === 'date') { rateTouched = false; getRate(); } update(); });
    f.addEventListener('currency', () => { getRate(); });
    f.addEventListener('files', showFiles);
    showFiles();
    if (currency === 'CAD' && cad) f.dataset.fxSource = 'Rate saved with this expense';
    getRate();
    if (!existing && !files.length) setTimeout(() => f.elements.payee.focus(), 250);
  });
}

/** An expense entered on the Mac with several lines: what it is, and who paid. */
function sheetExpenseInfo(t) {
  const d = booksData();
  const personal = paidPersonally(t);
  const contributed = !!contributionFor(t.id);
  let body = kvLine('Date', fmt.date(fromSec(t.date))) + kvLine('Amount', fmt.money(txnTotal(t), true)) + kvLine('Paid with', paidWithLabel(t));
  for (const l of t.lines || []) body += kvLine(esc((l.memo || '').trim() || d.accountName(l.accountID)), fmt.money(Number(l.amount) || 0, true));
  openSheet(`${sheetHead(d.payeeName(t) || 'Expense', t.tripID && get(t.tripID) ? tripTitle(get(t.tripID)) : '')}
    <section class="card"><div style="margin:-4px 0">${body}</div></section>
    ${personal && contributionAccount() ? `<div class="form-section"><div class="fs-head">Paid personally</div><div class="segmented">${[['owner', 'Company pays me back'], ['contribution', 'My contribution']].map(([k, l]) => `<button data-act="expense-personal" data-id="${esc(key(t.id))}" data-as="${k}" class="${(contributed ? 'contribution' : 'owner') === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>` : ''}
    <div class="btn-row"><button class="btn" data-act="txn-open" data-id="${esc(key(t.id))}">${icon('bookClosed')}Open in Books</button></div>
    <p class="note" style="text-align:center">It has several lines, so change it on the Mac.</p>
    ${isPaired(t) ? `<p class="note" style="text-align:center">${esc(PAIRED_NOTE)}</p>` : ''}`);
}

function sheetDrive({ id = null, tripID = null } = {}) {
  const existing = id ? get(id) : null;
  const last = allMileage()[0];
  const trip = get(existing?.tripID || tripID);
  const m = existing ? clone(existing) : { date: toSec(localNoon(new Date())), vehicle: last?.vehicle || '', from: '', to: '', purpose: trip?.purpose || '', miles: 0, roundTrip: false, odometerStart: 0, odometerEnd: 0, personalVehicle: last ? last.personalVehicle !== false : true, tripID: trip?.id };
  const unit = distanceUnit();
  const factor = unit === 'km' ? KM_PER_MILE : 1;
  const posted = existing ? mileagePosted(existing) : null;
  const vehicles = [...new Set(allMileage().map((x) => (x.vehicle || '').trim()).filter(Boolean))];
  const jobs = projects().filter((p) => statusGroup(p.status) !== 'closed' || sameId(p.id, m.projectID)).sort((a, b) => projectName(a).localeCompare(projectName(b)));
  const tripJobs = (trip?.projectIDs || []).map((x) => project(x)).filter(Boolean);
  const projectID = existing ? m.projectID : tripJobs.length === 1 ? tripJobs[0].id : null;
  const trips = allTrips().slice(0, 30);
  openSheet(`${sheetHead(existing ? 'Drive' : 'Log a Drive', trip ? tripTitle(trip) : '')}
    <form id="drive-form" data-id="${esc(existing ? key(existing.id) : '')}" data-unit="${unit}">
      <div class="form-section"><div class="form-card">
        <div class="two"><label class="field"><span>From</span><input name="from" value="${esc(m.from || '')}" placeholder="Hotel"></label><label class="field"><span>To</span><input name="to" value="${esc(m.to || '')}" placeholder="77 Birch St"></label></div>
        <div class="two"><label class="field"><span>Distance (${unit === 'km' ? 'km' : 'miles'}, one way)</span><input name="distance" type="number" inputmode="decimal" step="0.1" min="0" value="${m.miles ? tenths(m.miles * factor).replace(/,/g, '') : ''}" placeholder="0" required></label>
          <label class="field"><span>Date</span><input name="date" type="date" value="${fmt.inputDate(fromSec(m.date))}" required></label></div>
        <label class="toggle">Round trip (counts it twice)<input type="checkbox" name="roundTrip" ${m.roundTrip ? 'checked' : ''}></label>
        <label class="field"><span>Business purpose</span><input name="purpose" value="${esc(m.purpose || '')}" placeholder="Site walk with the framer"></label>
        <p class="note" id="drive-note" style="margin:-4px 0 12px"></p>
      </div></div>
      <div class="form-section"><div class="form-card">
        <label class="field"><span>Vehicle</span><input name="vehicle" value="${esc(m.vehicle || '')}" list="vehicles" placeholder="Rental, F-150…"><datalist id="vehicles">${vehicles.map((v) => `<option value="${esc(v)}">`).join('')}</datalist></label>
        <label class="toggle">My own vehicle (claimed at the IRS rate)<input type="checkbox" name="personalVehicle" ${m.personalVehicle !== false ? 'checked' : ''}></label>
        <label class="field"><span>Project</span><select name="projectID"><option value="">Company (no project)</option>${jobs.map((p) => `<option value="${esc(p.id)}" ${sameId(p.id, projectID) ? 'selected' : ''}>${esc(projectName(p))}</option>`).join('')}</select></label>
        <label class="field"><span>Trip</span><select name="tripID"><option value="">No trip</option>${trips.map((x) => `<option value="${esc(x.id)}" ${sameId(x.id, m.tripID) ? 'selected' : ''}>${esc(`${tripTitle(x)} · ${tripDates(x)}`)}</option>`).join('')}</select></label>
        <div class="two"><label class="field"><span>Odometer start</span><input name="odometerStart" type="number" inputmode="decimal" step="1" min="0" value="${m.odometerStart ? Math.round(m.odometerStart * factor) : ''}" placeholder="${(() => { const o = lastOdometer({ vehicle: m.vehicle || '', date: m.date, skipID: existing?.id, below: Number(m.odometerEnd) || 0, tripID: m.tripID || null }); return o ? Math.round(o * factor) : ''; })()}"></label><label class="field"><span>Odometer end</span><input name="odometerEnd" type="number" inputmode="decimal" step="1" min="0" value="${m.odometerEnd ? Math.round(m.odometerEnd * factor) : ''}"></label></div>
      </div><div class="fs-foot">${posted ? `In the books as ${contributionFor(posted.id) ? 'your contribution' : 'owed to you'}; saving keeps it in step.` : 'Saved here first; post it to the books when you like.'}</div></div>
      ${posted && contributionAccount() ? `<div class="form-section"><div class="fs-head">In the books</div><div class="segmented">${[['owner', 'Company pays me back'], ['contribution', 'My contribution']].map(([k, l]) => `<button type="button" data-act="expense-personal" data-id="${esc(key(posted.id))}" data-as="${k}" class="${(contributionFor(posted.id) ? 'contribution' : 'owner') === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>` : ''}
      ${existing && !posted && m.personalVehicle !== false ? `<div class="form-section"><div class="btn-row wrap"><button type="button" class="btn" data-act="drive-post" data-id="${esc(key(existing.id))}" data-as="owner">${icon('wallet')}Post: Pay Me Back</button>${contributionAccount() ? `<button type="button" class="btn" data-act="drive-post" data-id="${esc(key(existing.id))}" data-as="contribution">${icon('handCoin')}Post as My Contribution</button>` : ''}</div></div>` : ''}
      <div class="sheet-actions">${existing ? `<button type="button" class="btn danger" data-act="drive-delete" data-id="${esc(key(existing.id))}" aria-label="Delete" style="flex:0 0 52px">${icon('trash')}</button>` : ''}<button type="button" class="btn" data-act="sheet-close">Cancel</button><button type="submit" class="btn primary">${existing ? 'Save' : 'Log Drive'}</button></div>
    </form>`, (el) => {
    const f = $('#drive-form', el);
    // Where the odometer was left: the last drive's ending reading, as a hint in Odometer start.
    const hintOdometer = () => {
      const d = parseInputDate(f.elements.date.value);
      const typedEnd = Number(f.elements.odometerEnd.value) || 0;
      const o = lastOdometer({ vehicle: f.elements.vehicle.value, date: d ? toSec(localNoon(d)) : 0, skipID: existing?.id, below: typedEnd / factor, tripID: f.elements.tripID.value || null });
      f.elements.odometerStart.placeholder = o ? String(Math.round(o * factor)) : '';
    };
    f.elements.tripID.addEventListener('change', hintOdometer);
    f.elements.odometerEnd.addEventListener('input', (e) => { if (e.isTrusted) f.elements.odometerEnd.dataset.typed = f.elements.odometerEnd.value ? '1' : ''; });
    if (existing && m.odometerEnd) f.elements.odometerEnd.dataset.typed = '1';
    f.elements.odometerEnd.addEventListener('input', hintOdometer);
    f.elements.vehicle.addEventListener('input', hintOdometer);
    f.elements.vehicle.addEventListener('change', hintOdometer);
    f.elements.date.addEventListener('change', hintOdometer);
    const update = () => {
      let dist = Number(f.elements.distance.value) || 0;
      const a = Number(f.elements.odometerStart.value) || 0, b = Number(f.elements.odometerEnd.value) || 0;
      if (!dist && a && b > a) { dist = b - a; }
      // Rounded to a tenth of a mile one way, as it's saved.
      const miles = (Math.round(dist / (unit === 'km' ? KM_PER_MILE : 1) * 10) / 10) * (f.elements.roundTrip.checked ? 2 : 1);
      // Odometer end is filled in from Odometer start plus the distance (both ways on a round
      // trip), until it's typed over; typing in it by hand leaves it alone from then on.
      const typedDist = Number(f.elements.distance.value) || 0;
      const endBox = f.elements.odometerEnd;
      if (!endBox.dataset.typed) endBox.value = a && typedDist ? String(Math.round(a + typedDist * (f.elements.roundTrip.checked ? 2 : 1))) : '';
      const date = parseInputDate(f.elements.date.value) || new Date();
      const rate = mileageRate(toSec(localNoon(date)));
      $('#drive-note', f).textContent = f.elements.personalVehicle.checked
        ? `${tenths(miles)} mi${unit === 'km' ? ` (${tenths(miles * KM_PER_MILE)} km)` : ''} × ${centsText(rate)} = ${fmt.money(miles * rate, true)}`
        : 'A company vehicle is logged for the record; its costs are already in the books.';
    };
    f.addEventListener('input', update);
    f.addEventListener('change', update);
    update();
    if (!existing) setTimeout(() => f.elements.from.focus(), 250);
  });
}

function readDriveForm(f, existing) {
  const unit = f.dataset.unit;
  const per = unit === 'km' ? KM_PER_MILE : 1;
  const v = (n) => (f.elements[n]?.value ?? '').trim();
  const m = existing ? clone(existing) : { id: newId() };
  m.from = v('from'); m.to = v('to'); m.purpose = v('purpose'); m.vehicle = v('vehicle');
  m.roundTrip = f.elements.roundTrip.checked;
  m.personalVehicle = f.elements.personalVehicle.checked;
  const a = Number(v('odometerStart')) || 0, b = Number(v('odometerEnd')) || 0;
  m.odometerStart = a ? Math.round(a / per * 10) / 10 : 0;
  m.odometerEnd = b ? Math.round(b / per * 10) / 10 : 0;
  let dist = Number(v('distance')) || 0;
  if (!dist && a && b > a) dist = b - a;
  m.miles = Math.round(dist / per * 10) / 10;
  if (!b && a && Number(v('distance')) > 0) m.odometerEnd = Math.round((m.odometerStart + m.miles * (m.roundTrip ? 2 : 1)) * 10) / 10;
  const d = parseInputDate(v('date'));
  if (d && !(existing && sameDay(d, fromSec(existing.date)))) m.date = toSec(localNoon(d));
  for (const k of ['projectID', 'tripID']) { if (v(k)) m[k] = v(k); else delete m[k]; }
  return m;
}

async function postDrive(m, as) {
  if (booksClosedOn(m.date)) { toast(closedMessage()); return false; }
  const existingT = get(stableID(`${key(m.id)}:mileage`));
  const t = mileageExpense(m, existingT && !existingT.isVoid ? existingT : null);
  if (!(txnTotal(t) > 0)) return false;
  await saveRecord('transaction', t);
  const saved = clone(get(m.id) || m);
  saved.postedTransactionID = t.id;
  await saveRecord('mileage', saved);
  if (as === 'contribution') await setContributed(t, true);
  return true;
}

// ---------------------------------------------------------------------------
// Saving

Object.assign(RECORD_OPS, {
  setFields(r, { fields }) { for (const [k, v] of Object.entries(fields)) { if (v == null) delete r[k]; else r[k] = v; } },
  // A simple expense changed here (one line). Ones changed into splits on the Mac are left alone.
  setExpense(t, { fields, line }) {
    for (const [k, v] of Object.entries(fields)) { if (v == null) delete t[k]; else t[k] = v; }
    if ((t.lines || []).length <= 1 && Object.keys(line).length) {
      const old = (t.lines || [])[0] || { id: newId(), quantity: 1, taxable: true, isDepositCredit: false };
      const next = { ...old, ...line };
      if ('accountID' in line && line.accountID == null) delete next.accountID;
      t.lines = [next];
    }
  },
});

async function saveExpense(f) {
  const d = booksData();
  const v = (n) => (f.elements[n]?.value ?? '').trim();
  const existing = f.dataset.id ? get(f.dataset.id) : null;
  const entered = money(Number(v('amount')) || 0);
  if (!(entered > 0)) { f.elements.amount.focus(); toast('Enter the amount.'); return false; }
  const day = parseInputDate(v('date'));
  if (!day) { f.elements.date.focus(); return false; }
  const date = existing && sameDay(day, fromSec(existing.date)) ? existing.date : toSec(localNoon(day));
  // Nothing new goes into the closed books, and nothing in them moves out (checked below).
  const inClosedBooks = !!existing && booksClosedOn(existing.date);
  if (booksClosedOn(date) && !inClosedBooks) { toast(closedMessage()); return false; }
  const reconciled = isReconciled(existing);
  const currency = v('currency');
  let usd = entered;
  let cadMemo = '';
  if (currency === 'CAD') {
    const rate = Number(v('rate')) || 0;
    if (!(rate > 0)) { f.elements.rate.focus(); toast('Enter the exchange rate.'); return false; }
    usd = money(entered * rate);
    let raw = null;
    try { raw = f.dataset.fxRaw ? JSON.parse(f.dataset.fxRaw) : null; } catch { /* typed */ }
    cadMemo = cadNote(entered, rate, raw ? raw.source : 'rate typed in', raw ? raw.date : '');
  }
  const kind = v('kind');
  const label = kind ? kindLabel(kind) : '';
  const lineMemo = [label, cadMemo].filter(Boolean).join(' · ');
  const paidWith = v('paidWith');
  const personal = paidWith === 'owner' || paidWith === 'contribution';
  // (An account no longer in the chart that it was already paid from stays as it is.)
  const accountID = personal ? d.sys.dueToOwner
    : (d.account(paidWith)?.id || (existing && key(existing.accountID) === paidWith ? existing.accountID : null) || d.sys.defaultBank);
  // How it was paid matters for 1099s (Eagle Creek Books leaves card payments off): a card
  // account is a card; otherwise keep what the Mac or Books set.
  const payType = personal ? null : d.account(accountID)?.type;
  // Paid personally: 'other', as the Mac records a receipt paid personally (unless the Mac or
  // Books already said how).
  const method = payType === 'creditCard' ? 'card'
    : payType === 'bank' ? (existing?.method && existing.method !== 'card' ? existing.method : 'other')
    : personal ? (existing && paidPersonally(existing) ? (existing.method || 'other') : 'other')
    : (existing?.method || 'other');
  let fields = {
    payee: v('payee'), date, accountID, method,
    projectID: v('projectID') || null, tripID: f.dataset.trip ? (get(f.dataset.trip)?.id || f.dataset.trip) : (existing?.tripID || null), memo: f.elements.memo.value,
  };
  let line = { accountID: v('accountID') || null, memo: lineMemo, amount: usd, rate: usd, quantity: 1 };
  if (existing) {
    // Only what changed here, so an edit made on the Mac at the same time to anything else
    // survives when this one is made again on its copy.
    const same = (a, b) => (a ?? null) === (b ?? null) || (typeof a === 'string' && typeof b === 'string' && key(a) === key(b)) || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.0005);
    const oldLine = (existing.lines || [])[0] || {};
    fields = Object.fromEntries(Object.entries(fields).filter(([k, val]) => !same(val, existing[k] ?? null)));
    line = Object.fromEntries(Object.entries(line).filter(([k, val]) => !same(val, oldLine[k] ?? null)));
    // In the closed books only notes can change (its memo, its trip), like on the Mac. A
    // reconciled entry keeps its date, account and amount; its category can still change.
    if (inClosedBooks || reconciled) {
      const wasContribution = !!contributionFor(existing.id);
      const fixedFields = inClosedBooks ? ['payee', 'date', 'accountID', 'method', 'projectID'] : ['date', 'accountID'];
      const fixedLine = inClosedBooks ? ['accountID', 'amount'] : ['amount'];
      const changesBooks = Object.keys(fields).some((k) => fixedFields.includes(k)) || Object.keys(line).some((k) => fixedLine.includes(k))
        || (inClosedBooks && wasContribution !== (paidWith === 'contribution'));
      if (changesBooks) { toast(inClosedBooks ? closedMessage() : reconciledMessage()); return false; }
    }
  }
  prefs.set('expense-currency', currency);
  prefs.set('expense-paid-with', paidWith);
  let saved;
  if (existing) {
    // Keep a memo note typed on the Mac that isn't ours.
    const oldMemo = ((existing.lines || [])[0]?.memo || '');
    if (!kind && oldMemo && !RECEIPT_KINDS.some(([, l]) => oldMemo.startsWith(l)) && !/CA\$/.test(oldMemo)) {
      const kept = [oldMemo, cadMemo].filter(Boolean).join(' · ');
      if (kept !== oldMemo) line.memo = kept; else delete line.memo;
    }
    saved = await editRecord('transaction', existing.id, [{ op: 'setExpense', fields, line }]);
  } else {
    const t = newExpenseShell(f.dataset.newId);
    for (const [k, val] of Object.entries(fields)) { if (val != null) t[k] = val; }
    t.lines = [{ id: newId(), ...line, taxable: true, isDepositCredit: false }];
    if (!line.accountID) delete t.lines[0].accountID;
    saved = await saveRecord('transaction', t);
  }
  if (!saved) return false;
  // Kept in as a contribution, or owed back.
  if (paidWith === 'contribution') await setContributed(get(saved.id), true);
  else if (contributionFor(saved.id) || get(contributionID(saved.id))) await setContributed(get(saved.id), false);
  if (S.ui.expenseFiles?.length) {
    await addFiles(S.ui.expenseFiles, { projectID: saved.projectID || null, category: 'receipt', transactionID: saved.id });
    S.ui.expenseFiles = [];
  }
  return saved;
}

Object.assign(ACTIONS, {
  'trip-new': () => sheetTrip(null),
  'trip-edit': (el) => sheetTrip(el.dataset.id),
  'trip-delete': async (el) => {
    const t = get(el.dataset.id);
    if (!t) return;
    const expenses = all('transaction').filter((x) => sameId(x.tripID, t.id));
    const drives = all('mileage').filter((x) => sameId(x.tripID, t.id));
    const proof = filesFor('recordID', t.id);
    const keep = [expenses.length ? plural(expenses.length, 'expense') : '', drives.length ? plural(drives.length, 'drive') : '', proof.length ? plural(proof.length, 'file') : ''].filter(Boolean);
    if (!confirm(`Delete ${tripTitle(t)}?${keep.length ? `\n\nIts ${keep.join(', ')} stay; they're just no longer grouped.` : ''}`)) return;
    closeSheet();
    for (const x of expenses) await editRecord('transaction', x.id, [{ op: 'setFields', fields: { tripID: null } }]);
    for (const x of drives) { const c = clone(x); delete c.tripID; await saveRecord('mileage', c); }
    for (const x of proof) { const c = clone(x); delete c.recordID; await saveRecord('file', c); }
    const stay = stayFor(t.id);
    if (stay) await deleteRecord('usStay', stay.id);
    await deleteRecord('trip', t.id);
    location.hash = '#/trips';
    toast('Trip deleted');
  },
  'trip-proof': (el) => {
    const t = get(el.dataset.id);
    if (!t) return;
    pickFiles({ accept: 'image/*,application/pdf', capture: false, multiple: true }, async (files) => {
      await addFiles(files, { projectID: null, category: 'travel', recordID: t.id });
    });
  },
  'trip-count-days': async (el) => {
    const t = get(el.dataset.id);
    if (!t || stayFor(t.id)) return;
    await saveRecord('usStay', { id: newId(), tripID: t.id, arrive: t.startDate, leave: t.endDate ?? t.startDate, note: '' });
    render();
    toast('Days counted');
  },
  'expense-new': (el) => sheetExpense({ tripID: el.dataset.trip || null }),
  'expense-snap': (el) => pickFiles({ accept: 'image/*', capture: true, multiple: false }, (files) => sheetExpense({ tripID: el.dataset.trip || null, files })),
  'expense-open': (el) => sheetExpense({ id: el.dataset.id }),
  'expense-kind': (el) => {
    const f = $('#expense-form');
    f.elements.kind.value = el.dataset.kind;
    $$('[data-act="expense-kind"]', f).forEach((b) => b.classList.toggle('on', b === el));
    const cat = travelCategory(el.dataset.kind, f.elements.projectID.value || null);
    f.elements.accountID.value = cat || '';
    sheetDirty = true;
  },
  'expense-currency': (el) => {
    const f = $('#expense-form');
    f.elements.currency.value = el.dataset.currency;
    $$('[data-act="expense-currency"]', f).forEach((b) => b.classList.toggle('on', b === el));
    f.dispatchEvent(new Event('currency'));
    sheetDirty = true;
  },
  'expense-receipt': (el) => {
    const f = $('#expense-form');
    pickFiles({ accept: el.dataset.capture ? 'image/*' : 'image/*,application/pdf', capture: !!el.dataset.capture, multiple: !el.dataset.capture }, async (files) => {
      if (f.dataset.id) {
        const t = get(f.dataset.id);
        const added = await addFiles(files, { projectID: t?.projectID || null, category: 'receipt', transactionID: t.id });
        if (added && document.body.contains(f)) $('#receipt-strip', f).innerHTML = receiptsFor(t.id).map((x) => thumbCell(x, '')).join('');
        hydrateThumbs();
      } else {
        S.ui.expenseFiles = [...(S.ui.expenseFiles || []), ...files];
        f.dispatchEvent(new Event('files'));
      }
      sheetDirty = true;
    });
  },
  'expense-delete': async (el) => {
    const t = get(el.dataset.id);
    if (!t) return;
    if (booksClosedOn(t.date)) { toast(closedMessage()); return; }
    if (isReconciled(t)) { toast(reconciledMessage()); return; }
    if (!confirm(`Delete this ${fmt.money(txnTotal(t), true)} expense?\n\nIt's removed from the books on every device. Its receipt stays in Files.${isPaired(t) ? '\n\nEagle Creek Books recorded it in your personal books too; delete the personal side there (Banking › Undo on its bank line).' : ''}`)) return;
    closeSheet();
    if (get(contributionID(t.id))) await deleteRecord('transaction', contributionID(t.id));
    await deleteRecord('transaction', t.id);
    render();
    toast('Deleted');
  },
  'expense-personal': async (el) => {
    const t = get(el.dataset.id);
    if (!t || !paidPersonally(t)) return;
    if (booksClosedOn(t.date)) { toast(closedMessage()); return; }
    const on = el.dataset.as === 'contribution';
    await setContributed(t, on);
    $$(`[data-act="expense-personal"][data-id="${el.dataset.id}"]`).forEach((b) => b.classList.toggle('on', b === el));
    renderSoon();
    toast(isPaired(t) ? `${on ? 'Kept in as your contribution' : 'Owed back to you'}. Change the personal side in Eagle Creek Books too.` : on ? 'Kept in as your contribution' : 'Owed back to you');
  },
  'drive-new': (el) => sheetDrive({ tripID: el.dataset.trip || null }),
  'drive-open': (el) => sheetDrive({ id: el.dataset.id }),
  'drive-delete': async (el) => {
    const m = get(el.dataset.id);
    if (!m) return;
    const posted = mileagePosted(m);
    if (!confirm(`Delete this drive?${posted ? '\n\nIts expense comes out of the books too.' : ''}`)) return;
    closeSheet();
    if (posted && isReconciled(posted)) { toast(reconciledMessage()); return; }
    if (posted && !booksClosedOn(posted.date)) {
      if (get(contributionID(posted.id))) await deleteRecord('transaction', contributionID(posted.id));
      await deleteRecord('transaction', posted.id);
    }
    await deleteRecord('mileage', m.id);
    render();
    toast('Deleted');
  },
  'drive-post': async (el) => {
    const m = get(el.dataset.id);
    if (!m) return;
    closeSheet();
    if (await postDrive(m, el.dataset.as)) { render(); toast(el.dataset.as === 'contribution' ? 'In the books as your contribution' : 'In the books as owed to you'); }
  },
  'drive-post-all': async (el) => {
    const list = allMileage().filter((m) => m.personalVehicle !== false && !mileagePosted(m) && mileageAmount(m) > 0).reverse();
    let n = 0;
    for (const m of list) if (await postDrive(m, el.dataset.as)) n++;
    render();
    toast(`${plural(n, 'drive')} posted`);
  },
  'distance-unit': (el) => { prefs.set('distance-unit-2', el.dataset.unit); render(); },
  'stay-new': () => sheetStay(null),
  'stay-open': (el) => sheetStay(el.dataset.id),
  'stay-delete': async (el) => {
    const s = get(el.dataset.id);
    if (!s) return;
    closeSheet();
    await deleteRecord('usStay', s.id);
    render();
    toast('Not counted');
  },
  'contribute-amount': () => {
    const owed = accountBalance(booksData().sys.dueToOwner);
    openSheet(`${sheetHead('Make It a Contribution', `The company owes you ${fmt.money(owed, true)}`)}
      <form id="contribute-form">
        <div class="form-section"><div class="form-card">
          <div class="two"><label class="field"><span>Amount</span><input name="amount" type="number" inputmode="decimal" step="0.01" min="0" max="${owed.toFixed(2)}" value="${owed.toFixed(2)}" required></label>
            <label class="field"><span>Date</span><input name="date" type="date" value="${fmt.inputDate(new Date())}" required></label></div>
          <label class="field"><span>Note</span><input name="memo" value="" placeholder="Leaving it in the company"></label>
        </div><div class="fs-foot">The company stops owing you this amount; it's recorded as money you put into the LLC (a journal entry from Owed to Owner to Owner Contributions).</div></div>
        <div class="sheet-actions"><button type="button" class="btn" data-act="sheet-close">Cancel</button><button type="submit" class="btn primary">Make Contribution</button></div>
      </form>`);
  },
});

document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (!['trip-form', 'expense-form', 'drive-form', 'stay-form', 'contribute-form'].includes(f.id)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const v = (n) => (f.elements[n]?.value ?? '').trim();
  if (f.id === 'trip-form') {
    const start = parseInputDate(v('startDate')), end = parseInputDate(v('endDate'));
    if (!start || !end) return;
    const existing = f.dataset.id ? get(f.dataset.id) : null;
    const fields = {
      title: v('title'), destination: v('destination'), purpose: f.elements.purpose.value.trim(), notes: f.elements.notes.value,
      startDate: existing && sameDay(start, fromSec(existing.startDate)) ? existing.startDate : toSec(localNoon(start)),
      endDate: toSec(localNoon(end < start ? start : end)),
      projectIDs: $$('[name=projectIDs]:checked', f).map((x) => x.value),
    };
    if (existing && sameDay(end < start ? start : end, fromSec(existing.endDate ?? existing.startDate))) fields.endDate = existing.endDate ?? existing.startDate;
    let trip;
    if (existing) trip = await editRecord('trip', existing.id, [{ op: 'setFields', fields }]);
    else trip = await saveRecord('trip', { id: newId(), ...fields });
    if (!trip) return;
    const stay = stayFor(trip.id);
    if (f.elements.usDays.checked) {
      const data = { ...(stay ? clone(stay) : { id: newId(), tripID: trip.id, note: '' }), arrive: trip.startDate, leave: trip.endDate };
      if (!stay || stay.arrive !== data.arrive || stay.leave !== data.leave) await saveRecord('usStay', data);
    } else if (stay) await deleteRecord('usStay', stay.id);
    closeSheet();
    if (!existing) location.hash = `#/trip/${key(trip.id)}`;
    toast(existing ? 'Saved' : 'Trip started');
  }
  if (f.id === 'expense-form') {
    const btn = $('button[type=submit]', f);
    btn.disabled = true;
    const saved = await saveExpense(f).catch((err) => { console.error(err); toast(friendlyError(err)); return false; });
    if (!saved) { btn.disabled = false; return; }
    closeSheet();
    toast(f.dataset.id ? 'Saved' : 'Expense added');
  }
  if (f.id === 'drive-form') {
    const existing = f.dataset.id ? get(f.dataset.id) : null;
    const m = readDriveForm(f, existing);
    if (!(m.miles > 0)) { f.elements.distance.focus(); toast('Enter the distance.'); return; }
    await saveRecord('mileage', m);
    // A changed ending reading moves the drives after it on the same trip (or, with no trip,
    // on no trip) by the same amount, start and end alike, so their own miles don't change.
    const oldEnd = Number(existing?.odometerEnd) || 0, newEnd = Number(m.odometerEnd) || 0;
    const shift = oldEnd && newEnd ? Math.round((newEnd - oldEnd) * 10) / 10 : 0;
    let shifted = 0;
    if (shift) {
      const pool = (m.tripID ? tripMileage(m.tripID) : all('mileage').filter((x) => !x.tripID).sort(driveOrder));
      for (const x of pool) {
        if (sameId(x.id, m.id) || driveOrder(x, existing || m) <= 0 || !(Number(x.odometerStart) || Number(x.odometerEnd))) continue;
        const y = clone(x);
        if (Number(y.odometerStart)) y.odometerStart = Math.round((Number(y.odometerStart) + shift) * 10) / 10;
        if (Number(y.odometerEnd)) y.odometerEnd = Math.round((Number(y.odometerEnd) + shift) * 10) / 10;
        await saveRecord('mileage', y);
        shifted++;
      }
    }
    const posted = existing ? mileagePosted(existing) : null;
    if (posted && !booksClosedOn(posted.date) && !booksClosedOn(m.date)) {
      const t = mileageExpense(m, posted);
      // A reconciled mileage expense keeps its amount; only the drive's notes change.
      if (isReconciled(posted) && (Math.abs(txnTotal(t) - txnTotal(posted)) >= 0.005 || t.date !== posted.date)) { toast(reconciledMessage()); return; }
      await saveRecord('transaction', t);
      if (contributionFor(t.id)) await setContributed(t, true);
    }
    closeSheet();
    toast(shifted ? `Saved · ${plural(shifted, 'later drive')} moved ${shift > 0 ? '+' : ''}${tenths(shift)} on the odometer` : existing ? 'Saved' : 'Drive logged');
  }
  if (f.id === 'stay-form') {
    const a = parseInputDate(v('arrive')), b = parseInputDate(v('leave'));
    if (!a || !b) return;
    const existing = f.dataset.id ? get(f.dataset.id) : null;
    await saveRecord('usStay', { ...(existing ? clone(existing) : { id: newId() }), arrive: toSec(localNoon(a)), leave: toSec(localNoon(b < a ? a : b)), note: v('note') });
    closeSheet();
    toast('Saved');
  }
  if (f.id === 'contribute-form') {
    const d = booksData();
    const owed = accountBalance(d.sys.dueToOwner);
    const amount = money(Math.min(Number(v('amount')) || 0, owed));
    const day = parseInputDate(v('date'));
    if (!(amount > 0) || !day) return;
    const date = sameDay(day, new Date()) ? stamp() : toSec(localNoon(day));
    if (booksClosedOn(date)) { toast(closedMessage()); return; }
    const t = newExpenseShell();
    Object.assign(t, { type: 'journal', method: 'other', date, payee: 'Owner contribution', memo: v('memo') || 'Money the company owed me, kept in as a contribution' });
    t.lines = [
      { id: newId(), accountID: d.sys.dueToOwner, memo: 'Owed to owner', quantity: 1, rate: 0, amount, taxable: true, isDepositCredit: false },
      { id: newId(), accountID: contributionAccount(), memo: 'Owner contribution', quantity: 1, rate: 0, amount: -amount, taxable: true, isDepositCredit: false },
    ];
    await saveRecord('transaction', t);
    closeSheet();
    render();
    toast(`${fmt.money(amount, true)} recorded as your contribution`);
  }
}, true);
