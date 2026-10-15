/* Eagle Creek — Contacts.
 *
 * Every trade, supplier, crew member, customer and lender, with what ties to them: their
 * files (W-9s, insurance, quotes, invoices, lien waivers, subcontract paperwork), projects,
 * open work, subcontracts and POs, and bills or invoices. Files are matched to people the same
 * way as on the Mac (Engine/ContactLinks.swift): picked on the file, else the contact on the
 * bill or invoice it backs up, else the sub on its subcontract or PO (or a job's customer).
 * Bills, invoices and subcontracts are read-only here; they're edited on the Mac.
 */
'use strict';

Object.assign(ICONS, {
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19.5a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.6"/><path d="M15.5 14.2A5 5 0 0 1 21 19"/>',
  phone: '<path d="M6.5 3.5h3l1.5 4-2 1.3a10 10 0 0 0 6.2 6.2l1.3-2 4 1.5v3a2 2 0 0 1-2 2A16.5 16.5 0 0 1 4.5 5.5a2 2 0 0 1 2-2z"/>',
  message: '<path d="M4 5h16v11H9l-5 4z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.5 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5 7.5-9.5V6z"/><path d="M12 8v4.5M12 15.5v.01"/>',
  bank: '<path d="M3 10h18L12 4zM5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>',
  wrench: '<path d="M15.2 4.3a4.7 4.7 0 0 0-5.4 6.3l-6 6a2.1 2.1 0 0 0 3 3l6-6a4.7 4.7 0 0 0 6.3-5.4l-2.8 2.8-2.6-.5-.5-2.6z"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
});

// ----- Names (the Mac's ContactKind)

const CONTACT_KINDS = {
  vendor: { one: 'Vendor', many: 'Vendors', icon: 'wrench', tint: 'var(--leather)' },
  customer: { one: 'Customer', many: 'Customers', icon: 'house', tint: 'var(--slate)' },
  employee: { one: 'Crew Member', many: 'Crew', icon: 'hardhat', tint: 'var(--forest)' },
  lender: { one: 'Lender', many: 'Lenders', icon: 'bank', tint: 'var(--gold)' },
  other: { one: 'Other', many: 'Other', icon: 'people', tint: 'var(--stone)' },
};
const contactKind = (c) => CONTACT_KINDS[c?.kind] || CONTACT_KINDS.vendor;
const contactDisplayName = (c) => (c?.name || '').trim() || `Unnamed ${contactKind(c).one.toLowerCase()}`;

// ----- Money (the Mac's Money and Transaction maths)

