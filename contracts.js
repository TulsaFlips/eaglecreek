/* Eagle Creek — a client job's contract and billing.
 *
 * The Contract section (client jobs): the terms, the schedule of values with what's been
 * billed on each line, and change orders. Money › Pay Applications: each progress billing
 * worked out exactly as the Mac does (Engine/PayApps.swift), with its continuation sheet; on
 * cost-plus and time-and-materials jobs, Money › Billing.
 * Change orders can be written from the site as drafts, sent to the client, marked rejected and
 * given their signed copy. Approving one changes the contract and the budget, so that, the
 * terms, the schedule of values and pay applications are done on the Mac.
 */
'use strict';

Object.assign(ICONS, {
  signature: '<path d="M3 17c3-1 4.5-9 7-9 2 0-1 9 1.5 9 1.5 0 2.5-3 4-3 1.2 0 1 2 2.5 2H21"/><path d="M3 21h18"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-11 7.5"/>',
  listNumber: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 5l1.5-1V9M3.5 14.5a1.5 1.5 0 1 1 2.5 1.2L3.5 18h3"/>',
});

const CO_STATUS = { draft: ['Draft', 'var(--stone)'], pending: ['Waiting on client', 'var(--slate)'], approved: ['Approved', 'var(--success)'], rejected: ['Rejected', 'var(--stone)'] };
const coStatus = (o) => (CO_STATUS[o.status] ? o.status : 'draft');
const CONTRACT_TYPES = { fixedPrice: 'Fixed price', costPlus: 'Cost plus fee', timeAndMaterials: 'Time & materials' };
const CONTRACT_HELP = {
  fixedPrice: 'Fixed price: bill progress with pay applications against the schedule of values. Approved change orders are added as their own lines.',
  costPlus: 'Cost plus: bill your job costs for a period at cost, plus your fee. Every bill, expense and posted crew labor on this job counts.',
  timeAndMaterials: 'Time & materials: crew hours are billed at each person’s bill rate; materials and subs at cost plus your markup.',
};
const contractOf = (p) => ({ type: 'fixedPrice', feePct: 15, retainagePct: 0, paymentTermsDays: 15, sov: [], notes: '', ...(p.contract || {}) });
const coLabel = (o) => `CO #${o.number || 1}`;
const coTitle = (o) => ((o.title || '').trim() ? `${coLabel(o)} – ${o.title.trim()}` : coLabel(o));
const projectChangeOrders = (pid) => all('changeOrder').filter((o) => sameId(o.projectID, pid)).sort((a, b) => (a.number || 0) - (b.number || 0));
const projectPayApplications = (pid) => all('payApp').filter((a) => sameId(a.projectID, pid)).sort((a, b) => (a.number || 0) - (b.number || 0));

// ----- Pay application maths (PayAppMath, PayAppStatement)

/** The schedule of values, then approved change orders in number order. */
function billingLines(p) {
  const lines = (contractOf(p).sov || []).map((l, i) => ({ id: l.id, itemNumber: (l.itemNumber || '').trim() || String(i + 1), description: l.description || '', scheduledValue: money(l.scheduledValue), changeOrderID: null }));
  for (const o of projectChangeOrders(p.id).filter((x) => x.status === 'approved')) {
    lines.push({ id: o.id, itemNumber: `CO ${o.number}`, description: (o.title || '').trim() || `Change order ${o.number}`, scheduledValue: money(o.amount), changeOrderID: o.id });
  }
  return lines;
}

