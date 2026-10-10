/* Eagle Creek — a project's Budget section: Budget, Selections, Subs & POs.
 *
 * Budget: every line by category with what's been billed against it in the books, the
 * contingency, and what's left (the Mac's BudgetTab and BudgetMath). The budget itself is
 * edited on the Mac.
 * Selections: the finish schedule (the Mac's SelectionsTab and SelectionMath): what's going in,
 * from whom, where each stands and when to order it. Selections can be added and changed here;
 * they live inside the project record, so each change is kept as a step that's made again on
 * the Mac's newer copy if the project changed there in the meantime (editRecord).
 * Subs & POs: what each sub or supplier agreed to, has billed and has left (CommitmentsTab).
 */
'use strict';

Object.assign(ICONS, {
  palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8h2.1a4.3 4.3 0 0 0 4.3-4.3c0-3.7-3.8-6.8-9-6.8z"/><circle cx="7.5" cy="11" r="1.1"/><circle cx="10" cy="7.3" r="1.1"/><circle cx="14.5" cy="7.3" r="1.1"/>',
  box: '<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  stack: '<path d="m12 3 9 4.5-9 4.5-9-4.5z"/><path d="m3 12 9 4.5 9-4.5M3 16.5 12 21l9-4.5"/>',
});

const trimNum = (v) => { const n = Number(v) || 0; return n === Math.round(n) ? String(n) : n.toFixed(1); };
const kvRow = (label, value, cls = '') => `<div class="kv"><span>${esc(label)}</span><span class="${cls}">${esc(value)}</span></div>`;
const drawTitle = (p, drawID) => {
  const i = (p.draws || []).findIndex((d) => sameId(d.id, drawID));
  if (i < 0) return '';
  const name = (p.draws[i].name || '').trim();
  return name ? `Draw ${i + 1} — ${name}` : `Draw ${i + 1}`;
};
const BUDGET_UNITS = ['ls', 'ea', 'sf', 'lf', 'sq', 'gal', 'set', 'hr', 'day', 'cy'];
const quantityText = (qty, unit, unitCost) => (unit === 'ls' && (qty ?? 1) === 1 ? 'Lump sum' : `${trimNum(qty ?? 1)} ${unit || ''} × ${fmt.money(unitCost, Math.round(unitCost) !== unitCost)}`);

// ---------------------------------------------------------------------------
// Budget

function budgetCategories(p) {
  const seen = new Set();
  const out = [];
  for (const b of p.budget || []) { const c = b.category ?? 'General'; if (!seen.has(c)) { seen.add(c); out.push(c); } }
  return out;
}

function budgetLineRow(p, b, jc) {
  const total = budgetItemTotal(b);
  const billed = jc.billedByItem.get(key(b.id)) || 0;
  const over = billed > total + 0.5 && total > 0;
  const actual = Number(b.actualCost) || 0;
  const sub = [quantityText(b.quantity, b.unit ?? 'ls', Number(b.unitCost) || 0), drawTitle(p, b.drawID).replace(/ — .*/, ''), (b.vendor || '').trim()].filter(Boolean);
  const money2 = [];
  if (billed) money2.push(`<span class="${over ? 'alert-text' : ''}">Billed ${esc(fmt.money(billed))}</span>`);
  if (actual) money2.push(`Actual ${esc(fmt.money(actual))}`);
  if (b.percentComplete) money2.push(`${Math.round(b.percentComplete)}% done`);
  const progress = total > 0 && billed > 0 ? `<div class="progress thin"><i style="width:${Math.min(100, Math.round(billed / total * 100))}%;${over ? 'background:var(--danger)' : ''}"></i></div>` : '';
  return `<button class="row" data-act="budget-line" data-project="${esc(key(p.id))}" data-id="${esc(key(b.id))}">
    <div class="main"><div class="t">${esc((b.name || '').trim() || '(unnamed item)')}</div>
      <div class="s">${esc(sub.join(' · '))}</div>${money2.length ? `<div class="s">${money2.join(' · ')}</div>` : ''}${progress}</div>
    <div class="end"><span class="amt">${esc(fmt.money(total))}</span>${over ? '<span class="alert-text">Over</span>' : ''}</div></button>`;
}

