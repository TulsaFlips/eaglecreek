/**
 * Eagle Creek — save emails from Gmail to your projects and your business email archive.
 *
 * How it works, once it's set up:
 *   • In Gmail (the phone app or the website), label an email:
 *       Eagle Creek/Business          → the business email archive
 *       Eagle Creek/<project name>    → that project's Files › Emails
 *     The project labels are made for you and kept up to date from Eagle Creek.
 *   • Or forward an email from any other inbox to your Gmail address with a tag:
 *       you+business@gmail.com, you+104@gmail.com (a job number) or you+77birchflip@gmail.com
 *     Each project's Files › Emails page in the Eagle Creek app shows its label and address.
 *   • Every few minutes this script saves each one as a PDF (who, when, the whole conversation),
 *     with its attachments as files beside it, then moves the email to Eagle Creek/Saved.
 *
 * It runs in your own Google account and signs in to Supabase as you (the anon or publishable
 * key, never the secret key). Your emails go from Gmail straight to your Supabase project.
 *
 * Setup (about 10 minutes, on a computer):
 *   1. In the Eagle Creek app: Settings › Save Emails from Gmail › Copy Setup Script. (Or paste this
 *      file and fill in CONFIG below by hand.)
 *   2. Go to script.google.com, signed in to the Gmail account you use for the business.
 *      New project, name it "Eagle Creek Email", delete what's there and paste.
 *   3. Project Settings (the gear) › Script Properties › Add script property:
 *      EC_PASSWORD = your Eagle Creek (Supabase) password. Save.
 *   4. Back in the Editor, pick "setup" in the function menu at the top and click Run.
 *      Google asks for permission: Review permissions › your account › Advanced ›
 *      Go to Eagle Creek Email (unsafe) › Allow. ("Unsafe" only means Google hasn't
 *      reviewed a script you wrote for yourself.)
 *   5. The log says what it did. That's it: it now checks every 5 minutes.
 * To stop it: run "stop". To change the password: update EC_PASSWORD.
 */

const CONFIG = {
  supabaseUrl: '__SUPABASE_URL__',
  supabaseKey: '__SUPABASE_KEY__', // anon or publishable key; never the secret / service_role key
  email: '__EMAIL__', // your Eagle Creek sign-in
  password: '', // leave empty: put it in Script Properties as EC_PASSWORD instead
};

const ROOT = 'Eagle Creek';
const BUSINESS = 'Eagle Creek/Business';
const SAVED = 'Eagle Creek/Saved';
const NOT_SAVED = 'Eagle Creek/Not Saved';
const MAX_FILE = 50 * 1000 * 1000; // Supabase's limit, same as the apps
const PER_RUN = 12; // conversations saved per run, so a run never times out
const CLOSED = ['sold', 'dead', 'complete', 'lost'];
const VERSION = 1;

// ---------------------------------------------------------------------------
// The functions you run

/** Run once: checks the settings, makes the labels, starts checking every 5 minutes. */
function setup() {
  const session = signIn_(true);
  Logger.log('Signed in to Eagle Creek as ' + CONFIG.email + '.');
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('EC_PROJECTS_AT');
  const result = syncProjects_(session);
  Logger.log('Labels ready: ' + result.labels.join(', '));
  ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === 'run').forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('run').timeBased().everyMinutes(5).create();
  Logger.log('Checking Gmail every 5 minutes.');
  const saved = work_(session);
  Logger.log(saved ? 'Saved ' + saved + ' now.' : 'Nothing labelled yet. Label an email "' + BUSINESS + '" or a project to try it.');
}

/** Stops checking Gmail. Saved emails stay in Eagle Creek. */
function stop() {
  ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === 'run').forEach((t) => ScriptApp.deleteTrigger(t));
  Logger.log('Stopped. Run setup to start again.');
}