function payAppStatement(app, apps, lines) {
  const earlier = apps.filter((a) => sameId(a.projectID, app.projectID) && !sameId(a.id, app.id) && (a.number || 0) < (app.number || 0)).sort((a, b) => a.number - b.number);
  const previousApp = earlier[earlier.length - 1] || null;
  const allLines = lines.slice();
  const known = new Set(lines.map((l) => key(l.id)));
  const orphans = [];
  for (const l of [...earlier, app].flatMap((a) => a.lines || [])) if (!known.has(key(l.id)) && !orphans.includes(key(l.id))) orphans.push(key(l.id));
  for (const id of orphans) allLines.push({ id, itemNumber: '—', description: 'Removed line', scheduledValue: 0, changeOrderID: null });
  const previousWork = new Map();
  for (const a of earlier) for (const l of a.lines || []) previousWork.set(key(l.id), (previousWork.get(key(l.id)) || 0) + (Number(l.workThisPeriod) || 0));
  const previousStored = new Map((previousApp?.lines || []).map((l) => [key(l.id), Number(l.storedMaterials) || 0]));
  const current = new Map((app.lines || []).map((l) => [key(l.id), l]));
  const released = !!app.releaseRetainage || earlier.some((a) => a.releaseRetainage);
  const pct = released ? 0 : Math.max(0, Number(app.retainagePct) || 0) / 100;
  const rows = allLines.map((line) => {
    const entry = current.get(key(line.id));
    const previous = money(previousWork.get(key(line.id)) || 0);
    const thisPeriod = money(entry?.workThisPeriod || 0);
    const stored = money(entry?.storedMaterials || 0);
    const completed = money(previous + thisPeriod + stored);
    return { line, previous, thisPeriod, stored, previousStored: money(previousStored.get(key(line.id)) || 0), retainage: money((previous + thisPeriod + stored) * pct), completed,
      percent: line.scheduledValue ? completed / line.scheduledValue : 0, balance: money(line.scheduledValue - completed) };
  });
  const s = {};
  s.originalSum = money(lines.filter((l) => !l.changeOrderID).reduce((t, l) => t + l.scheduledValue, 0));
  s.changeOrders = money(lines.filter((l) => l.changeOrderID).reduce((t, l) => t + l.scheduledValue, 0));
  s.contractSumToDate = money(s.originalSum + s.changeOrders);
  s.completedToDate = money(rows.reduce((t, r) => t + r.completed, 0));
  s.storedToDate = money(rows.reduce((t, r) => t + r.stored, 0));
  s.retainage = money(money(money(s.completedToDate - s.storedToDate) * pct) + money(s.storedToDate * pct));
  s.earnedLessRetainage = money(s.completedToDate - s.retainage);
  s.previousCertificates = 0; s.previousRetainage = 0;
  if (previousApp) {
    const prev = payAppStatement(previousApp, apps, lines).summary;
    s.previousCertificates = prev.earnedLessRetainage;
    s.previousRetainage = prev.retainage;
  }
  s.retainageChange = money(s.retainage - s.previousRetainage);
  s.depositApplied = money(Math.min(Math.max(0, Number(app.depositApplied) || 0), Math.max(0, s.earnedLessRetainage - s.previousCertificates)));
  s.currentDue = money(s.earnedLessRetainage - s.previousCertificates - s.depositApplied);
  s.balanceToFinish = money(s.contractSumToDate - s.earnedLessRetainage);
  return { rows, summary: s };
}

// ----- Contract pages

function contractTiles(p) {
  const f = clientFinancials(p);
  return `<div class="tiles">
    ${tile('Contract', fmt.money(f.contractTotal), f.approvedChanges ? `Includes ${fmt.money(f.approvedChanges)} in changes` : CONTRACT_TYPES[f.contractType] || '', { accent: 'var(--forest)' })}
    ${tile('Billed to Client', fmt.money(f.billedToDate), f.contractTotal > 0 ? `${Math.round(f.billedToDate / f.contractTotal * 100)}% of the contract` : '', { accent: 'var(--slate)', progress: f.contractTotal > 0 ? Math.min(1, f.billedToDate / f.contractTotal) : null })}
    ${tile('Left to Bill', fmt.money(f.leftToBill), f.pendingChanges ? `${fmt.money(f.pendingChanges)} in changes pending` : '', { accent: 'var(--gold)' })}
  </div>`;
}