function projectBudget(p) {
  const items = p.budget || [];
  const t = budgetTotals(p);
  const work = p.kind === 'flip' ? 'Rehab' : 'Construction';
  if (!items.length && t.estimate <= 0) {
    return emptyState('hammer', 'No Budget Yet', p.kind === 'clientJob'
      ? "The budget is filled from the estimate (at your cost) on the Mac. Once it's set up, it shows here with what's been billed against each line."
      : "Set up the budget on the Mac (the standard scope, or your own categories). It shows here with what's been billed against each line.");
  }
  const jc = jobCost(p);
  const spent = budgetSpent(p, jc.billedByItem, jc.rehabBilled);
  const left = money(t.total - spent);
  const used = t.total > 0 ? jc.rehabBilled / t.total : 0;
  let html = `<div class="tiles">
    ${tile(`${work} Budget`, fmt.money(t.total), t.contingency > 0 ? `Includes ${fmt.money(t.contingency)} contingency` : plural(items.length, 'line'))}
    ${tile('Billed', fmt.money(jc.rehabBilled), t.total > 0 ? `${Math.round(used * 100)}% of budget` : '', { accent: 'var(--forest)', progress: Math.min(1, used) })}
    ${tile('Budget Left', fmt.money(left), left < 0 ? 'Over budget' : 'Total less spent', { accent: left < 0 ? 'var(--danger)' : 'var(--olive)' })}
  </div>`;
  const overLines = items.filter((b) => { const total = budgetItemTotal(b); return total > 0 && (jc.billedByItem.get(key(b.id)) || 0) > total + 0.5; });
  if (overLines.length) {
    const names = overLines.slice(0, 3).map((b) => (b.name || '').trim() || 'Unnamed line').join(', ');
    html += banner(`${plural(overLines.length, 'line')} ${overLines.length === 1 ? 'is' : 'are'} billed over budget: ${names}${overLines.length > 3 ? '…' : ''}.`, 'var(--danger)');
  }
  for (const c of budgetCategories(p)) {
    const lines = items.filter((b) => (b.category ?? 'General') === c);
    const subtotal = lines.reduce((s, b) => s + budgetItemTotal(b), 0);
    html += card(c, lines.map((b) => budgetLineRow(p, b, jc)).join(''), { action: `<span class="card-total">${esc(fmt.money(subtotal))}</span>` });
  }
  const area = livingArea(p);
  const actual = items.reduce((s, b) => s + (Number(b.actualCost) || 0), 0);
  let totals = '';
  if (t.estimate > 0) totals += kvRow('Estimated from cost per sq ft', fmt.money(t.estimate));
  totals += kvRow('Line items', fmt.money(t.base));
  totals += kvRow(`Contingency (${trimNum(p.contingencyPct ?? 10)}%)`, fmt.money(t.contingency));
  totals += `<div class="kv"><span><b>Total</b></span><span class="total-v">${esc(fmt.money(t.total))}</span></div>`;
  if (area > 0) totals += kvRow('Per sq ft', fmt.money(t.total / area, true));
  if (actual) totals += kvRow('Actual (typed on lines)', fmt.money(actual));
  totals += kvRow('Billed in the books', fmt.money(jc.rehabBilled));
  if (jc.unlinkedRehab) totals += kvRow(`${work} billed but not on a line`, fmt.money(jc.unlinkedRehab));
  totals += `<div class="kv"><span><b>Budget left</b></span><span class="total-v" style="${left < 0 ? 'color:var(--danger)' : ''}">${esc(fmt.money(left))}</span></div>`;
  html += card('Totals', `<div style="padding:0 16px 6px">${totals}</div>`);
  html += `<p class="note" style="margin:0 4px 14px">Budget left counts each line's larger of its typed actual and its bills, plus billed work not tied to a line. Change the budget on the Mac.</p>`;
  return html;
}

function sheetBudgetLine(projectID, itemID) {
  const p = project(projectID);
  const b = (p?.budget || []).find((x) => sameId(x.id, itemID));
  if (!b) return;
  const jc = jobCost(p);
  const total = budgetItemTotal(b);
  const billed = jc.billedByItem.get(key(b.id)) || 0;
  const paid = jc.paidByItem.get(key(b.id)) || 0;
  const over = billed > total + 0.5 && total > 0;
  let body = '';
  body += kvRow('Quantity', `${trimNum(b.quantity ?? 1)} ${b.unit ?? 'ls'}`);
  body += kvRow('Unit cost', fmt.money(Number(b.unitCost) || 0, true));
  body += `<div class="kv"><span><b>Total</b></span><span class="total-v">${esc(fmt.money(total, true))}</span></div>`;
  const draw = drawTitle(p, b.drawID);
  if ((p.draws || []).length) body += kvRow('Draw', draw || 'Not in a draw');
  if ((p.units || []).length) { const u = (p.units || []).find((x) => sameId(x.id, b.unitID)); body += kvRow('Home', u ? ((u.name || '').trim() || 'Unnamed unit') : 'Shared'); }
  if ((b.vendor || '').trim()) body += kvRow('Vendor', b.vendor.trim());
  if (b.percentComplete) body += kvRow('Done', `${Math.round(b.percentComplete)}%`);
  let money2 = '';
  if (b.actualCost) money2 += kvRow('Actual (typed)', fmt.money(b.actualCost, true));
  money2 += kvRow('Billed in the books', fmt.money(billed, true), over ? 'alert-text' : '');
  money2 += kvRow('Paid', fmt.money(paid, true));
  money2 += kvRow(over ? 'Over budget by' : 'Left on this line', fmt.money(Math.abs(money(total - billed)), true), over ? 'alert-text' : '');
  const sources = (jc.sources.get(key(b.id)) || []).slice().sort((x, y) => (y.transaction.date || 0) - (x.transaction.date || 0));
  const sourceRows = sources.map(({ transaction: t, line }) => {
    const who = booksData().payeeName(t) || TXN_TYPES[t.type] || 'Transaction';
    const label = t.type === 'journal' ? 'Crew labor' : txnLabel(t);
    return `<button class="row" data-act="txn-open" data-id="${esc(key(t.id))}"><div class="main"><div class="t">${esc(who)}</div><div class="s">${esc([label, fmt.date(fromSec(t.date)), (line.memo || '').trim()].filter(Boolean).join(' · '))}</div></div><div class="end"><span class="amt">${esc(fmt.money(Number(line.amount) || 0, true))}</span></div></button>`;
  }).join('');
  const sels = (p.selections || []).filter((s) => sameId(s.budgetItemID, b.id));
  openSheet(`${sheetHead((b.name || '').trim() || 'Budget Line', `${b.category ?? 'General'} · ${projectName(p)}`)}
    <section class="card"><div style="margin:-4px 0">${body}</div></section>
    <section class="card"><div class="card-head"><h2>Spent</h2></div><div style="margin-top:-6px">${money2}</div></section>
    ${sourceRows ? card(`Bills and Expenses (${sources.length})`, sourceRows) : ''}
    ${sels.length ? card(`Selections (${sels.length})`, sels.map((s) => selectionRow(p, s, null)).join('')) : ''}
    ${(b.notes || '').trim() ? card('Notes', `<div style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(b.notes)}</div>`, { flush: false }) : ''}
    <p class="note" style="text-align:center">Change budget lines on the Mac.</p>`);
}

