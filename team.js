// The team (1.14.0): signing in with a username, and what each person may see and change.
// The owner adds people and sets their access in Eagle Creek on the Mac (Settings › Team); the
// database enforces it (supabase/setup.sql: team_members, team_area, team_allows). This file
// keeps the phone in step: it hides what a person can't see and stops edits they can't make
// before the database has to refuse them.

/** Usernames sign in as <username>@team.eaglecreek.invalid, an address that never gets mail. */
const TEAM_DOMAIN = 'team.eaglecreek.invalid';
const TURNED_OFF_NOTICE = 'The owner turned off your access to Eagle Creek, so its copy of the books on this device was erased.';

const AREA_LABELS = {
  projects: 'Projects & schedule',
  files: 'Files & photos',
  contacts: 'Contacts',
  jobCosts: 'Budgets & contracts',
  time: 'Timesheets',
  money: 'Books & banking',
  travel: 'Trips & mileage',
};

/** Which part of the app each tab is (Email is the owner's alone). */
const TAB_AREAS = { projects: 'projects', schedule: 'projects', calendar: 'projects', trips: 'travel', books: 'money', contacts: 'contacts', mail: 'owner', settings: 'any' };

/** "jake" → jake@team.eaglecreek.invalid; an email address stays as it is. */
function loginAddress(text) {
  const t = String(text || '').trim();
  return t.includes('@') ? t : `${t.toLowerCase()}@${TEAM_DOMAIN}`;
}
const validUsername = (t) => /^[a-z0-9][a-z0-9_-]{2,31}$/.test(String(t || '').trim().toLowerCase());

/** How a sign-in is shown: the username, or the email. */
function loginName(email) {
  const e = String(email || '');
  return e.toLowerCase().endsWith(`@${TEAM_DOMAIN}`) ? e.slice(0, -(TEAM_DOMAIN.length + 1)) : e;
}

/** The area a kind of record belongs to (the same as team_area in setup.sql; the database also
 *  keeps the personal books and statement-type vault files from members without Books & Banking). */
function areaOf(kind) {
  if (LEDGER_KINDS.includes(kind) || kind === 'bankConnection') return kind === 'device' ? 'any' : kind === 'bankConnection' ? 'owner' : 'money';
  if (['project', 'task', 'punchItem', 'dailyLog', 'event', 'planSheet', 'planMark'].includes(kind)) return 'projects';
  if (kind === 'file') return 'files';
  if (kind === 'contact') return 'contacts';
  if (['commitment', 'changeOrder', 'payApp', 'costItem'].includes(kind)) return 'jobCosts';
  if (kind === 'timeEntry') return 'time';
  if (['transaction', 'books'].includes(kind)) return 'money';
  if (['trip', 'mileage'].includes(kind)) return 'travel';
  if (kind === 'company') return 'company';
  return 'owner';
}

const isMember = () => S.team?.role === 'member';

/** Vault categories that go with Books & Banking (the same list as team_area_of in setup.sql). */
const BOOKS_ONLY_CATEGORIES = ['financialStatement', 'bankStatement', 'taxReturn', 'taxForm', 'loanDocument', 'entityDocument', 'email'];
/** A file record that goes with Books & Banking: a statement-type category, or an email's attachment. */
const fileGoesWithBooks = (f) => BOOKS_ONLY_CATEGORIES.includes(f?.category) || (!!f?.recordID && String(f?.notes || '').startsWith('From the email '));
/** Whether this person may save this record as it is (the database's own test). */
function canEditRecord(kind, data) {
  if (!isMember()) return true;
  if (kind === 'file' && fileGoesWithBooks(data)) return canEdit('money');
  if (LEDGER_KINDS.includes(kind) && data?.entityID && key(data.entityID) !== '72a26b35-295a-55fb-aeb0-4856302b5b18') return false;
  return canEditKind(kind);
}

function canView(area) {
  if (!isMember() || area === 'any') return true;
  if (S.team.disabled) return false;
  // The company profile (reserves, track record) goes with Books & Banking.
  if (area === 'company') return ['view', 'edit'].includes(S.team.access?.money);
  if (area === 'owner') return false;
  return ['view', 'edit'].includes(S.team.access?.[area]);
}

function canEdit(area) {
  if (!isMember()) return true;
  if (S.team.disabled) return false;
  if (area === 'any') return true;
  if (area === 'owner' || area === 'company') return false;
  return S.team.access?.[area] === 'edit';
}