function contractTerms(p) {
  const c = contractOf(p);
  let html = contractTiles(p);
  let terms = '';
  if (p.customerID) terms += `<a class="kv" href="#/contact/${esc(key(p.customerID))}"><span>Client</span><span style="color:var(--forest)">${esc(contactName(p.customerID) || 'Unnamed customer')}</span></a>`;
  else terms += kvLine('Client', 'Not picked yet');
  if ((p.jobNumber || '').trim()) terms += kvLine('Job #', p.jobNumber.trim());
  terms += kvLine('Type', CONTRACT_TYPES[c.type] || 'Fixed price');
  if (c.type !== 'fixedPrice') terms += kvLine(c.type === 'costPlus' ? 'Fee on cost' : 'Markup on materials and subs', `${trimNum(c.feePct)}%`);
  terms += kvLine('Retainage the client holds', `${trimNum(c.retainagePct)}%`);
  terms += kvLine('Invoices due in', c.paymentTermsDays ? plural(c.paymentTermsDays, 'day') : 'On receipt');
  html += kvCard('Contract', terms);
  let dates = '';
  dates += kvLine('Signed', c.signedDate != null ? fmt.date(fromSec(c.signedDate)) : 'Not yet');
  dates += kvLine('Start', c.startDate != null ? fmt.date(fromSec(c.startDate)) : 'Not set');
  dates += kvLine('Scheduled completion', c.completionDate != null ? fmt.date(fromSec(c.completionDate)) : 'Not set');
  const sched = schedule(p.id);
  if (sched.length) {
    const finish = sched.reduce((m, s) => (s.finish > m ? s.finish : m), sched[0].finish);
    const late = c.completionDate != null && sod(finish) > sod(fromSec(c.completionDate));
    dates += kvLine('Schedule finishes', fmt.date(finish), late ? 'alert-text' : '');
  }
  html += kvCard('Dates', dates);
  if ((c.notes || '').trim()) html += card('Notes', `<div style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(c.notes)}</div>`, { flush: false });
  html += `<p class="note" style="margin:0 4px 14px">${esc(CONTRACT_HELP[c.type] || CONTRACT_HELP.fixedPrice)} The terms are set on the Mac.</p>`;
  return html;
}

function contractSOV(p) {
  const c = contractOf(p);
  const apps = projectPayApplications(p.id);
  const billed = new Map();
  for (const a of apps) for (const l of a.lines || []) billed.set(key(l.id), (billed.get(key(l.id)) || 0) + (Number(l.workThisPeriod) || 0));
  const last = apps[apps.length - 1];
  if (last) for (const l of last.lines || []) billed.set(key(l.id), (billed.get(key(l.id)) || 0) + (Number(l.storedMaterials) || 0));
  if (!(c.sov || []).length) {
    return contractTiles(p) + emptyState('listNumber', 'No Schedule of Values Yet', c.type === 'fixedPrice' ? 'The schedule of values is what pay applications bill against. Fill it from the estimate on the Mac.' : 'Cost-plus and T&M jobs bill from job costs, so a schedule of values is optional.');
  }
  let html = contractTiles(p);
  const total = money((c.sov || []).reduce((s, l) => s + (Number(l.scheduledValue) || 0), 0));
  html += card('Schedule of Values', (c.sov || []).map((l, i) => {
    const done = billed.get(key(l.id)) || 0;
    const value = Number(l.scheduledValue) || 0;
    return `<div class="row static"><span class="pnum">${esc((l.itemNumber || '').trim() || String(i + 1))}</span>
      <div class="main"><div class="t">${esc((l.description || '').trim() || 'Untitled line')}</div><div class="s">Billed ${esc(fmt.money(done))}${value > 0 ? ` · ${Math.round(done / value * 100)}%` : ''}</div>${value > 0 && done > 0 ? `<div class="progress thin"><i style="width:${Math.min(100, Math.round(done / value * 100))}%"></i></div>` : ''}</div>
      <div class="end"><span class="amt">${esc(fmt.money(value, true))}</span></div></div>`;
  }).join('') + `<div style="padding:0 16px 6px">${kvTotal('Original contract sum', fmt.money(total, true))}</div>`);
  const estPrice = money((p.estimate?.lines || []).filter((l) => !l.isOptional).reduce((s, l) => s + estimatePrice(p.estimate, l), 0));
  if (estPrice > 0 && Math.abs(estPrice - total) > 0.5) html += `<div class="banner" style="--c:var(--slate)">${icon('warn')}<div>The schedule of values (${esc(fmt.money(total))}) doesn't match the estimate price (${esc(fmt.money(estPrice))}). That's fine if the contract was negotiated.</div></div>`;
  const approved = projectChangeOrders(p.id).filter((o) => o.status === 'approved');
  if (approved.length) html += card('Approved Change Orders', approved.map((o) => `<button class="row" data-act="co-open" data-id="${esc(key(o.id))}"><span class="pnum" style="width:44px">CO ${esc(o.number)}</span><div class="main"><div class="t">${esc((o.title || '').trim() || 'Untitled')}</div></div><div class="end"><span class="amt">${esc(fmt.money(o.amount, true))}</span></div></button>`).join(''));
  return html;
}

