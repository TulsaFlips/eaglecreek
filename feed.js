/* Eagle Creek — the bank feed on the phone.
 *
 * Eagle Creek Books (Mac) brings bank and card lines in (Plaid, or statement files) and keeps
 * them in its own table, `ledger_documents`. This reads the business's lines waiting For Review
 * and lets you decide them from the phone the way Books does: match the entry already in the
 * books, add it as an expense or deposit on a project, or leave it out. Ids and fields are the
 * Mac's (FeedEngine.swift), so Books shows the decision, can undo it, and never doubles it.
 */
'use strict';

const EAGLE_CREEK_ENTITY = stableID('eaglecreek.entity.business');
const FEED_WINDOW_DAYS = 5;

const feedLineName = (l) => (l.merchantName || '').trim() || (l.name || '').trim() || l.originalDescription || '(no description)';
const feedKey = (l) => `${key(l.id)}:${key(l.entityID)}`;
/** The business's bank lines, newest first. */
function feedLines(status = null) {
  return all('feedLine')
    .filter((l) => sameId(l.entityID, EAGLE_CREEK_ENTITY) && !l.isRemoved && (status ? l.status === status : true))
    .sort((a, b) => (b.date || 0) - (a.date || 0) || String(a.id).localeCompare(String(b.id)));
}
const feedReviewCount = () => feedLines('review').length;

/** The statement side of a posting, as Books refers to it (ClearingRef). */
function clearingRefFor(posting, t) {
  if (posting.paymentID) return { transactionID: t.id, paymentID: posting.paymentID, transferTo: false };
  if (t.type === 'transfer' && sameId(posting.accountID, t.toAccountID) && !sameId(t.toAccountID, t.accountID)) return { transactionID: t.id, paymentID: null, transferTo: true };
  return { transactionID: t.id, paymentID: null, transferTo: false };
}
const sameRef = (a, b) => sameId(a.transactionID, b.transactionID) && sameId(a.paymentID || '', b.paymentID || '') && !!a.transferTo === !!b.transferTo;
function refCleared(ref, t) {
  if (ref.paymentID) return !!(t.payments || []).find((p) => sameId(p.id, ref.paymentID))?.isCleared;
  return ref.transferTo ? !!t.toCleared : !!t.isCleared;
}
function refReconciled(ref, t) {
  if (ref.paymentID) return (t.payments || []).find((p) => sameId(p.id, ref.paymentID))?.reconciledAt != null;
  return ref.transferTo ? t.toReconciledAt != null : t.reconciledAt != null;
}

/** Statement sides already claimed by a decided line. */
function feedUsedRefs() {
  const used = [];
  for (const l of all('feedLine')) if ((l.status === 'added' || l.status === 'matched') && !l.isRemoved) used.push(...(l.clearing || []));
  return used;
}

/** Entries already in the books this line could be (the Mac's FeedEngine.matches, first part). */
function feedMatches(line) {
  const d = booksData();
  const used = feedUsedRefs();
  const day = sod(fromSec(line.date));
  const out = [];
  for (const posting of d.postings) {
    if (!sameId(posting.accountID, line.accountID) || posting.isOpeningBalance) continue;
    if (Math.abs(posting.amount - line.amount) >= 0.005) continue;
    const t = get(posting.transactionID);
    if (!t) continue;
    const ref = clearingRefFor(posting, t);
    if (used.some((u) => sameRef(u, ref))) continue;
    const days = Math.abs(Math.round((sod(fromSec(posting.date)) - day) / 86_400_000));
    const check = (line.checkNumber || '').replace(/^0+/, '');
    const numberMatches = check && posting.number && String(posting.number).replace(/^0+/, '') === check;
    if (days > FEED_WINDOW_DAYS && !(numberMatches && days <= 120)) continue;
    let score = 10 - days;
    if (numberMatches) score += 6;
    if (posting.isCleared) score -= 4;
    const payee = d.payeeName(t) || posting.payee || '';
    if (payee && payee.toLowerCase() === feedLineName(line).toLowerCase()) score += 2;
    out.push({ ref, t, posting, score, days, payee, alreadyCleared: refCleared(ref, t) });
  }
  return out.sort((a, b) => b.score - a.score || b.posting.date - a.posting.date);
}