// ---------------------------------------------------------------------------
// Selections (SelectionMath)

const SELECTION_STATUS = {
  tbd: ['TBD', 'var(--warning)', 'Not decided yet. Settle it before ordering or installing.'],
  gcChoice: ['GC Choice', 'var(--slate)', 'Contractor picks, to the spec and budget shown.'],
  locked: ['Locked', 'var(--forest)', 'Final. Order exactly as written; no substitutions without approval.'],
  ordered: ['Ordered', 'var(--gold)', 'Ordered; waiting on delivery.'],
  installed: ['Installed', 'var(--success)', 'In and done.'],
  notApplicable: ['N/A', 'var(--stone)', 'Not part of this job.'],
};
const selStatus = (s) => (SELECTION_STATUS[s?.status] ? s.status : 'tbd');
const waitingToOrder = (status) => status === 'locked' || status === 'gcChoice';
const SELECTION_CATEGORIES = ['Flooring', 'Interior Paint', 'Kitchen', 'Bathrooms', 'Doors & Trim', 'Lighting & Electrical', 'Appliances', 'Exterior', 'Other'];
const STARTER_SELECTIONS = [
  ['Flooring', [['LVP – living areas and bedrooms', 'sf'], ['Tile – baths and laundry', 'sf'], ['Transitions and thresholds', 'ea']]],
  ['Interior Paint', [['Walls', 'gal'], ['Ceilings', 'gal'], ['Trim and doors', 'gal']]],
  ['Kitchen', [['Cabinets', 'lf'], ['Countertops', 'sf'], ['Backsplash', 'sf'], ['Sink', 'ea'], ['Faucet', 'ea'], ['Cabinet hardware', 'ea']]],
  ['Bathrooms', [['Vanity', 'ea'], ['Toilet', 'ea'], ['Tub / shower', 'ea'], ['Faucet', 'ea'], ['Vanity light', 'ea'], ['Mirror', 'ea'], ['Accessories', 'set']]],
  ['Doors & Trim', [['Interior doors', 'ea'], ['Door hardware', 'ea'], ['Baseboard', 'lf'], ['Casing', 'lf'], ['Closet shelving', 'lf']]],
  ['Lighting & Electrical', [['Ceiling lights', 'ea'], ['Ceiling fans', 'ea'], ['Exterior lights', 'ea'], ['Switches, outlets and plates', 'ls'], ['Smoke / CO detectors', 'ea']]],
  ['Appliances', [['Range', 'ea'], ['Refrigerator', 'ea'], ['Microwave', 'ea'], ['Dishwasher', 'ea']]],
  ['Exterior', [['Body paint', 'gal'], ['Trim paint', 'gal'], ['Front door', 'ea'], ['House numbers', 'set'], ['Mailbox', 'ea']]],
];

const selectionTotal = (s) => (s.quantity ?? 1) * (Number(s.unitCost) || 0);
const selectionMarkup = (p) => (p.kind === 'clientJob' ? (p.estimate?.markupPct ?? 20) : null);
const selectionPrice = (s, markup) => money(selectionTotal(s) * (1 + markup / 100));
const selectionOverage = (s, markup) => (!(s.allowance > 0) || selStatus(s) === 'notApplicable' ? 0 : Math.max(0, money(selectionPrice(s, markup) - s.allowance)));
const selectionName = (s) => (s.item || '').trim() || 'Untitled item';

function newSelection(category, sortIndex) {
  return { id: newId(), category, item: '', brandModel: '', colorFinish: '', quantity: 1, unit: 'ea', unitCost: 0, status: 'tbd', notes: '', link: '', allowance: 0, leadDays: 0, sortIndex };
}

/** Categories in the usual order, then any others A–Z, each with its items in order. */
function groupedSelections(items) {
  const names = new Set(items.map((s) => s.category ?? 'Other'));
  const order = [...SELECTION_CATEGORIES.filter((c) => names.has(c)), ...[...names].filter((c) => !SELECTION_CATEGORIES.includes(c)).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))];
  return order.map((c) => ({
    category: c,
    items: items.filter((s) => (s.category ?? 'Other') === c).sort((a, b) => ((a.sortIndex || 0) === (b.sortIndex || 0) ? ((a.item || '') < (b.item || '') ? -1 : (a.item || '') > (b.item || '') ? 1 : 0) : (a.sortIndex || 0) - (b.sortIndex || 0))),
  }));
}