function changeOrderRow(o) {
  const st = coStatus(o);
  const rejected = st === 'rejected';
  const sub = [fmt.date(fromSec(o.date)), (o.reason || '').trim(), o.daysAdded ? `${o.daysAdded > 0 ? '+' : ''}${plural(o.daysAdded, 'workday')}` : ''].filter(Boolean).join(' · ');
  return `<button class="row" data-act="co-open" data-id="${esc(key(o.id))}">${icon('branch', 'ic glyph', `--tint:${CO_STATUS[st][1]}`)}
    <div class="main"><div class="t ${rejected ? 'done-t' : ''}">${esc(coTitle(o))}</div><div class="s">${esc(sub)}</div></div>
    <div class="end"><span class="amt ${rejected ? 'done-t' : ''}">${esc(fmt.money(o.amount, true))}</span>${pill(CO_STATUS[st][0], CO_STATUS[st][1])}</div></button>`;
}

function contractChangeOrders(p) {
  const orders = projectChangeOrders(p.id);
  const add = `<button class="btn primary sm" data-act="co-new" data-project="${esc(key(p.id))}">${icon('plus')}Change Order</button>`;
  if (!orders.length) return emptyState('branch', 'No Change Orders Yet', 'Changes to the scope go here: what changes, what it costs, how many days it adds. Write one from the site; approve it on the Mac.', `<div style="margin-top:14px">${add}</div>`);
  const sum = (st) => money(orders.filter((o) => coStatus(o) === st).reduce((s, o) => s + (Number(o.amount) || 0), 0));
  let html = `<div class="page-bar"><span class="count">${plural(orders.length, 'change order')}</span>${add}</div>`;
  html += `<div class="tiles">${tile('Approved', fmt.money(sum('approved')), plural(orders.filter((o) => coStatus(o) === 'approved').length, 'change'), { accent: 'var(--success)' })}${tile('Waiting on Client', fmt.money(sum('pending')), plural(orders.filter((o) => coStatus(o) === 'pending').length, 'change'), { accent: 'var(--slate)' })}${tile('Drafts', fmt.money(sum('draft')), plural(orders.filter((o) => coStatus(o) === 'draft').length, 'change'), { accent: 'var(--stone)' })}</div>`;
  return html + `<section class="card flush">${orders.map(changeOrderRow).join('')}</section>`;
}

function newChangeOrder(projectID, fields = {}) {
  const numbers = all('changeOrder').filter((o) => sameId(o.projectID, projectID)).map((o) => o.number || 0);
  return { id: newId(), projectID: project(projectID)?.id || projectID, number: (numbers.length ? Math.max(...numbers) : 0) + 1, title: '', details: '', reason: '', date: stamp(), status: 'draft', cost: 0, amount: 0, daysAdded: 0, approvedBy: '', daysApplied: 0, ...fields };
}