/** What this payee was categorized as last time (the Mac's "learns from last time"). */
function feedGuess(line) {
  const d = booksData();
  const name = feedLineName(line).toLowerCase();
  const previous = d.transactions
    .filter((t) => !t.isVoid && (t.type === 'expense' || t.type === 'deposit') && (d.payeeName(t) || '').toLowerCase() === name && (t.lines || []).length === 1 && t.lines[0].accountID)
    .sort((a, b) => (b.date || 0) - (a.date || 0))[0];
  return previous ? { accountID: previous.lines[0].accountID, projectID: previous.projectID || null, contactID: previous.contactID || null } : null;
}

const feedMethod = (line) => (booksData().account(line.accountID)?.type === 'creditCard' ? 'card' : (line.checkNumber ? 'check' : 'ach'));

// ----- Deciding

Object.assign(RECORD_OPS, {
  // Marks one statement side as on the statement (or not), the way Books does on a match.
  setCleared(t, { ref, cleared }) {
    if (ref.paymentID) { const p = (t.payments || []).find((x) => sameId(x.id, ref.paymentID)); if (p) p.isCleared = !!cleared; }
    else if (ref.transferTo) t.toCleared = !!cleared;
    else t.isCleared = !!cleared;
  },
});

async function feedDecide(line, patch) {
  const now = stamp();
  const next = { ...clone(line), ...patch, decidedAt: patch.status === 'review' ? null : now, updatedAt: now };
  if (patch.status === 'review') { next.transactionIDs = []; next.clearing = []; next.alreadyCleared = []; next.pairedLineID = null; next.ruleID = null; next.decidedAt = null; }
  await saveRecord('feedLine', next);
  return next;
}

/** Adds the line to the books as an expense or deposit (one line, one project), like FeedEngine.add. */
async function feedAdd(line, { accountID, projectID, payee, memo, contactID }) {
  const d = booksData();
  if (booksClosedOn(line.date)) { toast(closedMessage()); return false; }
  const amount = money(Math.abs(line.amount));
  if (amount < 0.005) { toast('This line has no amount.'); return false; }
  const moneyIn = line.amount > 0;
  const category = d.account(accountID);
  if (category && isMoneyAccountType(category.type)) { toast('Transfers between accounts are recorded in Eagle Creek Books.'); return false; }
  const t = newExpenseShell(stableID(`${key(line.id)}:add`));
  t.type = moneyIn ? 'deposit' : 'expense';
  t.date = line.date;
  t.accountID = line.accountID;
  t.method = feedMethod(line);
  t.number = line.checkNumber || '';
  if (contactID) t.contactID = contactID; else delete t.contactID;
  t.payee = contactID ? '' : ((payee || '').trim() || feedLineName(line));
  if (projectID) t.projectID = projectID; else delete t.projectID;
  t.memo = (memo || '').trim() || feedLineName(line);
  t.isCleared = true;
  t.lines = [{ id: newId(), accountID: accountID || (moneyIn ? d.sys.uncategorizedIncome : d.sys.uncategorizedExpense), memo: feedLineName(line), quantity: 1, rate: amount, amount, taxable: true, isDepositCredit: false }];
  const vendor = contactID ? get(contactID) : null;
  t.waiver = { status: vendor?.requiresLienWaivers && !moneyIn ? 'needed' : 'notRequired', scope: 'progress' };
  await saveRecord('transaction', t);
  await feedDecide(line, { status: 'added', transactionIDs: [t.id], clearing: [{ transactionID: t.id, paymentID: null, transferTo: false }], alreadyCleared: [] });
  return true;
}

/** Ties the line to an entry already in the books and marks that entry cleared. */
async function feedMatch(line, match) {
  const already = refCleared(match.ref, match.t);
  if (!already) await editRecord('transaction', match.t.id, [{ op: 'setCleared', ref: match.ref, cleared: true }]);
  await feedDecide(line, { status: 'matched', transactionIDs: [match.t.id], clearing: [match.ref], alreadyCleared: already ? [match.ref] : [] });
  return true;
}

