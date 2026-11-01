/* Eagle Creek — field companion web app.
 *
 * Reads and writes the same Supabase `documents` rows and `files` bucket as the Mac app,
 * using the Mac's own formats: one JSON row per record, dates as seconds since 1970
 * (to the millisecond), newest edit wins. Works offline; changes upload when there's signal.
 */
'use strict';

const APP_VERSION = '1.19.2';
// The record kinds kept on this device. QuickBooks, bank imports and the rest stay on the Mac.
// planSheet and planMark are the plan reader's scales and measurements (plans.js); the Mac app
// leaves kinds it doesn't know alone.
// books (the chart of accounts), transaction, commitment, changeOrder, payApp and timeEntry are
// read for Contacts, the budget and the money pages; they're edited on the Mac.
// trip and mileage are the Mac's Trips & Mileage; usStay (days in the US) is kept for the phone.
// note is the Notes tab (notes.js), kept on the phone, iPad and computer alike.
const KINDS = ['project', 'file', 'task', 'dailyLog', 'punchItem', 'event', 'contact', 'company', 'planSheet', 'planMark',
  'transaction', 'commitment', 'changeOrder', 'payApp', 'timeEntry', 'books', 'trip', 'mileage', 'usStay', 'mailBridge', 'note'];
// Eagle Creek Books' own table (`ledger_documents`, setup.sql v1.3): bank feed lines, so they can
// be reviewed from the phone (feed.js). Each row also carries the company (`entity_id`).
const LEDGER_KINDS = ['feedLine', 'device'];
const LEDGER_TABLE = 'ledger_documents';
const tableFor = (kind) => (LEDGER_KINDS.includes(kind) ? LEDGER_TABLE : 'documents');
const KINDS_KEY = [...KINDS, ...LEDGER_KINDS].join(',');
const UPLOAD_LIMIT = 50_000_000; // Supabase's free plan, same as the Mac
const CLIENT_APP = 'Web app'; // the Mac sends "eaglecreek", Eagle Creek Books "books"

// ---------------------------------------------------------------------------
// Small helpers

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stamp = () => Math.round(Date.now()) / 1000; // seconds, to the millisecond (the Mac's precision)
/**
 * The stamp for a change made to a copy stamped `base`: now, or just after `base` when another
 * device's clock runs ahead of this one. Supabase keeps whichever copy has the newer stamp
 * (setup.sql v1.3), so an edit here must always be newer than the copy it was made on.
 */
const stampAfter = (base) => {
  const now = stamp();
  const b = Number(base) || 0;
  // A stamp more than two days ahead isn't a clock running fast; don't follow it.
  return b >= now && b - now < 172_800 ? Math.round((b + 0.001) * 1000) / 1000 : now;
};
const toSec = (date) => Math.round(date.getTime()) / 1000;
const fromSec = (s) => new Date((s || 0) * 1000);
const key = (id) => String(id || '').toLowerCase();
const sameId = (a, b) => !!a && !!b && key(a) === key(b);
const clone = (o) => JSON.parse(JSON.stringify(o));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID().toUpperCase();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toUpperCase();
}

// Dates on the device's own calendar.
const sod = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds());
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();
function addMonths(d, n) {
  const y = d.getFullYear(), m = d.getMonth() + n;
  const ty = y + Math.floor(m / 12), tm = ((m % 12) + 12) % 12;
  return new Date(ty, tm, Math.min(d.getDate(), daysIn(ty, tm)), d.getHours(), d.getMinutes(), d.getSeconds());
}
const dayDiff = (a, b) => Math.round((sod(b) - sod(a)) / 86_400_000);
const localNoon = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);

/** All-day dates are stored by the Mac as noon UTC on that date (CalendarMath.dayKey). */
const dayKey = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 12) / 1000;
/** Midnight here of a stored calendar date; an ordinary moment reads as its day here. */
function localDay(sec) {
  const d = fromSec(sec);
  if (d.getUTCHours() === 12 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0) {
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  return sod(d);
}

// US dates and times, whatever the phone's region (as on the Mac).
const fmt = {
  date: (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
  short: (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  weekday: (d) => `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.getMonth() + 1}/${d.getDate()}`, // "Fri 10/9", the Mac's log list
  day: (d) => d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
  time: (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
  dateTime: (d) => `${fmt.date(d)} at ${fmt.time(d)}`,
  month: (d) => d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
  size: (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} KB` : `${b || 0} bytes`),
  ago(sec) {
    if (!sec) return 'Never';
    const s = Math.max(0, Date.now() / 1000 - sec);
    if (s < 45) return 'Just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    return fmt.dateTime(fromSec(sec));
  },
  relDay(d) {
    const n = dayDiff(new Date(), d);
    if (n === 0) return 'Today';
    if (n === 1) return 'Tomorrow';
    if (n === -1) return 'Yesterday';
    return fmt.short(d);
  },
  inputDate: (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
  inputTime: (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
};
function parseInputDate(v, time) {
  if (!v) return null;
  const [y, m, d] = v.split('-').map(Number);
  if (!y || !m || !d) return null;
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0);
}

// ----- Voice notes: dictation into any text box, with the phone's own speech recognition.
// On iPhone and iPad the words come from Apple's dictation; in Chrome from Google's. The text
// goes into the box as it's recognised, and saves like typing would. Where the app can't use
// speech recognition (some home-screen installs), the keyboard's own mic key still works.
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
// Android's Chrome re-sends the whole phrase on every update, each marked final, so there it
// listens one phrase at a time (the phrase replaces its draft until it's final, then is kept
// once) and starts listening again on its own until the mic is tapped.
const ANDROID_SPEECH = /Android/i.test(navigator.userAgent);
const Dictation = {
  rec: null, target: null, field: null, base: '', finals: '', draft: '', lastFinal: '', keepGoing: false,
  supported() { return !!SpeechRec; },
  /** Begin listening into `box` (a textarea), or — with `field` and no box — into that field of
   *  the next form rendered (see attach). Returns false when dictation can't start. */
  start(box, { field = null } = {}) {
    if (!SpeechRec) { toast('Dictation isn’t available in this app on this device. Tap into the box and use the keyboard’s mic key instead.'); return false; }
    if (this.rec) this.stop();
    this.finals = '';
    this.draft = '';
    this.lastFinal = '';
    this.field = field;
    this.keepGoing = true;
    this.setTarget(box);
    if (!this.listen()) return false;
    this.paint();
    toast('Listening… tap the mic again when you’re done.');
    return true;
  },
  /** One recognition session. Returns false when it couldn't start. */
  listen() {
    const rec = new SpeechRec();
    rec.continuous = !ANDROID_SPEECH;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    this.rec = rec;
    rec.onresult = (e) => {
      if (this.rec !== rec) return;
      if (ANDROID_SPEECH) {
        // The newest result is the whole phrase so far; keep it as the draft until the session ends.
        const last = e.results[e.results.length - 1];
        this.draft = last ? last[0].transcript : '';
        this.write('');
        return;
      }
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0].transcript;
        if (!r.isFinal) { interim += text; continue; }
        // Some phones send the same final twice.
        if (text.trim() && text.trim() === this.lastFinal) continue;
        this.lastFinal = text.trim();
        this.finals += Dictation.tidy(text, this.base + this.finals);
      }
      this.write(interim);
    };
    rec.onerror = (e) => {
      if (this.rec !== rec) return;
      const why = e.error;
      if (why === 'no-speech' && ANDROID_SPEECH) return; // the session ends; onend starts the next
      if (why === 'not-allowed' || why === 'service-not-allowed') toast('The microphone is off for Eagle Creek. Allow it in the browser’s site settings (or Settings › Safari) and try again.');
      else if (why === 'no-speech') toast('Didn’t hear anything.');
      else if (why === 'network') toast('Dictation needs a connection.');
      else if (why !== 'aborted') toast('Dictation stopped.');
      this.keepGoing = false;
      this.stop();
    };
    rec.onend = () => {
      if (this.rec !== rec) return;
      // The phrase is done: keep it, then listen for the next one.
      if (this.draft.trim()) this.finals += Dictation.tidy(Dictation.sentence(this.draft), this.base + this.finals);
      this.draft = '';
      this.write('');
      if (ANDROID_SPEECH && this.keepGoing && this.listen()) return;
      this.stop();
    };
    try { rec.start(); } catch (err) { console.error(err); this.rec = null; toast('Couldn’t start dictation.'); return false; }
    return true;
  },
  stop() {
    const rec = this.rec;
    this.rec = null;
    this.keepGoing = false;
    if (rec) { rec.onresult = rec.onerror = rec.onend = null; try { rec.stop(); } catch { /* already stopped */ } }
    if (this.draft.trim()) this.finals += Dictation.tidy(Dictation.sentence(this.draft), this.base + this.finals);
    this.draft = '';
    this.write('');
    this.target = null;
    this.field = null;
    this.paint();
  },
  /** Point the words at a box: what's already there stays, and the dictation goes after it. */
  setTarget(box) {
    this.target = box || null;
    if (!box) return;
    const have = box.value.replace(/\s+$/, '');
    this.base = have ? `${have}${/[.!?]$/.test(have) ? ' ' : '. '}` : '';
    this.write('');
  },
  /** After a page renders: a voice note started from a list lands in the form's field. */
  attach(root) {
    if (!this.rec || this.target || !this.field) return;
    const box = root.querySelector(`#log-form textarea[name="${this.field}"], #note-form textarea[name="${this.field}"]`);
    if (box) { this.setTarget(box); this.paint(); }
  },
  write(interim) {
    const box = this.target;
    if (!box || !box.isConnected) return;
    const text = `${this.base}${this.finals}${this.draft || interim}`.replace(/\s+$/, '');
    if (box.value === text) return;
    box.value = text;
    box.dispatchEvent(new Event('input', { bubbles: true }));
  },
  /** A phrase from a recognizer that never punctuates (Android's): ends it with a period, since
   *  phrases end on pauses, which are mostly the ends of sentences. */
  sentence(phrase) {
    const t = phrase.trim();
    return t && !/[.!?…:,;]$/.test(t) ? `${t}.` : t;
  },
  /** Line breaks and a little spoken punctuation (Apple's dictation handles the rest itself). */
  tidy(chunk, before = '') {
    let t = chunk.replace(/\s+/g, ' ').trim();
    if (!t) return '';
    if (/(^|[.!?]|\n)\s*$/.test(before)) t = t[0].toUpperCase() + t.slice(1);
    t = t.replace(/\s*\b(new paragraph)\b\s*/gi, '\n\n').replace(/\s*\b(new line)\b\s*/gi, '\n')
      .replace(/\s*\bfull stop\b/gi, '.').replace(/\s*\bquestion mark\b/gi, '?').replace(/\s*\bexclamation (point|mark)\b/gi, '!');
    t = t.replace(/([.!?]\s+|\n)([a-z])/g, (m, a, b) => a + b.toUpperCase());
    return `${t}${/[\n]$/.test(t) ? '' : ' '}`;
  },
  paint() {
    $$('.mic').forEach((b) => b.classList.toggle('on', !!this.target && b.closest('.dictate-wrap')?.querySelector('textarea') === this.target));
    document.body.classList.toggle('dictating', !!this.rec);
  },
};

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2600);
}

// Line icons in the spirit of the Mac's SF Symbols.
const ICONS = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  schedule: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h6M9 12.5h7M7 16h5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  hammer: '<path d="m14 6 4 4-9.5 9.5a2.1 2.1 0 0 1-3-3z"/><path d="m13 3 8 8-2 2-8-8z"/>',
  building: '<path d="M3 21h18M5 21V9l6-4v16M11 21V3l8 4v14"/><path d="M14 10h2M14 14h2M7.5 12h1M7.5 16h1"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5h6v2M3 12.5h18"/>',
  camera: '<path d="M4 8h3l2-2.5h6L17 8h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m21 16-5-5-9 9"/>',
  book: '<path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z"/><path d="M5 18a2 2 0 0 1 2-2h11M9 8h5"/>',
  checklist: '<path d="m4 6 1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17"/><path d="M11 6h9M11 12h9M11 18h9"/>',
  file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>',
  doc: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  chev: '<path d="M9 5l7 7-7 7"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  pin: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  share: '<path d="M12 3v12M7.5 7.5 12 3l4.5 4.5"/><path d="M5 12v8h14v-8"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M5 19h14"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  rain: '<path d="M7 15a4 4 0 1 1 1-7.9A5 5 0 0 1 17.5 9 3.5 3.5 0 0 1 17 16H7z"/><path d="M9 19l-1 2M13 19l-1 2M17 19l-1 2"/>',
  warn: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.01"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16"/><path d="M20 20v-4h-4"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  left: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  right: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
};
const icon = (name, cls = 'ic', style = '') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"${style ? ` style="${style}"` : ''}>${ICONS[name] || ''}</svg>`;

// ---------------------------------------------------------------------------
// Names and colours from the Mac app

const STATUS = {
  analyzing: 'Analyzing', offerMade: 'Offer Made', underContract: 'Under Contract', rehab: 'In Rehab', listed: 'Listed',
  sold: 'Sold', rental: 'Held as Rental', dead: 'Dead', preconstruction: 'Plans & Permits', construction: 'Under Construction',
  lead: 'Lead', estimating: 'Estimating', proposalSent: 'Proposal Sent', awarded: 'Contract Signed', complete: 'Complete', lost: 'Lost',
};
// ProjectStatus.color in the Mac's Tiles.swift.
const STATUS_COLOR = {
  analyzing: 'stone', lead: 'stone', estimating: 'sage', offerMade: 'slate', proposalSent: 'slate', underContract: 'gold',
  awarded: 'gold', preconstruction: 'tan', rehab: 'leather', construction: 'leather', listed: 'olive', sold: 'success',
  complete: 'success', rental: 'spruce', dead: 'clay', lost: 'clay',
};
const ACTIVE = new Set(['underContract', 'rehab', 'listed', 'preconstruction', 'construction', 'awarded']);
const PIPELINE = new Set(['analyzing', 'offerMade', 'lead', 'estimating', 'proposalSent']);
const statusLabel = (s) => STATUS[s] || 'Analyzing';
const statusColor = (s) => `var(--${STATUS_COLOR[s] || 'stone'})`;
const isActiveStatus = (s) => ACTIVE.has(s);
const statusGroup = (s) => (ACTIVE.has(s) ? 'active' : PIPELINE.has(s) || !s ? 'pipeline' : s === 'rental' ? 'rentals' : 'closed');
const KIND_LABEL = { flip: 'Rehab / Flip', newBuild: 'New Build', clientJob: 'Client Job' };
const KIND_ICON = { flip: 'hammer', newBuild: 'building', clientJob: 'briefcase' };

const CATEGORY = {
  propertyPhoto: 'Property Photos', progressPhoto: 'Progress Photos', invoice: 'Invoices', receipt: 'Receipts',
  lienWaiver: 'Lien Waivers', drawPaperwork: 'Draw Paperwork', contractBid: 'Contracts & Bids',
  permitInspection: 'Permits & Inspections', closingTitle: 'Closing & Title', loanDocument: 'Loan Documents',
  insurance: 'Insurance', plansSpecs: 'Plans & Specs', proposal: 'Proposals & Estimates', changeOrder: 'Change Orders',
  payApplication: 'Pay Applications', financialStatement: 'Financial Statements', bankStatement: 'Bank Statements',
  taxReturn: 'Tax Returns', taxForm: 'W-9s & 1099s', travel: 'Travel', entityDocument: 'LLC & Entity Documents', email: 'Emails', other: 'Other',
};
const CATEGORY_ONE = {
  propertyPhoto: 'Property Photo', progressPhoto: 'Progress Photo', invoice: 'Invoice', receipt: 'Receipt',
  lienWaiver: 'Lien Waiver', drawPaperwork: 'Draw Paperwork', contractBid: 'Contract / Bid', permitInspection: 'Permit / Inspection',
  closingTitle: 'Closing / Title', loanDocument: 'Loan Document', insurance: 'Insurance', plansSpecs: 'Plans / Specs',
  proposal: 'Proposal / Estimate', changeOrder: 'Change Order', payApplication: 'Pay Application', financialStatement: 'Financial Statement',
  bankStatement: 'Bank Statement', taxReturn: 'Tax Return', taxForm: 'W-9 / 1099', travel: 'Travel Document', entityDocument: 'Entity Document', email: 'Email', other: 'Other',
};
/** Saved from Gmail (mail.js). An older Mac re-saves an unknown type as Other, but keeps the tag. */
const isEmailFile = (f) => f?.category === 'email' || (Array.isArray(f?.tags) && f.tags.includes('Email'));
const PHOTO_CATEGORIES = new Set(['propertyPhoto', 'progressPhoto']);
const DOCUMENT_ORDER = ['plansSpecs', 'invoice', 'receipt', 'lienWaiver', 'drawPaperwork', 'proposal', 'contractBid', 'changeOrder',
  'payApplication', 'permitInspection', 'closingTitle', 'loanDocument', 'insurance', 'other'];
const UPLOAD_CHOICES = ['progressPhoto', 'propertyPhoto', 'plansSpecs', 'receipt', 'invoice', 'permitInspection', 'lienWaiver', 'contractBid', 'changeOrder', 'insurance', 'email', 'other'];
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'heic', 'heif', 'tif', 'tiff', 'gif', 'webp', 'bmp']);
const CONTENT_TYPES = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif',
  tif: 'image/tiff', tiff: 'image/tiff', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', txt: 'text/plain', csv: 'text/csv',
  rtf: 'application/rtf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odt: 'application/vnd.oasis.opendocument.text', zip: 'application/zip',
};
const contentType = (ext) => CONTENT_TYPES[(ext || '').toLowerCase()] || 'application/octet-stream';