function sheetChangeOrder(id, draft = null) {
  const o = draft || get(id);
  if (!o) return;
  const p = project(o.projectID);
  const st = coStatus(o);
  const editable = !draft ? st === 'draft' || st === 'pending' : true;
  const markup = p?.estimate?.markupPct ?? 20;
  const files = draft ? [] : filesFor('recordID', o.id);
  const ro = (label, value) => kvLine(label, value);
  let body;
  if (editable) {
    body = `<div class="form-section"><div class="form-card">
        <label class="field"><span>Title</span><input name="title" value="${esc(o.title || '')}" placeholder="Add outlet in garage"></label>
        <div class="two"><label class="field"><span>Date</span><input name="date" type="date" value="${fmt.inputDate(fromSec(o.date))}"></label>
          <label class="field"><span>Workdays added</span><input name="daysAdded" type="number" inputmode="numeric" step="1" min="-60" max="365" value="${esc(o.daysAdded || 0)}"></label></div>
        <label class="field"><span>Reason</span><input name="reason" value="${esc(o.reason || '')}" placeholder="Owner request, hidden condition, design change…" list="co-reasons"></label>
        <datalist id="co-reasons"><option>Owner request</option><option>Hidden condition</option><option>Design change</option><option>Code requirement</option></datalist>
        <label class="field"><span>What changes</span><textarea name="details" rows="3" placeholder="What changes, in plain words">${esc(o.details || '')}</textarea></label>
      </div></div>
      <div class="form-section"><div class="fs-head">Money</div><div class="form-card">
        <div class="two"><label class="field"><span>Your cost</span><input name="cost" type="number" inputmode="decimal" step="0.01" value="${o.cost ? esc(o.cost) : ''}" placeholder="0"></label>
          <label class="field"><span>Price to client</span><input name="amount" type="number" inputmode="decimal" step="0.01" value="${o.amount ? esc(o.amount) : ''}" placeholder="0"></label></div>
        <button type="button" class="btn sm" data-act="co-price" data-markup="${esc(markup)}" style="margin:-2px 0 12px">Price at the job's ${esc(trimNum(markup))}% markup</button>
        <p class="note" id="co-credit" style="margin:-4px 0 12px">${(o.amount || 0) < 0 ? 'A negative price is a credit to the client.' : ''}</p>
      </div></div>`;
  } else {
    body = `<section class="card"><div style="margin:-4px 0">${ro('Date', fmt.date(fromSec(o.date)))}${(o.reason || '').trim() ? ro('Reason', o.reason.trim()) : ''}${ro('Your cost', fmt.money(o.cost || 0, true))}${ro('Price to client', fmt.money(o.amount || 0, true))}${ro('Workdays added', String(o.daysAdded || 0))}
      ${o.sentDate != null ? ro('Sent', fmt.date(fromSec(o.sentDate))) : ''}${o.approvedDate != null ? ro('Approved', `${fmt.date(fromSec(o.approvedDate))}${(o.approvedBy || '').trim() ? ` by ${o.approvedBy.trim()}` : ''}`) : ''}</div></section>
      ${(o.details || '').trim() ? card('What Changes', `<div style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(o.details)}</div>`, { flush: false }) : ''}
      <p class="note" style="margin:0 4px 12px">${st === 'approved' ? 'Approved: it’s on the contract and the budget. Change or take it back on the Mac.' : 'Rejected. Put it back to draft to rework it.'}</p>`;
  }
  const actions = [];
  if (!draft && st === 'draft') actions.push(`<button type="button" class="btn" data-act="co-status" data-status="pending">${icon('share')}Mark Sent to Client</button>`);
  if (!draft && st === 'pending') actions.push(`<button type="button" class="btn" data-act="co-status" data-status="rejected">${icon('close')}Mark Rejected</button>`, `<button type="button" class="btn" data-act="co-status" data-status="draft">${icon('undo')}Back to Draft</button>`);
  if (!draft && st === 'rejected') actions.push(`<button type="button" class="btn" data-act="co-status" data-status="draft">${icon('undo')}Back to Draft</button>`);
  openSheet(`${sheetHead(draft ? `New Change Order (${coLabel(o)})` : coTitle(o), p ? projectName(p) : '')}
    <form id="co-form" data-id="${esc(draft ? '' : key(o.id))}">
      <div class="page-bar">${pill(CO_STATUS[st][0], CO_STATUS[st][1])}${st === 'pending' || st === 'draft' ? '<span class="count small">Approve it on the Mac</span>' : ''}</div>
      ${body}
      ${actions.length ? `<div class="form-section"><div class="btn-row wrap">${actions.join('')}</div></div>` : ''}
      ${draft ? '' : `<div class="form-section"><div class="fs-head">Signed Copy</div>${files.length ? `<section class="card flush">${files.map(fileRow).join('')}</section>` : ''}
        <div class="btn-row"><button type="button" class="btn" data-act="co-attach" data-id="${esc(key(o.id))}" data-capture="1">${icon('camera')}Camera</button><button type="button" class="btn" data-act="co-attach" data-id="${esc(key(o.id))}">${icon('folder')}Choose File</button></div></div>`}
      <div class="sheet-actions">${!draft && st === 'draft' ? `<button type="button" class="btn danger" data-act="co-delete" data-id="${esc(key(o.id))}" aria-label="Delete" style="flex:0 0 52px">${icon('trash')}</button>` : ''}<button type="button" class="btn" data-act="sheet-close">${editable ? 'Cancel' : 'Done'}</button>${editable ? `<button type="submit" class="btn primary">${draft ? 'Save Draft' : 'Save'}</button>` : ''}</div>
    </form>`, (el) => {
    S.ui.coDraft = draft;
    const f = $('#co-form', el);
    if (editable) f.elements.amount.addEventListener('input', () => { $('#co-credit', f).textContent = Number(f.elements.amount.value) < 0 ? 'A negative price is a credit to the client.' : ''; });
    if (draft && !draft.title) setTimeout(() => f.elements.title.focus(), 250);
  });
}