/** What the timer runs. */
function run() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return;
  try {
    work_(null);
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// The work

function work_(session) {
  const started = Date.now();
  const props = PropertiesService.getScriptProperties();
  ensureLabel_(ROOT);
  const savedLabel = ensureLabel_(SAVED);
  ensureLabel_(BUSINESS);
  // Projects become labels and forwarding tags, at most hourly (setup does it at once).
  if (Date.now() - Number(props.getProperty('EC_PROJECTS_AT') || 0) > 3600 * 1000) {
    session = session || signIn_();
    syncProjects_(session);
  }
  const labels = readMap_('EC_LABELS'); // label → project id ('' = business)
  const tags = readMap_('EC_TAGS'); // +tag → project id ('' = business)
  const me = Session.getEffectiveUser().getEmail();

  // What's waiting: labelled conversations, then ones forwarded to a +tag address.
  const jobs = [];
  const seen = {};
  const add = (thread, projectID, label) => {
    const k = thread.getId() + ':' + projectID;
    if (seen[k] || jobs.length >= PER_RUN) return;
    seen[k] = true;
    jobs.push({ thread: thread, projectID: projectID, label: label });
  };
  const fromLabel = (name) => {
    const label = GmailApp.getUserLabelByName(name);
    if (label) label.getThreads(0, PER_RUN).forEach((t) => add(t, labels[name], label));
  };
  const labelNames = Object.keys(labels);
  if (Date.now() - Number(props.getProperty('EC_SWEEP_AT') || 0) > 3600 * 1000) {
    // Once an hour, look in each label itself, in case Gmail's search spells a name differently.
    labelNames.forEach(fromLabel);
    props.setProperty('EC_SWEEP_AT', String(Date.now()));
  } else {
    // Otherwise one search per ten labels, so a quiet check stays light on Gmail however many
    // projects there are. A name with other characters (& . ' #…) is looked up by itself.
    const simple = labelNames.filter((n) => /^[A-Za-z0-9 \/-]+$/.test(n));
    labelNames.filter((n) => simple.indexOf(n) < 0).forEach(fromLabel);
    for (let i = 0; i < simple.length && jobs.length < PER_RUN; i += 10) {
      const chunk = simple.slice(i, i + 10);
      GmailApp.search('{' + chunk.map((n) => 'label:' + searchName_(n)).join(' ') + '}', 0, PER_RUN).forEach((thread) => {
        thread.getLabels().forEach((label) => {
          const name = label.getName();
          if (chunk.indexOf(name) >= 0) add(thread, labels[name], label);
        });
      });
    }
  }
  const at = me.indexOf('@');
  const tagNames = Object.keys(tags);
  if (at > 0 && tagNames.length) {
    const user = me.slice(0, at), domain = me.slice(at + 1);
    // A handful of addresses per search keeps each one short, however many projects there are.
    for (let i = 0; i < tagNames.length && jobs.length < PER_RUN; i += 8) {
      const terms = tagNames.slice(i, i + 8).map((t) => user + '+' + t + '@' + domain).map((a) => 'deliveredto:' + a + ' to:' + a);
      const q = '{' + terms.join(' ') + '} -label:' + searchName_(SAVED) + ' -label:' + searchName_(NOT_SAVED) + ' newer_than:60d';
      GmailApp.search(q, 0, PER_RUN).forEach((thread) => {
        const tag = tagOf_(thread, user, domain, tags);
        if (tag != null) add(thread, tags[tag], null);
      });
    }
  }
  if (!jobs.length) {
    heartbeat_(session, me, 0);
    return 0;
  }

  session = session || signIn_();
  const contacts = loadContacts_(session);
  const live = liveProjects_(session);
  // Conversations a run started but never finished (too big for the time Google allows a run).
  const tries = JSON.parse(props.getProperty('EC_TRIES') || '{}');
  let saved = 0;
  let lastError = '';
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    if (Date.now() - started > 4 * 60 * 1000) break; // the rest wait for the next run
    const k = job.thread.getId() + ':' + (job.projectID || 'business');
    tries[k] = (tries[k] || 0) + 1;
    props.setProperty('EC_TRIES', JSON.stringify(tries));
    try {
      if (tries[k] > 2) throw new Error('It\'s too big to save in the time Google gives a run. Download it from Gmail and add it in the app.');
      if (job.projectID && !live[String(job.projectID).toLowerCase()]) throw new Error('Its project isn\'t in Eagle Creek any more. Label it with another project.');
      saveThread_(session, job, me, contacts);
      job.thread.addLabel(savedLabel);
      if (job.label) job.thread.removeLabel(job.label);
      saved++;
    } catch (e) {
      lastError = '"' + (job.thread.getFirstMessageSubject() || '(no subject)') + '": ' + String(e && e.message || e);
      Logger.log('Couldn\'t save ' + lastError);
      job.thread.addLabel(ensureLabel_(NOT_SAVED));
      if (job.label) job.thread.removeLabel(job.label);
    }
    delete tries[k];
    props.setProperty('EC_TRIES', JSON.stringify(tries));
  }
  heartbeat_(session, me, saved, lastError);
  return saved;
}