const EVENT_KINDS = {
  appointment: ['Appointment', 'var(--olive)'], meeting: ['Meeting', 'var(--plum)'], siteVisit: ['Site visit', 'var(--leather)'],
  inspection: ['Inspection', 'var(--spruce)'], closing: ['Closing', 'var(--gold)'], deadline: ['Deadline', 'var(--danger)'],
  travel: ['Travel', 'var(--slate)'], personal: ['Personal', 'var(--walnut)'],
};
const REPEATS = { never: 'Never', daily: 'Every day', weekdays: 'Every weekday', weekly: 'Every week', everyTwoWeeks: 'Every 2 weeks', monthly: 'Every month', yearly: 'Every year' };
const REMINDERS_TIMED = [[0, 'At start'], [10, '10 minutes before'], [30, '30 minutes before'], [60, '1 hour before'], [120, '2 hours before'], [1440, '1 day before']];
const REMINDERS_ALLDAY = [[0, 'Morning of'], [1440, '1 day before'], [2880, '2 days before'], [10080, '1 week before']];
const PUNCH = { open: ['Open', 'var(--stone)'], ready: ['Ready to check', 'var(--slate)'], closed: ['Done', 'var(--success)'] };
const WORK = { notStarted: ['Not Started', 'var(--stone)'], working: ['Working On It', 'var(--forest)'], stuck: ['Stuck', 'var(--danger)'], done: ['Done', 'var(--success)'] };
const PROGRESS = { done: 'Done', late: 'Late', behind: 'Should have started', inProgress: 'In progress', upcoming: 'Upcoming' };
const WEATHER_CHOICES = ['Sunny', 'Partly cloudy', 'Cloudy', 'Rain', 'Thunderstorms', 'Snow', 'Windy', 'Hot', 'Cold', 'Freezing'];
const PROJECT_COLORS = ['var(--forest)', 'var(--gold)', 'var(--leather)', 'var(--slate)', 'var(--spruce)', 'var(--olive)', 'var(--plum)', 'var(--tan)', 'var(--walnut)', 'var(--sage)'];
function projectColor(id) {
  let h = 0;
  for (const c of key(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PROJECT_COLORS[h % PROJECT_COLORS.length];
}

// ---------------------------------------------------------------------------
// Appearance (Settings → Appearance; Light by default, like the Mac)

function themeChoice() { try { return localStorage.getItem('ec-theme') || 'light'; } catch { return 'light'; } }
function applyTheme(choice = themeChoice()) {
  try { localStorage.setItem('ec-theme', choice); } catch { /* private mode */ }
  const dark = choice === 'dark' || (choice === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('meta[name=theme-color]')?.setAttribute('content', dark ? '#1C1D20' : '#F4F5F8');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (themeChoice() === 'system') applyTheme('system'); });

// Folded groups and filters are remembered on this device.
const prefs = (() => {
  let p = {};
  try { p = JSON.parse(localStorage.getItem('ec-ui') || '{}'); } catch { /* fine */ }
  return {
    get: (k, d) => (k in p ? p[k] : d),
    set: (k, v) => { p[k] = v; try { localStorage.setItem('ec-ui', JSON.stringify(p)); } catch { /* fine */ } },
  };
})();

// ---------------------------------------------------------------------------
// On-device storage (IndexedDB). `rawIDB` is the database as it is; `idb` seals and opens
// values with the app lock's key (lock.js) on the way in and out, so records, photos and the
// sign-in are ciphertext on the device once a lock is set up.

const rawIDB = (() => {
  let opening;
  const STORES = ['kv', 'docs', 'blobs', 'cache'];
  function open() {
    opening = opening || new Promise((resolve, reject) => {
      const req = indexedDB.open('eaglecreek', 1);
      req.onupgradeneeded = () => { for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return opening;
  }
  async function run(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let result;
      const req = fn(tx.objectStore(store));
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  return {
    get: (s, k) => run(s, 'readonly', (st) => st.get(k)),
    set: (s, k, v) => run(s, 'readwrite', (st) => st.put(v, k)),
    del: (s, k) => run(s, 'readwrite', (st) => st.delete(k)),
    clear: (s) => run(s, 'readwrite', (st) => st.clear()),
    batch: (s, puts, dels = []) => run(s, 'readwrite', (st) => { for (const [k, v] of puts) st.put(v, k); for (const k of dels) st.delete(k); }),
    async all(s) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const out = [];
        const tx = db.transaction(s);
        const cur = tx.objectStore(s).openCursor();
        cur.onsuccess = () => { const c = cur.result; if (c) { out.push([c.key, c.value]); c.continue(); } };
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(tx.error);
      });
    },
  };
})();

const idb = {
  async get(s, k) { return LOCK.open(await rawIDB.get(s, k)); },
  async set(s, k, v) { return rawIDB.set(s, k, LOCK.seals(s, k) ? await LOCK.seal(v) : v); },
  del: (s, k) => rawIDB.del(s, k),
  clear: (s) => rawIDB.clear(s),
  async batch(s, puts, dels = []) {
    const sealed = [];
    for (const [k, v] of puts) sealed.push([k, LOCK.seals(s, k) ? await LOCK.seal(v) : v]);
    return rawIDB.batch(s, sealed, dels);
  },
  async all(s) {
    const rows = await rawIDB.all(s);
    const out = [];
    for (const [k, v] of rows) out.push([k, await LOCK.open(v)]);
    return out;
  },
};

// ---------------------------------------------------------------------------
// App state

const freshMeta = () => ({ cursor: null, lastFull: 0, lastSync: 0, ledgerCursor: null, ledgerLastFull: 0, uploads: [], storageDeletes: [], kinds: KINDS_KEY, recordOps: {} });
const S = {
  config: null, // { url, key }
  session: null, // { accessToken, refreshToken, expiresAt, userID, email }
  team: null, // this person's place on the team (team.js): { role, owner, access, disabled, username, name }
  docs: new Map(), // id (lowercase) -> { id, kind, deleted, data }
  dirty: new Set(), // ids with edits not uploaded yet
  meta: freshMeta(),
  syncing: false,
  syncError: null,
  syncDetail: '',
  version: 0,
  ui: { calDay: sod(new Date()), calMode: 'day', filesOpen: {}, search: '' },
};

function bump() { S.version++; }

// Lists by kind, schedules and file lookups, worked out once per change.
const memo = { v: -1, day: '', byKind: new Map(), schedules: new Map(), byRecord: null, byProject: null, books: null, cache: new Map() };
function fresh() {
  const today = fmt.inputDate(new Date());
  if (memo.v !== S.version || memo.day !== today) {
    memo.v = S.version; memo.day = today;
    memo.byKind = new Map(); memo.schedules = new Map(); memo.byRecord = null; memo.byProject = null; memo.contactLinks = null;
    memo.books = null; memo.cache = new Map(); // books.js and the money pages
    for (const row of S.docs.values()) {
      if (row.deleted) continue;
      if (!memo.byKind.has(row.kind)) memo.byKind.set(row.kind, []);
      memo.byKind.get(row.kind).push(row.data);
    }
  }
  return memo;
}
const all = (kind) => fresh().byKind.get(kind) || [];
const get = (id) => { const row = S.docs.get(key(id)); return row && !row.deleted ? row.data : null; };
const projects = () => all('project');
const project = (id) => (id ? get(id) : null);
const company = () => all('company').slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || {};
const contacts = () => all('contact').filter((c) => !c.isArchived).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
const contactName = (id) => { const c = id && get(id); return c ? (c.name || c.contactName || '') : ''; };
const projectName = (p) => (p?.name || '').trim() || (p?.property?.street || '').trim() || 'Untitled Project';
function projectAddress(p) {
  const pr = p?.property || {};
  let csz = pr.city || '';
  if (pr.state) csz += csz ? `, ${pr.state}` : pr.state;
  if (pr.zip) csz += csz ? ` ${pr.zip}` : pr.zip;
  return [pr.street, csz].filter(Boolean).join(', ');
}
const fileTitle = (f) => (f.title || '').trim() || f.originalFileName || CATEGORY_ONE[f.category] || 'File';
const storageName = (f) => { const ext = (f.fileExtension || '').toLowerCase(); return ext ? `${key(f.id)}.${ext}` : key(f.id); };
const isImage = (f) => IMAGE_EXT.has((f.fileExtension || '').toLowerCase());
const isPDF = (f) => (f.fileExtension || '').toLowerCase() === 'pdf';
const fileDate = (f) => fromSec(f.documentDate || f.addedAt);
function filesFor(field, id) {
  const m = fresh();
  const prop = field === 'recordID' ? 'byRecord' : 'byProject';
  if (!m[prop]) {
    m[prop] = new Map();
    for (const f of all('file')) {
      const k = key(f[field]);
      if (!k) continue;
      if (!m[prop].has(k)) m[prop].set(k, []);
      m[prop].get(k).push(f);
    }
  }
  return m[prop].get(key(id)) || [];
}
const isPending = (f) => S.meta.uploads.includes(key(f.id));

async function saveMeta() {
  await idb.set('kv', 'meta', { ...S.meta, dirty: [...S.dirty] });
}

/** Saves an edited or new record and queues it for upload (the Mac's saveRecord). */
async function saveRecord(kind, data, { upload = true } = {}) {
  if (!canEditRecord(kind, data)) throw refuseViewOnly(kind === 'file' && fileGoesWithBooks(data) ? 'transaction' : kind);
  const id = key(data.id);
  data.updatedAt = stampAfter(Math.max(Number(data.updatedAt) || 0, Number(S.docs.get(id)?.data?.updatedAt) || 0));
  const row = { id, kind, deleted: false, data };
  S.docs.set(id, row);
  if (upload) S.dirty.add(id);
  bump();
  await idb.set('docs', id, row);
  await saveMeta();
  if (upload) scheduleSync();
  return data;
}

async function deleteRecord(kind, id) {
  if (!canEditKind(kind)) throw refuseViewOnly(kind);
  const k = key(id);
  const row = { id: k, kind, deleted: true, data: { updatedAt: stampAfter(S.docs.get(k)?.data?.updatedAt) } };
  S.docs.set(k, row);
  S.dirty.add(k);
  bump();
  await idb.set('docs', k, row);
  await saveMeta();
  scheduleSync();
}

/**
 * Changes to records the Mac edits too: a project (its selections and draws live inside it) or
 * a bill (its payments' lien waivers). Each change is kept as a small step (RECORD_OPS, from
 * budget.js and money.js) until it has reached Supabase. If the record changed on the Mac in the
 * meantime, the steps are made again on the Mac's newer copy before it's sent (applyRemote), so
 * neither side's edit is lost, with signal or without. Returns the record as saved here.
 */
const RECORD_OPS = {};
function applyRecordOps(data, ops) {
  for (const op of ops) RECORD_OPS[op.op]?.(data, op);
  return data;
}
async function editRecord(kind, id, ops) {
  if (!canEditKind(kind)) throw refuseViewOnly(kind);
  const current = get(id);
  if (!current || S.docs.get(key(id))?.kind !== kind) { toast(kind === 'project' ? 'This project was deleted on the Mac.' : 'This was deleted on the Mac.'); return null; }
  const k = key(id);
  if (!S.meta.recordOps[k]) S.meta.recordOps[k] = { kind, base: Number(current.updatedAt) || 0, ops: [] };
  S.meta.recordOps[k].ops.push(...clone(ops));
  const data = applyRecordOps(clone(current), ops);
  await saveRecord(kind, data, { upload: true });
  clearTimeout(syncTimer);
  syncNow();
  renderSoon();
  return data;
}
const editProject = (projectID, ops) => editRecord('project', projectID, ops);

// ---------------------------------------------------------------------------
// Supabase

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function friendlyError(e) {
  const m = String(e?.message || e || '');
  if (/permission denied for table/i.test(m)) return "Supabase won't let the app use its table yet. Run supabase/setup.sql again in the Supabase SQL Editor.";
  if (/invalid login credentials/i.test(m)) return "That email and password didn't work.";
  if (/email not confirmed/i.test(m)) return 'This account still needs its email confirmed. Use the link Supabase emailed you.';
  if (/failed to fetch|networkerror|load failed|network connection/i.test(m)) return navigator.onLine ? "Couldn't reach Supabase. Check the project URL, or try again in a moment." : "You're offline. Changes are saved here and upload when there's signal.";
  if (/invalid api key|no api key/i.test(m)) return "Supabase didn't accept the key. Use the project's anon or publishable key.";
  if (/relation .*documents.* does not exist|could not find the table/i.test(m)) return "This Supabase project doesn't have the Eagle Creek table yet. Run supabase/setup.sql in its SQL Editor.";
  return m || 'Something went wrong.';
}

async function api(path, { method = 'GET', query, headers = {}, body, token, raw = false } = {}) {
  const base = (S.config?.url || '').trim().replace(/\/+$/, '');
  const anon = (S.config?.key || '').trim();
  if (!base || !anon) throw new ApiError(0, 'Supabase is not set up.');
  const url = new URL(base + path);
  if (query) for (const [k, v] of query) url.searchParams.append(k, v);
  const h = { apikey: anon, ...headers };
  // Signed in, the user's token; before that, only an old-style anon key (a JWT) goes here too.
  if (token) h.Authorization = `Bearer ${token}`;
  else if (anon.startsWith('eyJ')) h.Authorization = `Bearer ${anon}`;
  // Which app made each change, for the change history Eagle Creek Books shows (setup.sql v1.3).
  const named = path.startsWith('/rest/v1/') && !S.noClientHeader;
  if (named) h['X-Client-App'] = CLIENT_APP;
  let res;
  try {
    res = await fetch(url.toString(), { method, headers: h, body, cache: 'no-store' });
  } catch (e) {
    // A Supabase that won't take the extra header (its CORS rules): carry on without it.
    if (!named || !navigator.onLine) throw e;
    delete h['X-Client-App'];
    res = await fetch(url.toString(), { method, headers: h, body, cache: 'no-store' });
    S.noClientHeader = true;
  }
  if (!res.ok) {
    let msg = '';
    try {
      const text = await res.text();
      try {
        const obj = JSON.parse(text);
        msg = obj.error_description || obj.msg || obj.message || obj.error || obj.hint || text;
      } catch { msg = text; }
    } catch { /* ignore */ }
    throw new ApiError(res.status, String(msg || `Server error ${res.status}`).slice(0, 300));
  }
  if (raw) return res;
  const type = res.headers.get('content-type') || '';
  if (res.status === 204 || !type.includes('json')) return null;
  return res.json();
}

function parseSession(obj, fallbackEmail) {
  if (!obj?.access_token || !obj?.refresh_token) return null;
  return {
    accessToken: obj.access_token,
    refreshToken: obj.refresh_token,
    expiresAt: Date.now() / 1000 + (Number(obj.expires_in) || 3600),
    userID: String(obj.user?.id || '').toLowerCase(),
    email: obj.user?.email || fallbackEmail || '',
  };
}

async function signIn(email, password) {
  email = loginAddress(email);
  const data = await api('/auth/v1/token', {
    method: 'POST', query: [['grant_type', 'password']],
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const session = parseSession(data, email);
  if (!session) throw new Error('Unexpected response from Supabase.');
  S.session = session;
  S.meta.cursor = null;
  S.meta.lastFull = 0;
  await idb.set('kv', 'session', session);
  await saveMeta();
  // What this person may see, before anything is shown.
  S.team = null;
  try { await loadMyAccess(session.accessToken); } catch { /* the first sync tries again */ }
  // A fresh sign-in on a device that was signed out from the Mac: its old row says "signed
  // out" until this device registers again, so that row isn't obeyed once more.
  await rawIDB.set('kv', 'device-fresh', true);
}

async function validSession(force = false) {
  const s = S.session;
  if (!s) throw new ApiError(401, 'Sign in to sync.');
  if (!force && s.expiresAt - Date.now() / 1000 > 120) return s;
  try {
    const data = await api('/auth/v1/token', {
      method: 'POST', query: [['grant_type', 'refresh_token']],
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: s.refreshToken }),
    });
    const next = parseSession(data, s.email);
    if (!next) throw new Error('Unexpected response from Supabase.');
    if (!next.userID) next.userID = s.userID;
    S.session = next;
    await idb.set('kv', 'session', next);
    return next;
  } catch (e) {
    if (e instanceof ApiError && [400, 401, 403].includes(e.status) && /banned/i.test(e.message)) {
      // Turned off by the owner (Settings › Team): this device's copy goes.
      await LOCK.wipe(TURNED_OFF_NOTICE);
      throw new ApiError(401, 'The owner turned off your access to Eagle Creek.');
    }
    if (e instanceof ApiError && [400, 401, 403].includes(e.status)) {
      // The sign-in ran out. Data on the device stays; signing in again picks up where it left off.
      S.lastEmail = s.email;
      S.session = null;
      await idb.del('kv', 'session');
      render();
      throw new ApiError(401, 'Your sign-in expired. Sign in again.');
    }
    throw e;
  }
}

async function signOut() {
  const s = S.session;
  if (s) {
    try { await api('/auth/v1/logout', { method: 'POST', token: s.accessToken, headers: { 'Content-Type': 'application/json' } }); } catch { /* fine */ }
  }
  S.session = null;
  await idb.del('kv', 'session');
}

/** Reads a Postgres timestamp ("2026-10-08 20:59:00.123456+00:00") in any browser. */
function serverStamp(text) {
  if (!text) return null;
  const v = Date.parse(String(text).replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1').replace(/([+-]\d\d)$/, '$1:00'));
  return Number.isFinite(v) ? v / 1000 : null;
}

/** Rows changed since the cursor (or everything). Falls back to everything without server stamps. */
async function fetchChanges(token, since, table = 'documents') {
  const kinds = `in.(${(table === LEDGER_TABLE ? LEDGER_KINDS : KINDS).join(',')})`;
  async function pages(withStamps, sinceISO) {
    const rows = [];
    for (;;) {
      const q = [['select', withStamps ? 'id,kind,deleted,data,server_updated_at' : 'id,kind,deleted,data'], ['kind', kinds]];
      if (sinceISO) q.push(['server_updated_at', `gt.${sinceISO}`]);
      q.push(['order', 'id.asc'], ['limit', '1000'], ['offset', String(rows.length)]);
      const page = await api(`/rest/v1/${table}`, { query: q, token });
      if (!Array.isArray(page)) throw new Error('Unexpected response from Supabase.');
      rows.push(...page);
      // Stop at an empty page: Supabase may cap pages below 1,000.
      if (page.length === 0 || rows.length > 200_000) break;
    }
    return rows;
  }
  try {
    const sinceISO = since ? new Date(since * 1000).toISOString().replace(/\.\d+Z$/, 'Z') : null;
    const rows = await pages(true, sinceISO);
    let newest = null;
    for (const r of rows) {
      const t = serverStamp(r.server_updated_at);
      if (t && (!newest || t > newest)) newest = t;
    }
    return { rows, newest, stamps: true };
  } catch (e) {
    if (e instanceof ApiError && e.status === 400 && /server_updated_at/.test(e.message)) {
      return { rows: await pages(false, null), newest: null, stamps: false };
    }
    throw e;
  }
}

/** Newest edit wins, unless there are newer unsent edits here (the Mac's rule for job records). */
async function applyRemote(rows) {
  const puts = [];
  const dels = [];
  let changed = false;
  let rebasedAny = false;
  for (const r of rows) {
    if (!r || !r.id || !(KINDS.includes(r.kind) || LEDGER_KINDS.includes(r.kind))) continue;
    const id = key(r.id);
    const data = r.data && typeof r.data === 'object' ? r.data : {};
    const remoteStamp = Number(data.updatedAt) || 0;
    const local = S.docs.get(id);
    const pending = !r.deleted && S.meta.recordOps?.[id];
    if (pending && local && S.dirty.has(id)) {
      const localStamp = Number(local.data?.updatedAt) || 0;
      // Changed on the Mac since the copy these edits were made on: make them again on its copy.
      if (Math.abs(remoteStamp - pending.base) > 0.001 && Math.abs(remoteStamp - localStamp) > 0.001) {
        const rebased = applyRecordOps(clone(data), pending.ops);
        rebased.updatedAt = stampAfter(remoteStamp);
        pending.base = remoteStamp;
        const row = { id, kind: r.kind, deleted: false, data: rebased };
        S.docs.set(id, row);
        puts.push([id, row]);
        changed = true;
        rebasedAny = true;
        continue;
      }
    }
    if (local && S.dirty.has(id)) {
      const localStamp = Number(local.data?.updatedAt) || 0;
      if (remoteStamp - localStamp <= 0.001) continue; // ours is newer: keep it and send it
      S.dirty.delete(id);
    }
    if (r.deleted) {
      if (local) { S.docs.delete(id); dels.push(id); changed = true; }
      continue;
    }
    if (local && !local.deleted && local.kind === r.kind && Math.abs((Number(local.data?.updatedAt) || 0) - remoteStamp) <= 0.001) continue;
    const row = { id, kind: r.kind, deleted: false, data };
    S.docs.set(id, row);
    puts.push([id, row]);
    changed = true;
  }
  if (puts.length || dels.length) await idb.batch('docs', puts, dels);
  if (rebasedAny) await saveMeta();
  if (changed) bump();
  return changed;
}

/** Removes the stored copies of photos deleted here. */
async function deleteStoredFiles(session) {
  for (const name of [...S.meta.storageDeletes]) {
    try {
      await api(`/storage/v1/object/files/${dataOwner()}/${name}`, { method: 'DELETE', token: session.accessToken });
    } catch (e) {
      if (!(e instanceof ApiError && (e.status === 400 || e.status === 404))) continue; // try again next sync
    }
    S.meta.storageDeletes = S.meta.storageDeletes.filter((x) => x !== name);
    await saveMeta();
  }
}

let uploadedSomething = false;
async function uploadFiles(session) {
  let failed = 0;
  let tooLarge = 0;
  const owner = dataOwner();
  if (!owner) return null;
  if (!canEdit('files')) return null;
  const queue = [...S.meta.uploads];
  for (const [index, fileId] of queue.entries()) {
    const pending = await idb.get('blobs', fileId);
    const row = S.docs.get(fileId);
    if (!pending || !row || row.deleted) {
      S.meta.uploads = S.meta.uploads.filter((x) => x !== fileId);
      await idb.del('blobs', fileId);
      continue;
    }
    if (pending.blob.size > UPLOAD_LIMIT) { tooLarge++; continue; }
    S.syncDetail = queue.length === 1 ? 'Uploading a photo…' : `Uploading ${index + 1} of ${queue.length}…`;
    renderHeader();
    try {
      await api(`/storage/v1/object/files/${owner}/${storageName(row.data)}`, {
        method: 'POST', token: session.accessToken,
        headers: { 'Content-Type': pending.contentType, 'x-upsert': 'true' }, body: pending.blob,
      });
      // The file is there; now its record can go up, so the Mac never sees one without the other.
      S.meta.uploads = S.meta.uploads.filter((x) => x !== fileId);
      S.dirty.add(fileId);
      await idb.set('cache', `${fileId}@${row.data.contentRevision || 0}`, pending.blob);
      await idb.del('blobs', fileId);
      await saveMeta();
      uploadedSomething = true;
    } catch (e) {
      if (e instanceof ApiError && /bucket/i.test(e.message)) return "File storage isn't set up. Run supabase/setup.sql in the Supabase SQL Editor.";
      if (e instanceof ApiError && e.status === 413) { tooLarge++; continue; }
      failed++;
    }
  }
  if (tooLarge) return `${plural(tooLarge, 'file')} ${tooLarge === 1 ? 'is' : 'are'} over 50 MB and can't upload.`;
  if (failed) return `${plural(failed, 'file')} didn't upload yet. It'll try again.`;
  return null;
}

async function pushChanges(token) {
  // Supabase keeps the newer copy when two devices save the same record (setup.sql v1.3), and
  // says which rows it took. One it turned down was changed on the Mac since this device last
  // looked: its newer copy is fetched, edits kept as steps are made again on it, and it goes
  // up again; any other edit gives way to the Mac's newer one, as on the Mac.
  const superseded = [];
  // Changes to areas this person can't change never go up (the database would refuse them);
  // the server's copies come back on the next full read.
  let refused = 0;
  for (const id of [...S.dirty]) {
    const row = S.docs.get(id);
    if (row && !row.deleted && !canEditRecord(row.kind, row.data)) { S.dirty.delete(id); delete S.meta.recordOps[id]; refused++; }
    else if (row && row.deleted && !canEditKind(row.kind)) { S.dirty.delete(id); refused++; }
  }
  for (let round = 0; round < 3; round++) {
    const ids = [...S.dirty].filter((id) => S.docs.has(id) && !S.meta.uploads.includes(id));
    if (!ids.length) break;
    const turnedDown = [];
    // Each table gets its own rows (Eagle Creek Books' bank lines go to ledger_documents).
    const batches = [];
    for (const table of ['documents', LEDGER_TABLE]) {
      const mine = ids.filter((id) => tableFor(S.docs.get(id).kind) === table);
      for (let i = 0; i < mine.length; i += 100) batches.push([table, mine.slice(i, i + 100)]);
    }
    for (const [table, chunk] of batches) {
      const sent = chunk.map((id) => {
        const row = S.docs.get(id);
        const body = {
          id, kind: row.kind, deleted: row.deleted,
          updated_at: new Date((row.data.updatedAt || stamp()) * 1000).toISOString(), data: row.data,
        };
        if (table === LEDGER_TABLE) body.entity_id = row.data.entityID ? key(row.data.entityID) : null;
        return { id, stamp: row.data.updatedAt, deleted: row.deleted, body };
      });
      let saved;
      try {
        saved = await api(`/rest/v1/${table}`, {
          method: 'POST', token, query: [['select', 'id']],
          headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify(sent.map((x) => x.body)),
        });
      } catch (e) {
        // The database's team rules turned these down (access changed since this device last
        // looked): they're dropped here and the server's copies come back on the next read.
        if (!(e instanceof ApiError && [401, 403].includes(e.status) && /row-level security|permission denied/i.test(e.message))) throw e;
        for (const x of sent) { S.dirty.delete(x.id); delete S.meta.recordOps[x.id]; refused++; }
        await saveMeta();
        continue;
      }
      // An older Supabase setup may not list them: then everything sent was taken.
      const took = Array.isArray(saved) ? new Set(saved.map((r) => key(r.id))) : null;
      const dels = [];
      for (const x of sent) {
        if (took && !took.has(x.id)) { turnedDown.push(x.id); continue; }
        const row = S.docs.get(x.id);
        // Clear only what went up; anything edited meanwhile goes next time.
        if (row && row.data.updatedAt === x.stamp) {
          S.dirty.delete(x.id);
          delete S.meta.recordOps[x.id]; // its edits are in Supabase now
          if (row.deleted) { S.docs.delete(x.id); dels.push(x.id); }
        }
      }
      if (dels.length) { await idb.batch('docs', [], dels); bump(); }
      await saveMeta();
    }
    if (!turnedDown.length) break;
    superseded.push(...await takeNewerCopies(token, turnedDown));
  }
  if (refused) {
    S.meta.cursor = null;
    S.meta.lastFull = 0;
    S.meta.ledgerCursor = null;
    await saveMeta();
    toast(refused === 1 ? "A change wasn't saved: your access doesn't include changing it." : `${refused} changes weren't saved: your access doesn't include changing them.`);
  }
  if (superseded.length) {
    const names = [...new Set(superseded)];
    toast(names.length === 1 ? `${names[0]} was changed on another device at the same time, so its newer version was kept.` : `${names.length} records were changed on another device at the same time, so their newer versions were kept.`);
  }
}

/** A short name for a record, for messages. */
function recordLabel(row) {
  const d = row?.data || {};
  if (row?.kind === 'project') return projectName(d);
  if (row?.kind === 'transaction') return (d.payee || '').trim() || contactName(d.contactID) || 'An entry in the books';
  return (d.name || d.title || d.payee || '').trim() || 'A record';
}

/**
 * Supabase kept its own, newer copy of these records. Brings that copy in: edits kept as steps
 * are made again on it (and stay queued), anything else gives way to it. Returns the names of
 * records whose edit here gave way.
 */
async function takeNewerCopies(token, ids) {
  const lost = [];
  const byTable = { documents: ids.filter((id) => tableFor(S.docs.get(id)?.kind) === 'documents'), [LEDGER_TABLE]: ids.filter((id) => tableFor(S.docs.get(id)?.kind) === LEDGER_TABLE) };
  for (const [table, list] of Object.entries(byTable)) for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const rows = await api(`/rest/v1/${table}`, {
      token, query: [['select', 'id,kind,deleted,data,updated_at'], ['id', `in.(${chunk.join(',')})`]],
    });
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      const id = key(r.id);
      const before = S.docs.get(id);
      const hadSteps = !!S.meta.recordOps?.[id];
      await applyRemote([r]);
      const local = S.docs.get(id);
      if (S.dirty.has(id) && local) {
        // Still ours to send (rebased, or newer by the record's own stamp): stamp it after the
        // copy Supabase holds, so it's taken this time.
        const held = Date.parse(r.updated_at || '') / 1000;
        if (Number.isFinite(held) && (Number(local.data.updatedAt) || 0) <= held) {
          local.data.updatedAt = Math.round((held + 0.001) * 1000) / 1000;
          await idb.set('docs', id, local);
        }
      } else if (before && !hadSteps) {
        lost.push(recordLabel(before.deleted ? { kind: r.kind, data: r.data } : before));
      }
    }
  }
  await saveMeta();
  return lost;
}

let syncTimer = null;
function scheduleSync(delay = 1500) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(), delay);
  renderHeader();
}