function readChangeOrderForm(f) {
  const v = (n) => (f.elements[n]?.value ?? '').trim();
  const out = { title: v('title'), reason: v('reason'), details: f.elements.details.value, cost: money(Number(v('cost')) || 0), amount: money(Number(v('amount')) || 0), daysAdded: Math.round(Number(v('daysAdded')) || 0) };
  const d = parseInputDate(v('date'));
  if (d) out.date = d;
  return out;
}

// ----- Pay applications (fixed price) and billing (cost plus, T&M)

function projectPayApps(p) {
  const c = contractOf(p);
  if (c.type !== 'fixedPrice') return costPlusBilling(p);
  const apps = projectPayApplications(p.id);
  if (!apps.length) {
    return emptyState('listNumber', 'No Pay Applications Yet', (c.sov || []).length ? 'Each pay application bills the work done in a period against the schedule of values. They’re made on the Mac and show here.' : 'Set up the schedule of values on the Mac first. Each pay application bills the work done in a period against its lines.');
  }
  const lines = billingLines(p);
  const f = clientFinancials(p);
  let html = `<div class="tiles">
    ${tile('Billed to Client', fmt.money(f.billedToDate), `${fmt.money(f.received)} received`, { accent: 'var(--slate)' })}
    ${tile('Client Owes', fmt.money(f.openInvoices), f.retainageReceivable > 0 ? `Plus ${fmt.money(f.retainageReceivable)} retainage` : '', { accent: 'var(--leather)' })}
    ${tile('Left to Bill', fmt.money(f.leftToBill), `of ${fmt.money(f.contractTotal)}`, { accent: 'var(--gold)' })}
  </div>`;
  html += `<section class="card flush">${apps.slice().reverse().map((a) => {
    const s = payAppStatement(a, apps, lines).summary;
    const inv = a.invoiceID ? get(a.invoiceID) : null;
    const st = inv ? TXN_STATUS[txnStatus(inv)] : ['Draft', 'var(--stone)'];
    return `<button class="row" data-act="payapp-open" data-id="${esc(key(a.id))}">${icon('listNumber', 'ic glyph', '--tint:var(--slate)')}
      <div class="main"><div class="t">Application ${esc(a.number)}</div><div class="s">${esc(`Work through ${fmt.date(fromSec(a.periodTo))}${a.releaseRetainage ? ' · Final' : ''}`)}</div></div>
      <div class="end"><span class="amt">${esc(fmt.money(s.currentDue, true))}</span>${pill(st[0], st[1])}</div></button>`;
  }).join('')}</section>`;
  return html;
}

function sheetPayApp(id) {
  const a = get(id);
  const p = a && project(a.projectID);
  if (!p) return;
  const apps = projectPayApplications(p.id);
  const { rows, summary: s } = payAppStatement(a, apps, billingLines(p));
  const inv = a.invoiceID ? get(a.invoiceID) : null;
  const st = inv ? TXN_STATUS[txnStatus(inv)] : ['Draft', 'var(--stone)'];
  const sum = [
    ['1. Original contract sum', s.originalSum], ['2. Net change by change orders', s.changeOrders], ['3. Contract sum to date', s.contractSumToDate, true],
    ['4. Completed and stored to date', s.completedToDate], ['5. Retainage', s.retainage], ['6. Earned less retainage', s.earnedLessRetainage, true],
    ['7. Less previous applications', s.previousCertificates], ...(s.depositApplied > 0 ? [['Less deposit applied', s.depositApplied]] : []),
    ['8. Current payment due', s.currentDue, true], ['9. Balance to finish, including retainage', s.balanceToFinish],
  ].map(([l, v, bold]) => (bold ? kvTotal(l, fmt.money(v, true)) : kvLine(esc(l), fmt.money(v, true)))).join('');
  const shownRows = rows.filter((r) => r.line.scheduledValue || r.completed || r.thisPeriod);
  openSheet(`${sheetHead(`Pay Application ${a.number}`, `${projectName(p)} · work through ${fmt.date(fromSec(a.periodTo))}`)}
    <div class="page-bar">${pill(st[0], st[1])}${inv ? `<button class="btn link" data-act="txn-open" data-id="${esc(key(inv.id))}">Invoice ${esc(inv.number || '')}</button>` : '<span class="count small">Not submitted yet</span>'}</div>
    ${kvCard('Summary', sum)}
    ${card('Continuation Sheet', shownRows.map((r) => `<div class="row static"><span class="pnum" style="width:40px">${esc(r.line.itemNumber)}</span>
      <div class="main"><div class="t">${esc(r.line.description || 'Untitled line')}</div>
        <div class="s">Scheduled ${esc(fmt.money(r.line.scheduledValue))} · Previous ${esc(fmt.money(r.previous))} · This period ${esc(fmt.money(r.thisPeriod))}${r.stored ? ` · Stored ${esc(fmt.money(r.stored))}` : ''}</div>
        <div class="progress thin"><i style="width:${Math.max(0, Math.min(100, Math.round(r.percent * 100)))}%"></i></div></div>
      <div class="end"><span class="amt">${Math.round(r.percent * 1000) / 10}%</span><span style="${r.balance < -0.5 ? 'color:var(--danger)' : ''}">${esc(fmt.money(r.balance))} left</span></div></div>`).join(''))}
    ${(a.notes || '').trim() ? card('Notes', `<div style="white-space:pre-wrap">${esc(a.notes)}</div>`, { flush: false }) : ''}
    <p class="note" style="text-align:center">Pay applications are made and submitted on the Mac.</p>`);
}