/** Each task's forecast start, for order-by dates. */
function taskStarts(projectID) {
  return new Map(schedule(projectID).map((s) => [key(s.task.id), s.start]));
}
/** When it needs ordering: the firm date, else the task's start less the lead time in workdays. */
function selectionOrderBy(s, starts) {
  if (s.orderBy != null) return sod(fromSec(s.orderBy));
  const start = s.taskID ? starts.get(key(s.taskID)) : null;
  if (!start) return null;
  return workCalendar().adding(-Math.max(0, s.leadDays || 0), start);
}

function selectionSummary(p, starts) {
  const markup = selectionMarkup(p);
  const today = sod(new Date());
  const week = addDays(today, 7);
  const sum = { counts: {}, active: 0, total: 0, allowances: 0, overage: 0, lateToOrder: 0, orderSoon: 0, price: 0 };
  for (const s of p.selections || []) {
    const st = selStatus(s);
    sum.counts[st] = (sum.counts[st] || 0) + 1;
    if (st === 'notApplicable') continue;
    sum.active += 1;
    sum.total += selectionTotal(s);
    if (markup != null) { sum.allowances += Number(s.allowance) || 0; sum.overage += selectionOverage(s, markup); sum.price += selectionPrice(s, markup); }
    if (waitingToOrder(st) && s.orderedDate == null) {
      const due = selectionOrderBy(s, starts);
      if (due) { if (due < today) sum.lateToOrder += 1; else if (due <= week) sum.orderSoon += 1; }
    }
  }
  sum.total = money(sum.total); sum.allowances = money(sum.allowances); sum.overage = money(sum.overage); sum.price = money(sum.price);
  return sum;
}

/** What's already billed for overages: change orders made for them that weren't rejected. */
function overageBilled(projectID) {
  return money(all('changeOrder').filter((o) => sameId(o.projectID, projectID) && o.reason === 'Client selections over allowance' && o.status !== 'rejected').reduce((s, o) => s + (Number(o.amount) || 0), 0));
}

function selectionRow(p, s, starts) {
  const st = selStatus(s);
  const [label, color] = SELECTION_STATUS[st];
  const na = st === 'notApplicable';
  const product = [s.brandModel, s.colorFinish].map((x) => (x || '').trim()).filter(Boolean).join(' · ');
  const bits = [];
  if (selectionTotal(s) > 0) bits.push(`${trimNum(s.quantity ?? 1)} ${s.unit || ''} · ${fmt.money(selectionTotal(s))}`);
  const vendor = contactName(s.vendorID);
  if (vendor) bits.push(vendor);
  let when = '';
  if (s.orderedDate != null) when = `<span class="muted">Ordered ${esc(fmt.short(fromSec(s.orderedDate)))}</span>`;
  else if (starts && !na) {
    const due = selectionOrderBy(s, starts);
    if (due) {
      const late = waitingToOrder(st) && due < sod(new Date());
      when = `<span style="${late ? 'color:var(--warning);font-weight:600' : ''}">Order by ${esc(fmt.short(due))}${late ? ' (late)' : ''}</span>`;
    }
  }
  const markup = selectionMarkup(p);
  const over = markup != null ? selectionOverage(s, markup) : 0;
  return `<button class="row ${na ? 'na' : ''}" data-act="sel-edit" data-project="${esc(key(p.id))}" data-id="${esc(key(s.id))}">
    <div class="main"><div class="t">${esc(selectionName(s))}</div>
      ${product ? `<div class="s">${esc(product)}</div>` : ''}
      ${bits.length || when ? `<div class="s">${[...bits.map(esc), when].filter(Boolean).join(' · ')}</div>` : ''}
      ${over > 0 ? `<div class="s" style="color:var(--warning)">${esc(fmt.money(over))} over the allowance</div>` : ''}</div>
    <div class="end">${pill(label, color)}</div></button>`;
}