async function syncNow({ full = false } = {}) {
  if (!S.session || !S.config) return;
  if (S.syncing) { scheduleSync(4000); return; }
  if (!navigator.onLine) { S.syncError = null; renderHeader(); return; }
  S.syncing = true;
  S.syncDetail = 'Checking for changes…';
  renderHeader();
  let changed = false;
  uploadedSomething = false;
  try {
    let session = await validSession();
    // Who this is on the team, first: what they may see decides what's read and kept.
    if (await loadMyAccess(session.accessToken)) changed = true;
    if (S.team?.disabled) { await LOCK.wipe(TURNED_OFF_NOTICE); return; }
    // Only what changed (with five minutes' overlap), and everything once a day as a safety net.
    let since = null;
    if (!full && S.meta.cursor && Date.now() / 1000 - (S.meta.lastFull || 0) < 86_400) since = S.meta.cursor - 300;
    let changes;
    try {
      changes = await fetchChanges(session.accessToken, since);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) throw e;
      session = await validSession(true);
      changes = await fetchChanges(session.accessToken, since);
    }
    changed = await applyRemote(changes.rows);
    if (changes.stamps) {
      if (changes.newest) S.meta.cursor = Math.max(S.meta.cursor || 0, changes.newest);
      if (since === null) S.meta.lastFull = Date.now() / 1000;
    } else {
      S.meta.cursor = null;
      S.meta.lastFull = 0;
    }
    // Eagle Creek Books' bank lines, from its own table (missing on a Supabase project that
    // hasn't run setup.sql v1.3: then there's simply no bank feed here).
    let sinceLedger = null;
    if (!full && S.meta.ledgerCursor && Date.now() / 1000 - (S.meta.ledgerLastFull || 0) < 86_400) sinceLedger = S.meta.ledgerCursor - 300;
    try {
      const ledger = await fetchChanges(session.accessToken, sinceLedger, LEDGER_TABLE);
      if (await applyRemote(ledger.rows)) changed = true;
      if (ledger.stamps) {
        if (ledger.newest) S.meta.ledgerCursor = Math.max(S.meta.ledgerCursor || 0, ledger.newest);
        if (sinceLedger === null) S.meta.ledgerLastFull = Date.now() / 1000;
      }
      S.ledgerUnavailable = false;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || /ledger_documents/.test(e.message))) S.ledgerUnavailable = true; else throw e;
    }
    if (await deviceCheckIn()) return; // signed out from the Mac: everything here is gone
    await deleteStoredFiles(session);
    const fileProblem = await uploadFiles(session);
    S.syncDetail = 'Sending changes…';
    renderHeader();
    await pushChanges(session.accessToken);
    S.meta.lastSync = Date.now() / 1000;
    S.syncError = fileProblem;
    await saveMeta();
  } catch (e) {
    S.syncError = friendlyError(e);
  } finally {
    S.syncing = false;
    S.syncDetail = '';
    if (changed || uploadedSomething || route().name === 'settings') renderSoon(); else renderHeader();
    if (changed && typeof planOnSync === 'function') planOnSync();
  }
}

// ---------------------------------------------------------------------------
// Files: adding photos and documents, and reading them back

function extOf(name) { const m = /\.([A-Za-z0-9]{1,8})$/.exec(name || ''); return m ? m[1].toLowerCase() : ''; }

/** Photos are resized on the phone (longest side 2400 px) so they upload fast from the site. */
async function prepareImage(file) {
  const ext = extOf(file.name) || (file.type.split('/')[1] || '');
  if (!/^image\//.test(file.type) && !IMAGE_EXT.has(ext)) return null;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const max = 2400;
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && /jpe?g/.test(file.type) && file.size < 4_000_000) { bitmap.close?.(); return null; }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    return blob && blob.size > 0 ? blob : null;
  } catch {
    return null; // a format this browser can't open (HEIC in Chrome): upload it as it is
  }
}

function photoName(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `Photo ${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}.${p(date.getMinutes())}.${p(date.getSeconds())}`;
}

/** Adds files as the Mac's VaultDocuments: saved here at once, uploaded on the next sync. */
async function addFiles(fileList, { projectID = null, category = 'progressPhoto', recordID = null, needsReview = false, contactID = null, transactionID = null, drawID = null, folderID = null, ids = null } = {}) {
  const files = [...fileList];
  if (!files.length) return 0;
  if (!canEdit('files')) { refuseViewOnly('file'); return 0; }
  toast(files.length === 1 ? 'Saving…' : `Saving ${files.length} files…`);
  let added = 0;
  for (const file of files) {
    const resized = await prepareImage(file);
    let blob = file;
    let ext = extOf(file.name) || (file.type === 'image/jpeg' ? 'jpg' : (file.type.split('/')[1] || ''));
    let name = file.name || '';
    const taken = file.lastModified ? new Date(file.lastModified) : new Date();
    if (resized) {
      blob = resized;
      ext = 'jpg';
      const base = name.replace(/\.[^.]+$/, '');
      name = (!base || /^image$/i.test(base) ? photoName(taken) : base) + '.jpg';
    } else if (!name || /^image\.\w+$/i.test(name)) {
      name = `${photoName(taken)}.${ext || 'jpg'}`;
    }
    if (blob.size > UPLOAD_LIMIT) { toast(`${name} is over 50 MB, too large to sync.`); continue; }
    const now = stamp();
    const doc = {
      id: newId(), category, title: '', originalFileName: name, fileExtension: ext, fileSize: blob.size,
      documentDate: Math.min(toSec(taken), now), addedAt: now, updatedAt: now, notes: '', tags: [], vendor: '', amount: 0,
      isPaid: false, includeInPackage: true, sortIndex: 0, contentRevision: 0, needsReview,
    };
    if (projectID) doc.projectID = projectID;
    if (recordID) doc.recordID = recordID;
    if (contactID) doc.contactID = contactID;
    if (transactionID) doc.transactionID = transactionID;
    if (drawID) doc.drawID = drawID;
    if (folderID && PHOTO_CATEGORIES.has(category)) doc.folderID = folderID;
    if (ids) ids.push(doc.id);
    const id = key(doc.id);
    await idb.set('blobs', id, { blob, contentType: contentType(ext) });
    S.meta.uploads.push(id);
    await saveRecord('file', doc, { upload: false });
    added++;
  }
  await saveMeta();
  scheduleSync(300);
  if (added) toast(added === 1 ? 'Added. It uploads when there\'s signal.' : `${added} added. They upload when there's signal.`);
  render();
  return added;
}

/** The file's contents: from this device if it's here, otherwise downloaded (and kept). */
async function fileBlob(f) {
  const id = key(f.id);
  const pending = await idb.get('blobs', id);
  if (pending) return pending.blob;
  const ck = `${id}@${f.contentRevision || 0}`;
  const cached = await idb.get('cache', ck);
  if (cached) return cached;
  const session = await validSession();
  const res = await api(`/storage/v1/object/authenticated/files/${dataOwner()}/${storageName(f)}`, { token: session.accessToken, raw: true });
  const blob = await res.blob();
  const typed = blob.type && blob.type !== 'application/octet-stream' ? blob : new Blob([blob], { type: contentType(f.fileExtension) });
  try { await idb.set('cache', ck, typed); } catch { /* storage full: still show it */ }
  return typed;
}

const thumbURLs = new Map();
async function thumbURL(f) {
  const tk = `thumb:${key(f.id)}@${f.contentRevision || 0}`;
  if (thumbURLs.has(tk)) return thumbURLs.get(tk);
  let thumb = await idb.get('cache', tk);
  if (!thumb) {
    const blob = await fileBlob(f);
    try {
      const bitmap = await createImageBitmap(blob);
      const size = 360;
      const scale = Math.min(1, size / Math.min(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close?.();
      thumb = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.75));
      if (thumb) await idb.set('cache', tk, thumb);
    } catch {
      thumb = null;
    }
  }
  if (!thumb) return null;
  const url = URL.createObjectURL(thumb);
  thumbURLs.set(tk, url);
  return url;
}

let thumbObserver = null;
function hydrateThumbs() {
  thumbObserver?.disconnect();
  thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      thumbObserver.unobserve(el);
      const f = get(el.dataset.thumb);
      if (!f) continue;
      thumbURL(f).then((url) => {
        if (!url) return;
        const badge = el.querySelector('.badge')?.outerHTML || '';
        el.innerHTML = `<img src="${url}" alt="">${badge}`;
      }).catch(() => {});
    }
  }, { rootMargin: '300px' });
  $$('[data-thumb]').forEach((el) => thumbObserver.observe(el));
}

let pickerHandler = null;
function pickFiles({ accept = 'image/*', capture = false, multiple = true }, onPick) {
  const input = $('#picker');
  input.value = '';
  input.accept = accept;
  input.multiple = multiple;
  if (capture) input.setAttribute('capture', 'environment'); else input.removeAttribute('capture');
  pickerHandler = onPick;
  input.click();
}

// ---------------------------------------------------------------------------
// Schedule math (the Mac's ScheduleEngine: workdays, US holidays, predecessors)

const holidayYears = new Map();
function weekdayUTC(y, m, d) { return new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 1; } // 1 = Sunday
function nthWeekday(n, wd, month, year) {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const matches = [];
  for (let d = 1; d <= days; d++) if (weekdayUTC(year, month, d) === wd) matches.push(d);
  if (n < 0) return matches[matches.length - 1];
  return matches[n - 1] ?? matches[matches.length - 1];
}
function observedDays(year) {
  const out = [];
  const fixed = (m, d) => {
    const wd = weekdayUTC(year, m, d);
    if (wd === 7) out.push(m === 1 && d === 1 ? [12, 31] : [m, d - 1]);
    else if (wd === 1) out.push([m, d + 1]);
    else out.push([m, d]);
  };
  fixed(1, 1);
  out.push([5, nthWeekday(-1, 2, 5, year)]);
  fixed(7, 4);
  out.push([9, nthWeekday(1, 2, 9, year)]);
  const tg = nthWeekday(4, 5, 11, year);
  out.push([11, tg], [11, tg + 1]);
  fixed(12, 25);
  return out;
}
function isHoliday(d) {
  const y = d.getFullYear(), m = d.getMonth() + 1, dd = d.getDate();
  if (m === 12 && dd === 31) return weekdayUTC(y + 1, 1, 1) === 7;
  if (!holidayYears.has(y)) holidayYears.set(y, new Set(observedDays(y).filter(([a, b]) => !(a === 12 && b === 31)).map(([a, b]) => a * 100 + b)));
  return holidayYears.get(y).has(m * 100 + dd);
}
function workCalendar() {
  const c = company().contractor || {};
  const sat = !!c.worksSaturdays;
  const hol = c.skipsHolidays !== false;
  const isWork = (d) => { const wd = d.getDay(); if (wd === 0) return false; if (wd === 6 && !sat) return false; return !(hol && isHoliday(d)); };
  const onOrAfter = (d) => { let x = sod(d); for (let i = 0; i < 60 && !isWork(x); i++) x = addDays(x, 1); return x; };
  const onOrBefore = (d) => { let x = sod(d); for (let i = 0; i < 60 && !isWork(x); i++) x = addDays(x, -1); return x; };
  const adding = (n, d) => {
    let cur = n >= 0 ? onOrAfter(d) : onOrBefore(d);
    let left = Math.abs(n);
    const dir = n >= 0 ? 1 : -1;
    for (let g = 0; left > 0 && g < 20000; g++) { cur = addDays(cur, dir); if (isWork(cur)) left--; }
    return cur;
  };
  const finish = (start, dur) => (dur <= 1 ? onOrAfter(start) : adding(dur - 1, start));
  return { isWork, onOrAfter, onOrBefore, adding, finish };
}
const isDone = (t) => (t.percentComplete || 0) >= 100 || t.actualFinish != null;
const isMilestone = (t) => (t.durationDays ?? 5) <= 0;
function workStatus(t) {
  if (isDone(t)) return 'done';
  if (t.isStuck) return 'stuck';
  if ((t.percentComplete || 0) > 0 || t.actualStart != null) return 'working';
  return 'notStarted';
}
const isLate = (s) => s.progress === 'late' || s.progress === 'behind';

/** Forecast dates for one project's tasks. */
function schedule(projectID) {
  const m = fresh();
  const mk = key(projectID);
  if (m.schedules.has(mk)) return m.schedules.get(mk);
  const tasks = all('task').filter((t) => sameId(t.projectID, projectID))
    .sort((a, b) => ((a.sortIndex || 0) - (b.sortIndex || 0)) || ((a.start || 0) - (b.start || 0)));
  if (!tasks.length) { m.schedules.set(mk, []); return []; }
  const cal = workCalendar();
  const byID = new Map(tasks.map((t) => [key(t.id), t]));
  const preds = new Map();
  for (const t of tasks) {
    const seen = new Set();
    preds.set(key(t.id), (t.predecessors || []).map(key).filter((p) => p !== key(t.id) && byID.has(p) && !seen.has(p) && seen.add(p)));
  }
  // Topological order; tasks caught in a loop keep their own dates.
  const indeg = new Map();
  const succ = new Map();
  for (const t of tasks) {
    const k = key(t.id);
    indeg.set(k, preds.get(k).length);
    for (const p of preds.get(k)) { if (!succ.has(p)) succ.set(p, []); succ.get(p).push(k); }
  }
  const queue = tasks.map((t) => key(t.id)).filter((k) => indeg.get(k) === 0);
  for (let i = 0; i < queue.length; i++) for (const n of succ.get(queue[i]) || []) { indeg.set(n, indeg.get(n) - 1); if (indeg.get(n) === 0) queue.push(n); }
  const placed = new Set(queue);
  for (const t of tasks) if (!placed.has(key(t.id))) queue.push(key(t.id));

  const today = sod(new Date());
  function pass(statusDate) {
    const early = new Map();
    for (const id of queue) {
      const t = byID.get(id);
      let start;
      if (t.actualStart != null) start = sod(fromSec(t.actualStart));
      else if (preds.get(id).length) {
        let latest = null;
        for (const p of preds.get(id)) {
          const pf = early.get(p)?.finish;
          if (!pf) continue;
          let c = isMilestone(t) ? cal.onOrAfter(pf) : cal.adding(1, pf);
          if ((t.lagDays || 0) > 0) c = cal.adding(t.lagDays, c);
          if (!latest || c > latest) latest = c;
        }
        start = latest || cal.onOrAfter(fromSec(t.start));
      } else start = cal.onOrAfter(fromSec(t.start));
      const started = (t.percentComplete || 0) > 0 || t.actualStart != null;
      if (statusDate && !isDone(t) && !started && start < statusDate) start = cal.onOrAfter(statusDate);
      let finish = isMilestone(t) ? start : cal.finish(start, t.durationDays ?? 5);
      if (t.actualFinish != null) finish = new Date(Math.max(sod(fromSec(t.actualFinish)), start));
      else if (statusDate && !isDone(t) && started && !isMilestone(t)) {
        const remaining = Math.max(1, Math.ceil((t.durationDays ?? 5) * (1 - Math.min(100, t.percentComplete || 0) / 100)));
        const fromToday = cal.finish(cal.onOrAfter(statusDate), remaining);
        if (fromToday > finish) finish = fromToday;
      }
      early.set(id, { start, finish });
    }
    return early;
  }
  const planned = pass(null);
  const early = pass(today);
  const result = tasks.map((t) => {
    const k = key(t.id);
    const e = early.get(k), p = planned.get(k);
    const started = (t.percentComplete || 0) > 0 || t.actualStart != null;
    let progress;
    if (isDone(t)) progress = 'done';
    else if (p.finish < today) progress = 'late';
    else if (p.start < today && !started) progress = 'behind';
    else if (started || e.start <= today) progress = 'inProgress';
    else progress = 'upcoming';
    return { task: t, start: e.start, finish: e.finish, plannedStart: p.start, progress };
  });
  m.schedules.set(mk, result);
  return result;
}
const scheduledTask = (t) => schedule(t.projectID).find((x) => sameId(x.task.id, t.id));

/** A task moved to a status today (the Mac's WorkStatus.apply). */
function withStatus(task, status, plannedStart) {
  const t = clone(task);
  const today = toSec(sod(new Date()));
  if (status === 'notStarted') { t.percentComplete = 0; delete t.actualStart; delete t.actualFinish; t.isStuck = false; }
  if (status === 'working') { t.isStuck = false; delete t.actualFinish; if ((t.percentComplete || 0) >= 100) t.percentComplete = 90; if (t.actualStart == null) t.actualStart = today; }
  if (status === 'stuck') { t.isStuck = true; delete t.actualFinish; if ((t.percentComplete || 0) >= 100) t.percentComplete = 90; }
  if (status === 'done') {
    t.isStuck = false; t.percentComplete = 100;
    if (t.actualStart == null) t.actualStart = Math.min(plannedStart ? toSec(plannedStart) : today, today);
    t.actualFinish = today;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Calendar math (the Mac's CalendarMath)

function occurrences(ev, from, to) {
  let first, lenSec = 0, lenDays = 1;
  if (ev.isAllDay) {
    first = localDay(ev.start);
    const last = new Date(Math.max(first, localDay(ev.end ?? ev.start)));
    lenDays = Math.max(1, dayDiff(first, last) + 1);
  } else {
    first = fromSec(ev.start);
    lenSec = Math.max(0, (ev.end ?? ev.start) - ev.start);
  }
  const skipped = new Set((ev.skippedDays || []).map((s) => localDay(s).getTime()));
  const lastDay = ev.repeatUntil != null ? addDays(localDay(ev.repeatUntil), 1) : null;
  const make = (st) => {
    if (lastDay && st >= lastDay) return null;
    if (skipped.has(sod(st).getTime())) return null;
    const end = ev.isAllDay ? addDays(st, lenDays) : new Date(st.getTime() + lenSec * 1000);
    const visibleEnd = Math.max(end, st.getTime() + 1000);
    if (!(st < to && visibleEnd > from)) return null;
    return { event: ev, start: st, end };
  };
  const repeats = ev.repeats || 'never';
  if (repeats === 'never') { const o = make(first); return o ? [o] : []; }
  const unit = repeats === 'monthly' ? 'month' : repeats === 'yearly' ? 'year' : 'day';
  const step = repeats === 'weekly' ? 7 : repeats === 'everyTwoWeeks' ? 14 : 1;
  // Always count from the first start so the 31st stays the 31st where it exists.
  const at = (i) => (unit === 'day' ? addDays(first, i * step) : addMonths(first, i * step * (unit === 'year' ? 12 : 1)));
  const reach = ev.isAllDay ? lenDays * 86_400_000 : lenSec * 1000;
  const windowStart = new Date(from.getTime() - reach);
  let index = 0;
  if (windowStart > first) {
    const count = unit === 'day' ? dayDiff(first, windowStart)
      : unit === 'month' ? (windowStart.getFullYear() - first.getFullYear()) * 12 + windowStart.getMonth() - first.getMonth()
        : windowStart.getFullYear() - first.getFullYear();
    index = Math.max(0, Math.floor(count / step) - 1);
  }
  const out = [];
  for (let n = 0; n < 2000; n++, index++) {
    const st = at(index);
    if (st >= to) break;
    if (lastDay && st >= lastDay) break;
    if (repeats === 'weekdays' && (st.getDay() === 0 || st.getDay() === 6)) continue;
    const o = make(st);
    if (o) out.push(o);
  }
  return out;
}

/** Your events, then active projects' tasks (the Mac's calendar layers). */
function calendarItems(from, to, projectID = null) {
  const items = [];
  const events = all('event').filter((e) => !projectID || sameId(e.projectID, projectID));
  for (const ev of events) {
    for (const o of occurrences(ev, from, to)) {
      const kind = EVENT_KINDS[ev.kind] || EVENT_KINDS.appointment;
      const p = ev.projectID ? project(ev.projectID) : null;
      const detail = [p ? projectName(p) : '', contactName(ev.contactID)].filter(Boolean).join(', ') || ev.location || '';
      items.push({ type: 'event', id: ev.id, title: (ev.title || '').trim() || kind[0], detail, start: o.start, end: o.end, allDay: !!ev.isAllDay, color: kind[1], occurrenceDay: sod(o.start), repeats: (ev.repeats || 'never') !== 'never' });
    }
  }
  const jobs = projects().filter((p) => (projectID ? sameId(p.id, projectID) : isActiveStatus(p.status)));
  for (const p of jobs) {
    for (const s of schedule(p.id)) {
      const start = sod(s.start);
      const end = addDays(sod(s.finish), 1);
      if (!(start < to && end > from)) continue;
      items.push({ type: 'task', id: s.task.id, projectID: p.id, title: s.task.name || 'Task', detail: projectName(p), start, end, allDay: true, color: projectColor(p.id), done: isDone(s.task), late: isLate(s), milestone: isMilestone(s.task) });
    }
  }
  return items.sort((a, b) => {
    const ra = a.type === 'event' ? 0 : 1, rb = b.type === 'event' ? 0 : 1;
    if (ra !== rb) return ra - rb;
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return a.start - b.start || a.title.localeCompare(b.title);
  });
}

// ---------------------------------------------------------------------------
// Rendering

let renderQueued = false;
function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    // Don't redraw under someone's fingers; wait until they leave the field.
    const a = document.activeElement;
    if (a && $('#main').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) {
      a.addEventListener('blur', () => setTimeout(renderSoon, 0), { once: true });
      renderHeader();
      return;
    }
    if ($('#sheet-root').children.length) { renderHeader(); return; }
    render();
  });
}

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || 'projects', a: parts[1], b: parts[2] };
}

let header = { title: 'Eagle Creek', sub: '', back: null, actions: '' };
function setHeader(h) { header = { title: 'Eagle Creek', sub: '', back: null, actions: '', ...h }; }

function syncPill() {
  const pending = S.dirty.size + S.meta.uploads.length;
  let cls = '', text;
  if (!navigator.onLine) { cls = 'wait'; text = pending ? `Offline · ${pending} to send` : 'Offline'; }
  else if (S.syncing) { cls = 'busy'; text = S.syncDetail || 'Syncing…'; }
  else if (S.syncError) { cls = 'err'; text = 'Sync problem'; }
  else if (pending) { cls = 'wait'; text = `${pending} to send`; }
  else text = S.meta.lastSync ? 'Synced' : 'Not synced yet';
  return `<button class="sync-pill ${cls}" data-act="sync-pill" aria-label="Sync status: ${esc(text)}"><i></i>${esc(text)}</button>`;
}

function renderHeader() {
  const top = $('#top');
  if (!S.session) { top.classList.add('hidden'); return; }
  top.classList.remove('hidden');
  top.classList.toggle('has-back', !!header.back);
  top.innerHTML = `
    ${header.back ? `<button class="icon-btn" data-act="back" data-to="${esc(header.back)}" aria-label="Back">${icon('back')}</button>` : ''}
    <div class="title"><h1>${esc(header.title)}</h1>${header.sub ? `<div class="sub">${esc(header.sub)}</div>` : ''}</div>
    ${header.actions || ''}
    ${syncPill()}`;
}

