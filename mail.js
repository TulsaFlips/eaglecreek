/* Eagle Creek — emails saved from Gmail.
 *
 * gmail-bridge.gs runs in your Google account: label an email "Eagle Creek/<project>" or
 * "Eagle Creek/Business" in Gmail (or forward it to you+tag@gmail.com) and it's saved as a PDF
 * of the conversation, with its attachments beside it. Each is an ordinary file (category
 * "email", tagged Email so it stays an email even if an older Mac re-saves it as Other); its
 * attachments point back to it (recordID). The script also keeps a status record (mailBridge):
 * which Gmail, when it last looked, and the labels and forwarding tags it uses.
 */
'use strict';

// ----- The emails

const allEmails = () => all('file').filter(isEmailFile).sort((a, b) => (b.documentDate || b.addedAt || 0) - (a.documentDate || a.addedAt || 0));
const emailAttachments = (f) => filesFor('recordID', f.id).filter((x) => !isEmailFile(x));
const emailNoteLine = (f, label) => { const m = new RegExp(`^${label}: (.*)$`, 'm').exec(f.notes || ''); return m ? m[1].replace(/"([^"]*)"\s*</g, '$1 <').trim() : ''; };
const gmailLink = (f) => { const u = emailNoteLine(f, 'Gmail'); return /^https:\/\/mail\.google\.com\//.test(u) ? u : ''; };
/** The message text kept in the notes (after the header lines), for a preview and for searching. */
const emailText = (f) => { const n = String(f.notes || ''); const i = n.indexOf('\n\n'); return i >= 0 ? n.slice(i + 2).trim() : ''; };
const emailWho = (f) => (f.vendor || '').trim() || emailNoteLine(f, 'From') || 'Unknown sender';
const emailSubject = (f) => (f.title || '').trim() || (f.originalFileName || '').replace(/\.pdf$/i, '') || '(no subject)';

function emailsForContact(c) {
  const address = (c.email || '').trim().toLowerCase();
  return allEmails().filter((f) => sameId(f.contactID, c.id) || (address && String(f.notes || '').toLowerCase().split('\n\n')[0].includes(address)));
}

function emailMatches(f, q) {
  if (!q) return true;
  const p = f.projectID ? project(f.projectID) : null;
  return [emailSubject(f), emailWho(f), f.notes, p ? projectName(p) : 'business'].some((x) => String(x || '').toLowerCase().includes(q));
}

function emailRow(f, { showProject = false } = {}) {
  const p = f.projectID ? project(f.projectID) : null;
  const n = emailAttachments(f).length;
  const sub = [emailWho(f), fmt.date(fileDate(f)), showProject ? (p ? projectName(p) : 'Business') : ''].filter(Boolean).join(' · ');
  const snippet = emailText(f).replace(/\s+/g, ' ').slice(0, 140);
  return `<button class="row" data-act="email-open" data-id="${esc(key(f.id))}">${icon('mail', 'ic glyph', '--tint:var(--slate)')}
    <div class="main"><div class="t">${esc(emailSubject(f))}</div><div class="s">${esc(sub)}</div>${snippet ? `<div class="s email-snip">${esc(snippet)}</div>` : ''}</div>
    ${n ? `<span class="end email-att">${icon('paperclip', 'ic', 'width:15px;height:15px')}${n}</span>` : ''}${icon('chev', 'ic chev')}</button>`;
}

// ----- The Gmail side: status, labels and forwarding addresses

const mailBridge = () => all('mailBridge').slice().sort((a, b) => (b.lastRun || 0) - (a.lastRun || 0))[0] || null;
/** you+tag@gmail.com addresses that file into a project (or, with null, the business archive). */
function forwardAddresses(projectID) {
  const b = mailBridge();
  if (!b?.gmail || !b.tags) return [];
  const at = b.gmail.indexOf('@');
  if (at < 1) return [];
  return Object.entries(b.tags).filter(([, id]) => (projectID ? sameId(id, projectID) : !id))
    .sort(([a], [c]) => (/^\d+$/.test(a) ? -1 : 0) - (/^\d+$/.test(c) ? -1 : 0) || a.length - c.length)
    .map(([tag]) => `${b.gmail.slice(0, at)}+${tag}${b.gmail.slice(at)}`);
}
/** The Gmail label that files into a project (or the business archive). */
function mailLabel(projectID) {
  if (!projectID) return 'Eagle Creek/Business';
  const b = mailBridge();
  const names = Object.entries(b?.labels || {}).filter(([, id]) => sameId(id, projectID)).map(([n]) => n);
  const p = project(projectID);
  const current = p ? `Eagle Creek/${projectName(p).replace(/\//g, '-')}` : '';
  return names.find((n) => n === current) || names[names.length - 1] || current;
}

/** How to save an email here: the label to use, and the address to forward to. */
function howToSave(projectID) {
  const b = mailBridge();
  if (!b) {
    return `<div class="banner" style="--c:var(--slate)">${icon('mail')}<div>Save emails here straight from Gmail: label one in Gmail, or forward it, and it shows up within a few minutes. ${isWide() ? '' : 'Set it up once from a computer: '}<a href="#/settings" data-act="mail-setup">Settings › Save Emails</a>.</div></div>`;
  }
  const label = mailLabel(projectID);
  const addr = forwardAddresses(projectID)[0];
  return `<section class="card how-save"><div class="hs-line">${icon('tag', 'ic', 'color:var(--gold)')}<div>In Gmail, label it <b>${esc(label)}</b></div></div>
    ${addr ? `<div class="hs-line">${icon('share', 'ic', 'color:var(--gold)')}<div>Or forward it to <b class="addr">${esc(addr)}</b></div><button class="btn sm" data-act="copy-text" data-text="${esc(addr)}" aria-label="Copy address">${icon('copy')}</button></div>` : ''}</section>`;
}

// ----- Pages

/** A project's Files › Emails. */
function projectEmails(p) {
  const list = allEmails().filter((f) => sameId(f.projectID, p.id));
  let html = howToSave(p.id);
  if (!list.length) return html + emptyState('mail', 'No Emails Yet', 'Emails about this job (from the client, trades, the city, the lender) are kept here as PDFs, with their attachments.');
  const q = (S.ui.mailSearch?.[key(p.id)] || '').trim().toLowerCase();
  if (list.length > 5) html += `<div class="search">${icon('search')}<input class="input" id="mail-search" data-scope="${esc(key(p.id))}" type="search" placeholder="Subject, sender or words in it" value="${esc(S.ui.mailSearch?.[key(p.id)] || '')}" autocomplete="off"></div>`;
  return html + `<div id="mail-results">${mailResults(list, q, false)}</div>`;
}

function mailResults(list, q, showProject) {
  const shown = list.filter((f) => emailMatches(f, q));
  if (!shown.length) return emptyState('search', 'Nothing Matches', 'Try a different word, or the sender’s name.');
  const months = new Map();
  for (const f of shown.slice(0, 300)) { const k = fmt.month(fileDate(f)); if (!months.has(k)) months.set(k, []); months.get(k).push(f); }
  let html = `<p class="note" style="margin:-4px 4px 10px">${esc(plural(shown.length, 'email'))}</p>`;
  for (const [m, arr] of months) html += `<div class="day-label">${esc(m)}</div><section class="card flush">${arr.map((f) => emailRow(f, { showProject })).join('')}</section>`;
  return html;
}

/** The business email archive (and every saved email). */
function viewMail(page) {
  setHeader({ title: 'Email Archive', back: isWide() ? null : '#/projects' });
  if (!['business', 'all'].includes(page)) page = 'business';
  const nav = `<nav class="seg" aria-label="Emails">${[['business', 'Business', 'briefcase'], ['all', 'All Emails', 'mail']].map(([k, l, ic]) => `<a href="#/mail/${k}" class="${k === page ? 'on' : ''}">${segIcon(ic)}${l}</a>`).join('')}</nav>`;
  const list = allEmails().filter((f) => page === 'all' || !f.projectID);
  let html = nav + howToSave(null);
  if (page === 'all') html = nav;
  if (!list.length) {
    return html + emptyState('mail', page === 'business' ? 'No Business Emails Yet' : 'No Saved Emails Yet',
      page === 'business' ? 'Keep the emails that matter to the LLC here: the bank, the accountant, insurance, the state, lenders and partners.' : 'Emails saved to projects and to the business archive all show here.');
  }
  const q = (S.ui.mailSearch?.[page] || '').trim().toLowerCase();
  html += `<div class="search">${icon('search')}<input class="input" id="mail-search" data-scope="${page}" type="search" placeholder="Subject, sender, project or words in it" value="${esc(S.ui.mailSearch?.[page] || '')}" autocomplete="off"></div>`;
  return html + `<div id="mail-results">${mailResults(list, q, page === 'all')}</div>`;
}

// ----- One email

function sheetEmail(id) {
  const f = get(id);
  if (!f) return;
  const p = f.projectID ? project(f.projectID) : null;
  const atts = emailAttachments(f);
  const link = gmailLink(f);
  const kv = (l, v) => (v ? `<div class="kv"><span>${esc(l)}</span><span>${esc(v)}</span></div>` : '');
  const text = emailText(f);
  const jobs = projects().filter((x) => statusGroup(x.status) !== 'closed' || sameId(x.id, f.projectID)).sort((a, b) => projectName(a).localeCompare(projectName(b)));
  openSheet(`${sheetHead(emailSubject(f), emailWho(f))}
    <div class="btn-row" style="margin-bottom:12px"><button class="btn primary" data-act="open-file" data-id="${esc(key(f.id))}">${icon('doc')}Open Email</button>${link ? `<a class="btn" href="${esc(link)}" target="_blank" rel="noopener">${icon('mail')}Open in Gmail</a>` : ''}</div>
    <section class="card"><div style="margin:-4px 0">
      ${kv('From', emailNoteLine(f, 'From') || emailWho(f))}${kv('To', emailNoteLine(f, 'To'))}${kv('Date', emailNoteLine(f, 'Date') || fmt.date(fileDate(f)))}
      ${kv('Filed in', p ? projectName(p) : 'Business email archive')}${f.contactID && get(f.contactID) ? kv('Contact', contactName(f.contactID)) : ''}
    </div></section>
    ${atts.length ? card(`Attachments (${atts.length})`, atts.map(contactFileRow).join('')) : ''}
    ${text ? card('Latest Message', `<div class="email-text">${esc(text)}</div>`, { flush: false, icon: 'message' }) : ''}
    <div class="form-section"><div class="fs-head">${fsTitle('folder', 'Move to')}</div><div class="form-card">
      <label class="field"><span class="sr">File it in</span><select id="email-move" data-id="${esc(key(f.id))}"><option value="">Business email archive</option>${jobs.map((x) => `<option value="${esc(x.id)}" ${sameId(x.id, f.projectID) ? 'selected' : ''}>${esc(projectName(x))}</option>`).join('')}</select></label>
    </div><div class="fs-foot">Its attachments move with it.</div></div>`);
}

async function moveEmail(id, projectID) {
  const f = get(id);
  if (!f) return;
  const target = projectID ? project(projectID) : null;
  for (const x of [f, ...emailAttachments(f)]) {
    const c = clone(x);
    if (target) c.projectID = target.id; else delete c.projectID;
    // Photos leaving a job become Other, as on the Mac.
    if (!target && PHOTO_CATEGORIES.has(c.category)) c.category = 'other';
    await saveRecord('file', c);
  }
  toast(target ? `Moved to ${projectName(target)}` : 'Moved to the business archive');
  renderSoon();
}

// ----- Settings › Save Emails

function mailSettingsCard() {
  const b = mailBridge();
  const steps = `<ol class="steps">
      <li>On a computer, tap <b>Copy Setup Script</b> (your Supabase address and key are filled in).</li>
      <li>Go to <a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener">script.google.com</a>, signed in to the business Gmail. Paste over what's there and save.</li>
      <li>Project Settings (gear) › Script Properties: add <b>EC_PASSWORD</b> with your Eagle Creek password.</li>
      <li>Back in the editor, choose <b>setup</b> and click <b>Run</b>, then Allow. It checks Gmail every 5 minutes from then on.</li>
    </ol>`;
  let body = '';
  if (b) {
    const ago = fmt.ago(b.lastRun);
    body += `<div class="kv"><span>Gmail</span><span>${esc(b.gmail || '')}</span></div>
      <div class="kv"><span>Last checked</span><span>${esc(ago)}</span></div>
      <div class="kv"><span>Saved so far</span><span>${esc(plural(Number(b.savedCount) || 0, 'email'))}</span></div>`;
    if (b.lastError && (!b.lastErrorAt || Date.now() / 1000 - b.lastErrorAt < 3 * 86400)) body += banner(`The last one it couldn't save: ${b.lastError}. It's labelled Eagle Creek/Not Saved in Gmail; label it again to retry.`);
    if (b.lastRun && Date.now() / 1000 - b.lastRun > 3 * 3600) body += banner("It hasn't checked in for a few hours. Open the script at script.google.com and look at Executions, or run setup again.");
    body += `<p class="note">Label an email <b>Eagle Creek/Business</b> or <b>Eagle Creek/</b>a project in Gmail, or forward it to ${esc(forwardAddresses(null)[0] || 'your +business address')}. Each project's address is on its Files › Emails page.</p>`;
    body += `<details class="help"><summary>Set it up again</summary>${steps}</details>`;
  } else {
    body += `<p style="margin:0 0 8px;font-size:15px">Label an email in Gmail (on your phone or computer) and it's saved to that project's Files, or to the business email archive, as a PDF with its attachments. Forwarding from other inboxes works too.</p>${steps}`;
  }
  body += `<div class="btn-row wrap" style="margin-top:8px"><button class="btn primary" data-act="copy-mail-script">${icon('copy')}Copy Setup Script</button><a class="btn" href="#/mail">${icon('mail')}Email Archive</a></div>`;
  return `<div id="mail-settings" style="scroll-margin-top:72px">${card('Save Emails from Gmail', `<div style="padding:0 16px 14px">${body}</div>`, { icon: 'mail' })}</div>`;
}

async function copyMailScript() {
  let text = '';
  try {
    const res = await fetch('gmail-bridge.gs', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    text = await res.text();
  } catch {
    toast("Couldn't get the script. Check the connection and try again.");
    return;
  }
  const js = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  text = text.replace("'__SUPABASE_URL__'", `'${js((S.config?.url || '').trim().replace(/\/+$/, ''))}'`)
    .replace("'__SUPABASE_KEY__'", `'${js((S.config?.key || '').trim())}'`)
    .replace("'__EMAIL__'", `'${js(S.session?.email || '')}'`);
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied. Paste it into a new project at script.google.com.');
  } catch {
    // No clipboard (an older browser): save it as a file instead.
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'Eagle Creek Email.gs';
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('Saved as a file. Open it, copy everything, and paste it at script.google.com.');
  }
}

// ----- Wiring

Object.assign(PROJECT_PAGES, { emails: ['Emails', (p) => projectEmails(p)] });

Object.assign(ACTIONS, {
  'email-open': (el) => sheetEmail(el.dataset.id),
  'copy-mail-script': () => copyMailScript(),
  'copy-text': async (el) => {
    try { await navigator.clipboard.writeText(el.dataset.text || ''); toast('Copied'); } catch { prompt('Copy this:', el.dataset.text || ''); }
  },
  'mail-setup': () => {
    closeSheet();
    location.hash = '#/settings';
    setTimeout(() => $('#mail-settings')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 150);
  },
});

document.addEventListener('input', (e) => {
  if (e.target.id !== 'mail-search') return;
  const scope = e.target.dataset.scope;
  S.ui.mailSearch = { ...(S.ui.mailSearch || {}), [scope]: e.target.value };
  const q = e.target.value.trim().toLowerCase();
  const r = route();
  const list = r.name === 'mail' ? allEmails().filter((f) => scope === 'all' || !f.projectID) : allEmails().filter((f) => sameId(f.projectID, scope));
  $('#mail-results').innerHTML = mailResults(list, q, r.name === 'mail' && scope === 'all');
});

document.addEventListener('change', (e) => {
  if (e.target.id !== 'email-move') return;
  const f = get(e.target.dataset.id);
  if (!f || (e.target.value || '') === (f.projectID ? key(f.projectID) : '') || sameId(e.target.value, f.projectID)) return;
  closeSheet();
  moveEmail(f.id, e.target.value || null);
});