function projectSelections(p) {
  const pid = esc(key(p.id));
  const items = p.selections || [];
  if (!items.length) {
    const packages = (company().finishPackages || []).slice(0, 3);
    return emptyState('palette', 'No Selections Yet', 'List every finish and fixture going in: the exact product, color, who it comes from and when to order it.',
      `<div class="stack-btns">${packages.map((pk) => `<button class="btn primary" data-act="sel-package" data-project="${pid}" data-id="${esc(key(pk.id))}">${icon('stack')}Apply “${esc((pk.name || '').trim() || 'Untitled package')}”</button>`).join('')}
        <button class="btn ${packages.length ? '' : 'primary'}" data-act="sel-starter" data-project="${pid}">Start from the Standard List</button>
        <button class="btn" data-act="sel-new" data-project="${pid}" data-cat="Flooring">${icon('plus')}Add an Item</button></div>`);
  }
  const starts = taskStarts(p.id);
  const sum = selectionSummary(p, starts);
  const showNA = prefs.get('show-na-selections', true);
  const locked = (sum.counts.locked || 0) + (sum.counts.ordered || 0) + (sum.counts.installed || 0);
  const parts = [plural(sum.active, 'item'), `${locked} locked`];
  if (sum.counts.tbd) parts.push(`${sum.counts.tbd} TBD`);
  let html = `<div class="page-bar"><span class="count small" style="${sum.lateToOrder ? 'color:var(--warning)' : ''}">${esc(parts.join(' · '))}</span>
    <button class="btn primary sm" data-act="sel-new" data-project="${pid}">${icon('plus')}Item</button></div>`;
  if (sum.lateToOrder) html += banner(`${plural(sum.lateToOrder, 'item')} ${sum.lateToOrder === 1 ? 'is' : 'are'} past the order-by date.`);
  if (sum.orderSoon) html += `<div class="banner" style="--c:var(--slate)">${icon('box')}<div>${plural(sum.orderSoon, 'item')} to order in the next week.</div></div>`;
  const markup = selectionMarkup(p);
  if (markup != null && sum.overage > 0) {
    const unbilled = Math.max(0, money(sum.overage - overageBilled(p.id)));
    html += unbilled > 0
      ? banner(`Selections are ${fmt.money(sum.overage)} over the client's allowances; ${fmt.money(unbilled)} isn't on a change order yet.`)
      : `<div class="banner" style="--c:var(--success)">${icon('checkCircle')}<div>Selections are ${esc(fmt.money(sum.overage))} over the client's allowances, all on change orders.</div></div>`;
  }
  // Budget lines whose selections add up to more than the line.
  const selected = new Map();
  for (const s of items) if (selStatus(s) !== 'notApplicable' && s.budgetItemID) selected.set(key(s.budgetItemID), (selected.get(key(s.budgetItemID)) || 0) + selectionTotal(s));
  for (const b of p.budget || []) {
    const amount = selected.get(key(b.id));
    if (amount != null && money(amount) > money(budgetItemTotal(b)) + 0.005) html += banner(`${(b.name || '').trim() || 'A budget line'}: selections add up to ${fmt.money(amount)}, over its ${fmt.money(budgetItemTotal(b))} budget.`, 'var(--danger)');
  }
  const visible = showNA ? items : items.filter((s) => selStatus(s) !== 'notApplicable');
  for (const g of groupedSelections(visible)) {
    const active = g.items.filter((s) => selStatus(s) !== 'notApplicable');
    const total = active.reduce((s, x) => s + selectionTotal(x), 0);
    html += card(`${g.category}`, g.items.map((s) => selectionRow(p, s, starts)).join(''),
      { action: `<span class="card-total">${total > 0 ? esc(fmt.money(total)) : ''}<button class="icon-btn sm" data-act="sel-new" data-project="${pid}" data-cat="${esc(g.category)}" aria-label="Add to ${esc(g.category)}">${icon('plus')}</button></span>` });
  }
  let totals = kvRow('Selections (your cost)', fmt.money(sum.total));
  if (markup != null) {
    totals += kvRow(`Client price (${trimNum(markup)}% markup)`, fmt.money(sum.price));
    if (sum.allowances > 0) { totals += kvRow('Allowances', fmt.money(sum.allowances)); totals += kvRow('Over allowance', fmt.money(sum.overage), sum.overage > 0 ? 'warn-text' : ''); }
  }
  if ((p.finishPackageName || '').trim()) totals += kvRow('Started from', p.finishPackageName.trim());
  html += card('Totals', `<div style="padding:0 16px 6px">${totals}</div>`);
  html += `<label class="check-label" style="margin:0 4px 14px"><input type="checkbox" data-act="toggle-pref" data-pref="show-na-selections" ${showNA ? 'checked' : ''}>Show N/A items</label>`;
  return html;
}