// Halves round away from zero, like the Mac (Math.round alone takes -2.5 to -2).
const money = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.sign(n) * Math.round(Math.abs(n) * 100) / 100 : 0; };
fmt.money = (v, cents = false) => (Number(v) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
const TXN_TYPES = { bill: 'Bill', expense: 'Expense', invoice: 'Invoice', deposit: 'Deposit', transfer: 'Transfer', journal: 'Journal Entry' };
const TXN_STATUS = {
  draft: ['Draft', 'var(--stone)'], open: ['Unpaid', 'var(--slate)'], partial: ['Partly paid', 'var(--warning)'],
  overdue: ['Overdue', 'var(--danger)'], paid: ['Paid', 'var(--success)'], posted: ['Recorded', 'var(--stone)'], void: ['Void', 'var(--stone)'],
};
const WAIVER = { needed: 'Needed', conditional: 'Conditional', unconditional: 'Received', notRequired: 'N/A' };
const METHODS = { check: 'Check', ach: 'ACH', wire: 'Wire', card: 'Card', cash: 'Cash', zelle: 'Zelle / Venmo', other: 'Other' };
const tracksBalance = (t) => t.type === 'bill' || t.type === 'invoice';
function txnSubtotal(t) {
  const lines = t.lines || [];
  if (t.type === 'journal') return money(lines.reduce((s, l) => s + Math.max(0, money(l.amount)), 0));
  return money(lines.reduce((s, l) => s + money(l.amount), 0));
}
function txnTax(t) {
  if (t.type !== 'invoice' || !(t.taxPct > 0)) return 0;
  const taxable = money((t.lines || []).filter((l) => l.taxable !== false).reduce((s, l) => s + money(l.amount), 0));
  return money(taxable * t.taxPct / 100);
}
const txnTotal = (t) => money(txnSubtotal(t) + txnTax(t));
const txnPaid = (t) => money((t.payments || []).reduce((s, p) => s + money(p.amount), 0));
const txnRetainage = (t) => (tracksBalance(t) ? money(t.retainageHeld || 0) : 0);
const txnDue = (t) => money(txnTotal(t) - txnRetainage(t));
const txnBalance = (t) => (!tracksBalance(t) || t.isVoid ? 0 : money(txnDue(t) - txnPaid(t)));
const txnOpen = (t) => tracksBalance(t) && !t.isVoid && txnBalance(t) > 0.005;
const txnOverdue = (t) => txnOpen(t) && t.dueDate != null && sod(fromSec(t.dueDate)) < sod(new Date());
function txnStatus(t) {
  if (t.isVoid) return 'void';
  if (!tracksBalance(t)) return 'posted';
  if (txnDue(t) <= 0.005 && !(t.payments || []).length) return t.type === 'invoice' && t.sentDate == null ? 'draft' : 'open';
  if (txnBalance(t) <= 0.005) return 'paid';
  if (txnOverdue(t)) return 'overdue';
  if (txnPaid(t) > 0.005) return 'partial';
  if (t.type === 'invoice' && t.sentDate == null) return 'draft';
  return 'open';
}
/** Money paid to the vendor on a bill or expense, each with its lien waiver. */
function vendorPayments(t) {
  if (t.isVoid) return [];
  if (t.type === 'bill') return (t.payments || []).map((p) => ({ date: p.date, amount: money(p.amount), method: p.method, reference: p.reference, waiver: p.waiver || {} }));
  if (t.type === 'expense') return [{ date: t.date, amount: txnTotal(t), method: t.method, reference: t.number, waiver: t.waiver || {} }];
  return [];
}
const txnLabel = (t) => `${TXN_TYPES[t.type] || 'Transaction'}${(t.number || '').trim() ? ` ${t.number.trim()}` : ''}`;
/** A subcontract or PO's amount with its approved changes (Commitment.revisedAmount). */
const commitmentAmount = (c) => money(money((c.lines || []).reduce((s, l) => s + (Number(l.amount) || 0), 0)) + money((c.changes || []).reduce((s, x) => s + (Number(x.amount) || 0), 0)));
const COMMITMENT_STATUS = { draft: ['Draft', 'var(--stone)'], issued: ['Sent', 'var(--slate)'], signed: ['Signed', 'var(--forest)'], complete: ['Complete', 'var(--success)'], void: ['Void', 'var(--stone)'] };
function commitmentTitle(c) {
  const label = (c.number || '').trim() ? `${c.kind === 'purchaseOrder' ? 'PO' : 'SC'} ${c.number.trim()}` : (c.kind === 'purchaseOrder' ? 'Purchase Order' : 'Subcontract');
  return (c.title || '').trim() ? `${label} – ${c.title.trim()}` : label;
}
const inThisYear = (sec) => sec != null && fromSec(sec).getFullYear() === new Date().getFullYear();

// ----- Who a file belongs to (the Mac's ContactLinks)

function contactLinks() {
  const m = fresh();
  if (m.contactLinks) return m.contactLinks;
  const byTransaction = new Map();
  for (const t of all('transaction')) if (t.contactID) byTransaction.set(key(t.id), t.contactID);
  const byRecord = new Map();
  const customers = new Map();
  for (const p of projects()) if (p.customerID) { byRecord.set(key(p.id), p.customerID); customers.set(key(p.id), p.customerID); }
  for (const c of all('commitment')) if (c.contactID) byRecord.set(key(c.id), c.contactID);
  for (const o of all('changeOrder')) { const cu = customers.get(key(o.projectID)); if (cu) byRecord.set(key(o.id), cu); }
  for (const a of all('payApp')) { const cu = customers.get(key(a.projectID)); if (cu) byRecord.set(key(a.id), cu); }
  m.contactLinks = { byTransaction, byRecord };
  return m.contactLinks;
}
function fileContactID(f) {
  if (f.contactID) return f.contactID;
  const { byTransaction, byRecord } = contactLinks();
  return (f.transactionID && byTransaction.get(key(f.transactionID))) || (f.recordID && byRecord.get(key(f.recordID))) || null;
}
const contactTransactions = (cid) => all('transaction').filter((t) => sameId(t.contactID, cid)).sort((a, b) => (b.date || 0) - (a.date || 0));
function contactFiles(cid) {
  const waiverFiles = new Set();
  for (const t of contactTransactions(cid)) {
    if (t.waiver?.documentID) waiverFiles.add(key(t.waiver.documentID));
    for (const p of t.payments || []) if (p.waiver?.documentID) waiverFiles.add(key(p.waiver.documentID));
  }
  // Saved emails have their own card (Emails); their attachments stay with the files.
  return all('file').filter((f) => !isEmailFile(f) && (waiverFiles.has(key(f.id)) || sameId(fileContactID(f), cid)))
    .sort((a, b) => ((b.documentDate || 0) - (a.documentDate || 0)) || ((b.addedAt || 0) - (a.addedAt || 0)));
}
const ROLE_LABELS = ['Customer', 'Subcontract', 'PO', 'Bills', 'Invoices', 'Schedule'];
function contactProjects(cid) {
  const roles = new Map();
  const add = (pid, r) => { if (!pid) return; const k = key(pid); if (!roles.has(k)) roles.set(k, new Set()); roles.get(k).add(r); };
  for (const p of projects()) if (sameId(p.customerID, cid)) add(p.id, 0);
  for (const c of all('commitment')) if (sameId(c.contactID, cid)) add(c.projectID, c.kind === 'purchaseOrder' ? 2 : 1);
  for (const t of all('transaction')) if (sameId(t.contactID, cid)) { if (t.type === 'bill' || t.type === 'expense') add(t.projectID, 3); if (t.type === 'invoice') add(t.projectID, 4); }
  for (const t of all('task')) if (sameId(t.contactID, cid)) add(t.projectID, 5);
  return projects().filter((p) => roles.has(key(p.id)))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map((p) => ({ project: p, roles: [...roles.get(key(p.id))].sort().map((r) => ROLE_LABELS[r]) }));
}
function insuranceState(c) {
  if (c.kind !== 'vendor' || c.insuranceExpires == null) return null;
  const days = dayDiff(new Date(), fromSec(c.insuranceExpires));
  if (fromSec(c.insuranceExpires) < new Date()) return { level: 'expired', text: `Insurance expired ${fmt.date(fromSec(c.insuranceExpires))}` };
  if (days <= 30) return { level: 'soon', text: `Insurance expires ${days === 0 ? 'today' : `in ${plural(days, 'day')}`}` };
  return null;
}
const needsW9 = (c) => c.kind === 'vendor' && c.is1099 && !c.w9OnFile;

// ----- Contacts list

function contactRow(c) {
  const k = contactKind(c);
  const ins = insuranceState(c);
  const sub = [c.trade, c.contactName, c.phone].filter((x) => (x || '').trim()).map((x) => x.trim()).join(' · ');
  const flags = [];
  if (ins) flags.push(`<span class="${ins.level === 'expired' ? 'alert-text' : ''}" style="${ins.level === 'soon' ? 'color:var(--warning)' : ''}">${esc(ins.text)}</span>`);
  if (needsW9(c)) flags.push('<span style="color:var(--warning)">No W-9 on file</span>');
  return `<a class="row" href="#/contact/${esc(key(c.id))}">
    ${icon(contactIcon(c), 'ic glyph', `--tint:${k.tint}`)}
    <div class="main"><div class="t">${esc(contactDisplayName(c))}${c.isArchived ? ' <span class="muted small">· Archived</span>' : ''}</div>
      ${sub ? `<div class="s">${esc(sub)}</div>` : ''}${flags.length ? `<div class="s">${flags.join(' · ')}</div>` : ''}</div>
    ${ins?.level === 'expired' ? icon('shield', 'ic', 'color:var(--danger)') : ''}${icon('chev', 'ic chev')}</a>`;
}

function contactResults() {
  const q = (S.ui.contactSearch || '').trim().toLowerCase();
  const filter = S.ui.contactKind || 'all';
  const showArchived = prefs.get('show-archived-contacts', false);
  const list = all('contact')
    .filter((c) => showArchived || !c.isArchived)
    .filter((c) => filter === 'all' || (c.kind || 'vendor') === filter)
    .filter((c) => !q || `${c.name} ${c.contactName} ${c.trade} ${c.phone} ${c.email}`.toLowerCase().includes(q))
    .sort((a, b) => contactDisplayName(a).localeCompare(contactDisplayName(b)));
  if (!all('contact').length) return emptyState('people', 'No Contacts Yet', 'Your trades, suppliers, crew, customers and lenders come over from the Mac app, or tap + to add one.');
  if (!list.length) return emptyState('search', 'No Matches', q ? `No contact matches “${S.ui.contactSearch.trim()}”.` : 'Nobody of that type yet.');
  if (filter !== 'all' || q) return `<section class="card flush">${list.map(contactRow).join('')}</section>`;
  let html = '';
  for (const [kind, info] of Object.entries(CONTACT_KINDS)) {
    const group = list.filter((c) => (c.kind || 'vendor') === kind);
    if (group.length) html += card(`${info.many} (${group.length})`, group.map(contactRow).join(''));
  }
  return html;
}

function viewContacts() {
  setHeader({ title: 'Contacts', actions: `<button class="icon-btn" data-act="contact-new" aria-label="New contact">${icon('plus')}</button>` });
  const filter = S.ui.contactKind || 'all';
  const showArchived = prefs.get('show-archived-contacts', false);
  const flagged = all('contact').filter((c) => !c.isArchived && insuranceState(c)?.level === 'expired').length;
  let html = '';
  if (flagged) html += banner(`${plural(flagged, 'trade')} ${flagged === 1 ? 'has' : 'have'} expired insurance. Get a new certificate before paying.`, 'var(--danger)');
  html += `<div class="search">${icon('search')}<input class="input" id="contact-search" type="search" placeholder="Name, trade, phone" value="${esc(S.ui.contactSearch || '')}" autocomplete="off"></div>`;
  html += `<nav class="seg" aria-label="Show">${[['all', 'All'], ...Object.entries(CONTACT_KINDS).map(([k, v]) => [k, v.many])].map(([k, l]) => `<button data-act="contact-filter" data-kind="${k}" class="${filter === k ? 'on' : ''}">${segIcon(k === 'all' ? 'people' : CONTACT_KINDS[k].icon)}${l}</button>`).join('')}</nav>`;
  html += `<div id="contact-results">${contactResults()}</div>`;
  html += `<label class="check-label" style="margin:4px 4px 0"><input type="checkbox" data-act="toggle-pref" data-pref="show-archived-contacts" ${showArchived ? 'checked' : ''}>Show archived</label>`;
  return html;
}

// ----- One contact

function txnRow(t) {
  const st = txnStatus(t);
  const p = t.projectID ? project(t.projectID) : null;
  const amount = tracksBalance(t) && txnOpen(t) && txnBalance(t) !== txnTotal(t) ? `${fmt.money(txnBalance(t), true)} due` : fmt.money(txnTotal(t), true);
  return `<button class="row" data-act="txn-open" data-id="${esc(key(t.id))}">
    <div class="main"><div class="t">${esc(txnLabel(t))}</div><div class="s">${esc([p ? projectName(p) : 'Company', fmt.date(fromSec(t.date))].join(' · '))}</div></div>
    <div class="end"><span class="num" style="color:var(--text);font-size:15px">${esc(amount)}</span>${pill(TXN_STATUS[st][0], TXN_STATUS[st][1])}</div></button>`;
}

function commitmentRow(c) {
  const p = c.projectID ? project(c.projectID) : null;
  const st = COMMITMENT_STATUS[c.status] || COMMITMENT_STATUS.draft;
  return `<button class="row" data-act="commitment-open" data-id="${esc(key(c.id))}">
    ${icon('doc', 'ic glyph', '--tint:var(--olive)')}
    <div class="main"><div class="t">${esc(commitmentTitle(c))}</div><div class="s">${esc(p ? projectName(p) : 'Company')}</div></div>
    <div class="end"><span class="num" style="color:var(--text);font-size:15px">${esc(fmt.money(commitmentAmount(c)))}</span>${pill(st[0], st[1])}</div></button>`;
}

function contactFileRow(f) {
  const p = f.projectID ? project(f.projectID) : null;
  const sub = [CATEGORY_ONE[f.category] || 'File', p ? projectName(p) : 'Company Files', fmt.date(fileDate(f))].join(' · ');
  return `<button class="row" data-act="open-file" data-id="${esc(key(f.id))}">${icon(isImage(f) ? 'image' : (FILE_ICONS[f.category] || 'doc'), 'ic glyph', '--tint:var(--sage)')}
    <div class="main"><div class="t">${esc(fileTitle(f))}</div><div class="s">${esc(sub)}${isPending(f) ? ' · Waiting to upload' : ''}</div></div>${icon('chev', 'ic chev')}</button>`;
}

/** W-9 line 3 (Eagle Creek Books' TaxClassification). */
const TAX_CLASSIFICATIONS = {
  individual: 'Individual or single-member LLC', cCorporation: 'C corporation', sCorporation: 'S corporation', partnership: 'Partnership',
  trustEstate: 'Trust or estate', llcC: 'LLC taxed as a C corporation', llcS: 'LLC taxed as an S corporation', llcP: 'LLC taxed as a partnership',
  exempt: 'Tax-exempt organization', other: 'Other',
};
/** "EIN ending 1234": the number itself stays in Eagle Creek Books. */
function maskedTaxID(c) {
  const digits = String(c.taxID || '').replace(/\D/g, '');
  if (!digits) return '';
  return `${(c.taxIDType || '').trim() || 'Taxpayer ID'} ending ${digits.slice(-4)}`;
}
/** The 1099 mailing address from its parts, when they've been filled in. */
function mailingAddress(c) {
  if (!(c.street || '').trim()) return '';
  const csz = [(c.city || '').trim(), [(c.state || '').trim(), (c.zip || '').trim()].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [(c.street || '').trim(), (c.street2 || '').trim(), csz].filter(Boolean).join(', ');
}

function viewContact(id) {
  const c = get(id);
  if (!c || !all('contact').includes(c)) {
    setHeader({ title: 'Contact', back: '#/contacts' });
    return emptyState('people', 'Not on This Device', 'This contact may have been deleted on the Mac.');
  }
  const k = contactKind(c);
  const cid = esc(key(c.id));
  setHeader({ title: contactDisplayName(c), sub: [k.one, c.trade].filter((x) => (x || '').trim()).join(' · '), back: '#/contacts',
    actions: `<button class="icon-btn" data-act="contact-edit" data-id="${cid}" aria-label="Edit">${icon('edit')}</button>` });
  const phone = (c.phone || '').trim();
  const digits = phone.replace(/[^\d+]/g, '');
  const email = (c.email || '').trim();
  const address = (c.address || '').trim();
  let html = '';
  // Reach them
  const actions = [];
  if (digits) actions.push(`<a class="action" href="tel:${esc(digits)}">${icon('phone')}Call</a>`, `<a class="action" href="sms:${esc(digits)}">${icon('message')}Text</a>`);
  if (email) actions.push(`<a class="action" href="mailto:${esc(email)}">${icon('mail')}Email</a>`);
  if (address) actions.push(`<a class="action" href="${mapsLink(address)}" target="_blank" rel="noopener">${icon('pin')}Directions</a>`);
  if (actions.length) html += `<div class="actions" style="grid-template-columns:repeat(${actions.length},1fr)">${actions.join('')}</div>`;
  else html += `<div class="banner" style="--c:var(--slate)">${icon('phone')}<div>No phone or email yet. <a href="#" data-act="contact-edit" data-id="${cid}">Add them</a>.</div></div>`;
  // Paperwork that needs attention
  const ins = insuranceState(c);
  if (ins?.level === 'expired') html += banner('Their insurance certificate has expired. Get a new one before paying.', 'var(--danger)');
  else if (ins) html += banner(`${ins.text} (${fmt.date(fromSec(c.insuranceExpires))}). Ask for a new certificate.`);
  if (needsW9(c)) html += banner('They get a 1099 but there’s no W-9 on file. Ask them for one.');

  const txns = contactTransactions(c.id);
  if (c.kind === 'employee') {
    const entries = all('timeEntry').filter((t) => sameId(t.contactID, c.id) && inThisYear(t.date));
    const hours = entries.reduce((s, t) => s + (Number(t.hours) || 0) + (Number(t.overtimeHours) || 0), 0);
    const cost = entries.reduce((s, t) => {
      const wages = money((t.hours || 0) * (t.payRate || 0) + (t.overtimeHours || 0) * (t.payRate || 0) * 1.5);
      return s + money(wages * (1 + (t.burdenPct || 0) / 100));
    }, 0);
    html += `<div class="tiles" style="grid-template-columns:repeat(2,1fr)">${tile('Hours This Year', String(Math.round(hours * 10) / 10), plural(entries.length, 'day'), { accent: 'var(--forest)' })}${tile('Labor Cost This Year', fmt.money(cost), 'Wages plus burden', { accent: 'var(--leather)' })}</div>`;
  } else if (txns.length) {
    const customer = c.kind === 'customer';
    const paidYear = customer
      ? txns.filter((t) => t.type === 'invoice' && !t.isVoid).flatMap((t) => t.payments || []).filter((p) => inThisYear(p.date)).reduce((s, p) => s + money(p.amount), 0)
      : txns.flatMap(vendorPayments).filter((p) => inThisYear(p.date)).reduce((s, p) => s + p.amount, 0);
    const open = txns.filter(txnOpen).reduce((s, t) => s + txnBalance(t), 0);
    const tiles = [
      tile(customer ? 'Received This Year' : 'Paid This Year', fmt.money(paidYear), '', { accent: 'var(--forest)' }),
      tile(customer ? 'They Owe You' : 'You Owe Them', fmt.money(open), plural(txns.filter(txnOpen).length, 'open item'), { accent: customer ? 'var(--slate)' : 'var(--leather)' }),
    ];
    if (c.requiresLienWaivers) {
      const missing = txns.flatMap(vendorPayments).filter((p) => !['unconditional', 'notRequired'].includes(p.waiver.status || 'needed'));
      tiles.push(tile('Waivers Needed', String(missing.length), fmt.money(missing.reduce((s, p) => s + p.amount, 0)), { accent: missing.length ? 'var(--danger)' : 'var(--olive)' }));
    }
    html += `<div class="tiles" style="grid-template-columns:repeat(${tiles.length},1fr)">${tiles.join('')}</div>`;
  }

  // Projects
  const jobs = contactProjects(c.id);
  if (jobs.length) {
    html += card(`Projects (${jobs.length})`, jobs.map(({ project: p, roles }) => `<a class="row" href="#/project/${esc(key(p.id))}">${icon(KIND_ICON[p.kind] || 'hammer', 'ic glyph', `--tint:${statusColor(p.status)}`)}
      <div class="main"><div class="t">${esc(projectName(p))}</div><div class="s"><span class="dot-label" style="--c:${statusColor(p.status)}">${esc(statusLabel(p.status))}</span> · ${esc(roles.join(', '))}</div></div>${icon('chev', 'ic chev')}</a>`).join(''));
  }
  // Open work
  const tasks = all('task').filter((t) => sameId(t.contactID, c.id) && !isDone(t)).map(scheduledTask).filter(Boolean).sort((a, b) => a.start - b.start);
  const punch = all('punchItem').filter((x) => sameId(x.contactID, c.id) && x.status !== 'closed');
  if (tasks.length || punch.length) {
    html += card(`Open Work (${tasks.length + punch.length})`, tasks.map((s) => taskRow(s, { showProject: true })).join('') + punch.map((x) => {
      const p = project(x.projectID);
      const due = x.dueDate != null ? fromSec(x.dueDate) : null;
      const late = due && sod(due) < sod(new Date());
      return `<a class="row" href="#/project/${esc(key(x.projectID))}/punch">${icon('checklist', 'ic glyph', `--tint:${late ? 'var(--danger)' : 'var(--forest)'}`)}<div class="main"><div class="t">#${x.number || 1} ${esc(x.title || '')}</div><div class="s">${esc([p ? projectName(p) : '', x.location].filter(Boolean).join(' · '))}</div></div>${due ? `<span class="end ${late ? 'alert-text' : ''}">${esc(fmt.relDay(due))}</span>` : ''}</a>`;
    }).join(''));
  }
  // Subcontracts and POs
  const commits = all('commitment').filter((x) => sameId(x.contactID, c.id)).sort((a, b) => (b.date || 0) - (a.date || 0));
  if (commits.length) html += card(`Subcontracts & POs (${commits.length})`, commits.map(commitmentRow).join(''));
  // Bills, invoices and payments
  if (txns.length) {
    const shown = S.ui.contactAllTxns === key(c.id) ? txns : txns.slice(0, 8);
    html += card(`Transactions (${txns.length})`, shown.map(txnRow).join('') + (shown.length < txns.length ? `<button class="row" data-act="contact-all-txns" data-id="${cid}"><div class="main"><div class="t" style="color:var(--forest)">Show all ${txns.length}</div></div></button>` : ''));
  }
  // Emails saved from Gmail with them (mail.js)
  const mails = typeof emailsForContact === 'function' ? emailsForContact(c) : [];
  if (mails.length) html += card(`Emails (${mails.length})`, mails.slice(0, 20).map((f) => emailRow(f, { showProject: true })).join('') + (mails.length > 20 ? `<div class="empty-line small">${mails.length - 20} older in the Email Archive</div>` : ''));
  // Files
  const files = contactFiles(c.id);
  const filter = S.ui.contactFileCat?.[key(c.id)] || 'all';
  const cats = [...new Set(files.map((f) => f.category || 'other'))];
  const shownFiles = files.filter((f) => filter === 'all' || (f.category || 'other') === filter).slice(0, 150);
  let fileBody = '';
  if (cats.length > 1) fileBody += `<nav class="seg" style="margin:2px 0 6px;padding:0 16px" aria-label="Type">${[['all', `All (${files.length})`], ...cats.map((x) => [x, CATEGORY[x] || x])].map(([v, l]) => `<button data-act="contact-file-cat" data-id="${cid}" data-cat="${esc(v)}" class="${filter === v ? 'on' : ''}">${esc(l)}</button>`).join('')}</nav>`;
  fileBody += shownFiles.length ? shownFiles.map(contactFileRow).join('') : `<div class="empty-line">No files yet. Their W-9, insurance certificate, quotes and invoices show here, from every project.</div>`;
  html += card(`Files (${files.length})`, fileBody, { action: `<button class="btn link" data-act="contact-add-file" data-id="${cid}">${icon('plus')}Add</button>` });
  // Details
  const rows = [];
  const kv = (l, v) => { if (v != null && String(v).trim() !== '') rows.push(`<div class="kv"><span>${esc(l)}</span><span>${esc(v)}</span></div>`); };
  kv('Contact person', c.contactName);
  kv(c.kind === 'employee' ? 'Role' : 'Trade', c.trade);
  kv('Phone', phone);
  kv('Email', email);
  kv('Address', address);
  if (c.kind === 'vendor') {
    kv('License #', c.licenseNumber);
    kv('Insurance expires', c.insuranceExpires != null ? fmt.date(fromSec(c.insuranceExpires)) : 'Not on file');
    kv('Gets a 1099', c.is1099 ? 'Yes' : 'No');
    if (c.is1099) kv('W-9 on file', c.w9OnFile ? 'Yes' : 'No');
    // W-9 details kept by Eagle Creek Books (v1.3) for the 1099-NEC.
    kv('Tax classification', TAX_CLASSIFICATIONS[c.taxClassification] || (c.taxClassification || ''));
    kv('Taxpayer ID', maskedTaxID(c));
    if (c.isAttorney) kv('Attorney', 'Yes (gets a 1099 even as a corporation)');
    const mail = mailingAddress(c);
    if (mail && mail !== address) kv('1099 mailing address', mail);
    kv('Gives lien waivers', c.requiresLienWaivers ? 'Yes' : 'No');
    kv('Pay within', c.paymentTermsDays ? plural(c.paymentTermsDays, 'day') : 'Not set (bills due in 30 days)');
  }
  const w9Gap = c.kind === 'vendor' && c.is1099 && (!(c.taxClassification || '').trim() || String(c.taxID || '').replace(/\D/g, '').length !== 9);
  html += card('Details', `<div style="padding:0 16px 8px">${rows.join('') || '<div class="empty-line" style="padding:4px 0 10px">Nothing filled in yet.</div>'}${w9Gap ? '<p class="note" style="margin:8px 0 4px">The W-9’s taxpayer ID and tax classification go in Eagle Creek Books (Vendors & Customers) for the 1099.</p>' : ''}</div>`, { action: `<button class="btn link" data-act="contact-edit" data-id="${cid}">Edit</button>` });
  if ((c.notes || '').trim()) html += card('Notes', `<div style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(c.notes)}</div>`, { flush: false });
  return html;
}

// ----- Sheets

const NEW_CONTACT_TYPES = [
  ['trade', 'Trade or Sub', 'vendor'], ['supplier', 'Supplier or Store', 'vendor'], ['customer', 'Customer', 'customer'],
  ['employee', 'Crew Member', 'employee'], ['lender', 'Lender', 'lender'], ['other', 'Other', 'other'],
];

function sheetContactEdit(id) {
  const existing = id ? get(id) : null;
  const c = existing ? clone(existing) : { kind: 'vendor' };
  const isVendor = (c.kind || 'vendor') === 'vendor';
  const crew = c.kind === 'employee';
  const field = (name, label, value = '', attrs = '') => `<label class="field"><span>${label}</span><input name="${name}" value="${esc(value ?? '')}" ${attrs}></label>`;
  const toggle = (name, label, on) => `<label class="toggle">${label}<input type="checkbox" name="${name}" ${on ? 'checked' : ''}></label>`;
  openSheet(`${sheetHead(existing ? 'Edit Contact' : 'New Contact', existing ? contactDisplayName(c) : '')}
    <form id="contact-form" data-id="${esc(id || '')}">
      ${existing ? '' : `<div class="form-section"><div class="fs-head">Type</div><div class="chips" style="margin:0">${NEW_CONTACT_TYPES.map(([v, l]) => `<button type="button" data-act="contact-type" data-type="${v}" class="${v === 'trade' ? 'on' : ''}">${l}</button>`).join('')}</div><input type="hidden" name="newType" value="trade"></div>`}
      ${existing ? `<div class="form-section"><div class="form-card"><label class="field"><span>Type</span><select name="kind">${Object.entries(CONTACT_KINDS).map(([k, v]) => `<option value="${k}" ${(c.kind || 'vendor') === k ? 'selected' : ''}>${v.one}</option>`).join('')}</select></label></div></div>` : ''}
      <div class="form-section"><div class="form-card">
        ${field('name', crew ? 'Name' : 'Name', c.name, `required placeholder="${crew ? 'First and last name' : 'Company or person'}"`)}
        <div class="vendor-f ${crew ? 'hidden' : ''}">${field('contactName', 'Contact person', c.contactName)}</div>
        <div class="trade-f ${existing && !(isVendor || crew) ? 'hidden' : ''}">${field('trade', crew ? 'Role' : 'Trade', c.trade, `placeholder="${crew ? 'Carpenter, laborer, superintendent…' : 'Plumbing, electrical, roofing, supplier…'}"`)}</div>
        <div class="two">${field('phone', 'Phone', c.phone, 'type="tel" inputmode="tel" autocomplete="off"')}${field('email', 'Email', c.email, 'type="email" inputmode="email" autocapitalize="off" autocomplete="off"')}</div>
        <label class="field"><span>Address</span><textarea name="address" rows="1">${esc(c.address || '')}</textarea></label>
      </div></div>
      <div class="form-section bills-f ${existing && !isVendor ? 'hidden' : ''}"><div class="fs-head">Bills and Paperwork</div><div class="form-card">
        ${toggle('requiresLienWaivers', 'Gives lien waivers', c.requiresLienWaivers ?? !existing)}
        ${toggle('is1099', 'Gets a 1099-NEC', c.is1099 ?? !existing)}
        ${toggle('w9OnFile', 'W-9 on file', c.w9OnFile)}
        <div class="two">
          <label class="field"><span>Insurance expires</span><input name="insuranceExpires" type="date" value="${c.insuranceExpires != null ? fmt.inputDate(fromSec(c.insuranceExpires)) : ''}"></label>
          ${field('licenseNumber', 'License #', c.licenseNumber)}
        </div>
        ${field('paymentTermsDays', 'Pay within (days)', c.paymentTermsDays || '', 'type="number" inputmode="numeric" min="0" step="1" placeholder="30"')}
      </div></div>
      <div class="form-section"><div class="form-card">
        <label class="field"><span>Notes</span><textarea name="notes" rows="2" placeholder="Anything worth remembering">${esc(c.notes || '')}</textarea></label>
        ${existing ? toggle('isArchived', 'Archived (hidden in lists)', c.isArchived) : ''}
      </div></div>
      <div class="sheet-actions"><button type="button" class="btn" data-act="sheet-close">Cancel</button><button type="submit" class="btn primary">${existing ? 'Save' : 'Add Contact'}</button></div>
    </form>`, (el) => {
    const f = $('#contact-form', el);
    const sync = () => {
      const kind = existing ? f.elements.kind.value : (NEW_CONTACT_TYPES.find((t) => t[0] === f.elements.newType.value) || [])[2];
      $('.bills-f', f).classList.toggle('hidden', kind !== 'vendor');
      $('.vendor-f', f).classList.toggle('hidden', kind === 'employee');
      $('.trade-f', f).classList.toggle('hidden', !(kind === 'vendor' || kind === 'employee'));
      $('.trade-f span', f).textContent = kind === 'employee' ? 'Role' : 'Trade';
    };
    if (existing) f.elements.kind.addEventListener('change', sync);
    f.addEventListener('contact-type', sync);
    if (!existing) setTimeout(() => f.elements.name.focus(), 250);
  });
}

function sheetContactFile(cid) {
  const c = get(cid);
  const jobs = contactProjects(cid).map((j) => j.project);
  const others = projects().filter((p) => statusGroup(p.status) !== 'closed' && !jobs.includes(p)).sort((a, b) => projectName(a).localeCompare(projectName(b)));
  const types = c?.kind === 'vendor'
    ? [['w9', 'W-9'], ['insurance', 'Insurance Certificate'], ['contractBid', 'Quote or Bid'], ['invoice', 'Invoice'], ['lienWaiver', 'Lien Waiver'], ['taxForm', '1099'], ['other', 'Other']]
    : [['contractBid', 'Contract or Bid'], ['invoice', 'Invoice'], ['insurance', 'Insurance'], ['loanDocument', 'Loan Document'], ['other', 'Other']];
  openSheet(`${sheetHead('Add a File', contactDisplayName(c))}
    <div class="form-section"><div class="form-card">
      <label class="field"><span>What is it?</span><select id="cf-type">${types.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
      <label class="field"><span>Where it goes</span><select id="cf-project"><option value="">Company Files</option>${jobs.length ? `<optgroup label="Their projects">${jobs.map((p) => `<option value="${esc(key(p.id))}">${esc(projectName(p))}</option>`).join('')}</optgroup>` : ''}${others.length ? `<optgroup label="Other projects">${others.map((p) => `<option value="${esc(key(p.id))}">${esc(projectName(p))}</option>`).join('')}</optgroup>` : ''}</select></label>
      <label class="field cf-exp hidden"><span>Insurance expires (optional)</span><input id="cf-expires" type="date"></label>
    </div><div class="fs-foot cf-note">Adding a W-9 also marks it as on file.</div></div>
    <div class="btn-row"><button class="btn primary" data-act="contact-file-go" data-id="${esc(key(cid))}" data-capture="1">${icon('camera')}Camera</button><button class="btn" data-act="contact-file-go" data-id="${esc(key(cid))}">${icon('folder')}Choose File</button></div>`, (el) => {
    const t = $('#cf-type', el);
    const sync = () => { $('.cf-exp', el).classList.toggle('hidden', t.value !== 'insurance'); $('.cf-note', el).classList.toggle('hidden', t.value !== 'w9'); };
    t.addEventListener('change', sync);
    sync();
  });
}

function sheetTransaction(id) {
  const t = get(id);
  if (!t) return;
  const st = txnStatus(t);
  const p = t.projectID ? project(t.projectID) : null;
  const who = contactName(t.contactID) || t.payee || '';
  const kv = (l, v, cls = '') => `<div class="kv"><span>${esc(l)}</span><span class="${cls}">${esc(v)}</span></div>`;
  let body = '';
  body += kv('Date', fmt.date(fromSec(t.date)));
  if (t.dueDate != null && tracksBalance(t)) body += kv('Due', fmt.date(fromSec(t.dueDate)), txnOverdue(t) ? 'alert-text' : '');
  body += kv('Project', p ? projectName(p) : 'Company');
  if (who) body += kv(t.type === 'invoice' ? 'Customer' : 'Paid to', who);
  if (t.commitmentID && get(t.commitmentID)) body += kv('Against', commitmentTitle(get(t.commitmentID)));
  if (txnTags(t).length) body += `<div class="kv"><span>Tags</span>${tagChips(t)}</div>`;
  const lines = (t.lines || []).filter((l) => money(l.amount) || (l.memo || '').trim());
  let lineHtml = lines.map((l) => `<div class="kv"><span>${esc((l.memo || '').trim() || 'Line')}</span><span class="num">${esc(fmt.money(money(l.amount), true))}</span></div>`).join('');
  if (txnTax(t)) lineHtml += kv('Sales tax', fmt.money(txnTax(t), true));
  lineHtml += `<div class="kv"><span><b>Total</b></span><span class="total-v">${esc(fmt.money(txnTotal(t), true))}</span></div>`;
  if (txnRetainage(t)) lineHtml += kv('Retainage held', fmt.money(txnRetainage(t), true));
  if (tracksBalance(t)) { lineHtml += kv('Paid', fmt.money(txnPaid(t), true)); lineHtml += `<div class="kv"><span><b>Balance</b></span><span class="total-v">${esc(fmt.money(txnBalance(t), true))}</span></div>`; }
  const pays = vendorPayments(t).length ? vendorPayments(t) : (t.payments || []).map((x) => ({ date: x.date, amount: money(x.amount), method: x.method, reference: x.reference, waiver: x.waiver || {} }));
  const showWaivers = t.type === 'bill' || t.type === 'expense';
  const payHtml = (t.type === 'bill' || t.type === 'invoice') && pays.length ? pays.map((x) => `<div class="kv"><span>${esc([fmt.date(fromSec(x.date)), METHODS[x.method] || '', (x.reference || '').trim()].filter(Boolean).join(' · '))}${showWaivers ? `<br><span class="small muted">Lien waiver: ${esc(WAIVER[x.waiver.status || 'needed'])}</span>` : ''}</span><span class="num">${esc(fmt.money(x.amount, true))}</span></div>`).join('') : '';
  const files = all('file').filter((f) => sameId(f.transactionID, t.id));
  openSheet(`${sheetHead(txnLabel(t), who)}
    <div class="page-bar">${pill(TXN_STATUS[st][0], TXN_STATUS[st][1])}<span class="count small">Edit it in the Mac app</span></div>
    ${isPaired(t) ? banner('Also in your personal books: Eagle Creek Books recorded this as money between you and the business.', 'var(--slate)') : ''}
    <section class="card"><div style="margin:-4px 0">${body}</div></section>
    <section class="card"><div class="card-head"><h2>${icon('coins', 'ic head-ic')}Amounts</h2></div><div style="margin-top:-6px">${lineHtml}</div></section>
    ${payHtml ? `<section class="card"><div class="card-head"><h2>${icon('banknote', 'ic head-ic')}Payments</h2></div><div style="margin-top:-6px">${payHtml}</div></section>` : ''}
    ${files.length ? card(`Files (${files.length})`, files.map(contactFileRow).join('')) : ''}
    ${(t.memo || '').trim() ? card('Memo', `<div style="white-space:pre-wrap">${esc(t.memo)}</div>`, { flush: false }) : ''}
    ${onMacDesktop() ? `<div class="btn-row"><a class="btn link-out" href="${esc(`eaglecreek://transaction/${String(t.id).toUpperCase()}`)}">${icon('share')}Open in Eagle Creek</a><a class="btn link-out" href="${esc(booksAppLink('transaction', t.id))}">${icon('bookClosed')}Open in Eagle Creek Books</a></div>` : ''}`);
}

function sheetCommitment(id) {
  const c = get(id);
  if (!c) return;
  const p = c.projectID ? project(c.projectID) : null;
  const st = COMMITMENT_STATUS[c.status] || COMMITMENT_STATUS.draft;
  const tot = commitmentTotals(c);
  const billed = tot.bills;
  const kv = (l, v) => `<div class="kv"><span>${esc(l)}</span><span class="num">${esc(v)}</span></div>`;
  const lines = (c.lines || []).map((l) => kv((l.description || '').trim() || 'Line', fmt.money(l.amount, true))).join('');
  const changes = (c.changes || []).map((x) => kv(`${fmt.short(fromSec(x.date))} · ${(x.description || '').trim() || 'Change'}`, fmt.money(x.amount, true))).join('');
  const files = all('file').filter((f) => sameId(f.recordID, c.id));
  openSheet(`${sheetHead(commitmentTitle(c), [contactName(c.contactID), p ? projectName(p) : ''].filter(Boolean).join(' · '))}
    <div class="page-bar">${pill(st[0], st[1])}<span class="count small">Edit it in the Mac app</span></div>
    <section class="card"><div style="margin:-4px 0">
      ${kv((c.changes || []).length ? 'Amount with changes' : 'Amount', fmt.money(tot.revised, true))}
      ${kv('Billed so far', `${fmt.money(tot.billed, true)} (${plural(billed.length, 'bill')})`)}
      ${kv('Left to bill', fmt.money(tot.remaining, true))}
      ${kv('Paid', fmt.money(tot.paid, true))}
      ${tot.openBalance ? kv('You owe now', fmt.money(tot.openBalance, true)) : ''}
      ${c.retainagePct ? kv('Retainage', `${c.retainagePct}%${tot.retainageOutstanding ? ` · ${fmt.money(tot.retainageOutstanding, true)} held` : ''}`) : tot.retainageOutstanding ? kv('Retainage held', fmt.money(tot.retainageOutstanding, true)) : ''}
      ${c.startDate != null ? kv('Start', fmt.date(fromSec(c.startDate))) : ''}
      ${c.finishDate != null ? kv('Finish', fmt.date(fromSec(c.finishDate))) : ''}
    </div></section>
    ${lines ? card('Scope Lines', `<div style="padding:0 16px 6px">${lines}</div>`) : ''}
    ${changes ? card('Changes', `<div style="padding:0 16px 6px">${changes}</div>`) : ''}
    ${(c.scope || '').trim() ? card('Scope', `<div style="white-space:pre-wrap">${esc(c.scope)}</div>`, { flush: false }) : ''}
    ${files.length ? card(`Files (${files.length})`, files.map(contactFileRow).join('')) : ''}
    ${billed.length ? card('Bills Against It', billed.sort((a, b) => (b.date || 0) - (a.date || 0)).map(txnRow).join('')) : ''}`);
}

// ----- Actions

Object.assign(ACTIONS, {
  'contact-new': () => sheetContactEdit(null),
  'contact-edit': (el) => sheetContactEdit(el.dataset.id),
  'contact-type': (el) => {
    const f = $('#contact-form');
    f.elements.newType.value = el.dataset.type;
    $$('[data-act="contact-type"]', f).forEach((b) => b.classList.toggle('on', b === el));
    const trade = el.dataset.type === 'trade';
    f.elements.requiresLienWaivers.checked = trade;
    f.elements.is1099.checked = trade;
    f.dispatchEvent(new Event('contact-type'));
  },
  'contact-filter': (el) => { S.ui.contactKind = el.dataset.kind; render(); },
  'contact-all-txns': (el) => { S.ui.contactAllTxns = el.dataset.id; render(); },
  'contact-file-cat': (el) => { S.ui.contactFileCat = { ...(S.ui.contactFileCat || {}), [el.dataset.id]: el.dataset.cat }; render(); },
  'contact-add-file': (el) => sheetContactFile(el.dataset.id),
  'contact-file-go': (el) => {
    const type = $('#cf-type').value;
    const p = project($('#cf-project').value);
    const expires = parseInputDate($('#cf-expires')?.value || '');
    const c = get(el.dataset.id);
    closeSheet();
    const category = type === 'w9' ? 'taxForm' : type;
    pickFiles({ accept: el.dataset.capture ? 'image/*' : '', capture: !!el.dataset.capture, multiple: !el.dataset.capture }, async (files) => {
      const added = await addFiles(files, { projectID: p ? p.id : null, category, contactID: c.id });
      if (!added) return;
      // A W-9 marks it on file; an insurance certificate can carry its new expiry (as on the Mac).
      const current = clone(get(c.id));
      let changed = false;
      if (type === 'w9' && !current.w9OnFile) { current.w9OnFile = true; changed = true; }
      if (type === 'insurance' && expires) { current.insuranceExpires = toSec(localNoon(expires)); changed = true; }
      if (changed) { await saveRecord('contact', current); render(); }
    });
  },
  'txn-open': (el) => sheetTransaction(el.dataset.id),
  'commitment-open': (el) => sheetCommitment(el.dataset.id),
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.id !== 'contact-form') return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const name = form.elements.name.value.trim();
  if (!name) { form.elements.name.focus(); return; }
  const id = form.dataset.id;
  let c;
  if (id) {
    c = clone(get(id));
    c.kind = form.elements.kind.value;
  } else {
    const t = NEW_CONTACT_TYPES.find((x) => x[0] === form.elements.newType.value) || NEW_CONTACT_TYPES[0];
    c = { id: newId(), kind: t[2], name: '', contactName: '', trade: '', email: '', phone: '', address: '', paymentTermsDays: 0, is1099: false, w9OnFile: false, requiresLienWaivers: false, licenseNumber: '', notes: '', isArchived: false, payRate: 0, burdenPct: 0, billRate: 0 };
  }
  const val = (n) => (form.elements[n]?.value ?? '').trim();
  c.name = name;
  c.contactName = c.kind === 'employee' ? (c.contactName || '') : val('contactName');
  c.trade = val('trade');
  c.phone = val('phone');
  c.email = val('email');
  c.address = form.elements.address.value.trim();
  c.notes = form.elements.notes.value;
  if (c.kind === 'vendor') {
    c.requiresLienWaivers = form.elements.requiresLienWaivers.checked;
    c.is1099 = form.elements.is1099.checked;
    c.w9OnFile = form.elements.w9OnFile.checked;
    c.licenseNumber = val('licenseNumber');
    c.paymentTermsDays = Math.max(0, parseInt(val('paymentTermsDays'), 10) || 0);
    const ins = parseInputDate(val('insuranceExpires'));
    if (ins) c.insuranceExpires = toSec(localNoon(ins)); else delete c.insuranceExpires;
  }
  if (form.elements.isArchived) c.isArchived = form.elements.isArchived.checked;
  try {
    await saveRecord('contact', c);
    closeSheet();
    toast(id ? 'Saved' : `${name} added`);
    if (!id) location.hash = `#/contact/${key(c.id)}`;
  } catch (err) {
    toast(friendlyError(err));
  }
}, true);

document.addEventListener('input', (e) => {
  if (e.target.id !== 'contact-search') return;
  S.ui.contactSearch = e.target.value;
  $('#contact-results').innerHTML = contactResults();
});