// The Mac's sidebar screens and their icon colours.
const TABS = [
  ['projects', 'Projects', 'folder', 'var(--forest)'],
  ['notes', 'Notes', 'note', 'var(--gold)'],
  ['schedule', 'Schedule', 'schedule', 'var(--gold)'],
  ['calendar', 'Calendar', 'calendar', 'var(--clay)'],
  ['trips', 'Trips', 'airplane', 'var(--slate)'],
  ['books', 'Books', 'bookClosed', 'var(--spruce)'],
  ['contacts', 'Contacts', 'people', 'var(--walnut)'],
  // On a phone, the Email Archive is the envelope on Projects.
  ['mail', 'Email', 'mail', 'var(--slate)', true],
  // On a phone, Settings is the gear on Projects; the sidebar lists it.
  ['settings', 'Settings', 'settings', 'var(--stone)', true],
];
const isWide = () => matchMedia('(min-width: 900px)').matches;
matchMedia('(min-width: 900px)').addEventListener?.('change', () => renderSoon());
function renderTabs(active) {
  const nav = $('#tabs');
  if (!S.session) { nav.classList.add('hidden'); return; }
  nav.classList.remove('hidden');
  nav.innerHTML = `<div class="brand"><img src="icon-180.png" alt="">Eagle Creek</div>` +
    TABS.filter(([r]) => canViewTab(r)).map(([r, label, ic, tint, wideOnly]) => `<a href="#/${r}" class="${active === r ? 'on' : ''}${wideOnly ? ' wide-only' : ''}" style="--tint:${tint}" ${active === r ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span></a>`).join('');
}

function render() {
  flushLogSave();
  if (typeof flushNoteSave === 'function') flushNoteSave();
  const main = $('#main');
  if (LOCK.isLocked()) {
    if ($('#lock-screen')) return; // already up; a re-render would drop the digits typed so far
    $('#tabs').classList.add('hidden');
    $('#top').classList.add('hidden');
    main.innerHTML = LOCK.lockHTML();
    wireLockScreen();
    render.lastHash = null;
    return;
  }
  if (!S.config || !S.session) {
    renderTabs(null);
    renderHeader();
    main.innerHTML = viewWelcome();
    render.lastHash = null;
    return;
  }
  if (lockNeedsSetup()) {
    if ($('#lock-setup')) return;
    $('#tabs').classList.add('hidden');
    $('#top').classList.add('hidden');
    main.innerHTML = LOCK.setupHTML(loginName(S.session.email));
    wireLockSetup();
    render.lastHash = null;
    return;
  }
  const r = route();
  let html = '';
  let tab = r.name;
  const tabOf = { project: 'projects', log: 'projects', contact: 'contacts', trip: 'trips', note: 'notes' }[r.name] || (TAB_AREAS[r.name] ? r.name : 'projects');
  try {
    if (!canViewTab(tabOf)) { html = viewNoAccess(tabOf); tab = tabOf; } else switch (r.name) {
      case 'project': html = viewProject(r.a, r.b || 'overview'); tab = 'projects'; break;
      case 'log': html = viewLog(r.a); tab = 'projects'; break;
      case 'schedule': html = viewSchedule(); break;
      case 'calendar': html = viewCalendar(); break;
      case 'contacts': html = viewContacts(); break;
      case 'contact': html = viewContact(r.a); tab = 'contacts'; break;
      case 'settings': html = viewSettings(); break;
      case 'books': html = viewBooks(r.a || 'overview', r.b); break;
      case 'trips': html = viewTrips(r.a || 'list'); break;
      case 'trip': html = viewTrip(r.a); tab = 'trips'; break;
      case 'mail': html = viewMail(r.a || 'business'); break;
      case 'notes': html = viewNotes(); break;
      case 'note': html = viewNote(r.a); tab = 'notes'; break;
      default: html = viewProjects(); tab = 'projects';
    }
  } catch (e) {
    console.error(e);
    html = banner(`Something went wrong showing this page: ${e.message}`, 'var(--danger)');
  }
  renderTabs(tab);
  renderHeader();
  const sameView = render.lastHash === location.hash;
  const keepScroll = sameView ? window.scrollY : 0;
  main.innerHTML = html;
  window.scrollTo(0, keepScroll);
  render.lastHash = location.hash;
  hydrateThumbs();
  $$('textarea', main).forEach(autoGrow);
  Dictation.attach(main);
  if (!sameView) $$('#main > nav.seg .on').forEach((el) => el.scrollIntoView({ block: 'nearest', inline: 'center' }));
}

function autoGrow(t) {
  t.style.height = 'auto';
  t.style.height = `${Math.max(t.scrollHeight + 2, Number(t.dataset.min) || 46)}px`;
}

/** A text box with a mic for dictation (voice notes). `attrs` go on the textarea. */
function dictatedArea(attrs, value = '') {
  return `<span class="dictate-wrap"><textarea ${attrs}>${esc(value || '')}</textarea><button type="button" class="mic" data-act="dictate" aria-label="Dictate">${icon('mic')}</button></span>`;
}

// ----- Building blocks (the Mac's Card, StatusPill, MetricTile, ContentUnavailableView)

const pill = (label, color) => `<span class="pill" style="--c:${color}">${esc(label)}</span>`;
/** A notice: a warning triangle for problems, an info mark for news, a check for good news. */
function banner(text, color = 'var(--warning)', ic = null) {
  const name = ic || (/danger|warning|clay/.test(color) ? 'warn' : /success/.test(color) ? 'checkCircle' : 'info');
  return `<div class="banner" style="--c:${color}">${icon(name)}<div>${esc(text)}</div></div>`;
}
/** A titled card. Its icon comes from the title (icons.js), or pass `icon` (false for none). */
function card(title, body, { action = '', flush = true, icon: ic = null } = {}) {
  const name = ic === false ? '' : (ic || cardIcon(title));
  return `<section class="card ${flush ? 'flush' : ''}"><div class="card-head"><h2>${name ? icon(name, 'ic head-ic') : ''}${esc(title)}</h2>${action}</div>${body}</section>`;
}
const cardLink = (label, href) => `<a class="btn link" href="${esc(href)}">${esc(label)}</a>`;
function tile(title, value, detail = '', { accent = 'var(--gold)', progress = null, tint = '', icon: ic = null } = {}) {
  const name = ic === false ? '' : (ic || tileIcon(title));
  return `<div class="tile" style="--a:${accent}"><div class="tt">${name ? icon(name, 'ic tile-ic') : ''}${esc(title)}</div><div class="tv"${tint ? ` style="color:${tint}"` : ''}>${esc(value)}</div>${progress != null ? `<div class="progress"><i style="width:${Math.round(progress * 100)}%"></i></div>` : ''}${detail ? `<div class="td">${esc(detail)}</div>` : ''}</div>`;
}
function emptyState(ic, title, text, action = '') {
  return `<div class="empty">${icon(ic)}<div class="et">${esc(title)}</div>${text ? `<div class="ed">${esc(text)}</div>` : ''}${action}</div>`;
}
const allClear = (text) => `<div class="all-clear">${icon('checkCircle')}${esc(text)}</div>`;

// ----- Welcome / sign in

/** The project config.js names (built into this copy), or null. */
function builtInProject() {
  if (typeof BUILT_IN_PROJECT === 'undefined') return null;
  const url = String(BUILT_IN_PROJECT.url || '').trim().replace(/\/+$/, '');
  const key = String(BUILT_IN_PROJECT.key || '').trim();
  return url && key ? { url, key } : null;
}
const usesBuiltInProject = () => { const b = builtInProject(); return !!b && (!S.config || S.config.url === b.url); };

function viewWelcome() {
  const builtIn = usesBuiltInProject();
  const c = S.config || builtInProject() || {};
  const wiped = S.wipeNotice ? banner(S.wipeNotice, 'var(--slate)') : '';
  const homeHint = isIOS && !isStandalone()
    ? `<div class="banner" style="--c:var(--slate)">${icon('share')}<div>On iPhone and iPad, add Eagle Creek to your Home Screen first (Share → Add to Home Screen), then open it from there and sign in. The Home Screen app keeps its own sign-in.</div></div>` : '';
  return `<div class="welcome">
    <img class="logo" src="icon-180.png" alt="">
    <h1>Eagle Creek</h1>
    <p class="lede">Your projects in the field: photos, daily logs, punch lists and the schedule, synced with the Mac app.</p>
    ${wiped}
    ${homeHint}
    <form id="signin" autocomplete="on">
      ${builtIn ? '' : projectFields(c, true)}
      <div class="form-section"><div class="fs-head">${fsTitle('person', 'Your account')}</div><div class="form-card">
        <label class="field"><span>Username or email</span><input name="email" type="text" autocomplete="username" required autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(loginName(S.lastEmail || ''))}"></label>
        <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
      </div></div>
      <div class="err-text" id="signin-err"></div>
      <button class="btn primary block" type="submit">Sign In</button>
      ${builtIn ? `<details class="help"><summary>Use a different Supabase project</summary>${projectFields(c, false)}</details>` : ''}
      <details class="help"><summary>${builtIn ? 'Signing in' : 'Where do I find these?'}</summary>
        <ol>
          <li>Use the username and password the owner gave you, or the owner's email and password. There's no way to make an account here: the owner adds people in Eagle Creek on the Mac (Settings › Team).</li>
          <li>The URL and key are in the Mac app under Settings → Cloud Sync. They're also on supabase.com: open your project, then <b>Connect</b> or Project Settings → API Keys. Use the anon or publishable key, never the secret or service_role key.</li>
          <li>Once one device is set up, Settings → <b>Set Up Another Device</b> makes a link. Paste it into the first box and the URL and key fill in.</li>
        </ol>
      </details>
    </form>
  </div>`;
}

function projectFields(c, required) {
  return `<div class="form-section"><div class="fs-head">${fsTitle('link', 'Supabase project')}</div><div class="form-card">
        <label class="field"><span>Project URL, or paste a setup link</span><input name="url" type="url" inputmode="url" placeholder="https://xxxx.supabase.co" value="${esc(c.url || '')}" ${required ? 'required' : ''} autocapitalize="off" autocorrect="off" spellcheck="false"></label>
        <label class="field"><span>Anon or publishable key</span><input name="key" placeholder="eyJ… or sb_publishable_…" value="${esc(c.key || '')}" ${required ? 'required' : ''} autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      </div></div>`;
}

/** A setup link (…#setup=…) holds the Supabase URL and key. */
function readSetupLink(text) {
  const m = /[#&]setup=([^&\s]+)/.exec(text || '');
  if (!m) return null;
  try {
    const cfg = JSON.parse(atob(decodeURIComponent(m[1])));
    return cfg.url && cfg.key ? { url: String(cfg.url), key: String(cfg.key) } : null;
  } catch { return null; }
}

// ----- Projects (the Mac's sidebar)

function projectSummary(p) {
  const sched = schedule(p.id);
  const open = sched.filter((s) => !isDone(s.task));
  const late = open.filter(isLate).length;
  const punch = all('punchItem').filter((x) => sameId(x.projectID, p.id) && x.status !== 'closed').length;
  const bits = [];
  if (open.length) bits.push(plural(open.length, 'open task'));
  if (late) bits.push(`<span class="alert-text">${late} late</span>`);
  if (punch) bits.push(plural(punch, 'punch item'));
  return bits.join(' · ');
}

function projectRow(p) {
  const color = statusColor(p.status);
  const street = (p.property?.street || '').trim();
  const summary = isActiveStatus(p.status) ? projectSummary(p) : '';
  return `<a class="row" href="#/project/${esc(key(p.id))}">
    ${icon(KIND_ICON[p.kind] || 'hammer', 'ic glyph', `--tint:${color}`)}
    <div class="main"><div class="t">${esc(projectName(p))}</div>
      <div class="s"><span class="dot-label" style="--c:${color}">${esc(statusLabel(p.status))}</span>${street && street !== projectName(p) ? ` · ${esc(street)}` : ''}</div>
      ${summary ? `<div class="s">${summary}</div>` : ''}
    </div>${icon('chev', 'ic chev')}</a>`;
}

function viewProjects() {
  setHeader({ title: 'Projects', actions: `<button class="icon-btn" data-act="receipt" aria-label="Snap a receipt" title="Snap a receipt">${icon('receipt')}</button>${isWide() ? '' : `${canViewTab('mail') ? `<a class="icon-btn" href="#/mail" aria-label="Email archive" title="Email archive">${icon('mail')}</a>` : ''}<a class="icon-btn" href="#/settings" aria-label="Settings" title="Settings">${icon('settings')}</a>`}` });
  let html = '';
  if (S.syncError) html += banner(S.syncError);
  html += `<div class="search">${icon('search')}<input class="input" id="project-search" type="search" placeholder="Find a project" value="${esc(S.ui.search)}" autocomplete="off"></div>`;
  return html + `<div id="project-results">${projectResults()}</div>`;
}

function projectResults() {
  const q = S.ui.search.trim().toLowerCase();
  if (!projects().length) {
    return S.meta.lastSync
      ? emptyState('folder', 'No Projects Yet', 'Projects come from the Mac app. Turn on Cloud Sync there with this same account.')
      : emptyState('folder', 'Getting Your Projects', S.syncError ? 'Waiting to reach Supabase.' : 'Downloading from Supabase…');
  }
  // Newest first within each group, as in the Mac's sidebar.
  const list = projects().filter((p) => !q || `${projectName(p)} ${projectAddress(p)} ${p.jobNumber || ''}`.toLowerCase().includes(q))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || projectName(a).localeCompare(projectName(b)));
  if (!list.length) return emptyState('search', 'No Matches', `No project matches “${S.ui.search.trim()}”.`);
  const groups = { active: [], pipeline: [], rentals: [], closed: [] };
  for (const p of list) groups[statusGroup(p.status)].push(p);
  let html = '';
  if (!q || groups.active.length) {
    html += card('Active Projects', groups.active.length ? groups.active.map(projectRow).join('') : '<div class="empty-line">No active projects</div>', { icon: GROUP_ICONS.active });
  }
  const folding = [['pipeline', 'Pipeline', true], ['rentals', 'Rentals', true], ['closed', 'Closed', false]];
  for (const [g, title, openByDefault] of folding) {
    const arr = groups[g];
    if (!arr.length) continue;
    const open = q ? true : prefs.get(`show-${g}`, openByDefault);
    html += `<button class="group-toggle ${open ? 'open' : ''}" data-act="toggle-group" data-group="${g}" aria-expanded="${open}"><h2>${icon(GROUP_ICONS[g], 'ic head-ic')}${title} (${arr.length})</h2>${icon('chev')}</button>`;
    if (open) html += `<section class="card flush">${arr.map(projectRow).join('')}</section>`;
  }
  return html;
}

// ----- One project

// The Mac's project sections and the pages in each (Store/Navigation.swift). Pages come from the
// modules that draw them (budget.js, money.js, contracts.js add theirs to PROJECT_PAGES); a section
// shows only the pages this version has.
const PROJECT_SECTIONS = [
  { id: 'overview', title: 'Overview', pages: ['overview'] },
  { id: 'contract', title: 'Contract', pages: ['contract', 'sov', 'changeOrders'], clientOnly: true },
  { id: 'budget', title: 'Budget', pages: ['budget', 'selections', 'subs'] },
  { id: 'schedule', title: 'Schedule', pages: ['schedule', 'logs', 'punch'] },
  { id: 'money', title: 'Money', pages: (p) => (p.kind === 'clientJob' ? ['billing', 'payApps', 'transactions', 'lienWaivers', 'reports'] : ['billing', 'draws', 'transactions', 'lienWaivers', 'reports']) },
  { id: 'files', title: 'Files', pages: ['photos', 'documents', 'emails'] },
];
const PROJECT_PAGES = {
  overview: ['Overview', (p) => projectOverview(p)],
  schedule: ['Schedule', (p) => projectSchedule(p)],
  logs: ['Daily Logs', (p) => projectLogs(p)],
  punch: ['Punch List', (p) => projectPunch(p)],
  photos: ['Photos', (p) => projectPhotos(p)],
  documents: ['Documents', (p) => projectDocuments(p)],
};
function projectSections(p) {
  return PROJECT_SECTIONS.filter((s) => !s.clientOnly || p.kind === 'clientJob')
    .map((s) => ({ ...s, pages: (typeof s.pages === 'function' ? s.pages(p) : s.pages).filter((pg) => PROJECT_PAGES[pg]) }))
    .filter((s) => s.pages.length);
}
/** A page's title; a few read differently on a client job, as on the Mac. */
function pageTitle(page, p) {
  if (page === 'payApps' && p.contract?.type && p.contract.type !== 'fixedPrice') return 'Billing';
  return PROJECT_PAGES[page][0];
}

function viewProject(id, page) {
  const p = project(id);
  if (!p) {
    setHeader({ title: 'Project', back: '#/projects' });
    return emptyState('folder', 'Not on This Device', 'This project may have been deleted on the Mac.', `<a class="btn" href="#/projects">Back to Projects</a>`);
  }
  setHeader({ title: projectName(p), sub: [p.jobNumber ? `Job ${p.jobNumber}` : '', KIND_LABEL[p.kind] || ''].filter(Boolean).join(' · '), back: '#/projects' });
  const pid = esc(key(p.id));
  const sections = projectSections(p);
  const section = sections.find((s) => s.pages.includes(page)) || sections[0];
  if (!section.pages.includes(page)) page = section.pages[0];
  prefs.set(`page-${section.id}`, page);
  const lastPage = (s) => { const last = prefs.get(`page-${s.id}`, s.pages[0]); return s.pages.includes(last) ? last : s.pages[0]; };
  let nav = `<nav class="seg" aria-label="Project sections">${sections.map((s) => `<a href="#/project/${pid}/${lastPage(s)}" class="${s === section ? 'on' : ''}">${segIcon(SECTION_ICONS[s.id])}${s.title}</a>`).join('')}</nav>`;
  if (section.pages.length > 1) nav += `<nav class="seg sub" aria-label="${esc(section.title)} pages">${section.pages.map((pg) => `<a href="#/project/${pid}/${pg}" class="${pg === page ? 'on' : ''}">${esc(pageTitle(pg, p))}</a>`).join('')}</nav>`;
  return nav + PROJECT_PAGES[page][1](p);
}

function todaysLog(projectID) {
  const today = new Date();
  return all('dailyLog').find((l) => sameId(l.projectID, projectID) && sameDay(fromSec(l.date), today)) || null;
}

function mapsLink(addr) {
  return isIOS ? `https://maps.apple.com/?q=${encodeURIComponent(addr)}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`;
}

function projectOverview(p) {
  const pid = esc(key(p.id));
  const addr = projectAddress(p);
  const sched = schedule(p.id);
  const weights = sched.map((s) => Math.max(1, s.task.durationDays ?? 5));
  const total = weights.reduce((a, b) => a + b, 0);
  const share = total ? sched.reduce((sum, s, i) => sum + weights[i] * Math.min(100, Math.max(0, isDone(s.task) ? 100 : s.task.percentComplete || 0)) / 100, 0) / total : null;
  const finish = sched.length ? sched.reduce((m, s) => (s.finish > m ? s.finish : m), sched[0].finish) : null;
  const open = sched.filter((s) => !isDone(s.task));
  const horizon = addDays(sod(new Date()), 14);
  const upNext = open.filter((s) => s.start <= horizon || s.task.isStuck).sort((a, b) => (isLate(b) - isLate(a)) || (a.start - b.start)).slice(0, 5);
  const punch = all('punchItem').filter((x) => sameId(x.projectID, p.id));
  const punchOpen = punch.filter((x) => x.status !== 'closed');
  const overdue = punchOpen.filter((x) => x.dueDate != null && sod(fromSec(x.dueDate)) < sod(new Date())).length;
  const photos = filesFor('projectID', p.id).filter((f) => PHOTO_CATEGORIES.has(f.category));
  const latestPhoto = photos.reduce((m, f) => Math.max(m, f.documentDate || f.addedAt || 0), 0);
  const log = todaysLog(p.id);
  const seen = new Set();
  const events = calendarItems(new Date(), addDays(sod(new Date()), 31), p.id)
    .filter((i) => i.type === 'event' && !seen.has(key(i.id)) && seen.add(key(i.id)))
    .sort((a, b) => a.start - b.start).slice(0, 4);
  const logs = all('dailyLog').filter((l) => sameId(l.projectID, p.id)).sort((a, b) => b.date - a.date).slice(0, 3);

  let html = `<div class="page-bar">${pill(statusLabel(p.status), statusColor(p.status))}${p.customerID && contactName(p.customerID) ? `<a class="count small" href="#/contact/${esc(key(p.customerID))}">Customer: ${esc(contactName(p.customerID))}</a>` : ''}</div>`;
  if (addr) {
    html += `<section class="card flush"><a class="row" href="${mapsLink(addr)}" target="_blank" rel="noopener">
      ${icon('pin', 'ic glyph')}<div class="main"><div class="t">${esc(addr)}</div><div class="s">Directions</div></div>${icon('chev', 'ic chev')}</a></section>`;
  }
  const hasPlans = typeof planFiles === 'function' && planFiles(p.id).length > 0;
  html += `<div class="actions" style="grid-template-columns:repeat(${hasPlans ? 4 : 3},1fr)">
    <button class="action" data-act="photo" data-project="${pid}" data-capture="1">${icon('camera')}Take Photo</button>
    <button class="action" data-act="today-log" data-project="${pid}">${icon('book')}Today's Log</button>
    <button class="action" data-act="punch-new" data-project="${pid}">${icon('checklist')}Punch Item</button>
    ${hasPlans ? `<button class="action" data-act="plans" data-project="${pid}">${icon('ruler')}Plans</button>` : ''}
  </div>`;
  html += `<div class="tiles">
    ${tile('Schedule', share == null ? '—' : `${Math.round(share * 100)}%`, finish ? `Finish ${fmt.short(finish)}` : 'No tasks yet', { progress: share })}
    ${tile('Punch List', punchOpen.length ? `${punchOpen.length} open` : punch.length ? 'Done' : '—', overdue ? `${overdue} overdue` : punch.length ? `${punch.length - punchOpen.length} done` : 'No items yet', { accent: overdue ? 'var(--danger)' : 'var(--gold)' })}
    ${tile('Photos', String(photos.length), latestPhoto ? `Latest ${fmt.short(fromSec(latestPhoto))}` : 'None yet')}
  </div>`;
  const upBody = upNext.length ? upNext.map((s) => taskRow(s)).join('')
    : sched.length ? allClear(open.length ? 'Nothing due in the next two weeks.' : 'Every task is done.') : '<div class="empty-line">No schedule yet. Tasks are added on the Mac.</div>';
  html += card('Up Next', upBody, { action: sched.length ? cardLink('See All', `#/project/${key(p.id)}/schedule`) : '' });
  if (events.length) html += card('Coming Up', events.map((i) => calendarRow(i, { withDate: true })).join(''));
  html += card('Daily Logs', logs.length ? logs.map(logRow).join('') : '<div class="empty-line">No logs yet.</div>', { action: cardLink(logs.length ? 'See All' : 'Start One', `#/project/${key(p.id)}/logs`) });
  if ((p.notes || '').trim()) html += card('Notes', `<div style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(p.notes)}</div>`, { flush: false });
  return html;
}