function sheetSelection(projectID, itemID, category) {
  const p = project(projectID);
  if (!p) return;
  const existing = itemID ? (p.selections || []).find((s) => sameId(s.id, itemID)) : null;
  const cat = category || (existing ? existing.category ?? 'Other' : [...SELECTION_CATEGORIES].reverse().find((c) => (p.selections || []).some((s) => s.category === c)) || 'Other');
  const s = existing ? clone(existing) : newSelection(cat, 0);
  const st = selStatus(s);
  const markup = selectionMarkup(p);
  const cats = [...SELECTION_CATEGORIES];
  for (const x of (p.selections || []).map((y) => y.category ?? 'Other')) if (!cats.includes(x)) cats.push(x);
  if (!cats.includes(s.category)) cats.push(s.category);
  const vendors = contacts().filter((c) => c.kind === 'vendor' || c.kind === 'other' || !c.kind || sameId(c.id, s.vendorID));
  const tasks = all('task').filter((t) => sameId(t.projectID, p.id)).sort((a, b) => (a.sortIndex || 0) - (b.sortIndex || 0));
  const starts = taskStarts(p.id);
  const computed = s.orderBy == null ? selectionOrderBy(s, starts) : null;
  const units = BUDGET_UNITS.includes(s.unit) ? BUDGET_UNITS : [...BUDGET_UNITS, s.unit];
  const field = (name, label, value, attrs = '') => `<label class="field"><span>${label}</span><input name="${name}" value="${esc(value ?? '')}" ${attrs}></label>`;
  const dateVal = (sec) => (sec != null ? fmt.inputDate(fromSec(sec)) : '');
  openSheet(`${sheetHead(existing ? selectionName(s) : 'New Selection', projectName(p))}
    <form id="sel-form" data-project="${esc(key(p.id))}" data-id="${esc(existing ? key(s.id) : '')}" data-new-id="${esc(s.id)}">
      <div class="form-section"><div class="fs-head">Status</div>
        <div class="chips status-chips" style="margin:0">${Object.entries(SELECTION_STATUS).map(([k, [l, c]]) => `<button type="button" data-act="sel-status" data-status="${k}" class="${k === st ? 'on' : ''}" style="--c:${c}">${l}</button>`).join('')}</div>
        <input type="hidden" name="status" value="${st}"><div class="fs-foot" id="sel-meaning">${esc(SELECTION_STATUS[st][2])}</div></div>
      <div class="form-section"><div class="form-card">
        <div class="two">
          <label class="field"><span>Category</span><select name="category">${cats.map((c) => `<option ${c === s.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}<option value="__new">New category…</option></select></label>
          ${field('itemName', 'Item', s.item, 'placeholder="Vanity, faucet, LVP…"')}
        </div>
        <div class="new-cat hidden">${field('newCategory', 'New category', '', 'placeholder="Landscaping, Garage, Pool…"')}</div>
        ${field('brandModel', 'Brand / model', s.brandModel, 'placeholder="Moen Align 6190"')}
        ${field('colorFinish', 'Color / finish', s.colorFinish, 'placeholder="Matte black"')}
        <div class="three">
          ${field('quantity', 'Qty', trimNum(s.quantity ?? 1), 'type="number" inputmode="decimal" step="any" min="0"')}
          <label class="field"><span>Unit</span><select name="unit">${units.map((u) => `<option ${u === s.unit ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select></label>
          ${field('unitCost', 'Cost / unit', s.unitCost ? s.unitCost : '', 'type="number" inputmode="decimal" step="0.01" min="0" placeholder="0"')}
        </div>
        <p class="note" style="margin:-4px 0 12px" id="sel-total"></p>
      </div></div>
      <div class="form-section"><div class="form-card">
        <label class="field"><span>From</span><select name="vendorID"><option value="">No one yet</option>${vendors.map((c) => `<option value="${esc(c.id)}" ${sameId(c.id, s.vendorID) ? 'selected' : ''}>${esc(contactDisplayName(c))}</option>`).join('')}</select></label>
        <label class="field"><span>Link or SKU</span><span class="input-with-btn"><input name="link" value="${esc(s.link || '')}" placeholder="Product page, SKU or model #" autocapitalize="off" autocorrect="off"><a class="icon-btn sel-open-link hidden" target="_blank" rel="noopener" aria-label="Open link">${icon('link')}</a></span></label>
        ${markup != null ? `${field('allowance', "Client allowance (their price)", s.allowance ? s.allowance : '', 'type="number" inputmode="decimal" step="0.01" min="0" placeholder="None"')}<p class="note" style="margin:-4px 0 12px" id="sel-price"></p>` : ''}
        <label class="field"><span>Notes</span><textarea name="notes" rows="1" placeholder="Anything to remember">${esc(s.notes || '')}</textarea></label>
      </div></div>
      <div class="form-section"><div class="fs-head">Budget and Schedule</div><div class="form-card">
        <label class="field"><span>Budget line</span><select name="budgetItemID"><option value="">None</option>${(p.budget || []).map((b) => `<option value="${esc(b.id)}" ${sameId(b.id, s.budgetItemID) ? 'selected' : ''}>${esc(`${b.category ?? 'General'} — ${(b.name || '').trim() || 'Untitled'}`)}</option>`).join('')}</select></label>
        <label class="field"><span>Needed for</span><select name="taskID"><option value="">No task</option>${tasks.map((t) => `<option value="${esc(t.id)}" ${sameId(t.id, s.taskID) ? 'selected' : ''}>${esc((t.name || '').trim() || 'Untitled')}</option>`).join('')}</select></label>
        <div class="lead ${s.taskID ? '' : 'hidden'}">${field('leadDays', 'Order ahead (workdays)', s.leadDays || 0, 'type="number" inputmode="numeric" min="0" max="120" step="1"')}</div>
        <div class="two">
          <label class="field"><span>Firm order-by date</span><input name="orderBy" type="date" value="${dateVal(s.orderBy)}"></label>
          <label class="field"><span>Ordered</span><input name="orderedDate" type="date" value="${dateVal(s.orderedDate)}"></label>
        </div>
        ${computed ? `<p class="note" style="margin:-4px 0 12px">Order by ${esc(fmt.date(computed))}, from the schedule.</p>` : ''}
      </div></div>
      <div class="sheet-actions">${existing ? `<button type="button" class="btn danger" data-act="sel-delete" data-project="${esc(key(p.id))}" data-id="${esc(key(s.id))}" aria-label="Delete" style="flex:0 0 52px">${icon('trash')}</button>` : ''}<button type="button" class="btn" data-act="sheet-close">Cancel</button><button type="submit" class="btn primary">${existing ? 'Save' : 'Add'}</button></div>
    </form>`, (el) => {
    const f = $('#sel-form', el);
    const update = () => {
      const total = (Number(f.elements.quantity.value) || 0) * (Number(f.elements.unitCost.value) || 0);
      $('#sel-total', f).textContent = total > 0 ? `Your cost: ${fmt.money(total, true)}` : '';
      if (markup != null) {
        const price = money(total * (1 + markup / 100));
        const allowance = Number(f.elements.allowance.value) || 0;
        const over = allowance > 0 ? Math.max(0, money(price - allowance)) : 0;
        $('#sel-price', f).innerHTML = `Their price at the job's ${esc(trimNum(markup))}% markup: ${esc(fmt.money(price, true))}${over > 0 ? ` · <span style="color:var(--warning)">${esc(fmt.money(over, true))} over</span>` : ''}`;
      }
      const link = f.elements.link.value.trim();
      const a = $('.sel-open-link', f);
      a.classList.toggle('hidden', !/^https?:\/\//i.test(link));
      if (/^https?:\/\//i.test(link)) a.href = link;
      $('.lead', f).classList.toggle('hidden', !f.elements.taskID.value);
      $('.new-cat', f).classList.toggle('hidden', f.elements.category.value !== '__new');
    };
    f.addEventListener('input', update);
    f.addEventListener('change', update);
    update();
    if (!existing) setTimeout(() => f.elements.itemName.focus(), 250);
  });
}

/** The selection as the form has it, keeping dates that weren't changed exactly as they were. */
function readSelectionForm(f, original) {
  const s = original ? clone(original) : newSelection('Other', 0);
  if (!original) s.id = f.dataset.newId;
  const v = (n) => (f.elements[n]?.value ?? '').trim();
  const newCat = v('newCategory');
  s.category = v('category') === '__new' ? (newCat || original?.category || 'Other') : v('category') || 'Other';
  s.item = v('itemName');
  s.brandModel = v('brandModel');
  s.colorFinish = v('colorFinish');
  s.quantity = Number(v('quantity')) || 0;
  s.unit = v('unit') || 'ea';
  s.unitCost = money(Number(v('unitCost')) || 0);
  s.status = v('status') || 'tbd';
  s.link = v('link');
  s.notes = f.elements.notes.value;
  if (f.elements.allowance) s.allowance = money(Number(v('allowance')) || 0);
  for (const [name, val] of [['vendorID', v('vendorID')], ['budgetItemID', v('budgetItemID')], ['taskID', v('taskID')]]) { if (val) s[name] = val; else delete s[name]; }
  s.leadDays = s.taskID ? Math.max(0, Math.min(120, Math.round(Number(v('leadDays')) || 0))) : (s.leadDays || 0);
  for (const name of ['orderBy', 'orderedDate']) {
    const val = v(name);
    const before = original?.[name] ?? null;
    if (!val) delete s[name];
    else if (before != null && fmt.inputDate(fromSec(before)) === val) s[name] = before;
    else if (name === 'orderedDate' && val === fmt.inputDate(new Date())) s[name] = stamp();
    else s[name] = toSec(localNoon(parseInputDate(val)));
  }
  return s;
}

/** A package's items ready for a job: new ids, no links to another job's budget or schedule,
 *  nothing already ordered (SelectionMath.packageItems). */
function packageItems(items) {
  return (items || []).map((src) => {
    const item = { ...clone(src), id: newId() };
    delete item.budgetItemID; delete item.taskID; delete item.orderBy; delete item.orderedDate;
    if (item.status === 'ordered' || item.status === 'installed') item.status = 'locked';
    return item;
  });
}

// How each change to a job's selections is made on a project (see editRecord in app.js).
Object.assign(RECORD_OPS, {
  upsertSelection(p, { item }) {
    const list = Array.isArray(p.selections) ? p.selections : [];
    const at = list.findIndex((x) => sameId(x.id, item.id));
    if (at >= 0) list[at] = clone(item);
    else {
      const added = clone(item);
      added.sortIndex = list.filter((x) => (x.category ?? 'Other') === added.category).reduce((m, x) => Math.max(m, x.sortIndex || 0), -1) + 1;
      list.push(added);
    }
    p.selections = list;
  },
  deleteSelection(p, { id }) {
    p.selections = (p.selections || []).filter((x) => !sameId(x.id, id));
  },
  // Adds items not already on the job (same category and name), as SelectionMath.apply does.
  addSelections(p, { items, packageName }) {
    const list = Array.isArray(p.selections) ? p.selections : [];
    const k = (s) => `${(s.category ?? 'Other').trim().toLowerCase()}|${(s.item || '').trim().toLowerCase()}`;
    const have = new Set(list.map(k));
    const ids = new Set(list.map((s) => key(s.id)));
    let next = list.reduce((m, s) => Math.max(m, s.sortIndex || 0), -1) + 1;
    for (const src of items) if (!have.has(k(src)) && !ids.has(key(src.id))) list.push({ ...clone(src), sortIndex: next++ });
    p.selections = list;
    if (packageName) p.finishPackageName = packageName;
  },
});

// ---------------------------------------------------------------------------
// Subs & POs

function projectSubs(p) {
  const list = all('commitment').filter((c) => sameId(c.projectID, p.id))
    .sort((a, b) => String(a.number || '').localeCompare(String(b.number || ''), 'en', { numeric: true }));
  if (!list.length) return emptyState('people', 'No Subs or POs Yet', "Subcontracts and purchase orders track what each sub or supplier agreed to, what they've billed, what's left and the retainage you're holding. They're written on the Mac.");
  const totals = list.map(commitmentTotals);
  const committed = list.map((c, i) => [c, totals[i]]).filter(([c]) => commitmentIsCommitted(c));
  const sumCommitted = money(committed.reduce((s, [, t]) => s + t.revised, 0));
  const billed = money(totals.reduce((s, t) => s + t.billed, 0));
  const leftToBill = money(committed.reduce((s, [, t]) => s + Math.max(0, t.remaining), 0));
  const retainage = money(totals.reduce((s, t) => s + t.retainageOutstanding, 0));
  let html = `<div class="tiles">
    ${tile('Committed', fmt.money(sumCommitted), plural(committed.length, 'signed or sent', 'signed or sent'), { accent: 'var(--olive)' })}
    ${tile('Subs Billed', fmt.money(billed), sumCommitted > 0 ? `${Math.round(billed / sumCommitted * 100)}% of committed` : '', { accent: 'var(--leather)', progress: sumCommitted > 0 ? Math.min(1, billed / sumCommitted) : null })}
    ${tile('Left to Bill', fmt.money(leftToBill), retainage ? `${fmt.money(retainage)} retainage held` : '', { accent: 'var(--slate)' })}
  </div>`;
  const rows = list.map((c, i) => {
    const t = totals[i];
    const st = COMMITMENT_STATUS[c.status] || COMMITMENT_STATUS.draft;
    const isVoid = c.status === 'void';
    const over = t.billed > t.revised + 0.5;
    return `<button class="row" data-act="commitment-open" data-id="${esc(key(c.id))}">
      ${icon('doc', 'ic glyph', '--tint:var(--olive)')}
      <div class="main"><div class="t ${isVoid ? 'done-t' : ''}">${esc(contactName(c.contactID) || 'No vendor yet')}</div><div class="s">${esc(commitmentTitle(c))}</div>
        ${t.revised > 0 && !isVoid ? `<div class="s">Billed ${esc(fmt.money(t.billed))} · ${over ? `<span class="alert-text">${esc(fmt.money(-t.remaining))} over</span>` : `${esc(fmt.money(t.remaining))} left`}</div><div class="progress thin"><i style="width:${Math.min(100, Math.round(t.percentBilled * 100))}%;${over ? 'background:var(--danger)' : ''}"></i></div>` : ''}</div>
      <div class="end"><span class="amt ${isVoid ? 'done-t' : ''}">${esc(fmt.money(t.revised))}</span>${pill(st[0], st[1])}</div></button>`;
  }).join('');
  return html + `<section class="card flush">${rows}</section>`;
}

Object.assign(PROJECT_PAGES, {
  budget: ['Budget', (p) => projectBudget(p)],
  selections: ['Selections', (p) => projectSelections(p)],
  subs: ['Subs & POs', (p) => projectSubs(p)],
});

// ---------------------------------------------------------------------------
// Actions

Object.assign(ACTIONS, {
  'budget-line': (el) => sheetBudgetLine(el.dataset.project, el.dataset.id),
  'sel-edit': (el) => sheetSelection(el.dataset.project, el.dataset.id),
  'sel-new': (el) => sheetSelection(el.dataset.project, null, el.dataset.cat),
  'sel-status': (el) => {
    const f = $('#sel-form');
    const status = el.dataset.status;
    f.elements.status.value = status;
    $$('[data-act="sel-status"]', f).forEach((b) => b.classList.toggle('on', b === el));
    $('#sel-meaning', f).textContent = SELECTION_STATUS[status][2];
    // Ordered or installed sets the order date (today); going back clears it, as on the Mac.
    if (status === 'ordered' || status === 'installed') { if (!f.elements.orderedDate.value) f.elements.orderedDate.value = fmt.inputDate(new Date()); } else f.elements.orderedDate.value = '';
    sheetDirty = true;
  },
  'sel-delete': async (el) => {
    const p = project(el.dataset.project);
    const s = (p?.selections || []).find((x) => sameId(x.id, el.dataset.id));
    if (!s || !confirm(`Delete ${selectionName(s)}?\n\nIt's removed from ${projectName(p)} on every device.`)) return;
    closeSheet();
    if (await editProject(p.id, [{ op: 'deleteSelection', id: s.id }])) toast('Deleted');
  },
  'sel-starter': async (el) => {
    const starter = [];
    for (const [category, rows] of STARTER_SELECTIONS) rows.forEach(([item, unit], i) => starter.push({ ...newSelection(category, i), item, unit }));
    if (await editProject(el.dataset.project, [{ op: 'addSelections', items: starter }])) toast('Standard list added');
  },
  'sel-package': async (el) => {
    const pk = (company().finishPackages || []).find((x) => sameId(x.id, el.dataset.id));
    if (!pk) return;
    const name = (pk.name || '').trim() || 'Untitled package';
    if (await editProject(el.dataset.project, [{ op: 'addSelections', items: packageItems(pk.items), packageName: name }])) toast(`Applied “${name}”`);
  },
});

document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (f.id !== 'sel-form') return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const pid = f.dataset.project;
  const id = f.dataset.id;
  const p = project(pid);
  const original = id ? (p?.selections || []).find((x) => sameId(x.id, id)) : null;
  const item = readSelectionForm(f, original);
  if (!item.item && !original) { f.elements.itemName.focus(); return; }
  const saved = await editProject(pid, [{ op: 'upsertSelection', item }]);
  closeSheet();
  if (saved) toast(original ? 'Saved' : 'Added');
}, true);