/** One conversation: a PDF of every message, and each attachment as its own file. */
function saveThread_(session, job, me, contacts) {
  const thread = job.thread;
  const messages = thread.getMessages();
  const subject = (thread.getFirstMessageSubject() || '').trim() || '(no subject)';
  const target = job.projectID || 'business';
  const id = uuidFrom_('eaglecreek.mail:' + thread.getId() + ':' + target);
  const last = messages[messages.length - 1];
  // Who it's with: whoever wrote a forwarded email, else the first sender who isn't you, else the
  // first person you wrote to.
  const isMe = (a) => !!a.email && a.email.toLowerCase().replace(/\+[^@]*@/, '@') === me.toLowerCase();
  const fwd = forwardedFrom_(messages[0]);
  const other = (fwd && fwd.email && !isMe(fwd) ? fwd : null) ||
    messages.map((m) => m.getFrom()).concat(messages.map((m) => m.getTo())).map(firstAddress_).find((a) => a.email && !isMe(a)) || { name: '', email: '' };
  const title = (fwd ? subject.replace(/^\s*((fwd?|fw)\s*:\s*)+/i, '').trim() : '') || subject;
  const contact = contacts.find((c) => c.email && other.email && c.email.toLowerCase() === other.email.toLowerCase());
  const attachments = [];
  messages.forEach((m) => {
    m.getAttachments({ includeInlineImages: false }).forEach((a, i) => {
      const type = (a.getContentType() || '').toLowerCase();
      const size = a.getSize();
      if (size > MAX_FILE || /calendar|ms-tnef/.test(type) || /\.ics$|winmail\.dat$/i.test(a.getName())) return;
      if (/^image\//.test(type) && size < 12000) return; // signature logos
      attachments.push({ message: m, attachment: a, index: i });
    });
  });

  const html = emailHtml_(subject, messages, attachments);
  let pdf;
  try {
    pdf = Utilities.newBlob(html, 'text/html', 'email.html').getAs('application/pdf');
  } catch (e) {
    pdf = Utilities.newBlob(plainHtml_(subject, messages), 'text/html', 'email.html').getAs('application/pdf');
  }
  const bytes = pdf.getBytes();
  upload_(session, id.toLowerCase() + '.pdf', bytes, 'application/pdf');
  const row = getFile_(session, id);
  const existing = row && row.data;
  const now = stampAfter_(row);
  const doc = existing ? existing : { id: id, addedAt: now, contentRevision: 0, isPaid: false, amount: 0, includeInPackage: true, sortIndex: 0, needsReview: false, tags: [], notes: '', vendor: '' };
  doc.category = 'email';
  doc.title = (existing && String(existing.title || '').trim()) || title; // keeps a name you gave it in the app
  doc.originalFileName = safeName_(title) + '.pdf';
  doc.fileExtension = 'pdf';
  doc.fileSize = bytes.length;
  doc.documentDate = last.getDate().getTime() / 1000;
  doc.updatedAt = now;
  if (existing) doc.contentRevision = Math.max(now, (Number(existing.contentRevision) || 0) + 0.001); // seconds, like the Mac
  doc.vendor = other.name || other.email || '';
  doc.tags = (doc.tags || []).filter((t) => t !== 'Email').concat(['Email']);
  doc.notes = summary_(thread, messages, attachments, fwd);
  if (job.projectID) doc.projectID = job.projectID; else delete doc.projectID;
  if (contact) doc.contactID = contact.id;
  saveFile_(session, doc);

  attachments.forEach((item) => {
    const a = item.attachment, m = item.message;
    const name = a.getName() || 'Attachment';
    const ext = (name.match(/\.([A-Za-z0-9]{1,8})$/) || [, ''])[1].toLowerCase();
    const aid = uuidFrom_('eaglecreek.mail:' + m.getId() + ':' + item.index + ':' + target);
    const data = a.getBytes();
    upload_(session, aid.toLowerCase() + (ext ? '.' + ext : ''), data, a.getContentType() || 'application/octet-stream');
    const priorRow = getFile_(session, aid);
    const prior = priorRow && priorRow.data;
    const stamp = stampAfter_(priorRow);
    const file = prior ? prior : { id: aid, addedAt: now, contentRevision: 0, isPaid: false, amount: 0, includeInPackage: true, sortIndex: 0, needsReview: false, tags: [], notes: '', vendor: '' };
    file.category = prior ? prior.category : guessCategory_(name, !!job.projectID);
    file.title = prior ? prior.title : '';
    file.originalFileName = name;
    file.fileExtension = ext;
    file.fileSize = data.length;
    file.documentDate = m.getDate().getTime() / 1000;
    file.updatedAt = stamp;
    if (prior) file.contentRevision = Math.max(stamp, (Number(prior.contentRevision) || 0) + 0.001);
    file.recordID = id; // the email it came with
    file.notes = 'From the email "' + title + '"' + (other.name || other.email ? ' with ' + (other.name || other.email) : '') + ', ' + Utilities.formatDate(m.getDate(), Session.getScriptTimeZone(), 'MMM d, yyyy') + '.';
    if (job.projectID) file.projectID = job.projectID; else delete file.projectID;
    if (contact) file.contactID = contact.id;
    saveFile_(session, file);
  });
}

// ---------------------------------------------------------------------------
// Projects → labels and forwarding tags

function syncProjects_(session) {
  const rows = api_(session, 'GET', '/rest/v1/documents?select=id,data&kind=eq.project&deleted=eq.false&order=id&limit=2000') || [];
  const live = rows.map((r) => r.data || {}).filter((p) => p.id);
  const alive = {};
  live.forEach((p) => { alive[String(p.id).toLowerCase()] = true; });
  // Keep the labels that still point at a project (a renamed project's old label still files to
  // it); drop the ones whose project was deleted.
  const old = readMap_('EC_LABELS');
  const labels = {};
  labels[BUSINESS] = '';
  Object.keys(old).forEach((name) => {
    if (old[name] && alive[String(old[name]).toLowerCase()]) labels[name] = old[name];
  });
  const reserved = [ROOT, BUSINESS, SAVED, NOT_SAVED].map((n) => n.toLowerCase());
  const taken = (name, p) => reserved.indexOf(name.toLowerCase()) >= 0 ||
    Object.keys(labels).some((n) => n.toLowerCase() === name.toLowerCase() && String(labels[n]).toLowerCase() !== String(p.id).toLowerCase());
  const made = [BUSINESS];
  const open = live.filter((p) => CLOSED.indexOf(p.status) < 0);
  open.forEach((p) => {
    const base = ROOT + '/' + projectName_(p).replace(/\//g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
    // A label another project already has stays with it; this one gets its job number added.
    let label = base;
    if (taken(label, p)) label = base + ' ' + (String(p.jobNumber || '').replace(/[^A-Za-z0-9-]/g, '') || String(p.id).slice(0, 4).toLowerCase());
    if (taken(label, p)) label = base + ' ' + String(p.id).slice(0, 8).toLowerCase();
    ensureLabel_(label);
    labels[label] = p.id;
    made.push(label);
  });
  // Forwarding tags: job numbers and names, for open projects. One two projects share is left out.
  const found = {};
  open.forEach((p) => {
    const job = String(p.jobNumber || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    const slug = projectName_(p).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
    [job, slug].filter((t, i, all) => t && t !== 'business' && all.indexOf(t) === i).forEach((t) => {
      found[t] = found[t] === undefined || found[t] === p.id ? p.id : null;
    });
  });
  const tags = { business: '' };
  Object.keys(found).forEach((t) => { if (found[t]) tags[t] = found[t]; });
  writeMap_('EC_LABELS', labels);
  writeMap_('EC_TAGS', tags);
  PropertiesService.getScriptProperties().setProperty('EC_PROJECTS_AT', String(Date.now()));
  return { labels: made, tags: tags };
}

/** Which projects are still in Eagle Creek (lower-case ids). */
function liveProjects_(session) {
  const rows = api_(session, 'GET', '/rest/v1/documents?select=id&kind=eq.project&deleted=eq.false&limit=5000') || [];
  const live = {};
  rows.forEach((r) => { live[String(r.id).toLowerCase()] = true; });
  return live;
}

/** Script Properties hold at most 9 KB each, so the label and tag lists are kept in pieces. */
function readMap_(name) {
  const props = PropertiesService.getScriptProperties();
  const n = Number(props.getProperty(name + '_N') || 0);
  let text = '';
  for (let i = 0; i < n; i++) text += props.getProperty(name + '_' + i) || '';
  try {
    return JSON.parse(text || '{}');
  } catch (e) {
    return {};
  }
}

function writeMap_(name, map) {
  const props = PropertiesService.getScriptProperties();
  const text = JSON.stringify(map);
  const before = Number(props.getProperty(name + '_N') || 0);
  const parts = {};
  let n = 0;
  for (let i = 0; i < text.length; i += 2500) parts[name + '_' + n++] = text.slice(i, i + 2500); // ≤ 7.5 KB even in accented names
  parts[name + '_N'] = String(n);
  props.setProperties(parts);
  for (let i = n; i < before; i++) props.deleteProperty(name + '_' + i);
}

function projectName_(p) {
  return String(p.name || '').trim() || String((p.property || {}).street || '').trim() || 'Untitled Project';
}

/** Which +tag a forwarded conversation was sent to. */
function tagOf_(thread, user, domain, tags) {
  const re = new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\+([A-Za-z0-9._-]+)@' + domain.replace(/\./g, '\\.'), 'i');
  const messages = thread.getMessages();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const text = [m.getHeader ? m.getHeader('Delivered-To') : '', m.getTo(), m.getCc()].join(' ');
    const hit = re.exec(text || '');
    if (hit) {
      const tag = hit[1].toLowerCase().replace(/[^a-z0-9]/g, '');
      if (tags[tag] != null) return tag;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The PDF and the notes

function emailHtml_(subject, messages, attachments) {
  const tz = Session.getScriptTimeZone();
  const parts = messages.map((m) => {
    const att = attachments.filter((a) => a.message === m).map((a) => esc_(a.attachment.getName()));
    let body = String(m.getBody() || '');
    body = body.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<head[\s\S]*?<\/head>/gi, '').replace(/<img[^>]+src=["']cid:[^>]*>/gi, '');
    if (!body.trim()) body = '<pre style="white-space:pre-wrap;font-family:inherit">' + esc_(m.getPlainBody()) + '</pre>';
    const row = (k, v) => (v ? '<tr><td class="k">' + k + '</td><td>' + esc_(tidy_(v)) + '</td></tr>' : '');
    return '<div class="msg"><table class="hdr">' + row('From', m.getFrom()) + row('To', m.getTo()) + row('Cc', m.getCc()) +
      row('Date', Utilities.formatDate(m.getDate(), tz, 'EEE, MMM d, yyyy h:mm a')) + '</table><div class="body">' + body + '</div>' +
      (att.length ? '<div class="att">Attachments (saved beside this email): ' + att.join(', ') + '</div>' : '') + '</div>';
  });
  return '<html><head><meta charset="utf-8"><style>body{font-family:Arial,Helvetica,sans-serif;font-size:10.5pt;color:#222}' +
    'h1{font-size:15pt;margin:0 0 3pt}.meta{color:#666;font-size:9pt;margin:0 0 6pt}.msg{border-top:1px solid #bbb;margin-top:12pt;padding-top:8pt}' +
    '.hdr td{font-size:9.5pt;color:#333;padding:1pt 10pt 1pt 0;vertical-align:top}.hdr td.k{color:#777;width:40pt}.body{margin-top:8pt}' +
    '.att{margin-top:8pt;font-size:9pt;color:#555}img{max-width:100%}</style></head><body><h1>' + esc_(subject) + '</h1><div class="meta">' +
    messages.length + (messages.length === 1 ? ' message' : ' messages') + ' · saved from Gmail ' + Utilities.formatDate(new Date(), tz, 'MMM d, yyyy') +
    '</div>' + parts.join('') + '</body></html>';
}

/** If an email's own HTML won't convert, its plain text will. */
function plainHtml_(subject, messages) {
  const tz = Session.getScriptTimeZone();
  return '<html><body style="font-family:Arial;font-size:10.5pt"><h1 style="font-size:15pt">' + esc_(subject) + '</h1>' + messages.map((m) =>
    '<hr><p style="color:#555;font-size:9.5pt">From: ' + esc_(m.getFrom()) + '<br>To: ' + esc_(m.getTo()) + '<br>Date: ' +
    Utilities.formatDate(m.getDate(), tz, 'EEE, MMM d, yyyy h:mm a') + '</p><pre style="white-space:pre-wrap;font-family:Arial">' + esc_(m.getPlainBody()) + '</pre>').join('') + '</body></html>';
}

/** The file's notes: who and when, a link back to Gmail, and the latest message's text (for searching). */
function summary_(thread, messages, attachments, fwd) {
  const tz = Session.getScriptTimeZone();
  const first = messages[0], last = messages[messages.length - 1];
  const lines = [
    'From: ' + tidy_(fwd ? fwd.text : first.getFrom()),
  ];
  if (fwd) lines.push('Forwarded by: ' + tidy_(first.getFrom()));
  lines.push(
    'To: ' + tidy_(first.getTo()),
    'Date: ' + Utilities.formatDate(last.getDate(), tz, 'MMM d, yyyy h:mm a') + (messages.length > 1 ? ' (' + messages.length + ' messages)' : ''));
  if (attachments.length) lines.push('Attachments: ' + attachments.map((a) => a.attachment.getName()).join(', '));
  lines.push('Gmail: https://mail.google.com/mail/u/0/#all/' + thread.getId());
  const text = fwd && messages.length === 1 ? [fwd.note, latestText_(fwd.body)].filter(Boolean).join('\n\n') : latestText_(last.getPlainBody());
  return lines.join('\n') + '\n\n' + text.slice(0, 3000);
}

/** Just what the latest message says: without the earlier ones quoted under it. */
function latestText_(text) {
  let t = String(text || '').replace(/\r/g, '');
  const cut = t.search(/^(On .{4,200}wrote:|-+ ?Original Message ?-+|From: .+\n(Sent|Date): .+)$/m);
  if (cut > 0) t = t.slice(0, cut);
  return t.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** A forwarded email's original sender ("From: …" under "Forwarded message"), and what it said. */
function forwardedFrom_(message) {
  const text = String(message.getPlainBody() || '').replace(/\r/g, '');
  // Gmail's and Apple Mail's markers only mean a forward. Outlook's ("Original Message", a line of
  // underscores) also sit above the quoted text in an ordinary reply, so they count only on a "Fw:".
  const isFwd = /^\s*(fwd?|fw)\s*:/i.test(message.getSubject() || '');
  const mark = /^[ \t>]*(-{2,} ?Forwarded message ?-{2,}|Begin forwarded message:)[ \t]*$/im.exec(text) ||
    (isFwd ? /^[ \t>]*(-{2,} ?Original Message ?-{2,}|_{10,})[ \t]*$/im.exec(text) : null);
  if (!mark) return null;
  const rest = text.slice(mark.index + mark[0].length);
  const from = /^[ \t>]*\*?From:\*?[ \t]*(.+)$/im.exec(rest.slice(0, 1500));
  if (!from) return null;
  const line = from[1].replace(/\*/g, '').trim();
  let a = firstAddress_(line);
  if (!/^[^\s@<>\[\]()"]+@[^\s@<>\[\]()"]+\.[^\s@<>\[\]()"]+$/.test(a.email)) {
    // "Dana Smith [mailto:dana@x.com]", "dana@x.com (Dana Smith)", or just a name.
    const m = /[\w.+'-]+@[\w-]+(\.[\w-]+)+/.exec(line);
    a = {
      name: line.replace(/[<\[(]?(mailto:)?[\w.+'-]+@[\w-]+(\.[\w-]+)+[>\])]?/, '').replace(/[()]/g, '').trim().replace(/^"|"$/g, '').trim(),
      email: m ? m[0] : '',
    };
  }
  const header = rest.slice(from.index);
  const gap = header.search(/\n[ \t>]*\n/);
  return {
    name: a.name, email: a.email, text: line,
    note: latestText_(text.slice(0, mark.index)), // what the forwarder wrote above it
    body: gap >= 0 ? header.slice(gap).replace(/^[ \t]*>[ \t]?/gm, '') : '',
  };
}

// ---------------------------------------------------------------------------
// Supabase (as you, with the anon or publishable key)

function signIn_(fresh) {
  const cache = CacheService.getScriptCache();
  if (!fresh) {
    const hit = cache.get('EC_SESSION');
    if (hit) return JSON.parse(hit);
  }
  const url = String(CONFIG.supabaseUrl || '').replace(/\/+$/, '');
  const key = String(CONFIG.supabaseKey || '').trim();
  const password = PropertiesService.getScriptProperties().getProperty('EC_PASSWORD') || CONFIG.password;
  if (!/^https?:\/\//.test(url) || !key || url.indexOf('__') >= 0) throw new Error('Fill in supabaseUrl and supabaseKey in CONFIG (Settings › Save Emails from Gmail › Copy Setup Script does it for you).');
  if (/service_role|sb_secret_/.test(key)) throw new Error('That\'s the secret key. Use the anon or publishable key.');
  if (!CONFIG.email || CONFIG.email.indexOf('__') >= 0) throw new Error('Fill in your Eagle Creek email in CONFIG.');
  if (!password) throw new Error('Add your Eagle Creek password in Project Settings › Script Properties as EC_PASSWORD.');
  const res = UrlFetchApp.fetch(url + '/auth/v1/token?grant_type=password', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: key }, payload: JSON.stringify({ email: CONFIG.email, password: password }),
  });
  const body = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() >= 400 || !body.access_token) throw new Error('Eagle Creek sign-in didn\'t work: ' + (body.error_description || body.msg || body.message || res.getResponseCode()));
  const session = { url: url, key: key, token: body.access_token, uid: String((body.user || {}).id || '').toLowerCase() };
  cache.put('EC_SESSION', JSON.stringify(session), Math.max(60, Math.min(50 * 60, (Number(body.expires_in) || 3600) - 300)));
  return session;
}

function api_(session, method, path, payload, prefer) {
  const headers = { apikey: session.key, Authorization: 'Bearer ' + session.token, 'X-Client-App': 'Gmail' };
  if (prefer) headers.Prefer = prefer;
  const options = { method: method.toLowerCase(), headers: headers, muteHttpExceptions: true };
  if (payload !== undefined) { options.contentType = 'application/json'; options.payload = JSON.stringify(payload); }
  const res = UrlFetchApp.fetch(session.url + path, options);
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code >= 400) throw failure_('Saving to Eagle Creek didn\'t work', res);
  return text ? JSON.parse(text) : null;
}

function upload_(session, name, bytes, contentType) {
  const res = UrlFetchApp.fetch(session.url + '/storage/v1/object/files/' + session.uid + '/' + name, {
    method: 'post', muteHttpExceptions: true, contentType: contentType, payload: bytes,
    headers: { apikey: session.key, Authorization: 'Bearer ' + session.token, 'x-upsert': 'true' },
  });
  if (res.getResponseCode() >= 400) throw failure_('Uploading the file didn\'t work', res);
}

/** An error that says what failed and Supabase's reason, in a line. */
function failure_(what, res) {
  const text = res.getContentText() || '';
  let why = '';
  try {
    const j = JSON.parse(text);
    why = j.message || j.error_description || j.msg || j.error || '';
  } catch (e) {
    why = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return new Error(what + ' (' + res.getResponseCode() + (why ? ', ' + String(why).slice(0, 160) : '') + ')');
}

/** A file's record if it's there: { data (null if deleted), at (its stamp, seconds) }. */
function getFile_(session, id) {
  const rows = api_(session, 'GET', '/rest/v1/documents?select=data,deleted,updated_at&id=eq.' + id.toLowerCase()) || [];
  if (!rows.length) return null;
  const at = Date.parse(rows[0].updated_at || '') / 1000 || 0;
  return { data: rows[0].deleted ? null : rows[0].data, at: Math.max(at, Number((rows[0].data || {}).updatedAt) || 0) };
}

/** Now, or just after the copy that's there if a device with a fast clock stamped it ahead
 *  (Supabase keeps the newer copy, so an older stamp would be turned down). */
function stampAfter_(row) {
  const now = Date.now() / 1000;
  const base = row ? row.at : 0;
  return base >= now && base - now < 2 * 86400 ? base + 0.001 : now;
}

function saveFile_(session, doc) {
  const id = String(doc.id).toLowerCase();
  const out = api_(session, 'POST', '/rest/v1/documents?select=id', [{
    id: id, kind: 'file', deleted: false, updated_at: new Date(doc.updatedAt * 1000).toISOString(), data: doc,
  }], 'resolution=merge-duplicates,return=representation');
  if (!(out || []).some((r) => String(r.id).toLowerCase() === id)) {
    throw new Error('Eagle Creek kept a newer copy of it. Label it again to save it over that.');
  }
}

function loadContacts_(session) {
  const rows = api_(session, 'GET', '/rest/v1/documents?select=id,data&kind=eq.contact&deleted=eq.false&limit=2000') || [];
  return rows.map((r) => ({ id: (r.data || {}).id, email: String((r.data || {}).email || '').trim() })).filter((c) => c.id && c.email);
}

/** What the app shows in Settings: which Gmail, when it last checked, the labels and addresses. */
function heartbeat_(session, me, saved, error) {
  const props = PropertiesService.getScriptProperties();
  const lastBeat = Number(props.getProperty('EC_BEAT_AT') || 0);
  const labels = readMap_('EC_LABELS');
  const tags = readMap_('EC_TAGS');
  const sig = uuidFrom_(JSON.stringify([labels, tags]));
  // Quiet runs check in hourly, or sooner when the labels or addresses changed (a new project).
  if (!saved && !error && sig === props.getProperty('EC_BEAT_SIG') && Date.now() - lastBeat < 3600 * 1000) return;
  session = session || signIn_();
  const id = uuidFrom_('eaglecreek.mailbridge:' + me.toLowerCase());
  const prior = ((api_(session, 'GET', '/rest/v1/documents?select=data&id=eq.' + id.toLowerCase()) || [])[0] || {}).data || {};
  const now = Date.now() / 1000;
  const data = {
    id: id, gmail: me, version: VERSION, lastRun: now,
    lastSaved: saved ? now : prior.lastSaved || null,
    savedCount: (Number(prior.savedCount) || 0) + saved,
    // The last one it couldn't save stays listed (the app shows it for a few days).
    lastError: error || prior.lastError || '',
    lastErrorAt: error ? now : prior.lastErrorAt || null,
    labels: labels,
    tags: tags,
    updatedAt: now,
  };
  api_(session, 'POST', '/rest/v1/documents?select=id', [{ id: id.toLowerCase(), kind: 'mailBridge', deleted: false, updated_at: new Date(now * 1000).toISOString(), data: data }], 'resolution=merge-duplicates,return=representation');
  props.setProperty('EC_BEAT_AT', String(Date.now()));
  props.setProperty('EC_BEAT_SIG', sig);
}

// ---------------------------------------------------------------------------
// Small helpers

function ensureLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

/** How Gmail's search box writes a label: lower case, spaces and slashes as hyphens. */
function searchName_(name) {
  return name.toLowerCase().replace(/[\s/]+/g, '-');
}

/** "Dana Smith <dana@x.com>, …" → { name: 'Dana Smith', email: 'dana@x.com' } */
function firstAddress_(text) {
  const s = String(text || '').split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)[0].trim();
  const m = /^(.*?)\s*<([^>]+)>$/.exec(s);
  if (m) return { name: m[1].replace(/^"|"$/g, '').trim(), email: m[2].trim() };
  return { name: '', email: s };
}

/** The file type for an attachment, from its name: the same rules (and the same types per place)
 *  as the Mac's guess, so "Invoice 4411.pdf" on a job is an Invoice and "Contractor list.pdf" isn't a contract. */
function guessCategory_(fileName, inProject) {
  const name = String(fileName || '');
  const words = name.replace(/\.[A-Za-z0-9]{1,8}$/, '').toLowerCase().split(/[^a-z0-9\u00c0-\u024f]+/).filter(Boolean);
  const padded = ' ' + words.join(' ') + ' ';
  const has = (p) => (p.indexOf(' ') >= 0 ? padded.indexOf(' ' + p + ' ') >= 0 : words.indexOf(p) >= 0);
  const allowed = inProject ? PROJECT_TYPES : COMPANY_TYPES;
  for (let i = 0; i < GUESS_RULES.length; i++) {
    const cat = GUESS_RULES[i][0];
    if (allowed.indexOf(cat) >= 0 && GUESS_RULES[i][1].some(has)) return cat;
  }
  if (inProject && /\.(jpe?g|png|heic|heif|webp|gif|tiff?|bmp)$/i.test(name)) return 'progressPhoto';
  return 'other';
}

const PROJECT_TYPES = ['propertyPhoto', 'progressPhoto', 'plansSpecs', 'invoice', 'receipt', 'lienWaiver', 'drawPaperwork', 'proposal', 'contractBid',
  'changeOrder', 'payApplication', 'permitInspection', 'closingTitle', 'loanDocument', 'insurance', 'email', 'other'];
const COMPANY_TYPES = ['financialStatement', 'bankStatement', 'taxReturn', 'taxForm', 'travel', 'entityDocument', 'insurance', 'loanDocument', 'receipt', 'email', 'other'];
// Most specific first, so "lien waiver invoice" is a lien waiver.
const GUESS_RULES = [
  ['lienWaiver', ['lien', 'waiver', 'waivers']],
  ['payApplication', ['pay app', 'payapp', 'g702', 'g703', 'pay application']],
  ['changeOrder', ['change order', 'changeorder']],
  ['drawPaperwork', ['draw', 'draws', 'disbursement']],
  ['permitInspection', ['permit', 'permits', 'inspection', 'inspections', 'co cert', 'certificate of occupancy']],
  ['closingTitle', ['closing', 'title', 'hud', 'settlement', 'alta', 'deed', 'escrow']],
  ['loanDocument', ['loan', 'term sheet', 'termsheet', 'promissory', 'mortgage', 'lender', 'appraisal']],
  ['insurance', ['insurance', 'coi', 'policy', 'builders risk', 'liability']],
  ['taxForm', ['w9', 'w 9', '1099', '1099 nec', '1099nec', 'w2']],
  ['taxReturn', ['tax return', '1040', '1065', '1120s', '1120', 'k1']],
  ['financialStatement', ['pnl', 'profit and loss', 'balance sheet', 'financials', 'financial statement']],
  ['bankStatement', ['bank statement', 'statement', 'statements']],
  ['entityDocument', ['operating agreement', 'articles of organization', 'ein', 'bylaws', 'annual report']],
  ['plansSpecs', ['plan', 'plans', 'blueprint', 'blueprints', 'spec', 'specs', 'drawing', 'drawings', 'survey', 'elevation']],
  ['proposal', ['proposal', 'estimate', 'quote', 'bid sheet']],
  ['contractBid', ['contract', 'agreement', 'bid', 'bids', 'subcontract', 'psa']],
  ['receipt', ['receipt', 'receipts', 'rcpt']],
  ['invoice', ['invoice', 'invoices', 'inv', 'bill']],
];

/** '"Dana Smith" <dana@x.com>' → 'Dana Smith <dana@x.com>' */
function tidy_(addresses) {
  return String(addresses || '').replace(/"([^"]*)"\s*</g, '$1 <').replace(/\s+/g, ' ').trim();
}

function safeName_(subject) {
  return String(subject).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Email';
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** The same id every time for the same text (so saving again updates the same file). */
function uuidFrom_(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, text, Utilities.Charset.UTF_8);
  const hex = [];
  for (let i = 0; i < 16; i++) hex.push(((bytes[i] + 256) % 256).toString(16).padStart(2, '0'));
  hex[6] = ((parseInt(hex[6], 16) & 0x0f) | 0x50).toString(16).padStart(2, '0');
  hex[8] = ((parseInt(hex[8], 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  const h = hex.join('');
  return (h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20, 32)).toUpperCase();
}