function taskRow(s, { showProject = false } = {}) {
  const t = s.task;
  const ws = workStatus(t);
  const dates = isMilestone(t) ? fmt.short(s.start) : `${fmt.short(s.start)} – ${fmt.short(s.finish)}`;
  const p = showProject ? project(t.projectID) : null;
  const sub = [p ? projectName(p) : t.phase, contactName(t.contactID)].filter(Boolean).join(' · ');
  const late = isLate(s) && ws !== 'done';
  const tint = ws === 'stuck' || late ? 'var(--danger)' : isMilestone(t) ? 'var(--gold)' : WORK[ws][1];
  const glyph = isMilestone(t) ? 'flag' : tradeIcon(`${t.name || ''} ${t.phase || ''} ${get(t.contactID)?.trade || ''}`, 'hammer');
  return `<button class="row" data-act="task" data-id="${esc(key(t.id))}">
    ${icon(glyph, 'ic glyph', `--tint:${tint}`)}
    <div class="main"><div class="t ${ws === 'done' ? 'done-t' : ''}">${esc(t.name || 'Task')}</div>
      <div class="s">${esc(sub ? `${sub} · ${dates}` : dates)}</div>
      ${late ? `<div class="s alert">${PROGRESS[s.progress]}</div>` : ''}</div>
    <div class="end">${pill(WORK[ws][0], WORK[ws][1])}</div>
  </button>`;
}

function projectSchedule(p) {
  const sched = schedule(p.id);
  if (!sched.length) return emptyState('schedule', 'No Schedule Yet', 'Tasks are added on the Mac. Once they sync, set their status here as work moves along.');
  const showDone = prefs.get('show-done-tasks', false);
  const list = sched.filter((s) => showDone || !isDone(s.task)).sort((a, b) => a.start - b.start);
  const openCount = sched.filter((s) => !isDone(s.task)).length;
  let html = `<div class="page-bar"><span class="count">${openCount} open</span><label class="check-label"><input type="checkbox" data-act="toggle-pref" data-pref="show-done-tasks" ${showDone ? 'checked' : ''}>Show done</label></div>`;
  html += list.length ? `<section class="card flush">${list.map((s) => taskRow(s)).join('')}</section>` : `<section class="card flush">${allClear('Every task is done.')}</section>`;
  return html;
}

function logRow(l) {
  const d = fromSec(l.date);
  const workers = (l.crews || []).reduce((n, c) => n + (Number(c.workers) || 0), 0);
  const photos = filesFor('recordID', l.id).length;
  const line = (l.workPerformed || '').trim() ? l.workPerformed.trim().split('\n')[0] : (l.weather || 'No notes yet');
  const rel = fmt.relDay(d);
  // The day's weather (amber when it held work up), and a warning when there were problems.
  const wx = (l.weather || '').trim() ? weatherIcon(l.weather) : l.weatherDelay ? 'rain' : '';
  const marks = (wx ? icon(wx, 'ic', `width:16px;height:16px;color:${l.weatherDelay ? 'var(--warning)' : 'var(--muted)'}`) : '') + ((l.issues || '').trim() ? icon('warn', 'ic', 'width:16px;height:16px;color:var(--warning)') : '');
  return `<a class="row" href="#/log/${esc(key(l.id))}">
    ${icon('book', 'ic glyph')}
    <div class="main"><div class="t">${esc(fmt.weekday(d))}${rel === 'Today' || rel === 'Yesterday' ? ` <span class="muted small">· ${rel}</span>` : ''}</div>
      <div class="s">${esc(line)}</div>${photos ? `<div class="s">${plural(photos, 'photo')}</div>` : ''}</div>
    <div class="end"><span style="display:flex;gap:4px">${marks}</span><span>${workers} on site</span></div></a>`;
}

function projectLogs(p) {
  const pid = esc(key(p.id));
  const logs = all('dailyLog').filter((l) => sameId(l.projectID, p.id)).sort((a, b) => b.date - a.date);
  const todayBtn = `<button class="btn primary sm" data-act="today-log" data-project="${pid}">${icon('plus')}Today</button>`;
  const voiceBtn = `<button class="btn sm" data-act="voice-note" data-project="${pid}">${icon('mic')}Voice Note</button>`;
  if (!logs.length) {
    return emptyState('book', 'No Daily Logs', 'A short note each day protects you on delays, disputes and draws. Tap Today to start.', `<div class="btn-row" style="justify-content:center;margin-top:14px">${todayBtn}${voiceBtn}<button class="btn sm" data-act="log-other-day" data-project="${pid}">${icon('calendar')}Another Day…</button></div>`);
  }
  return `<div class="page-bar"><span class="count">${plural(logs.length, 'log')}</span><span style="display:flex;gap:8px"><button class="btn sm" data-act="log-other-day" data-project="${pid}">${icon('calendar')}Another Day…</button>${voiceBtn}${todayBtn}</span></div>
    <section class="card flush">${logs.map(logRow).join('')}</section>`;
}

function punchRow(x) {
  const due = x.dueDate != null ? fromSec(x.dueDate) : null;
  const overdue = due && x.status !== 'closed' && sod(due) < sod(new Date());
  const bits = [x.location, contactName(x.contactID)].filter(Boolean).map(esc);
  if (due) bits.push(`<span class="${overdue ? 'alert-text' : ''}">Due ${esc(fmt.short(due))}</span>`);
  const done = x.status === 'closed';
  return `<div class="row" data-act="punch-edit" data-id="${esc(key(x.id))}" role="button" tabindex="0">
    <button class="check ${done ? 'on' : ''}" data-act="punch-check" data-id="${esc(key(x.id))}" aria-label="${done ? 'Mark not done' : 'Mark done'}"><span class="box">${icon('check')}</span></button>
    <span class="pnum">${x.number || 1}</span>
    <div class="main"><div class="t ${done ? 'done-t' : ''}">${esc(x.title || 'Untitled item')}</div>${bits.length ? `<div class="s">${bits.join(' · ')}</div>` : ''}</div>
    ${x.status === 'ready' ? `<div class="end">${pill(PUNCH.ready[0], PUNCH.ready[1])}</div>` : ''}
  </div>`;
}

function projectPunch(p) {
  const pid = esc(key(p.id));
  const items = all('punchItem').filter((x) => sameId(x.projectID, p.id)).sort((a, b) => (a.number || 0) - (b.number || 0));
  const showDone = prefs.get('show-done-punch', false);
  const shown = items.filter((x) => showDone || x.status !== 'closed');
  const open = items.filter((x) => x.status !== 'closed').length;
  const add = `<button class="btn primary sm" data-act="punch-new" data-project="${pid}">${icon('plus')}Item</button>`;
  if (!items.length) {
    return emptyState('checklist', 'No Punch Items', "Walk the job and add what's left to finish or fix: where it is, who's doing it, and when.", `<button class="btn primary" data-act="punch-new" data-project="${pid}">${icon('plus')}Add an Item</button>`);
  }
  let html = `<div class="page-bar"><span class="count">${open} open</span><span style="display:flex;gap:12px;align-items:center"><label class="check-label"><input type="checkbox" data-act="toggle-pref" data-pref="show-done-punch" ${showDone ? 'checked' : ''}>Show done</label>${add}</span></div>`;
  html += shown.length ? `<section class="card flush">${shown.map(punchRow).join('')}</section>`
    : `<section class="card flush">${emptyState('checkCircle', "Everything's Done", 'Turn on Show done to see finished items.')}</section>`;
  return html;
}

function thumbCell(f, list) {
  const badge = isPending(f) ? 'Waiting to upload' : f.category === 'propertyPhoto' ? 'Property' : '';
  return `<button class="thumb" data-act="open-file" data-id="${esc(key(f.id))}" data-list="${esc(list)}" ${isImage(f) ? `data-thumb="${esc(key(f.id))}"` : ''} aria-label="${esc(fileTitle(f))}">
    ${icon(isImage(f) ? 'image' : 'file')}${badge ? `<span class="badge">${esc(badge)}</span>` : ''}</button>`;
}

function photoGrid(files, listName) {
  const groups = new Map();
  for (const f of files) {
    const label = fmt.date(fileDate(f));
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(f);
  }
  let html = '';
  for (const [label, arr] of groups) html += `<div class="day-label">${esc(label)}</div><div class="grid">${arr.map((f) => thumbCell(f, listName)).join('')}</div>`;
  return html;
}

const projectPhotoList = (projectID) => filesFor('projectID', projectID).filter((f) => PHOTO_CATEGORIES.has(f.category)).sort((a, b) => (b.documentDate || b.addedAt || 0) - (a.documentDate || a.addedAt || 0));

// ----- Photo folders: the Mac's Project.photoFolders, in its order. Each photo's folderID says
// which one it's in; one pointing at a folder the project doesn't have isn't in a folder.

const photoFolders = (p) => (Array.isArray(p?.photoFolders) ? p.photoFolders.filter((x) => x && x.id) : []);
function photoFolderOf(f, folders) {
  if (!f?.folderID || !PHOTO_CATEGORIES.has(f.category)) return null;
  return folders.find((x) => sameId(x.id, f.folderID)) || null;
}
/** The photos a pick shows: 'all', 'none' (not in a folder) or a folder's id (lowercase). */
function photosInPick(files, pick, folders) {
  if (!pick || pick === 'all') return files;
  if (pick === 'none') return files.filter((f) => !photoFolderOf(f, folders));
  return files.filter((f) => key(photoFolderOf(f, folders)?.id) === pick);
}
/** The folder picked on a project's Photos page; All Photos when it's gone. */
function photoFolderPick(p, photos) {
  const pick = (S.ui.photoFolder || {})[key(p.id)] || 'all';
  const folders = photoFolders(p);
  if (pick === 'none') return photos.some((f) => photoFolderOf(f, folders)) ? 'none' : 'all';
  return pick === 'all' || folders.some((x) => key(x.id) === pick) ? pick : 'all';
}
const cleanFolderName = (s) => String(s || '').split(/\s+/).filter(Boolean).join(' ');

// A folder added on the phone goes into the project as a step, so a change made on the Mac at
// the same time isn't lost (see editRecord).
Object.assign(RECORD_OPS, {
  addPhotoFolder(p, { id, name }) {
    const list = Array.isArray(p.photoFolders) ? p.photoFolders : [];
    if (!list.some((x) => sameId(x.id, id))) list.push({ id, name });
    p.photoFolders = list;
  },
});

function projectPhotos(p) {
  const pid = esc(key(p.id));
  const photos = projectPhotoList(p.id);
  const folders = photoFolders(p);
  const pick = photoFolderPick(p, photos);
  const picked = folders.find((x) => key(x.id) === pick) || null;
  const files = photosInPick(photos, pick, folders);
  const chip = (value, label, n) => `<button type="button" data-act="photo-folder" data-project="${pid}" data-folder="${esc(value)}" class="${pick === value ? 'on' : ''}" aria-pressed="${pick === value}">${label}<span class="ct">${n}</span></button>`;
  let chips = chip('all', 'All Photos', photos.length);
  const loose = photos.filter((f) => !photoFolderOf(f, folders)).length;
  if (loose < photos.length) chips += chip('none', 'Not in a Folder', loose);
  for (const x of folders) chips += chip(key(x.id), `${icon('folder', 'ic chip-ic')}${esc(x.name)}`, photosInPick(photos, key(x.id), folders).length);
  chips += `<button type="button" data-act="photo-folder-new" data-project="${pid}">${icon('plus', 'ic chip-ic')}New Folder</button>`;
  const into = picked ? ` data-folder="${esc(key(picked.id))}"` : '';
  let html = `<div class="chips photo-folders">${chips}</div>
    <div class="btn-row" style="margin-bottom:12px">
    <button class="btn primary" data-act="photo" data-project="${pid}"${into} data-capture="1">${icon('camera')}Camera</button>
    <button class="btn" data-act="photo" data-project="${pid}"${into}>${icon('image')}Library</button></div>`;
  if (files.length) html += photoGrid(files, `photos:${key(p.id)}:${pick}`);
  else if (picked) html += emptyState('folder', `No Photos in ${picked.name} Yet`, `Photos you take or pick while ${picked.name} is selected go into it, here and on the Mac.`);
  else html += emptyState('image', 'No Photos Yet', "Photos taken here go into this project's Progress Photos on the Mac.");
  return html;
}

function sheetNewPhotoFolder(projectID) {
  const p = project(projectID);
  if (!p) return;
  openSheet(`
    ${sheetHead('New Folder', projectName(p))}
    <div class="form-section"><div class="form-card"><label class="field"><span>Name</span><input id="folder-name" maxlength="80" autocomplete="off" placeholder="Demo, Framing, Final…"></label></div>
    <div class="fs-foot">Photos you take or pick while a folder is selected go into it, here and on the Mac.</div></div>
    <div class="sheet-actions"><button class="btn" data-act="sheet-close">Cancel</button><button class="btn primary" data-act="photo-folder-create" data-project="${esc(key(p.id))}">Create</button></div>
  `, (sheet) => {
    const input = $('#folder-name', sheet);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('[data-act="photo-folder-create"]', sheet).click(); }
    });
    input.focus();
  });
}

/** Moves a photo into one of its project's folders ('' for none). Every other field is kept. */
async function movePhotoToFolder(fileID, folderKey) {
  const f = get(fileID);
  if (!f) return;
  const folders = photoFolders(project(f.projectID));
  const folder = folderKey ? folders.find((x) => key(x.id) === folderKey) : null;
  if (folderKey && !folder) return;
  if (folder ? sameId(f.folderID, folder.id) : !f.folderID) return;
  const c = clone(f);
  if (folder) c.folderID = folder.id; else delete c.folderID;
  try {
    // A photo still waiting to upload goes up with its new folder once it has.
    await saveRecord('file', c, { upload: !isPending(f) });
  } catch (err) {
    if (!(err instanceof ViewOnlyError)) toast(friendlyError(err));
    return;
  }
  const label = $('#viewer-folder');
  if (label) label.textContent = folder ? folder.name : 'Not in a Folder';
  toast(folder ? `Moved to ${folder.name}` : 'Taken out of its folder');
}

function fileRow(f) {
  const marks = isPDF(f) && typeof planMarkCount === 'function' ? planMarkCount(f.id) : 0;
  const sub = [fmt.date(fileDate(f)), f.fileSize ? fmt.size(f.fileSize) : '', (f.fileExtension || '').toUpperCase(), marks ? plural(marks, 'measurement') : '', isPending(f) ? 'Waiting to upload' : ''].filter(Boolean).join(' · ');
  return `<button class="row" data-act="open-file" data-id="${esc(key(f.id))}">
    ${icon(isImage(f) ? 'image' : 'doc', 'ic glyph', '--tint:var(--sage)')}
    <div class="main"><div class="t">${esc(fileTitle(f))}</div><div class="s">${esc(sub)}</div></div>${icon('chev', 'ic chev')}</button>`;
}

function projectDocuments(p) {
  // Emails have their own page (Files › Emails); their attachments stay here by type.
  const files = filesFor('projectID', p.id).filter((f) => !PHOTO_CATEGORIES.has(f.category) && !isEmailFile(f));
  const add = `<button class="btn sm" data-act="add-file" data-project="${esc(key(p.id))}">${icon('plus')}Add a File</button>`;
  if (!files.length) return emptyState('doc', 'No Documents Yet', 'Plans, permits, contracts and other files for this project show up here.', `<div style="margin-top:14px">${add}</div>`);
  const by = new Map();
  for (const f of files) { const c = f.category || 'other'; if (!by.has(c)) by.set(c, []); by.get(c).push(f); }
  const order = [...DOCUMENT_ORDER, ...[...by.keys()].filter((c) => !DOCUMENT_ORDER.includes(c))];
  let html = `<div class="page-bar"><span class="count">${plural(files.length, 'file')}</span>${add}</div><section class="card flush">`;
  for (const c of order) {
    const arr = by.get(c);
    if (!arr) continue;
    const open = S.ui.filesOpen[c] ?? c === 'plansSpecs';
    html += `<button class="row" data-act="toggle-files" data-cat="${esc(c)}" aria-expanded="${open}">${icon(FILE_ICONS[c] || 'folder', 'ic glyph', '--tint:var(--sage)')}
      <div class="main"><div class="t">${esc(CATEGORY[c] || c)}</div></div><span class="end num">${arr.length}</span>
      ${icon('chev', 'ic chev', `transform:rotate(${open ? 90 : 0}deg)`)}</button>`;
    if (open) html += arr.sort((a, b) => (b.documentDate || 0) - (a.documentDate || 0)).map(fileRow).join('');
  }
  return html + '</section>';
}

// ----- Daily log (the Mac's DailyLogEditor)

function viewLog(id) {
  const l = get(id);
  if (!l) {
    setHeader({ title: 'Daily Log', back: '#/projects' });
    return emptyState('book', 'Not on This Device', 'This log may have been deleted on the Mac.');
  }
  const p = project(l.projectID);
  const d = fromSec(l.date);
  const rel = fmt.relDay(d);
  setHeader({ title: rel === 'Today' ? "Today's Log" : rel === 'Yesterday' ? "Yesterday's Log" : fmt.weekday(d), sub: p ? projectName(p) : '', back: p ? `#/project/${key(p.id)}/logs` : '#/projects' });
  const names = [...new Set(contacts().map((c) => c.name).filter(Boolean))];
  const photos = filesFor('recordID', l.id).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  const lid = esc(key(l.id));
  const area = (name, label, ph = '') => `<label class="field"><span>${label}</span>${dictatedArea(`name="${name}" placeholder="${esc(ph)}" rows="1"`, l[name])}</label>`;
  const crews = (l.crews || []).map((c, i) => `<div class="crew" data-crew="${i}">
      <div class="crew-head"><span>Crew ${i + 1}</span><button type="button" class="btn link danger" data-act="crew-remove" data-i="${i}">Remove</button></div>
      <div class="crew-grid">
        <label class="field"><span>Who</span><input name="crew-name" list="contact-names" value="${esc(c.name || contactName(c.contactID))}" placeholder="Or type a name"></label>
        <label class="field"><span>Workers</span><input name="crew-workers" type="number" inputmode="numeric" min="0" step="1" value="${esc(c.workers ?? 1)}"></label>
        <label class="field"><span>Hours</span><input name="crew-hours" type="number" inputmode="decimal" min="0" step="0.5" value="${esc(c.hours ?? 8)}"></label>
      </div>
      <label class="field"><span>Work</span><input name="crew-work" value="${esc(c.work || '')}" placeholder="What they did"></label>
    </div>`).join('');
  return `<form id="log-form" data-id="${lid}" autocomplete="off">
    <datalist id="contact-names">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    <div class="form-section"><div class="form-card">
      <label class="field"><span>Date</span><input name="date" type="date" value="${fmt.inputDate(d)}" max="${fmt.inputDate(addDays(new Date(), 7))}"></label>
    </div></div>
    <div class="form-section"><div class="fs-head">${fsTitle('cloudSun', 'Weather')}<button type="button" class="btn link" data-act="fill-weather">${icon('sun')}Fill In</button></div><div class="form-card">
      <label class="field"><span>Conditions</span><input name="weather" value="${esc(l.weather || '')}" placeholder="Sunny"></label>
      <div class="chips">${WEATHER_CHOICES.map((w) => `<button type="button" data-act="weather-pick" data-w="${esc(w)}" class="${(l.weather || '') === w ? 'on' : ''}">${icon(weatherIcon(w), 'ic chip-ic')}${w}</button>`).join('')}</div>
      <div class="two">
        <label class="field"><span>High °F</span><input name="highTemp" type="number" inputmode="decimal" value="${l.highTemp ?? ''}"></label>
        <label class="field"><span>Low °F</span><input name="lowTemp" type="number" inputmode="decimal" value="${l.lowTemp ?? ''}"></label>
      </div>
      <label class="toggle">Weather delay (work stopped or slowed)<input type="checkbox" name="weatherDelay" ${l.weatherDelay ? 'checked' : ''}></label>
    </div></div>
    <div class="form-section"><div class="fs-head">${fsTitle('hardhat', 'Crews on Site')}<button type="button" class="btn link" data-act="crew-add">${icon('plus')}Add Crew</button></div>
      <div class="form-card">${crews || '<div class="empty-line" style="padding:2px 0 12px">No crews listed.</div>'}</div></div>
    <div class="form-section"><div class="fs-head">${fsTitle('hammer', 'Work Performed')}</div><div class="form-card">
      <label class="field"><span class="sr">Work performed</span>${dictatedArea('name="workPerformed" placeholder="What got done today" rows="3" data-min="96"', l.workPerformed)}</label>
    </div></div>
    <div class="form-section"><div class="fs-head">${fsTitle('truck', 'Deliveries and Inspections')}</div><div class="form-card">
      ${area('deliveries', 'Deliveries', 'Lumber package, windows…')}
      ${area('inspections', 'Inspections', 'Framing inspection – passed')}
      ${area('visitors', 'Visitors', 'Owner walk-through, lender inspector…')}
    </div></div>
    <div class="form-section"><div class="fs-head">${fsTitle('warn', 'Problems, Delays and Safety')}</div><div class="form-card">
      ${area('issues', 'Problems or delays', 'Anything that held up work or needs follow-up')}
      ${area('safety', 'Safety', 'Toolbox talk, incidents, near misses')}
    </div></div>
    <div class="form-section"><div class="fs-head">${fsTitle('note', 'Notes')}</div><div class="form-card">
      ${area('notes', 'Notes', 'Anything else')}
      <label class="field"><span>Written by</span><input name="author" value="${esc(l.author || '')}"></label>
    </div></div>
    <div class="form-section"><div class="fs-head">${fsTitle('camera', `Photos (${photos.length})`)}</div>
      <div class="btn-row" style="margin-bottom:8px">
        <button type="button" class="btn primary" data-act="photo" data-project="${esc(key(l.projectID))}" data-record="${lid}" data-capture="1">${icon('camera')}Camera</button>
        <button type="button" class="btn" data-act="photo" data-project="${esc(key(l.projectID))}" data-record="${lid}">${icon('image')}Library</button>
      </div>
      ${photos.length ? `<div class="grid">${photos.map((f) => thumbCell(f, `log:${key(l.id)}`)).join('')}</div>` : ''}
      <div class="fs-foot">Photos added here are also in the project's Photos.</div>
    </div>
    <div class="saved-note" id="saved-note">${S.dirty.has(key(l.id)) ? 'Saved on this device' : 'Saved'}</div>
    <button type="button" class="btn block danger" data-act="log-delete" data-id="${lid}">${icon('trash')}Delete This Log…</button>
  </form>`;
}