async function feedExclude(line) {
  await feedDecide(line, { status: 'excluded', transactionIDs: [], clearing: [], alreadyCleared: [] });
  return true;
}

/** Sends a decided line back to For Review (what the phone made comes out; a match is unmarked). */
async function feedUndo(line) {
  if (line.status === 'added') {
    for (const id of line.transactionIDs || []) {
      const t = get(id);
      if (!t) continue;
      if (!sameId(id, stableID(`${key(line.id)}:add`))) { toast('This line was recorded on the Mac with more than one entry. Undo it in Eagle Creek Books.'); return false; }
      if (isReconciled(t)) { toast(reconciledMessage()); return false; }
      if (booksClosedOn(t.date)) { toast(closedMessage()); return false; }
      await deleteRecord('transaction', id);
    }
  } else if (line.status === 'matched') {
    for (const ref of line.clearing || []) {
      const t = get(ref.transactionID);
      if (!t) continue;
      if (refReconciled(ref, t)) { toast(reconciledMessage()); return false; }
      if ((line.alreadyCleared || []).some((a) => sameRef(a, ref))) continue;
      await editRecord('transaction', t.id, [{ op: 'setCleared', ref, cleared: false }]);
    }
  }
  await feedDecide(line, { status: 'review' });
  return true;
}

// ----- Screens

function bankFeedPage() {
  if (S.ledgerUnavailable) return emptyState('bank', 'No Bank Feed Here Yet', 'Run supabase/setup.sql (v1.3 or later) in the Supabase SQL Editor, and connect a bank in Eagle Creek Books.');
  const d = booksData();
  const review = feedLines('review');
  const decided = feedLines().filter((l) => l.status !== 'review' && l.decidedAt && Date.now() / 1000 - l.decidedAt < 7 * 86_400).slice(0, 30);
  let html = '';
  if (!all('feedLine').length) {
    html += emptyState('bank', 'No Bank Lines Yet', 'Connect a bank (or import a statement file) in Eagle Creek Books. Its lines show here to review from your phone.');
    return html;
  }
  const byAccount = new Map();
  for (const l of review) { const k = key(l.accountID); if (!byAccount.has(k)) byAccount.set(k, []); byAccount.get(k).push(l); }
  if (!review.length) html += allClear('Nothing to review. Every bank line is in the books.');
  for (const [accountID, lines] of byAccount) {
    html += card(`${d.accountName(accountID)} · ${plural(lines.length, 'line')}`, lines.map((l) => feedRow(l)).join(''), { icon: 'bank' });
  }
  if (decided.length) {
    html += card('Decided This Week', decided.map((l) => feedRow(l, true)).join(''), { icon: 'checkCircle' });
  }
  return html;
}

function feedRow(l, done = false) {
  const d = booksData();
  const status = { added: 'Added', matched: 'Matched', excluded: 'Left out', review: '' }[l.status] || '';
  const what = done && l.status !== 'excluded' ? (l.transactionIDs || []).map((id) => get(id)).filter(Boolean).map((t) => `${TXN_TYPES[t.type] || t.type} · ${d.accountName((t.lines || [])[0]?.accountID)}`).join(', ') : '';
  return `<a class="row" href="#/books/bank/${esc(key(l.id))}">${icon(l.amount > 0 ? 'inbox' : 'card', 'ic glyph', `--tint:${l.amount > 0 ? 'var(--success)' : 'var(--slate)'}`)}<div class="main"><div class="t">${esc(feedLineName(l))}</div><div class="s">${esc([fmt.short(fromSec(l.date)), done ? status : d.accountName(l.accountID), what].filter(Boolean).join(' · '))}</div></div><div class="end"><span class="amt" style="${l.amount > 0 ? 'color:var(--success)' : ''}">${esc(fmt.money(Math.abs(l.amount), true))}</span></div>${icon('chev', 'ic chev')}</a>`;
}