function costPlusBilling(p) {
  const f = clientFinancials(p);
  const c = contractOf(p);
  let html = `<div class="tiles">
    ${tile('Billed to Client', fmt.money(f.billedToDate), `${fmt.money(f.received)} received`, { accent: 'var(--slate)' })}
    ${tile('Earned So Far', fmt.money(f.earnedRevenue), c.type === 'costPlus' ? `Cost plus ${trimNum(f.feePct)}% fee` : 'Hours at bill rates, plus markup', { accent: 'var(--forest)' })}
    ${tile(f.overUnderBilled >= 0 ? 'Billed Ahead' : 'Not Yet Billed', fmt.money(Math.abs(f.overUnderBilled)), f.overUnderBilled >= 0 ? 'More billed than earned' : 'Bill it on the Mac', { accent: f.overUnderBilled < 0 ? 'var(--warning)' : 'var(--gold)' })}
  </div>`;
  html += kvCard('Job Cost', kvLine('Cost to date', fmt.money(f.costToDate)) + (c.type === 'timeAndMaterials' ? kvLine('Crew labor at cost', fmt.money(f.laborCostToDate)) + kvLine('Crew hours at bill rates', fmt.money(f.laborAtBillRates)) : '') + kvLine('Budgeted cost', fmt.money(f.estimatedCost)) + kvTotal('Projected billings', fmt.money(f.contractTotal)));
  const invoices = all('transaction').filter((t) => sameId(t.projectID, p.id) && t.type === 'invoice').sort((a, b) => (b.date || 0) - (a.date || 0));
  html += card('Invoices', invoices.length ? invoices.map((t) => ledgerTxnRow(t, { showProject: false })).join('') : '<div class="empty-line">No invoices yet. Billings are made on the Mac.</div>');
  return html;
}

Object.assign(PROJECT_PAGES, {
  contract: ['Terms', (p) => contractTerms(p)],
  sov: ['Schedule of Values', (p) => contractSOV(p)],
  changeOrders: ['Change Orders', (p) => contractChangeOrders(p)],
  payApps: ['Pay Applications', (p) => projectPayApps(p)],
});

// ----- Edits from the field

Object.assign(RECORD_OPS, {
  // Approved change orders change the contract and the budget; those are only changed on the Mac.
  setChangeOrder(o, { fields }) {
    if (o.status === 'approved') return;
    for (const [k, v] of Object.entries(fields)) { if (v == null) delete o[k]; else o[k] = v; }
  },
});