let logSave = null; // { form, timer }
function readLogForm(form) {
  const current = get(form.dataset.id);
  if (!current) return null;
  const l = clone(current);
  const val = (n) => form.elements[n]?.value ?? '';
  for (const n of ['weather', 'workPerformed', 'deliveries', 'inspections', 'visitors', 'issues', 'safety', 'notes', 'author']) l[n] = val(n);
  const num = (v) => (String(v).trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const hi = num(val('highTemp')), lo = num(val('lowTemp'));
  if (hi == null) delete l.highTemp; else l.highTemp = hi;
  if (lo == null) delete l.lowTemp; else l.lowTemp = lo;
  l.weatherDelay = !!form.elements.weatherDelay?.checked;
  const day = parseInputDate(val('date'));
  if (day) l.date = toSec(localNoon(day)); // the Mac keeps log dates at noon
  const byName = new Map(contacts().map((c) => [String(c.name || '').toLowerCase(), c.id]));
  l.crews = $$('[data-crew]', form).map((el, i) => {
    const old = (current.crews || [])[i] || {};
    const name = $('[name="crew-name"]', el).value.trim();
    const crew = {
      ...old, id: old.id || newId(), name,
      workers: Math.max(0, parseInt($('[name="crew-workers"]', el).value, 10) || 0),
      hours: Math.max(0, Number($('[name="crew-hours"]', el).value) || 0),
      work: $('[name="crew-work"]', el).value,
    };
    const match = byName.get(name.toLowerCase());
    if (match) crew.contactID = match; else if (name !== (old.name || contactName(old.contactID))) delete crew.contactID;
    return crew;
  });
  return l;
}
/** Saves the log being typed in right away (before the page redraws or the app goes away). */
function flushLogSave() {
  if (!logSave) return;
  const { form } = logSave;
  clearTimeout(logSave.timer);
  logSave = null;
  if (!form.isConnected) return;
  const l = readLogForm(form);
  if (!l || JSON.stringify(l) === JSON.stringify(get(form.dataset.id))) { setSavedNote('Saved'); return; }
  saveRecord('dailyLog', l).then(() => setSavedNote(navigator.onLine ? 'Saved' : 'Saved on this device'));
}
function setSavedNote(text) { const n = $('#saved-note'); if (n) n.textContent = text; }
function queueLogSave(form, immediate = false) {
  if (logSave) clearTimeout(logSave.timer);
  logSave = { form, timer: setTimeout(flushLogSave, 700) };
  setSavedNote('Saving…');
  if (immediate) flushLogSave();
}

async function openOrCreateLog(projectID, day = new Date()) {
  const existing = all('dailyLog').find((l) => sameId(l.projectID, projectID) && sameDay(fromSec(l.date), day));
  if (existing) { location.hash = `#/log/${key(existing.id)}`; return; }
  // A new log lists the last log's crews, with their work left blank (as on the Mac).
  const previous = all('dailyLog').filter((l) => sameId(l.projectID, projectID)).sort((a, b) => b.date - a.date)[0];
  const p = project(projectID);
  const log = {
    id: newId(), projectID: p ? p.id : projectID, date: toSec(localNoon(day)),
    weather: '', weatherDelay: false, crews: (previous?.crews || []).map((c) => ({ ...c, id: newId(), work: '' })),
    workPerformed: '', deliveries: '', inspections: '', visitors: '', issues: '', safety: '', notes: '', author: company().principalName || '',
  };
  await saveRecord('dailyLog', log);
  location.hash = `#/log/${key(log.id)}`;
}

const WMO = (c) => (c === 0 ? 'Sunny' : c <= 2 ? 'Partly cloudy' : c === 3 ? 'Cloudy' : c <= 48 ? 'Fog' : c <= 57 ? 'Drizzle' : c <= 67 ? 'Rain' : c <= 77 ? 'Snow' : c <= 82 ? 'Rain' : c <= 86 ? 'Snow' : 'Thunderstorms');
async function fillWeather(form) {
  const l = get(form.dataset.id);
  const p = l && project(l.projectID);
  const day = parseInputDate(form.elements.date.value) || new Date();
  if (dayDiff(new Date(), day) > 14) { toast('Forecasts only go two weeks ahead.'); return; }
  toast('Getting the weather…');
  try {
    let lat, lon;
    const pr = p?.property || {};
    if (pr.city) {
      const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(pr.city)}&count=10&countryCode=US&format=json`).then((r) => r.json());
      const hit = (g.results || []).find((r) => !pr.state || (r.admin1_code || '').toUpperCase() === pr.state.toUpperCase() || (r.admin1 || '').toLowerCase().startsWith(pr.state.toLowerCase())) || (g.results || [])[0];
      if (hit) { lat = hit.latitude; lon = hit.longitude; }
    }
    if (lat == null) {
      const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 10000, maximumAge: 600000 }));
      lat = pos.coords.latitude; lon = pos.coords.longitude;
    }
    const ds = fmt.inputDate(day);
    // Recent and coming days from the forecast; older days from the weather archive.
    const base = dayDiff(day, new Date()) > 60 ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast';
    const w = await fetch(`${base}?latitude=${lat}&longitude=${lon}&daily=weather_code,temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=auto&start_date=${ds}&end_date=${ds}`).then((r) => r.json());
    const code = w.daily?.weather_code?.[0];
    if (code == null) throw new Error('No weather for that day.');
    form.elements.weather.value = WMO(code);
    if (w.daily.temperature_2m_max[0] != null) form.elements.highTemp.value = Math.round(w.daily.temperature_2m_max[0]);
    if (w.daily.temperature_2m_min[0] != null) form.elements.lowTemp.value = Math.round(w.daily.temperature_2m_min[0]);
    $$('[data-act="weather-pick"]', form).forEach((b) => b.classList.toggle('on', b.dataset.w === form.elements.weather.value));
    queueLogSave(form, true);
    toast(`Weather for ${pr.city || 'your location'}`);
  } catch (e) {
    toast(e?.code === 1 ? 'Allow location to fill in the weather.' : "Couldn't get the weather. Type it in instead.");
  }
}

// ----- Schedule (the next two weeks on every active project)

function viewSchedule() {
  setHeader({ title: 'Schedule', sub: 'Next two weeks on active projects' });
  const today = sod(new Date());
  const horizon = addDays(today, 14);
  const rows = [];
  for (const p of projects().filter((x) => isActiveStatus(x.status))) {
    for (const s of schedule(p.id)) if (!isDone(s.task) && (s.start <= horizon || s.task.isStuck)) rows.push(s);
  }
  const rank = (s) => (s.task.isStuck ? 0 : s.progress === 'late' ? 1 : s.progress === 'behind' ? 2 : 3);
  rows.sort((a, b) => rank(a) - rank(b) || a.start - b.start);
  const attention = rows.filter((s) => rank(s) < 3);
  const now = rows.filter((s) => rank(s) === 3 && s.start <= today);
  const soon = rows.filter((s) => rank(s) === 3 && s.start > today);
  const punch = all('punchItem').filter((x) => x.status !== 'closed' && x.dueDate != null && sod(fromSec(x.dueDate)) <= horizon && project(x.projectID) && isActiveStatus(project(x.projectID).status))
    .sort((a, b) => a.dueDate - b.dueDate);
  let html = S.syncError ? banner(S.syncError) : '';
  const block = (title, arr) => (arr.length ? card(`${title} (${arr.length})`, arr.map((s) => taskRow(s, { showProject: true })).join('')) : '');
  html += block('Needs Attention', attention);
  html += block('Under Way', now);
  html += block('Starting Soon', soon);
  if (punch.length) {
    html += card(`Punch Items Due (${punch.length})`, punch.map((x) => {
      const p = project(x.projectID);
      const due = fromSec(x.dueDate);
      const late = sod(due) < today;
      return `<a class="row" href="#/project/${esc(key(x.projectID))}/punch">${icon('checklist', 'ic glyph', `--tint:${late ? 'var(--danger)' : 'var(--forest)'}`)}<div class="main"><div class="t">#${x.number || 1} ${esc(x.title || '')}</div><div class="s">${esc([p ? projectName(p) : '', x.location].filter(Boolean).join(' · '))}</div></div><span class="end ${late ? 'alert-text' : ''}">${esc(fmt.relDay(due))}</span></a>`;
    }).join(''));
  }
  if (!rows.length && !punch.length) html += `<section class="card flush">${allClear('Nothing scheduled on active projects for the next two weeks.')}</section>`;
  return html;
}

// ----- Calendar

function calendarRow(i, { withDate = false } = {}) {
  let time = i.allDay ? (dayDiff(i.start, i.end) > 1 ? `${fmt.short(i.start)}–${fmt.short(addDays(i.end, -1))}` : 'All day') : fmt.time(i.start);
  if (withDate && !(i.allDay && dayDiff(i.start, i.end) > 1)) time = `${fmt.relDay(i.start)}\n${time}`;
  const act = i.type === 'event' ? `data-act="event-edit" data-id="${esc(key(i.id))}" data-day="${toSec(i.occurrenceDay)}"` : `data-act="task" data-id="${esc(key(i.id))}"`;
  return `<button class="row" ${act}>
    <div class="ev-bar" style="--c:${i.color}"></div>
    <div class="ev-time">${esc(time).replace('\n', '<br>')}</div>
    <div class="main"><div class="t ${i.done ? 'done-t' : ''}">${i.type === 'task' && i.milestone ? '<span class="diamond" aria-label="Milestone">◆</span> ' : ''}${esc(i.title)}</div>${i.detail ? `<div class="s">${esc(i.detail)}</div>` : ''}</div>
    ${i.late && !i.done ? `<div class="end">${pill('Late', 'var(--danger)')}</div>` : ''}
  </button>`;
}

function viewCalendar() {
  setHeader({ title: 'Calendar', actions: `<button class="icon-btn" data-act="event-new" aria-label="New event">${icon('plus')}</button>` });
  const sel = S.ui.calDay;
  const weekStart = addDays(sel, -sel.getDay());
  const weekEnd = addDays(weekStart, 7);
  const weekItems = calendarItems(weekStart, weekEnd);
  const onDay = (d) => { const next = addDays(d, 1); return weekItems.filter((i) => i.start < next && Math.max(i.end, i.start.getTime() + 1000) > d); };
  let html = `<div class="cal-nav">
    <button class="icon-btn" data-act="cal-shift" data-n="-7" aria-label="Previous week">${icon('left')}</button>
    <h2>${esc(fmt.month(sel))}</h2>
    <button class="icon-btn" data-act="cal-shift" data-n="7" aria-label="Next week">${icon('right')}</button></div>`;
  html += `<div class="week-strip">${[...Array(7)].map((_, i) => {
    const d = addDays(weekStart, i);
    return `<button data-act="cal-day" data-t="${d.getTime()}" class="${sameDay(d, sel) ? 'sel' : ''} ${sameDay(d, new Date()) ? 'today' : ''} ${onDay(d).length ? 'has' : ''}" aria-label="${esc(fmt.day(d))}"><span class="dow">${d.toLocaleDateString('en-US', { weekday: 'narrow' })}</span><span class="dn">${d.getDate()}</span><span class="mark"></span></button>`;
  }).join('')}</div>`;
  html += `<div class="cal-tools"><div class="segmented"><button data-act="cal-mode" data-mode="day" class="${S.ui.calMode === 'day' ? 'on' : ''}">Day</button><button data-act="cal-mode" data-mode="week" class="${S.ui.calMode === 'week' ? 'on' : ''}">Week</button></div>
    <button class="btn sm" data-act="cal-today" ${sameDay(sel, new Date()) && S.ui.calMode === 'day' ? 'disabled' : ''}>Today</button></div>`;
  const days = S.ui.calMode === 'week' ? [...Array(7)].map((_, i) => addDays(weekStart, i)) : [sel];
  for (const d of days) {
    const items = onDay(d);
    const rel = fmt.relDay(d);
    const title = rel === fmt.short(d) ? fmt.day(d) : `${rel} · ${fmt.day(d)}`;
    html += card(title, items.length ? items.map(calendarRow).join('') : '<div class="empty-line">Nothing scheduled.</div>',
      { action: `<button class="btn link" data-act="event-new" data-t="${d.getTime()}" aria-label="New event on ${esc(fmt.day(d))}">${icon('plus')}</button>` });
  }
  return html;
}

// ----- Settings

function viewSettings() {
  setHeader({ title: 'Settings', back: isWide() ? null : '#/projects' });
  const pending = S.dirty.size + S.meta.uploads.length;
  const theme = themeChoice();
  let html = '';
  html += card('Cloud Sync', `<div style="padding:0 16px 14px">
    <div class="kv"><span>Status</span><span>${esc(S.syncing ? (S.syncDetail || 'Syncing…') : S.syncError ? 'Needs attention' : navigator.onLine ? (S.meta.lastSync ? 'Up to date' : 'Not synced yet') : 'Offline')}</span></div>
    <div class="kv"><span>Last synced</span><span>${esc(fmt.ago(S.meta.lastSync))}</span></div>
    <div class="kv"><span>Waiting to send</span><span>${pending ? [S.dirty.size ? plural(S.dirty.size, 'change') : '', S.meta.uploads.length ? plural(S.meta.uploads.length, 'file') : ''].filter(Boolean).join(', ') : 'Nothing'}</span></div>
    <div class="kv"><span>On this device</span><span>${plural(projects().length, 'project')} · ${plural(all('contact').length, 'contact')} · ${plural(all('file').length, 'file')}</span></div>
    ${S.syncError ? banner(S.syncError) : ''}
    <button class="btn primary block" data-act="sync-now" ${S.syncing ? 'disabled' : ''} style="margin-top:6px">${icon('sync')}Sync Now</button>
    <p class="note">Syncs on its own every minute while the app is open, and whenever you make a change.</p>
  </div>`);
  html += card('Appearance', `<div style="padding:0 16px 16px"><div class="segmented" role="radiogroup">
    ${[['light', 'Light'], ['dark', 'Dark'], ['system', 'Match Device']].map(([k, l]) => `<button data-act="theme" data-theme="${k}" class="${theme === k ? 'on' : ''}" role="radio" aria-checked="${theme === k}">${l}</button>`).join('')}
  </div></div>`);
  if (!isStandalone()) {
    const how = isIOS
      ? 'In Safari, tap <b>Share</b>, then <b>Add to Home Screen</b>. Open Eagle Creek from the Home Screen and sign in there; it keeps its own sign-in, separate from Safari.'
      : deferredInstall ? `<button class="btn primary block" data-act="install">${icon('download')}Install Eagle Creek</button>`
        : 'In Chrome, open the <b>⋮</b> menu and choose <b>Add to Home screen</b> (Android) or <b>Cast, save and share → Install page as app</b> (computer).';
    html += card('Add to Home Screen', `<div style="padding:0 16px 14px;font-size:15px">${how}</div>`);
  }
  const builtIn = usesBuiltInProject();
  html += card('Account', `<div style="padding:0 16px 14px">
    <div class="kv"><span>Signed in as</span><span>${esc(loginName(S.session?.email || ''))}</span></div>
    ${S.team?.name ? `<div class="kv"><span>Name</span><span>${esc(S.team.name)}</span></div>` : ''}
    <div class="kv"><span>Role</span><span>${isMember() ? 'Team member' : 'Owner'}</span></div>
    <div class="kv"><span>Supabase</span><span>${esc((S.config?.url || '').replace(/^https?:\/\//, ''))}</span></div>
    ${accessSummaryHTML()}
    ${builtIn ? '<p class="note">On another phone or iPad, open this site and sign in with your username (or email) and password.</p>' : `<button class="btn block" data-act="setup-link" style="margin-top:6px">${icon('share')}Set Up Another Device</button>
    <p class="note">Makes a link with your Supabase URL and key. On the other phone or iPad, paste it into the first box on the sign-in screen, then sign in with your username (or email) and password.</p>`}
  </div>`);
  if (typeof mailSettingsCard === 'function') html += mailSettingsCard();
  html += securitySettingsCard();
  html += card('This Device', `<div style="padding:0 16px 14px">
    <div class="btn-row wrap"><button class="btn" data-act="clear-cache">${icon('trash')}Free Up Space</button><button class="btn" data-act="full-sync">${icon('download')}Download Everything</button></div>
    <p class="note">Free Up Space removes downloaded copies of photos and documents; they download again when opened. Nothing waiting to upload is touched.</p>
    <button class="btn block danger" data-act="sign-out" style="margin-top:10px">${icon('logout')}Sign Out…</button>
  </div>`);
  html += `<p class="small muted" style="text-align:center;margin-top:6px">Eagle Creek for phone and iPad · ${APP_VERSION}</p>`;
  return html;
}

// ---------------------------------------------------------------------------
// Sheets (forms that slide up)

let sheetDirty = false;
function openSheet(html, onMount) {
  const root = $('#sheet-root');
  sheetDirty = false;
  root.innerHTML = `<div class="sheet-backdrop" data-act="sheet-backdrop"><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div></div>`;
  document.body.style.overflow = 'hidden';
  onMount?.($('.sheet', root));
  $$('textarea', root).forEach(autoGrow);
}
function closeSheet() {
  if (viewerState) { viewerState.cleanup?.(); viewerState = null; }
  $('#sheet-root').innerHTML = '';
  document.body.style.overflow = '';
  renderSoon();
}
const sheetHead = (title, sub = '') => `<div class="sheet-head"><div><h1 style="font-size:20px">${esc(title)}</h1>${sub ? `<div class="sh-sub">${esc(sub)}</div>` : ''}</div><button class="icon-btn" data-act="sheet-close" aria-label="Close">${icon('close')}</button></div>`;

function sheetTask(id) {
  const t = get(id);
  if (!t) return;
  const s = scheduledTask(t);
  const p = project(t.projectID);
  const ws = workStatus(t);
  const span = s ? (isMilestone(t) ? `Milestone · ${fmt.short(s.start)}` : `${plural(t.durationDays ?? 5, 'workday')} · ${fmt.short(s.start)} – ${fmt.short(s.finish)}`) : '';
  openSheet(`
    ${sheetHead(t.name || 'Task', [p ? projectName(p) : '', t.phase].filter(Boolean).join(' · '))}
    <div class="form-section"><div class="form-card" style="padding-bottom:12px">
      ${span ? `<div class="kv" style="padding-top:0"><span>When</span><span>${esc(span)}</span></div>` : ''}
      ${s && isLate(s) && ws !== 'done' ? `<div class="kv"><span>Progress</span><span class="alert-text">${PROGRESS[s.progress]}</span></div>` : ''}
      ${contactName(t.contactID) ? `<div class="kv"><span>Who</span><a href="#/contact/${esc(key(t.contactID))}">${esc(contactName(t.contactID))}</a></div>` : ''}
    </div></div>
    <div class="form-section"><div class="fs-head">Status</div><div class="two">${Object.entries(WORK).map(([k, [label, color]]) => `<button class="btn ${k === ws ? 'primary' : ''}" data-act="task-status" data-id="${esc(key(t.id))}" data-status="${k}"><span class="dot-label" style="--c:${k === ws ? 'var(--on-accent)' : color}">${label}</span></button>`).join('')}</div></div>
    <div class="form-section"><div class="form-card">
      <label class="field"><span>Percent complete · <b id="pct-label">${Math.round(t.percentComplete || 0)}%</b></span><input type="range" id="task-pct" min="0" max="100" step="5" value="${Math.round(t.percentComplete || 0)}"></label>
      <label class="field"><span>Notes</span>${dictatedArea('id="task-notes" rows="2"', t.notes)}</label>
    </div></div>
    <div class="sheet-actions"><button class="btn" data-act="sheet-close">Cancel</button><button class="btn primary" data-act="task-save" data-id="${esc(key(t.id))}">Save</button></div>
    ${p && route().name !== 'project' ? `<a class="btn link block" style="margin-top:8px" href="#/project/${esc(key(p.id))}/schedule">Open ${esc(projectName(p))}</a>` : ''}
  `, (el) => {
    const r = $('#task-pct', el);
    r.addEventListener('input', () => { $('#pct-label', el).textContent = `${r.value}%`; });
  });
}