function viewFeedLine(id) {
  const l = all('feedLine').find((x) => sameId(x.id, id));
  setHeader({ title: 'Bank Line', back: '#/books/bank' });
  if (!l) return emptyState('bank', 'Gone', 'This line is no longer in the feed.');
  const d = booksData();
  const matches = l.status === 'review' ? feedMatches(l) : [];
  const guess = feedGuess(l);
  const moneyIn = l.amount > 0;
  const cats = d.sorted.filter((a) => !a.isArchived && (moneyIn ? ['income', 'otherIncome', 'otherAsset', 'loan', 'otherLiability', 'equity'].includes(a.type) : ['expense', 'jobCost', 'otherExpense', 'otherAsset', 'loan', 'otherLiability', 'equity'].includes(a.type)) && !a.systemRole);
  const jobs = projects().filter((p) => statusGroup(p.status) !== 'closed').sort((a, b) => projectName(a).localeCompare(projectName(b)));
  const people = contacts().filter((c) => (moneyIn ? c.kind === 'customer' : c.kind !== 'customer'));
  let html = `<section class="card"><div class="card-head"><h2>${icon(moneyIn ? 'inbox' : 'card', 'ic head-ic')}${esc(feedLineName(l))}</h2></div>
    <div class="kv" style="padding-top:0"><span>Amount</span><span style="font-weight:600${moneyIn ? ';color:var(--success)' : ''}">${esc(fmt.money(Math.abs(l.amount), true))} ${moneyIn ? 'in' : 'out'}</span></div>
    <div class="kv"><span>Date</span><span>${esc(fmt.date(fromSec(l.date)))}</span></div>
    <div class="kv"><span>Account</span><span>${esc(d.accountName(l.accountID))}</span></div>
    ${l.originalDescription && l.originalDescription !== feedLineName(l) ? `<div class="kv"><span>Bank said</span><span>${esc(l.originalDescription)}</span></div>` : ''}
    ${l.checkNumber ? `<div class="kv"><span>Check</span><span>#${esc(l.checkNumber)}</span></div>` : ''}
    ${l.note ? `<div class="fs-foot">${esc(l.note)}</div>` : ''}</section>`;
  if (l.status !== 'review') {
    const entries = (l.transactionIDs || []).map((x) => get(x)).filter(Boolean);
    html += card(l.status === 'excluded' ? 'Left Out of the Books' : (l.status === 'matched' ? 'Matched' : 'Added'),
      (entries.length ? entries.map((t) => `<button class="row" data-act="txn-open" data-id="${esc(key(t.id))}"><div class="main"><div class="t">${esc(`${TXN_TYPES[t.type] || t.type} · ${d.payeeName(t) || 'No name'}`)}</div><div class="s">${esc([fmt.short(fromSec(t.date)), d.accountName((t.lines || [])[0]?.accountID), t.projectID ? projectName(project(t.projectID)) : ''].filter(Boolean).join(' · '))}</div></div><div class="end"><span class="amt">${esc(fmt.money(txnTotal(t), true))}</span></div></button>`).join('') : `<div class="empty-line">${l.status === 'excluded' ? 'Not part of the books (a personal charge, a duplicate).' : 'The entry is no longer in the books.'}</div>`)
        + `<div class="btn-row" style="padding:12px 16px"><button type="button" class="btn" data-act="feed-undo" data-id="${esc(key(l.id))}">${icon('back')}Undo · back to For Review</button></div>`, { icon: false });
    return html;
  }
  if (booksClosedOn(l.date)) html += banner(`${closedMessage()} This line can still be matched or left out.`);
  if (matches.length) {
    html += card('Already in the Books?', matches.slice(0, 4).map((m, i) => `<label class="row" style="cursor:pointer"><input type="radio" name="feed-match" value="${i}" ${i === 0 ? 'checked' : ''} style="margin-right:10px"><div class="main"><div class="t">${esc(`${TXN_TYPES[m.t.type] || m.t.type}${m.posting.number ? ` #${m.posting.number}` : ''} · ${m.payee || 'No name'}`)}</div><div class="s">${esc([fmt.short(fromSec(m.posting.date)), m.alreadyCleared ? 'Already marked cleared' : '', m.t.projectID ? projectName(project(m.t.projectID)) : ''].filter(Boolean).join(' · '))}</div></div><div class="end"><span class="amt">${esc(fmt.money(Math.abs(m.posting.amount), true))}</span></div></label>`).join('')
      + `<div class="btn-row" style="padding:12px 16px"><button type="button" class="btn primary" data-act="feed-match" data-id="${esc(key(l.id))}">${icon('checkCircle')}Match</button></div>`, { icon: 'checkCircle' });
  }
  html += `<form id="feed-form" data-id="${esc(key(l.id))}"><div class="form-section"><div class="fs-head">${matches.length ? 'Or add it as new' : (moneyIn ? 'Add as a deposit' : 'Add as an expense')}</div><div class="form-card">
      <label class="field"><span>${moneyIn ? 'From' : 'Paid to'}</span><select name="contactID"><option value="">${esc(feedLineName(l))} (as typed)</option>${people.map((c) => `<option value="${esc(c.id)}" ${guess?.contactID && sameId(c.id, guess.contactID) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Category</span><select name="accountID"><option value="">Uncategorized</option>${cats.map((a) => `<option value="${esc(a.id)}" ${guess?.accountID && sameId(a.id, guess.accountID) ? 'selected' : ''}>${esc(accountDisplayName(a))}</option>`).join('')}</select></label>
      <label class="field"><span>Project</span><select name="projectID"><option value="">Company (no project)</option>${jobs.map((p) => `<option value="${esc(p.id)}" ${guess?.projectID && sameId(p.id, guess.projectID) ? 'selected' : ''}>${esc(projectName(p))}</option>`).join('')}</select></label>
      <label class="field"><span>Memo</span><input name="memo" value="" placeholder="${esc(feedLineName(l))}" autocomplete="off"></label>
    </div>${guess ? `<div class="fs-foot">Filled in from last time (${esc(d.accountName(guess.accountID))}${guess.projectID ? ` · ${esc(projectName(project(guess.projectID)))}` : ''}). Splits across projects are done in Eagle Creek Books.</div>` : '<div class="fs-foot">Splits across projects and transfers between accounts are done in Eagle Creek Books.</div>'}</div>
    <div class="sheet-actions" style="padding:0 16px 16px"><button type="button" class="btn" data-act="feed-exclude" data-id="${esc(key(l.id))}">Leave Out</button><button type="submit" class="btn primary" ${booksClosedOn(l.date) ? 'disabled' : ''}>${moneyIn ? 'Add Deposit' : 'Add Expense'}</button></div></form>`;
  return html;
}

Object.assign(ACTIONS, {
  'feed-match': async (el) => {
    const l = all('feedLine').find((x) => sameId(x.id, el.dataset.id));
    if (!l) return;
    const matches = feedMatches(l);
    const picked = Number($('input[name=feed-match]:checked')?.value ?? 0);
    const m = matches[picked];
    if (!m) { toast('That entry is no longer there.'); render(); return; }
    if (await feedMatch(l, m)) { toast('Matched'); location.hash = '#/books/bank'; }
  },
  'feed-exclude': async (el) => {
    const l = all('feedLine').find((x) => sameId(x.id, el.dataset.id));
    if (!l) return;
    if (!confirm('Leave this line out of the books? (A personal charge, or a duplicate.) You can undo it.')) return;
    if (await feedExclude(l)) { toast('Left out'); location.hash = '#/books/bank'; }
  },
  'feed-undo': async (el) => {
    const l = all('feedLine').find((x) => sameId(x.id, el.dataset.id));
    if (!l) return;
    if (await feedUndo(l)) { toast('Back in For Review'); render(); }
  },
});

document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (f.id !== 'feed-form') return;
  e.preventDefault();
  const l = all('feedLine').find((x) => sameId(x.id, f.dataset.id));
  if (!l) return;
  const v = (n) => (f.elements[n]?.value ?? '').trim();
  const btn = $('button[type=submit]', f);
  btn.disabled = true;
  const ok = await feedAdd(l, { accountID: v('accountID') || null, projectID: v('projectID') || null, contactID: v('contactID') || null, memo: v('memo') }).catch((err) => { console.error(err); toast(friendlyError(err)); return false; });
  if (!ok) { btn.disabled = false; return; }
  toast(l.amount > 0 ? 'Deposit added' : 'Expense added');
  location.hash = '#/books/bank';
});