/** The overage on a client's allowances not on a change order yet, as a draft (SelectionMath.overageChangeOrder). */
function overageChangeOrderFields(p) {
  const markup = selectionMarkup(p);
  if (markup == null) return null;
  const over = (p.selections || []).filter((s) => selectionOverage(s, markup) > 0);
  const total = money(over.reduce((s, x) => s + selectionOverage(x, markup), 0));
  const billed = overageBilled(p.id);
  const amount = money(total - billed);
  if (amount <= 0.005) return null;
  const lines = over.map((x) => `${x.category ?? 'Other'} – ${selectionName(x)}: allowance ${fmt.money(x.allowance, true)}, selected ${fmt.money(selectionPrice(x, markup), true)} (${fmt.money(selectionOverage(x, markup), true)} over)`);
  if (billed > 0.005) lines.push(`Less ${fmt.money(billed, true)} already billed on earlier change orders.`);
  return { title: 'Selections over allowance', details: lines.join('\n'), reason: 'Client selections over allowance', cost: money(amount / (1 + markup / 100)), amount };
}

Object.assign(ACTIONS, {
  'co-open': (el) => sheetChangeOrder(el.dataset.id),
  'co-new': (el) => sheetChangeOrder(null, newChangeOrder(el.dataset.project)),
  'co-overage': (el) => {
    const p = project(el.dataset.project);
    const fields = p && overageChangeOrderFields(p);
    if (fields) sheetChangeOrder(null, newChangeOrder(p.id, fields));
  },
  'co-price': (el) => {
    const f = $('#co-form');
    const cost = Number(f.elements.cost.value) || 0;
    f.elements.amount.value = money(cost * (1 + (Number(el.dataset.markup) || 0) / 100)).toFixed(2);
    f.elements.amount.dispatchEvent(new Event('input', { bubbles: true }));
    sheetDirty = true;
  },
  'co-status': async (el) => {
    const f = $('#co-form');
    const o = get(f.dataset.id);
    if (!o) return;
    const status = el.dataset.status;
    const fields = { status };
    if (coStatus(o) === 'draft' || coStatus(o) === 'pending') Object.assign(fields, readChangeOrderForm(f));
    if (fields.date instanceof Date) fields.date = sameDay(fields.date, fromSec(o.date)) ? o.date : toSec(localNoon(fields.date));
    if (status === 'pending') fields.sentDate = o.sentDate ?? stamp();
    closeSheet();
    if (await editRecord('changeOrder', o.id, [{ op: 'setChangeOrder', fields }])) toast(status === 'pending' ? 'Marked sent' : status === 'rejected' ? 'Marked rejected' : 'Back to draft');
  },
  'co-delete': async (el) => {
    const o = get(el.dataset.id);
    if (!o || coStatus(o) !== 'draft' || !confirm(`Delete ${coLabel(o)}?\n\nThis can't be undone.`)) return;
    closeSheet();
    await deleteRecord('changeOrder', o.id);
    render();
    toast('Deleted');
  },
  'co-attach': (el) => {
    const o = get(el.dataset.id);
    if (!o) return;
    pickFiles({ accept: el.dataset.capture ? 'image/*' : 'image/*,application/pdf', capture: !!el.dataset.capture, multiple: false }, async (files) => {
      const p = project(o.projectID);
      const added = await addFiles(files, { projectID: o.projectID, category: 'changeOrder', recordID: o.id, contactID: p?.customerID || null });
      if (added) { closeSheet(); sheetChangeOrder(o.id); }
    });
  },
  'payapp-open': (el) => sheetPayApp(el.dataset.id),
});

document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (f.id !== 'co-form') return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const fields = readChangeOrderForm(f);
  if (f.dataset.id) {
    const o = get(f.dataset.id);
    if (!o) { closeSheet(); return; }
    fields.date = fields.date ? (sameDay(fields.date, fromSec(o.date)) ? o.date : toSec(localNoon(fields.date))) : o.date;
    closeSheet();
    if (await editRecord('changeOrder', o.id, [{ op: 'setChangeOrder', fields }])) toast('Saved');
  } else {
    const draft = { ...S.ui.coDraft, ...fields };
    draft.date = fields.date ? (sameDay(fields.date, new Date()) ? stamp() : toSec(localNoon(fields.date))) : stamp();
    // Numbered when it's saved, in case another one was added meanwhile.
    const numbers = all('changeOrder').filter((o) => sameId(o.projectID, draft.projectID)).map((o) => o.number || 0);
    draft.number = (numbers.length ? Math.max(...numbers) : 0) + 1;
    await saveRecord('changeOrder', draft);
    closeSheet();
    toast(`${coLabel(draft)} saved as a draft`);
  }
}, true);