function sheetPunch(id, projectID) {
  const existing = id ? get(id) : null;
  const pid = existing ? existing.projectID : projectID;
  const x = existing || { status: 'open', title: '', location: '', details: '' };
  // Assigned to a trade or a crew member, as on the Mac.
  const people = contacts().filter((c) => !c.kind || c.kind === 'vendor' || c.kind === 'employee' || sameId(c.id, x.contactID));
  const due = x.dueDate != null ? fmt.inputDate(fromSec(x.dueDate)) : '';
  const p = project(pid);
  openSheet(`
    ${sheetHead(existing ? `Punch Item #${x.number || 1}` : 'New Punch Item', p ? projectName(p) : '')}
    <form id="punch-form" data-id="${esc(id || '')}" data-project="${esc(key(pid))}">
      <div class="form-section"><div class="form-card">
        <label class="field"><span>What needs doing</span><input name="title" value="${esc(x.title)}" required placeholder="Touch up paint by the front door"></label>
        <label class="field"><span>Room or area</span><input name="location" value="${esc(x.location)}" placeholder="Kitchen"></label>
        <div class="two">
          <label class="field"><span>Assigned to</span><select name="contactID"><option value="">Nobody yet</option>${people.map((c) => `<option value="${esc(c.id)}" ${sameId(c.id, x.contactID) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
          <label class="field"><span>Due</span><input name="dueDate" type="date" value="${due}"></label>
        </div>
        <label class="field"><span>Details</span><textarea name="details" rows="2">${esc(x.details)}</textarea></label>
      </div></div>
      <div class="form-section"><div class="fs-head">Status</div><div class="segmented">${Object.entries(PUNCH).map(([k, [l]]) => `<button type="button" data-act="punch-status-pick" data-status="${k}" class="${(x.status || 'open') === k ? 'on' : ''}">${l}</button>`).join('')}</div><input type="hidden" name="status" value="${esc(x.status || 'open')}"></div>
      <div class="sheet-actions">${existing ? `<button type="button" class="btn danger" data-act="punch-delete" data-id="${esc(id)}" aria-label="Delete" style="flex:0 0 52px">${icon('trash')}</button>` : ''}<button type="button" class="btn" data-act="sheet-close">Cancel</button><button type="submit" class="btn primary">${existing ? 'Save' : 'Add Item'}</button></div>
    </form>`, (el) => { if (!existing) setTimeout(() => $('[name="title"]', el)?.focus(), 250); });
}

function reminderOptions(allDay, current) {
  const list = allDay ? REMINDERS_ALLDAY : REMINDERS_TIMED;
  return `<option value="">None</option>${list.map(([m, l]) => `<option value="${m}" ${current === m ? 'selected' : ''}>${l}</option>`).join('')}`;
}

function sheetEvent(id, opts = {}) {
  const existing = id ? get(id) : null;
  const ev = existing ? clone(existing) : null;
  let start, end;
  if (ev) {
    start = ev.isAllDay ? localDay(ev.start) : fromSec(ev.start);
    end = ev.isAllDay ? localDay(ev.end ?? ev.start) : fromSec(ev.end ?? ev.start + 3600);
  } else {
    // The next half hour, as on the Mac (9:00 on another day).
    const base = opts.day ? new Date(opts.day) : new Date();
    const now = new Date();
    if (sameDay(base, now)) {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes() < 30 ? 30 : 60);
    } else start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 9, 0);
    end = new Date(start.getTime() + 3600_000);
  }
  const allDay = ev ? !!ev.isAllDay : false;
  const kind = ev?.kind || 'appointment';
  const jobs = projects().filter((p) => statusGroup(p.status) !== 'closed' || (ev && sameId(p.id, ev.projectID))).sort((a, b) => projectName(a).localeCompare(projectName(b)));
  const repeating = ev && (ev.repeats || 'never') !== 'never';
  const occurrence = opts.occurrenceDay ? new Date(Number(opts.occurrenceDay) * 1000) : null;
  openSheet(`
    ${sheetHead(existing ? 'Event' : 'New Event')}
    <form id="event-form" data-id="${esc(id || '')}" data-day="${opts.occurrenceDay || ''}">
      <div class="form-section"><div class="form-card">
        <label class="field"><span>Title</span><input name="title" value="${esc(ev?.title || '')}" placeholder="${esc(EVENT_KINDS[kind][0])}"></label>
        <label class="field"><span>Type</span><select name="kind">${Object.entries(EVENT_KINDS).map(([k, [l]]) => `<option value="${k}" ${kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div></div>
      <div class="form-section"><div class="form-card">
        <label class="toggle">All day<input type="checkbox" name="isAllDay" ${allDay ? 'checked' : ''}></label>
        <div class="two"><label class="field"><span>Starts</span><input name="startDate" type="date" value="${fmt.inputDate(start)}"></label><label class="field time-f ${allDay ? 'hidden' : ''}"><span>&nbsp;</span><input name="startTime" type="time" value="${fmt.inputTime(start)}"></label></div>
        <div class="two"><label class="field"><span>Ends</span><input name="endDate" type="date" value="${fmt.inputDate(end)}"></label><label class="field time-f ${allDay ? 'hidden' : ''}"><span>&nbsp;</span><input name="endTime" type="time" value="${fmt.inputTime(end)}"></label></div>
        <div class="two">
          <label class="field"><span>Repeat</span><select name="repeats">${Object.entries(REPEATS).map(([k, l]) => `<option value="${k}" ${(ev?.repeats || 'never') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="field"><span>Reminder</span><select name="reminder">${reminderOptions(allDay, ev?.reminderMinutes ?? null)}</select></label>
        </div>
        <div class="until-f ${repeating ? '' : 'hidden'}">
          <label class="toggle">Stop repeating on a date<input type="checkbox" name="hasUntil" ${ev?.repeatUntil != null ? 'checked' : ''}></label>
          <label class="field until-date ${ev?.repeatUntil != null ? '' : 'hidden'}"><span>Last day</span><input name="repeatUntil" type="date" value="${ev?.repeatUntil != null ? fmt.inputDate(localDay(ev.repeatUntil)) : fmt.inputDate(addMonths(start, 3))}"></label>
        </div>
      </div>
      ${repeating ? '<div class="fs-foot">This event repeats. Changes apply to every repeat; the dates above are the first one.</div>' : ''}
      <div class="fs-foot">Reminders come from the Mac app.</div></div>
      <div class="form-section"><div class="form-card">
        <label class="field"><span>Project</span><select name="projectID"><option value="">None</option>${jobs.map((p) => `<option value="${esc(p.id)}" ${sameId(p.id, ev?.projectID) ? 'selected' : ''}>${esc(projectName(p))}</option>`).join('')}</select></label>
        <label class="field"><span>With</span><select name="contactID"><option value="">Nobody</option>${contacts().map((c) => `<option value="${esc(c.id)}" ${sameId(c.id, ev?.contactID) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Location</span><input name="location" value="${esc(ev?.location || '')}"></label>
        <label class="field"><span>Notes</span>${dictatedArea('name="notes" rows="2"', ev?.notes)}</label>
      </div></div>
      <div class="sheet-actions"><button type="button" class="btn" data-act="sheet-close">Cancel</button><button type="submit" class="btn primary">${existing ? 'Save' : 'Add Event'}</button></div>
      ${existing ? `<div class="sheet-actions" style="margin-top:10px">${repeating && occurrence ? `<button type="button" class="btn danger" data-act="event-skip">Delete Only This One…</button>` : ''}<button type="button" class="btn danger" data-act="event-delete">${repeating ? 'Delete All Repeats…' : 'Delete…'}</button></div>` : ''}
    </form>`, (el) => {
    const f = $('#event-form', el);
    f.elements.isAllDay.addEventListener('change', () => {
      const on = f.elements.isAllDay.checked;
      $$('.time-f', f).forEach((x) => x.classList.toggle('hidden', on));
      if (!on) { f.elements.startTime.value = '09:00'; f.elements.endTime.value = '10:00'; }
      // Keep the reminder to one the new kind of event offers (as on the Mac).
      const cur = f.elements.reminder.value === '' ? null : Number(f.elements.reminder.value);
      let next = cur;
      if (cur != null) next = on ? (cur < 1440 ? 0 : cur < 2880 ? 1440 : cur < 10080 ? 2880 : 10080) : (cur >= 1440 ? 1440 : 0);
      f.elements.reminder.innerHTML = reminderOptions(on, next);
    });
    f.elements.repeats.addEventListener('change', () => $('.until-f', f).classList.toggle('hidden', f.elements.repeats.value === 'never'));
    f.elements.hasUntil.addEventListener('change', () => $('.until-date', f).classList.toggle('hidden', !f.elements.hasUntil.checked));
    f.elements.kind.addEventListener('change', () => { f.elements.title.placeholder = EVENT_KINDS[f.elements.kind.value][0]; });
    f.elements.projectID.addEventListener('change', () => {
      const p = project(f.elements.projectID.value);
      if (p && !f.elements.location.value) f.elements.location.value = projectAddress(p);
      if (p && !existing && f.elements.kind.value === 'appointment') { f.elements.kind.value = 'siteVisit'; f.elements.title.placeholder = EVENT_KINDS.siteVisit[0]; }
    });
    // Moving the start keeps the length the same.
    let lastStart = parseInputDate(f.elements.startDate.value, f.elements.startTime.value);
    const shift = () => {
      const s = parseInputDate(f.elements.startDate.value, f.elements.isAllDay.checked ? '00:00' : f.elements.startTime.value);
      const e = parseInputDate(f.elements.endDate.value, f.elements.isAllDay.checked ? '00:00' : f.elements.endTime.value);
      if (!s || !lastStart || !e) { lastStart = s; return; }
      const moved = new Date(e.getTime() + (s - lastStart));
      f.elements.endDate.value = fmt.inputDate(moved);
      if (!f.elements.isAllDay.checked) f.elements.endTime.value = fmt.inputTime(moved);
      lastStart = s;
    };
    f.elements.startDate.addEventListener('change', shift);
    f.elements.startTime.addEventListener('change', shift);
  });
}

function sheetAddFile(projectID) {
  openSheet(`
    ${sheetHead('Add a File', project(projectID) ? projectName(project(projectID)) : '')}
    <div class="form-section"><div class="form-card"><label class="field"><span>What is it?</span><select id="upload-cat">${UPLOAD_CHOICES.filter((c) => !PHOTO_CATEGORIES.has(c)).map((c) => `<option value="${c}">${CATEGORY_ONE[c]}</option>`).join('')}</select></label></div></div>
    <div class="btn-row"><button class="btn primary" data-act="upload-go" data-project="${esc(projectID || '')}" data-capture="1">${icon('camera')}Camera</button><button class="btn" data-act="upload-go" data-project="${esc(projectID || '')}">${icon('folder')}Choose File</button></div>
  `);
}

function sheetReceipt() {
  const jobs = projects().filter((p) => statusGroup(p.status) !== 'closed').sort((a, b) => projectName(a).localeCompare(projectName(b)));
  openSheet(`
    ${sheetHead('Snap a Receipt')}
    <div class="form-section"><div class="form-card"><label class="field"><span>Project (optional)</span><select id="receipt-job"><option value="">Company / not sure</option>${jobs.map((p) => `<option value="${esc(key(p.id))}">${esc(projectName(p))}</option>`).join('')}</select></label></div>
    <div class="fs-foot">It waits in Books › Receipts on the Mac. Enter as Expense there reads the store, date and total for you.</div></div>
    <div class="btn-row"><button class="btn primary" data-act="receipt-go" data-capture="1">${icon('camera')}Camera</button><button class="btn" data-act="receipt-go">${icon('image')}Library</button></div>
  `);
}

// ---------------------------------------------------------------------------
// Viewer: photos (swipe between them) and other files. PDFs open in the plan reader (plans.js).

let viewerState = null;
let pdfjs = null;
function loadPdfJs() {
  pdfjs = pdfjs || import('./pdf.min.js').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.js', location.href).href;
    return lib;
  }).catch((e) => { pdfjs = null; throw e; });
  return pdfjs;
}

function viewerList(name) {
  if (!name) return [];
  const [kind, id, pick] = name.split(':');
  if (kind === 'photos') return photosInPick(projectPhotoList(id), pick, photoFolders(project(id))).map((f) => key(f.id));
  if (kind === 'log') return filesFor('recordID', id).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0)).map((f) => key(f.id));
  if (kind === 'draw') return all('file').filter((f) => sameId(f.drawID, id)).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).map((f) => key(f.id));
  return [];
}
const canDelete = (f) => PHOTO_CATEGORIES.has(f.category) && !f.transactionID && !f.drawID;

async function openFile(id, listName = '') {
  const f = get(id);
  if (!f) return;
  if (isPDF(f) && typeof openPlan === 'function') return openPlan(f);
  flushLogSave();
  viewerState?.cleanup?.();
  const list = viewerList(listName);
  const index = list.indexOf(key(f.id));
  const root = $('#sheet-root');
  // A project's photo can move to another of its folders from here.
  const folders = PHOTO_CATEGORIES.has(f.category) ? photoFolders(project(f.projectID)) : [];
  const inFolder = photoFolderOf(f, folders);
  const folderPicker = folders.length ? `<div class="btns"><label class="btn sm folder-pick">${icon('folder')}<span id="viewer-folder">${esc(inFolder ? inFolder.name : 'Not in a Folder')}</span>
      <select data-folder-move="${esc(key(f.id))}" aria-label="Move to folder"${canEditRecord('file', f) ? '' : ' disabled'}><option value="">Not in a Folder</option>${folders.map((x) => `<option value="${esc(key(x.id))}"${inFolder && sameId(inFolder.id, x.id) ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label></div>` : '';
  root.innerHTML = `<div class="viewer" role="dialog" aria-modal="true" aria-label="${esc(fileTitle(f))}">
    <div class="viewer-bar"><button class="icon-btn" data-act="sheet-close" aria-label="Close">${icon('close')}</button><div class="t">${esc(fileTitle(f))}</div><div id="viewer-tools" class="zoom"></div></div>
    <div class="viewer-body" id="viewer-body"><div class="viewer-msg">Loading…</div>
      ${index > 0 ? `<button class="viewer-nav prev" data-act="viewer-step" data-n="-1" aria-label="Previous photo">${icon('left')}</button>` : ''}
      ${index >= 0 && index < list.length - 1 ? `<button class="viewer-nav next" data-act="viewer-step" data-n="1" aria-label="Next photo">${icon('right')}</button>` : ''}</div>
    <div class="viewer-foot"><div>${esc([CATEGORY_ONE[f.category] || '', fmt.date(fileDate(f)), f.fileSize ? fmt.size(f.fileSize) : '', index >= 0 && list.length > 1 ? `${index + 1} of ${list.length}` : ''].filter(Boolean).join(' · '))}</div>${folderPicker}<div class="btns" id="viewer-btns"></div></div></div>`;
  document.body.style.overflow = 'hidden';
  const state = { id: key(f.id), list, listName, index, urls: [], cleanup: null };
  viewerState = state;
  state.cleanup = () => { for (const u of state.urls) URL.revokeObjectURL(u); state.pdf?.destroy?.(); };
  const body = $('#viewer-body');
  // Swipe left or right between photos.
  if (list.length > 1) {
    let sx = null, sy = null;
    body.addEventListener('touchstart', (e) => { if (e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; } else sx = null; }, { passive: true });
    body.addEventListener('touchend', (e) => {
      if (sx == null || (window.visualViewport && visualViewport.scale > 1.05)) return;
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      sx = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) stepViewer(dx < 0 ? 1 : -1);
    }, { passive: true });
  }
  try {
    const blob = await fileBlob(f);
    if (viewerState !== state) return;
    const url = URL.createObjectURL(blob);
    state.urls.push(url);
    const ext = (f.fileExtension || '').toLowerCase();
    const msg = (text) => { $('.viewer-msg', body)?.remove(); body.insertAdjacentHTML('afterbegin', `<div class="viewer-msg">${text}</div>`); };
    if (isImage(f)) {
      const img = new Image();
      img.alt = fileTitle(f);
      img.onload = () => { $('.viewer-msg', body)?.remove(); body.prepend(img); };
      img.onerror = () => msg(`This browser can't show ${esc(ext.toUpperCase())} photos. Use Share or Download to open it.`);
      img.src = url;
    } else {
      msg(`${icon('doc', 'ic', 'width:40px;height:40px')}<br>Use Share or Download to open this ${esc(ext.toUpperCase() || 'file')}.`);
    }
    const name = f.originalFileName || `${fileTitle(f)}${ext ? `.${ext}` : ''}`;
    const fileObj = new File([blob], name, { type: blob.type || contentType(ext) });
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [fileObj] }));
    $('#viewer-btns').innerHTML = `${canShare ? `<button class="btn sm" id="viewer-share">${icon('share')}Share / Save</button>` : ''}
      <a class="btn sm" href="${url}" download="${esc(name)}">${icon('download')}Download</a>
      ${canDelete(f) ? `<button class="btn sm danger" data-act="file-delete" data-id="${esc(key(f.id))}">${icon('trash')}Delete</button>` : ''}`;
    $('#viewer-share')?.addEventListener('click', () => navigator.share({ files: [fileObj], title: fileTitle(f) }).catch(() => {}));
  } catch (e) {
    if (viewerState !== state) return;
    $('.viewer-msg', body)?.remove();
    body.insertAdjacentHTML('afterbegin', `<div class="viewer-msg">${e instanceof ApiError && (e.status === 400 || e.status === 404)
      ? "This file hasn't reached the cloud yet. It downloads after the Mac's next sync."
      : esc(friendlyError(e))}</div>`);
    if (canDelete(f)) $('#viewer-btns').innerHTML = `<button class="btn sm danger" data-act="file-delete" data-id="${esc(key(f.id))}">${icon('trash')}Delete</button>`;
  }
}

function stepViewer(n) {
  const st = viewerState;
  if (!st || st.index < 0) return;
  // The list as it is now: the photo showing may have been moved to another folder meanwhile,
  // in which case its neighbours are where it was.
  const list = viewerList(st.listName);
  const here = list.indexOf(st.id);
  const target = here >= 0 ? here + n : (n > 0 ? st.index : st.index - 1);
  const next = target >= 0 ? list[target] : undefined;
  if (next) openFile(next, st.listName);
}

async function deleteFile(id) {
  const f = get(id);
  if (!f) return;
  const k = key(f.id);
  if (isPending(f)) {
    // Never left this phone: just forget it.
    S.meta.uploads = S.meta.uploads.filter((x) => x !== k);
    await idb.del('blobs', k);
    S.docs.delete(k);
    S.dirty.delete(k);
    await idb.del('docs', k);
    bump();
    await saveMeta();
  } else {
    S.meta.storageDeletes.push(storageName(f));
    await deleteRecord('file', f.id);
  }
}

// ---------------------------------------------------------------------------
// Actions

let deferredInstall = null;

const ACTIONS = {
  back: (el) => { if (render.cameFromApp && history.length > 1) history.back(); else location.hash = el.dataset.to; },
  'sync-pill': () => { if (S.syncError || !navigator.onLine) location.hash = '#/settings'; else { syncNow(); toast('Syncing…'); } },
  'toggle-group': (el) => { const g = el.dataset.group; prefs.set(`show-${g}`, !prefs.get(`show-${g}`, g !== 'closed')); $('#project-results').innerHTML = projectResults(); },
  'toggle-pref': (el) => { prefs.set(el.dataset.pref, el.checked); render(); },
  'toggle-files': (el) => { const c = el.dataset.cat; S.ui.filesOpen[c] = !(S.ui.filesOpen[c] ?? c === 'plansSpecs'); render(); },
  'sheet-close': () => closeSheet(),
  'sheet-backdrop': (el, e) => { if (e.target === el && !sheetDirty) closeSheet(); },

  photo: (el) => {
    const p = project(el.dataset.project);
    const rec = el.dataset.record ? get(el.dataset.record) : null;
    // Into the folder picked on the Photos page.
    const folder = p && el.dataset.folder ? photoFolders(p).find((x) => key(x.id) === el.dataset.folder) : null;
    flushLogSave();
    pickFiles({ accept: 'image/*', capture: !!el.dataset.capture, multiple: !el.dataset.capture },
      (files) => addFiles(files, { projectID: p ? p.id : null, category: 'progressPhoto', recordID: rec ? rec.id : null, folderID: folder ? folder.id : null }));
  },
  'photo-folder': (el) => {
    S.ui.photoFolder = { ...(S.ui.photoFolder || {}), [el.dataset.project]: el.dataset.folder };
    render();
  },
  'photo-folder-new': (el) => sheetNewPhotoFolder(el.dataset.project),
  'photo-folder-create': async (el) => {
    const p = project(el.dataset.project);
    if (!p) { closeSheet(); return; }
    const name = cleanFolderName($('#folder-name')?.value);
    if (!name) { toast('Type a name for the folder.'); return; }
    if (photoFolders(p).some((x) => String(x.name || '').toLowerCase() === name.toLowerCase())) { toast(`There's already a folder named “${name}”.`); return; }
    const id = newId();
    closeSheet();
    if (await editProject(p.id, [{ op: 'addPhotoFolder', id, name }])) {
      S.ui.photoFolder = { ...(S.ui.photoFolder || {}), [key(p.id)]: key(id) };
      toast(`Added ${name}`);
      render();
    }
  },
  'add-file': (el) => sheetAddFile(el.dataset.project),
  'upload-go': (el) => {
    const cat = $('#upload-cat').value;
    const p = project(el.dataset.project);
    closeSheet();
    pickFiles({ accept: el.dataset.capture ? 'image/*' : '', capture: !!el.dataset.capture, multiple: true },
      (files) => addFiles(files, { projectID: p ? p.id : null, category: cat, needsReview: cat === 'receipt' }));
  },
  receipt: () => sheetReceipt(),
  'receipt-go': (el) => {
    const p = project($('#receipt-job').value);
    closeSheet();
    pickFiles({ accept: 'image/*,application/pdf', capture: !!el.dataset.capture, multiple: !el.dataset.capture },
      (files) => addFiles(files, { projectID: p ? p.id : null, category: 'receipt', needsReview: true }));
  },
  'open-file': (el) => openFile(el.dataset.id, el.dataset.list || ''),
  'viewer-step': (el) => stepViewer(Number(el.dataset.n)),
  'file-delete': async (el) => {
    const f = get(el.dataset.id);
    if (!f || !confirm(`Delete this photo?\n\nIt's removed from ${project(f.projectID) ? projectName(project(f.projectID)) : 'Eagle Creek'} on every device. This can't be undone.`)) return;
    const st = viewerState;
    const next = st && st.index >= 0 ? (st.list[st.index + 1] || st.list[st.index - 1]) : null;
    await deleteFile(f.id);
    toast('Photo deleted');
    if (next && st) openFile(next, st.listName); else closeSheet();
  },

  'today-log': (el) => openOrCreateLog(el.dataset.project),
  // Starts listening right away (the tap is what lets the mic open), then opens today's log;
  // what's said lands in its Notes once the form is on screen.
  'voice-note': (el) => { if (Dictation.start(null, { field: 'notes' })) return openOrCreateLog(el.dataset.project); },
  'dictate': (el) => {
    const box = el.closest('.dictate-wrap')?.querySelector('textarea');
    if (!box) return;
    if (Dictation.target === box) Dictation.stop(); else Dictation.start(box);
  },
  'log-other-day': (el) => {
    openSheet(`${sheetHead('Log for Another Day')}
      <div class="form-section"><div class="form-card"><label class="field"><span>Day</span><input type="date" id="other-day" value="${fmt.inputDate(addDays(new Date(), -1))}" max="${fmt.inputDate(new Date())}"></label></div>
      <div class="fs-foot">Opens that day's log, or starts one.</div></div>
      <div class="sheet-actions"><button class="btn" data-act="sheet-close">Cancel</button><button class="btn primary" data-act="log-other-go" data-project="${esc(el.dataset.project)}">Open</button></div>`);
  },
  'log-other-go': (el) => { const d = parseInputDate($('#other-day').value); closeSheet(); if (d) openOrCreateLog(el.dataset.project, d); },
  'weather-pick': (el) => {
    const form = $('#log-form');
    form.elements.weather.value = el.dataset.w;
    $$('[data-act="weather-pick"]', form).forEach((b) => b.classList.toggle('on', b === el));
    queueLogSave(form, true);
  },
  'crew-add': async () => {
    const form = $('#log-form');
    const l = readLogForm(form);
    if (logSave) { clearTimeout(logSave.timer); logSave = null; }
    l.crews.push({ id: newId(), name: '', workers: 1, hours: 8, work: '' });
    await saveRecord('dailyLog', l);
    render();
    const last = $$('[data-crew]').pop();
    $('[name="crew-name"]', last)?.focus();
  },
  'crew-remove': async (el) => {
    const form = $('#log-form');
    const l = readLogForm(form);
    if (logSave) { clearTimeout(logSave.timer); logSave = null; }
    l.crews.splice(Number(el.dataset.i), 1);
    await saveRecord('dailyLog', l);
    render();
  },
  'fill-weather': () => fillWeather($('#log-form')),
  'log-delete': async (el) => {
    const l = get(el.dataset.id);
    if (!l || !confirm(`Delete the log for ${fmt.date(fromSec(l.date))}?\n\nIts photos stay with the project. This can't be undone.`)) return;
    if (logSave) { clearTimeout(logSave.timer); logSave = null; }
    for (const f of filesFor('recordID', l.id)) { const c = clone(f); delete c.recordID; await saveRecord('file', c, { upload: !isPending(f) }); }
    await deleteRecord('dailyLog', l.id);
    location.hash = `#/project/${key(l.projectID)}/logs`;
    toast('Log deleted');
  },

  task: (el) => sheetTask(el.dataset.id),
  'task-status': async (el) => {
    const t = get(el.dataset.id);
    if (workStatus(t) !== el.dataset.status) await saveRecord('task', withStatus(t, el.dataset.status, scheduledTask(t)?.plannedStart));
    closeSheet();
    toast(`Marked ${WORK[el.dataset.status][0]}`);
  },
  'task-save': async (el) => {
    const original = get(el.dataset.id);
    const pct = Number($('#task-pct').value);
    let t = clone(original);
    if (pct !== Math.round(original.percentComplete || 0)) {
      if (pct >= 100) t = withStatus(t, 'done', scheduledTask(original)?.plannedStart);
      else {
        if (isDone(t)) t = withStatus(t, 'working');
        t.percentComplete = pct;
        if (pct > 0 && t.actualStart == null) t.actualStart = toSec(sod(new Date()));
      }
    }
    t.notes = $('#task-notes').value;
    if (JSON.stringify(t) !== JSON.stringify(original)) await saveRecord('task', t);
    closeSheet();
  },

  'punch-new': (el) => sheetPunch(null, el.dataset.project),
  'punch-edit': (el, e) => { if (e.target.closest('.check')) return; sheetPunch(el.dataset.id); },
  // The square: done or not done, like the Mac's checkbox.
  'punch-check': async (el) => {
    const x = clone(get(el.dataset.id));
    const next = x.status === 'closed' ? 'open' : 'closed';
    x.status = next;
    if (next === 'closed') x.closedDate = x.closedDate ?? stamp(); else delete x.closedDate;
    await saveRecord('punchItem', x);
    render();
  },
  'punch-status-pick': (el) => {
    const f = $('#punch-form');
    f.elements.status.value = el.dataset.status;
    $$('[data-act="punch-status-pick"]', f).forEach((b) => b.classList.toggle('on', b === el));
    sheetDirty = true;
  },
  'punch-delete': async (el) => {
    const x = get(el.dataset.id);
    const name = x?.title ? `“${x.title}”` : `punch item #${x?.number || 1}`;
    if (!confirm(`Delete ${name}?\n\nThis can't be undone. To keep it on the list as finished, mark it done instead.`)) return;
    await deleteRecord('punchItem', el.dataset.id);
    closeSheet();
    toast('Deleted');
  },

  'event-new': (el) => sheetEvent(null, { day: el.dataset.t ? Number(el.dataset.t) : S.ui.calDay.getTime() }),
  'event-edit': (el) => sheetEvent(el.dataset.id, { occurrenceDay: el.dataset.day }),
  'event-delete': async () => {
    const f = $('#event-form');
    const ev = get(f.dataset.id);
    const repeats = ev && (ev.repeats || 'never') !== 'never';
    if (!confirm(`${repeats ? 'Delete every repeat of this event?' : 'Delete this event?'}\n\nIt's removed from your calendar on every device.`)) return;
    await deleteRecord('event', f.dataset.id);
    closeSheet();
    toast('Event deleted');
  },
  'event-skip': async () => {
    const f = $('#event-form');
    const ev = clone(get(f.dataset.id));
    const day = new Date(Number(f.dataset.day) * 1000);
    if (!confirm(`Delete only the ${fmt.date(day)} one?\n\nThe other repeats stay on your calendar.`)) return;
    if (!(ev.skippedDays || []).some((s) => localDay(s).getTime() === sod(day).getTime())) {
      ev.skippedDays = [...(ev.skippedDays || []), dayKey(day)];
      await saveRecord('event', ev);
    }
    closeSheet();
    toast(`Removed the ${fmt.short(day)} one`);
  },
  'cal-shift': (el) => { S.ui.calDay = addDays(S.ui.calDay, Number(el.dataset.n)); render(); },
  'cal-day': (el) => { S.ui.calDay = new Date(Number(el.dataset.t)); S.ui.calMode = 'day'; render(); },
  'cal-mode': (el) => { S.ui.calMode = el.dataset.mode; render(); },
  'cal-today': () => { S.ui.calDay = sod(new Date()); S.ui.calMode = 'day'; render(); },

  'sync-now': () => syncNow(),
  'full-sync': () => { syncNow({ full: true }); toast('Downloading everything…'); },
  theme: (el) => { applyTheme(el.dataset.theme); render(); },
  'clear-cache': async () => {
    await idb.clear('cache');
    for (const u of thumbURLs.values()) URL.revokeObjectURL(u);
    thumbURLs.clear();
    toast('Downloaded copies removed');
  },
  'setup-link': async () => {
    const payload = btoa(JSON.stringify({ url: S.config.url, key: S.config.key }));
    const link = `${location.origin}${location.pathname}#setup=${encodeURIComponent(payload)}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Eagle Creek setup link', text: "Paste this into Eagle Creek's sign-in screen (first box):", url: link }); return; } catch (e) { if (e?.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(link); toast('Setup link copied'); } catch { prompt('Copy this link:', link); }
  },
  install: async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; render(); },
  'sign-out': async () => {
    const pending = S.dirty.size + S.meta.uploads.length;
    if (!confirm(pending
      ? `${plural(pending, 'change')} ${pending === 1 ? "hasn't" : "haven't"} uploaded yet and will be lost. Sign out anyway?`
      : 'Sign out of Eagle Creek on this device?\n\nEverything downloaded here is removed. Your data stays safe in the cloud.')) return;
    S.lastEmail = S.session?.email || '';
    await signOut();
    await LOCK.wipe(null);
  },

  // ----- The app lock (Settings › Security)
  'lock-now': async () => { await LOCK.lock(); },
  'lock-timeout': async (el) => { await LOCK.setTimeout(el.dataset.seconds); render(); },
  'lock-bio': async () => {
    if (LOCK.bioEnabled()) {
      if (!confirm('Turn off Face ID / Touch ID for Eagle Creek? Your PIN still unlocks it.')) return;
      await LOCK.removeBiometric();
      toast('Face ID turned off');
      render();
      return;
    }
    const pin = await askPIN('Your PIN', 'To add Face ID / Touch ID, enter your PIN first.');
    if (!pin) return;
    const result = await LOCK.enrollBiometric(pin);
    if (result === 'ok') toast('Face ID / Touch ID can unlock Eagle Creek now');
    else if (result === 'wrong-pin') toast("That wasn't your PIN.");
    else if (result === 'cancelled') toast('Cancelled');
    else toast("This device can't unlock the app with Face ID (its browser doesn't give apps a key from the passkey). The PIN is used.");
    render();
  },
  'lock-change-pin': async () => {
    const current = await askPIN('Current PIN', 'Enter the PIN you use now.');
    if (!current) return;
    const next = await askPIN('New PIN', 'Six digits.');
    if (!next) return;
    const again = await askPIN('Enter It Again', 'The same six digits, to be sure.');
    if (again !== next) { toast("The two PINs didn't match."); return; }
    const ok = await LOCK.changePIN(current, next);
    toast(ok ? 'PIN changed' : "That wasn't your current PIN.");
  },
};

// ---------------------------------------------------------------------------
// The app lock and this device's place among your devices (lock.js does the crypto)

function lockNeedsSetup() { return !!S.session && !LOCK.enabled(); }

LOCK.onLock = async () => {
  clearInterval(autoSyncTimer);
  S.session = null;
  S.team = null;
  S.docs.clear();
  S.dirty.clear();
  S.meta = freshMeta();
  if ($('#sheet-root').children.length) closeSheet();
  bump();
  render();
};

LOCK.onWipe = async (reason) => {
  clearInterval(autoSyncTimer);
  S.lastEmail = S.session?.email || S.lastEmail || '';
  S.session = null;
  S.team = null;
  S.docs.clear();
  S.dirty.clear();
  S.meta = freshMeta();
  S.wipeNotice = reason || null;
  if ($('#sheet-root').children.length) closeSheet();
  bump();
  history.replaceState(null, '', `${location.pathname}#/projects`);
  render();
};

/** Reads what the device holds (sealed until now) and carries on where the app left off. */
async function afterUnlock() {
  await loadDeviceState();
  bump();
  render();
  if (S.session) { syncNow(); startAutoSync(); }
}

function wireLockScreen() {
  const root = $('#lock-screen');
  if (!root) return;
  const foot = $('.lock-foot', root);
  foot.innerHTML = `${LOCK.bioEnabled() ? '<button type="button" class="btn primary" data-lock="bio">Unlock with Face ID</button>' : ''}
    <button type="button" class="btn link danger" data-lock="forget">Sign out and erase this device…</button>`;
  LOCK.wire(root, async (pin) => {
    try {
      if (await LOCK.unlockWithPIN(pin)) { await afterUnlock(); return null; }
    } catch { return null; } // wiped: the welcome screen is up
    const wait = LOCK.waitSeconds();
    $('.lock-hint', root).textContent = wait > 0 ? `Wait ${wait} seconds before trying again.` : 'Enter your PIN.';
    const left = LOCK.MAX_FAILED - LOCK.state.failed;
    return wait > 0 ? `Wrong PIN. Wait ${wait} seconds.` : `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left before this device is erased.`;
  });
  foot.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-lock]');
    if (!b) return;
    if (b.dataset.lock === 'bio') {
      if (await LOCK.unlockWithBiometric()) await afterUnlock();
      else toast("Face ID didn't unlock it. Use your PIN.");
    } else if (b.dataset.lock === 'forget') {
      if (!confirm('Sign out and erase everything Eagle Creek keeps on this device?\n\nYour books stay safe in the cloud. Changes made here that never uploaded would be lost.')) return;
      await LOCK.wipe(null);
    }
  });
}

function wireLockSetup() {
  const root = $('#lock-setup');
  if (!root) return;
  let first = null;
  LOCK.wire(root, async (pin) => {
    if (first === null) {
      first = pin;
      $('h1', root).textContent = 'Enter It Again';
      $('.lock-hint', root).textContent = 'The same six digits, to be sure.';
      return '';
    }
    if (pin !== first) {
      first = null;
      $('h1', root).textContent = 'Set a PIN';
      $('.lock-hint', root).textContent = 'Six digits.';
      return "They didn't match. Start again.";
    }
    $('.lock-hint', root).textContent = "Sealing what's on this device…";
    await LOCK.setUp(pin, { email: S.session?.email || '', timeout: 120 });
    if (await LOCK.bioPossible() && confirm('Unlock with Face ID / Touch ID too?\n\nYour PIN always works as well.')) {
      const result = await LOCK.enrollBiometric(pin);
      if (result === 'ok') toast('Face ID / Touch ID can unlock Eagle Creek');
      else if (result !== 'cancelled') toast("Face ID isn't available for the app on this device; the PIN is used.");
    }
    render();
    syncNow();
    startAutoSync();
    return null;
  });
}

/** Asks for a PIN in a sheet; resolves to the six digits, or null when dismissed. */
function askPIN(title, hint) {
  return new Promise((resolve) => {
    let done = false;
    openSheet(lockKeypad('lock-ask', title, hint), (sheet) => {
      LOCK.wire(sheet.querySelector('#lock-ask'), async (pin) => { done = true; closeSheet(); resolve(pin); return null; });
    });
    const watch = setInterval(() => { if (!$('#lock-ask')) { clearInterval(watch); if (!done) resolve(null); } }, 300);
  });
}

function securitySettingsCard() {
  const timeout = LOCK.config?.timeout ?? 120;
  const bio = LOCK.bioEnabled();
  return card('Security', `<div style="padding:0 16px 14px">
    <div class="kv"><span>App lock</span><span>${LOCK.enabled() ? (bio ? 'PIN and Face ID' : 'PIN') : 'Off'}</span></div>
    <div class="kv"><span>This device</span><span>${esc(deviceName())}</span></div>
    <p class="note" style="margin-top:4px">Everything Eagle Creek keeps on this device is encrypted behind the lock; ten wrong PINs, or ${LOCK.EXPIRY_DAYS} days without unlocking, erase the device's copy. Your books stay in the cloud. Every device is listed, and can be signed out, in Eagle Creek Books on the Mac (Settings › Security).</p>
    <div class="fs-head" style="margin-top:10px">Lock after being in the background</div>
    <div class="segmented" role="radiogroup">${LOCK.TIMEOUTS.map(([sec, label]) => `<button data-act="lock-timeout" data-seconds="${sec}" class="${timeout === sec ? 'on' : ''}" role="radio" aria-checked="${timeout === sec}">${label.replace('After ', '')}</button>`).join('')}</div>
    <div class="btn-row wrap" style="margin-top:10px">
      <button class="btn" data-act="lock-bio">${bio ? 'Turn Off Face ID' : 'Use Face ID / Touch ID'}</button>
      <button class="btn" data-act="lock-change-pin">Change PIN</button>
      <button class="btn" data-act="lock-now">${icon('logout')}Lock Now</button>
    </div>
  </div>`);
}

/** This install's id among your devices (kept in the clear; it's only a name). */
async function deviceID() {
  let id = await rawIDB.get('kv', 'device');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))].map((b, i) => (i === 4 || i === 6 || i === 8 || i === 10 ? '-' : '') + b.toString(16).padStart(2, '0')).join('')).toLowerCase();
    await rawIDB.set('kv', 'device', id);
  }
  return id;
}