const canViewKind = (kind) => canView(areaOf(kind));
const canEditKind = (kind) => canEdit(areaOf(kind));
const canViewTab = (tab) => canView(TAB_AREAS[tab] || 'any');

/** Whose books these are: files live in the owner's folder, whoever adds them. */
function dataOwner() {
  return String((isMember() && S.team.owner) || S.session?.userID || '').toLowerCase();
}

class ViewOnlyError extends Error {}

/** Says why a change can't be made, and returns the error to throw. */
function refuseViewOnly(kind) {
  const label = AREA_LABELS[areaOf(kind)];
  const message = label && canView(areaOf(kind))
    ? `You can view ${label} but not change it. The owner can give you edit access.`
    : "Your sign-in can't change this.";
  toast(message);
  return new ViewOnlyError(message);
}

// A refused edit has already said why; it isn't a crash.
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason instanceof ViewOnlyError) { e.preventDefault(); renderSoon(); }
});

/**
 * Reads this person's place on the team (their own row in team_members; the owner and a project
 * from before the team have none and see everything). Returns true when it changed.
 */
async function loadMyAccess(token) {
  let rows = [];
  try {
    rows = await api('/rest/v1/team_members', {
      token, query: [['user_id', `eq.${S.session.userID}`], ['select', 'role,access,disabled,username,name,owner_id']],
    });
  } catch (e) {
    // A Supabase project that hasn't run setup.sql v1.4 yet has no team: everything, as before.
    if (!(e instanceof ApiError && (e.status === 404 || /team_members/.test(e.message)))) throw e;
  }
  const row = Array.isArray(rows) ? rows[0] : null;
  const next = row && row.role === 'member'
    ? { role: 'member', owner: String(row.owner_id || '').toLowerCase(), access: row.access || {}, disabled: !!row.disabled, username: row.username || '', name: row.name || '' }
    : { role: 'owner', owner: S.session.userID, access: {}, disabled: false, username: row?.username || '', name: row?.name || '' };
  const changed = JSON.stringify(S.team || null) !== JSON.stringify(next);
  S.team = next;
  if (changed) {
    await idb.set('kv', 'team', next);
    await forgetHiddenRecords();
  }
  return changed;
}

/**
 * Takes records this person may no longer see off the device, and reads everything again on the
 * next sync, so anything newly allowed comes in.
 */
async function forgetHiddenRecords() {
  const gone = [];
  for (const [id, row] of S.docs) if (!canViewKind(row.kind)) gone.push(id);
  for (const id of gone) {
    S.docs.delete(id);
    S.dirty.delete(id);
    delete S.meta.recordOps[id];
  }
  if (gone.length) await idb.batch('docs', [], gone);
  if (!canEdit('files') && S.meta.uploads.length) {
    for (const id of S.meta.uploads) await idb.del('blobs', id);
    S.meta.uploads = [];
  }
  S.meta.cursor = null;
  S.meta.lastFull = 0;
  S.meta.ledgerCursor = null;
  S.meta.ledgerLastFull = 0;
  await saveMeta();
  bump();
}

/** What a member may do, for Settings. */
function accessSummaryHTML() {
  if (!isMember()) return '';
  const rows = Object.entries(AREA_LABELS).map(([area, label]) => {
    const level = S.team.access?.[area] || 'none';
    return `<div class="kv"><span>${esc(label)}</span><span>${level === 'edit' ? 'View and change' : level === 'view' ? 'View only' : 'No access'}</span></div>`;
  }).join('');
  return `<div class="fs-head" style="margin-top:10px">Your access</div>${rows}<p class="note">Set by the owner in Eagle Creek on the Mac (Settings › Team).</p>`;
}

/** Shown in place of a page this person can't see. */
function viewNoAccess(tab) {
  setHeader({ title: 'Eagle Creek' });
  const first = TABS.find(([r]) => canViewTab(r) && r !== 'settings');
  const label = AREA_LABELS[TAB_AREAS[tab]];
  return emptyState('key', 'Not part of your access',
    label ? `Your sign-in doesn't include ${label}. The owner can change that in Eagle Creek on the Mac (Settings › Team).` : "This part of Eagle Creek is the owner's.",
    first ? `<a class="btn primary" href="#/${first[0]}">Go to ${esc(first[1])}</a>` : '');
}