function deviceName() {
  const ua = navigator.userAgent;
  const device = /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android phone' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : 'Device';
  const browser = isStandalone() ? 'Home Screen app' : /CriOS|Chrome/.test(ua) ? 'Chrome' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : 'browser';
  return `${device} (${browser})`;
}

function platformName() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'macOS';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Web';
}

/**
 * This device's row among your devices (kind "device" in Eagle Creek Books' table): kept fresh
 * every ten minutes, and obeyed when the Mac signs this device out. Resolves true when the
 * device wiped itself.
 */
async function deviceCheckIn() {
  if (S.ledgerUnavailable) return false;
  const id = await deviceID();
  const row = S.docs.get(id);
  const justSignedIn = !!(await rawIDB.get('kv', 'device-fresh'));
  if (row && !row.deleted && row.data.revokedAt && !justSignedIn) {
    await LOCK.wipe('This device was signed out from your Mac (Eagle Creek Books › Settings › Security), so its copy of your books was erased. Sign in again to use it here.');
    return true;
  }
  const now = stamp();
  const data = row && !row.deleted ? clone(row.data) : { id: id.toUpperCase(), registeredAt: now, app: 'phone' };
  const fresh = !justSignedIn && row && !data.revokedAt && now - (Number(data.lastSeenAt) || 0) < 600 && data.appVersion === APP_VERSION && data.lockEnabled === LOCK.enabled() && data.name === deviceName();
  if (justSignedIn) await rawIDB.del('kv', 'device-fresh');
  if (fresh) return false;
  Object.assign(data, { name: deviceName(), app: 'phone', platform: platformName(), appVersion: APP_VERSION, lastSeenAt: now, lockEnabled: LOCK.enabled(), revokedAt: null });
  await saveRecord('device', data, { upload: true });
  return false;
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  if (el.tagName === 'A') e.preventDefault();
  if (el.dataset.act === 'punch-check') e.stopPropagation();
  Promise.resolve(fn(el, e)).catch((err) => { console.error(err); toast(friendlyError(err)); });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#sheet-root').children.length) closeSheet();
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.row[role=button]')) { e.preventDefault(); e.target.click(); }
  if (viewerState && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) stepViewer(e.key === 'ArrowRight' ? 1 : -1);
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  e.preventDefault();
  try {
    if (form.id === 'signin') {
      const err = $('#signin-err');
      const btn = $('button[type=submit]', form);
      err.textContent = '';
      const link = readSetupLink(form.elements.url.value);
      if (link) { form.elements.url.value = link.url; form.elements.key.value = link.key; }
      const login = form.elements.email.value.trim();
      if (!login.includes('@') && !validUsername(login)) { err.textContent = "That isn't a username. A username is letters and numbers (dashes and underscores too), or sign in with an email."; return; }
      const builtIn = builtInProject();
      if (builtIn && !form.elements.url.value.trim()) { form.elements.url.value = builtIn.url; form.elements.key.value = builtIn.key; }
      let url = form.elements.url.value.trim();
      if (url && !/^https?:\/\//.test(url)) url = `https://${url}`;
      try { url = new URL(url).origin; } catch { err.textContent = "That doesn't look like a Supabase project URL."; return; }
      const anon = form.elements.key.value.trim();
      if (/^sb_secret_/.test(anon) || /service_role/.test(atobSafe(anon.split('.')[1] || ''))) {
        err.textContent = "That's the secret key. Use the anon or publishable key instead; the secret one should never go in an app.";
        return;
      }
      S.config = { url, key: anon };
      btn.disabled = true;
      btn.textContent = 'Signing in…';
      try {
        await idb.set('kv', 'config', S.config);
        await signIn(login, form.elements.password.value);
        history.replaceState(null, '', `${location.pathname}#/projects`);
        render();
        syncNow({ full: true });
        startAutoSync();
      } catch (ex) {
        err.textContent = friendlyError(ex);
        btn.disabled = false;
        btn.textContent = 'Sign In';
      }
    }
    if (form.id === 'punch-form') {
      const title = form.elements.title.value.trim();
      if (!title) { form.elements.title.focus(); return; }
      const id = form.dataset.id;
      const p = project(form.dataset.project);
      let x;
      if (id) x = clone(get(id));
      else {
        const numbers = all('punchItem').filter((i) => sameId(i.projectID, form.dataset.project)).map((i) => i.number || 0);
        x = { id: newId(), projectID: p ? p.id : form.dataset.project, number: (numbers.length ? Math.max(...numbers) : 0) + 1, createdDate: stamp(), status: 'open' };
      }
      x.title = title;
      x.location = form.elements.location.value.trim();
      x.details = form.elements.details.value;
      const c = form.elements.contactID.value;
      if (c) x.contactID = c; else delete x.contactID;
      const due = parseInputDate(form.elements.dueDate.value);
      if (due) x.dueDate = toSec(localNoon(due)); else delete x.dueDate;
      const status = form.elements.status.value || 'open';
      if (status === 'closed') x.closedDate = x.status === 'closed' && x.closedDate ? x.closedDate : stamp(); else delete x.closedDate;
      x.status = status;
      await saveRecord('punchItem', x);
      closeSheet();
      toast(id ? 'Saved' : `Added #${x.number}`);
    }
    if (form.id === 'event-form') {
      const id = form.dataset.id;
      const ev = id ? clone(get(id)) : { id: newId(), skippedDays: [], externalCalendarID: '', externalID: '' };
      ev.title = form.elements.title.value.trim();
      ev.kind = form.elements.kind.value;
      const pid = form.elements.projectID.value;
      if (pid) ev.projectID = pid; else delete ev.projectID;
      const cid = form.elements.contactID.value;
      if (cid) ev.contactID = cid; else delete ev.contactID;
      ev.isAllDay = form.elements.isAllDay.checked;
      ev.location = form.elements.location.value.trim();
      ev.notes = form.elements.notes.value;
      ev.repeats = form.elements.repeats.value;
      const rem = form.elements.reminder.value;
      if (rem === '') delete ev.reminderMinutes; else ev.reminderMinutes = Number(rem);
      if (ev.isAllDay) {
        // All-day days are calendar dates, stored the Mac's way so they stay put in any time zone.
        const s = parseInputDate(form.elements.startDate.value) || new Date();
        const en = parseInputDate(form.elements.endDate.value) || s;
        ev.start = dayKey(s);
        ev.end = dayKey(en < s ? s : en);
      } else {
        const s = parseInputDate(form.elements.startDate.value, form.elements.startTime.value) || new Date();
        let en = parseInputDate(form.elements.endDate.value, form.elements.endTime.value) || new Date(s.getTime() + 3600_000);
        if (en <= s) en = new Date(s.getTime() + 3600_000);
        ev.start = toSec(s);
        ev.end = toSec(en);
      }
      if (ev.repeats === 'never') { delete ev.repeatUntil; ev.skippedDays = []; }
      else if (form.elements.hasUntil.checked) {
        const u = parseInputDate(form.elements.repeatUntil.value);
        if (u) ev.repeatUntil = dayKey(u); else delete ev.repeatUntil;
      } else delete ev.repeatUntil;
      await saveRecord('event', ev);
      closeSheet();
      toast(id ? 'Saved' : 'Event added');
    }
  } catch (err) {
    console.error(err);
    toast(friendlyError(err));
  }
});
function atobSafe(s) { try { return atob(s.replace(/-/g, '+').replace(/_/g, '/')); } catch { return ''; } }

document.addEventListener('input', (e) => {
  if (e.target.id === 'project-search') {
    S.ui.search = e.target.value;
    $('#project-results').innerHTML = projectResults();
    return;
  }
  if (e.target.tagName === 'TEXTAREA') autoGrow(e.target);
  if (e.target.closest('.sheet')) sheetDirty = true;
  const form = e.target.closest('#log-form');
  if (form) queueLogSave(form);
});
document.addEventListener('change', (e) => {
  if (e.target.matches?.('[data-folder-move]')) {
    movePhotoToFolder(e.target.dataset.folderMove, e.target.value);
    return;
  }
  if (e.target.closest('.sheet')) sheetDirty = true;
  const form = e.target.closest('#log-form');
  if (form) queueLogSave(form, true);
});
// Pasting a setup link into the sign-in screen fills in the URL and key.
document.addEventListener('paste', (e) => {
  if (e.target?.name !== 'url' || !e.target.closest('#signin')) return;
  const link = readSetupLink(e.clipboardData?.getData('text') || '');
  if (!link) return;
  e.preventDefault();
  const form = $('#signin');
  form.elements.url.value = link.url;
  form.elements.key.value = link.key;
  toast('Supabase details filled in');
  form.elements.email.focus();
});

$('#picker').addEventListener('change', (e) => {
  const files = e.target.files;
  if (files && files.length && pickerHandler) pickerHandler(files);
  pickerHandler = null;
});

// ---------------------------------------------------------------------------
// Start up

let autoSyncTimer = null;
function startAutoSync() {
  clearInterval(autoSyncTimer);
  autoSyncTimer = setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 60_000);
}

window.addEventListener('hashchange', () => {
  render.cameFromApp = true;
  if ($('#sheet-root').children.length) { viewerState?.cleanup?.(); viewerState = null; $('#sheet-root').innerHTML = ''; document.body.style.overflow = ''; }
  render();
});
window.addEventListener('online', () => { renderHeader(); syncNow(); });
window.addEventListener('offline', () => renderHeader());
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    // Back from the background: lock if it was away long enough (the setting), else carry on.
    if (LOCK.enabled() && LOCK.key && LOCK.state.hiddenAt && Date.now() - LOCK.state.hiddenAt >= (LOCK.config.timeout || 0) * 1000) { await LOCK.lock(); return; }
    if (!reloadForUpdate()) syncNow();
  } else {
    flushLogSave();
    if (LOCK.enabled() && LOCK.key) { LOCK.state.hiddenAt = Date.now(); LOCK.saveState(); }
  }
});
function reloadForUpdate() {
  if (!S.updateReady) return false;
  const a = document.activeElement;
  const busy = $('#sheet-root').children.length || (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) || S.meta.uploads.length && S.syncing;
  if (busy) return false;
  flushLogSave();
  setTimeout(() => location.reload(), 300);
  return true;
}
window.addEventListener('pagehide', flushLogSave);
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; if (route().name === 'settings') renderSoon(); });
// A new day: "today", late flags and the forecast move on.
setInterval(() => { if (S.ui.lastDay && !sameDay(S.ui.lastDay, new Date())) { S.ui.lastDay = new Date(); renderSoon(); } }, 60_000);

async function boot() {
  applyTheme();
  // A setup link (#setup=…) fills in the Supabase details.
  const link = readSetupLink(location.hash);
  if (link) history.replaceState(null, '', `${location.pathname}#/projects`);
  let locked = false;
  try {
    if (link) await rawIDB.set('kv', 'config', link);
    S.config = (await rawIDB.get('kv', 'config')) || builtInProject() || null;
    await LOCK.load(rawIDB);
    if (LOCK.isExpired()) {
      await LOCK.wipe(`Eagle Creek wasn't unlocked on this device for ${LOCK.EXPIRY_DAYS} days, so its copy of your books was erased. Sign in again to download them.`);
    }
    // With a lock set up, what's stored stays sealed until the PIN (or Face ID) opens it.
    locked = LOCK.isLocked();
    if (!locked) await loadDeviceState();
  } catch (e) {
    $('#main').innerHTML = banner(`This browser won't let Eagle Creek save anything (${e.message}). Private browsing can cause this.`, 'var(--danger)');
    return;
  }
  S.ui.lastDay = new Date();
  bump();
  render();
  if (S.session && !locked && !lockNeedsSetup()) { syncNow(); startAutoSync(); }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // A new version published to the site takes over when it's safe: not while you're typing or
    // in the middle of a form, so nothing is lost.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || S.updateReady) return;
      S.updateReady = true;
      reloadForUpdate();
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // Ask the browser to keep this app's data even when space runs low.
  navigator.storage?.persist?.().catch(() => {});
}

/** The sign-in, the sync bookkeeping and every record kept on the device. */
async function loadDeviceState() {
  S.session = (await idb.get('kv', 'session')) || null;
  S.team = (await idb.get('kv', 'team')) || null;
  const meta = await idb.get('kv', 'meta');
  if (meta) {
    S.dirty = new Set(meta.dirty || []);
    delete meta.dirty;
    S.meta = { ...freshMeta(), ...meta };
    // 1.4.0 kept project edits as projectOps.
    if (meta.projectOps) { for (const [k, v] of Object.entries(meta.projectOps)) S.meta.recordOps[k] = { kind: 'project', ...v }; delete S.meta.projectOps; }
    // This version keeps more kinds of records: read everything once to pick up the older ones.
    if (S.meta.kinds !== KINDS_KEY) { S.meta.cursor = null; S.meta.lastFull = 0; S.meta.kinds = KINDS_KEY; }
  }
  S.docs.clear();
  for (const [k, row] of await idb.all('docs')) S.docs.set(k, row);
}

// Once every script is in (the other modules define views app.js renders).
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { boot(); });
else boot();
