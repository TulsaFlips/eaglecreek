/* Eagle Creek — Notes (1.18.0).
 *
 * A notes app of its own, in the Notes tab: quick notes and checklists, pinned ones on top,
 * folders, a project on a note when it belongs to one, search, dictation into any note, and
 * sharing. Notes are records (kind `note`) in the same Supabase account as everything else, so
 * they're on every phone, iPad and computer you sign in on, and work with no signal.
 *
 * A note: { id, title, body, kind: 'text' | 'checklist', items: [{ id, text, done }], folder,
 *   projectID, pinned, createdAt, updatedAt }
 */
'use strict';

const NOTE_SAVE_DELAY = 600;

// ----- Reading notes

const allNotes = () => all('note');
const noteTitle = (n) => (n.title || '').trim() || firstLine(n) || 'New Note';
function firstLine(n) {
  if (n.kind === 'checklist') return (n.items || []).find((i) => (i.text || '').trim())?.text.trim() || '';
  return (n.body || '').trim().split('\n')[0].trim();
}
/** What a note says, flattened, for the list and for search. */
function noteText(n) {
  return n.kind === 'checklist' ? (n.items || []).map((i) => i.text || '').join('\n') : n.body || '';
}
function noteSnippet(n) {
  const title = (n.title || '').trim();
  if (n.kind === 'checklist') {
    const items = (n.items || []).filter((i) => (i.text || '').trim());
    const done = items.filter((i) => i.done).length;
    if (!items.length) return 'Empty checklist';
    const open = items.filter((i) => !i.done).slice(0, 2).map((i) => i.text.trim());
    return `${done}/${items.length} done${open.length ? ` · ${open.join(', ')}` : ''}`;
  }
  const lines = (n.body || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const rest = title ? lines : lines.slice(1);
  return rest.join(' · ').slice(0, 140) || (title ? 'No additional text' : '');
}
const noteFolders = () => [...new Set(allNotes().map((n) => (n.folder || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
const noteMatches = (n, q) => !q || `${n.title || ''}\n${noteText(n)}\n${n.folder || ''}\n${projectName(project(n.projectID))}`.toLowerCase().includes(q);

/** Newest edited first, pinned ahead of the rest. */
const sortNotes = (list) => list.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0));

function noteBucket(n) {
  const d = fromSec(n.updatedAt || n.createdAt);
  const days = -dayDiff(new Date(), d);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 Days';
  if (days < 30) return 'Previous 30 Days';
  return fmt.month(d);
}

// ----- The list

function viewNotes() {
  const q = (S.ui.notesSearch || '').trim().toLowerCase();
  const folder = S.ui.notesFolder || '';
  setHeader({ title: 'Notes', actions: `<button class="icon-btn" data-act="note-voice" aria-label="Voice note" title="Voice note">${icon('mic')}</button><button class="icon-btn" data-act="note-new" aria-label="New note" title="New note">${icon('plus')}</button>` });
  const notes = allNotes();
  if (!notes.length && !q) {
    return emptyState('note', 'No Notes Yet', 'Quick notes, checklists and voice notes, on every device you sign in on. Pin the ones you keep coming back to, put them in folders, and tie a note to a project when it belongs to one.',
      `<div class="btn-row wrap" style="justify-content:center;margin-top:14px"><button class="btn primary" data-act="note-new">${icon('plus')}New Note</button><button class="btn" data-act="note-voice">${icon('mic')}Voice Note</button><button class="btn" data-act="note-new" data-kind="checklist">${icon('checkCircle')}Checklist</button></div>`);
  }
  const folders = noteFolders();
  let html = `<div class="search">${icon('search')}<input class="input" id="note-search" type="search" placeholder="Search notes" value="${esc(S.ui.notesSearch || '')}" autocomplete="off"></div>`;
  if (folders.length || folder) {
    html += `<div class="chips">${[['', 'All'], ['*pinned', 'Pinned'], ...folders.map((f) => [f, f])].map(([k, label]) => `<button type="button" data-act="note-folder-pick" data-folder="${esc(k)}" class="${folder === k ? 'on' : ''}">${k ? icon(k === '*pinned' ? 'pushpin' : 'folder', 'ic chip-ic') : ''}${esc(label)}</button>`).join('')}</div>`;
  }
  html += `<div id="note-results">${noteResults()}</div>`;
  html += `<div class="btn-row" style="justify-content:center;margin-top:16px"><button class="btn primary" data-act="note-new">${icon('plus')}New Note</button><button class="btn" data-act="note-new" data-kind="checklist">${icon('checkCircle')}Checklist</button></div>`;
  return html;
}

function noteResults() {
  const q = (S.ui.notesSearch || '').trim().toLowerCase();
  const folder = S.ui.notesFolder || '';
  let list = allNotes().filter((n) => noteMatches(n, q));
  if (folder === '*pinned') list = list.filter((n) => n.pinned);
  else if (folder) list = list.filter((n) => (n.folder || '').trim() === folder);
  list = sortNotes(list);
  if (!list.length) return emptyState('search', q ? 'Nothing Found' : 'Nothing Here', q ? `No note mentions “${S.ui.notesSearch.trim()}”.` : folder === '*pinned' ? 'Pin a note from its page (the pin at the top).' : 'This folder is empty.');
  let html = '';
  if (!q && !folder) {
    const pinned = list.filter((n) => n.pinned);
    if (pinned.length) html += card('Pinned', pinned.map(noteRow).join(''), { icon: 'pushpin' });
    list = list.filter((n) => !n.pinned);
  }
  const groups = new Map();
  for (const n of list) { const b = noteBucket(n); if (!groups.has(b)) groups.set(b, []); groups.get(b).push(n); }
  for (const [label, arr] of groups) html += card(label, arr.map(noteRow).join(''), { icon: false });
  return html;
}

function noteRow(n) {
  const d = fromSec(n.updatedAt || n.createdAt);
  const when = dayDiff(new Date(), d) === 0 ? fmt.time(d) : fmt.short(d);
  const p = project(n.projectID);
  const tags = [n.folder ? `<span class="note-tag">${icon('folder', 'ic')}${esc(n.folder)}</span>` : '', p ? `<span class="note-tag">${icon('house', 'ic')}${esc(projectName(p))}</span>` : ''].filter(Boolean).join('');
  return `<a class="row" href="#/note/${esc(key(n.id))}">${icon(n.kind === 'checklist' ? 'checkCircle' : 'note', 'ic glyph', `--tint:${n.kind === 'checklist' ? 'var(--forest)' : 'var(--gold)'}`)}
    <div class="main"><div class="t">${n.pinned ? `${icon('pushpin', 'ic pin-ic')}` : ''}${esc(noteTitle(n))}</div><div class="s">${esc(noteSnippet(n))}</div>${tags ? `<div class="note-tags">${tags}</div>` : ''}</div>
    <div class="end"><span>${esc(when)}</span></div>${icon('chev', 'ic chev')}</a>`;
}

// ----- One note

function viewNote(id) {
  const n = get(id);
  if (!n || !allNotes().includes(n)) {
    setHeader({ title: 'Note', back: '#/notes' });
    return emptyState('note', 'Not on This Device', 'This note may have been deleted on another device.');
  }
  const nid = esc(key(n.id));
  setHeader({ title: noteTitle(n), back: '#/notes',
    actions: `<button class="icon-btn ${n.pinned ? 'on' : ''}" data-act="note-pin" data-id="${nid}" aria-label="${n.pinned ? 'Unpin' : 'Pin'}" title="${n.pinned ? 'Unpin' : 'Pin'}">${icon(n.pinned ? 'pinFilled' : 'pushpin')}</button><button class="icon-btn" data-act="note-more" data-id="${nid}" aria-label="More" title="More">${icon('dots')}</button>` });
  const p = project(n.projectID);
  const chips = `<div class="note-chips">
    <button type="button" class="note-chip" data-act="note-folder" data-id="${nid}">${icon('folder')}${esc(n.folder || 'No folder')}</button>
    <button type="button" class="note-chip" data-act="note-project" data-id="${nid}">${icon('house')}${p ? esc(projectName(p)) : 'No project'}</button>
  </div>`;
  const body = n.kind === 'checklist' ? checklistHTML(n) : `<label class="field" style="margin:0"><span class="sr">Note</span>${dictatedArea('name="body" placeholder="Start writing, or tap the mic and talk" data-min="220" rows="8"', n.body)}</label>`;
  const created = fromSec(n.createdAt || n.updatedAt);
  const edited = fromSec(n.updatedAt || n.createdAt);
  return `<form id="note-form" data-id="${nid}" autocomplete="off" onsubmit="return false">
    <div class="note-paper">
      <input name="title" class="note-title" placeholder="Title" value="${esc(n.title || '')}" aria-label="Title">
      ${chips}
      ${body}
    </div>
    <div class="note-foot"><span id="saved-note">${S.dirty.has(key(n.id)) ? 'Saved on this device' : 'Saved'}</span><span>Edited ${esc(fmt.dateTime(edited))}${sameDay(created, edited) ? '' : ` · Created ${esc(fmt.date(created))}`}</span></div>
  </form>`;
}

function checklistHTML(n) {
  const items = n.items || [];
  const rows = items.map((it, i) => `<div class="check-row ${it.done ? 'done' : ''}" data-index="${i}">
    <input type="checkbox" class="check-box" data-index="${i}" ${it.done ? 'checked' : ''} aria-label="Done">
    <input class="check-text" name="item" data-index="${i}" value="${esc(it.text || '')}" placeholder="Item" enterkeyhint="next">
    <button type="button" class="check-del" data-act="note-item-remove" data-index="${i}" aria-label="Remove">${icon('close')}</button>
  </div>`).join('');
  const done = items.filter((i) => i.done).length;
  return `<div class="checklist">${rows}
    <button type="button" class="btn link" data-act="note-item-add" style="margin-top:4px">${icon('plus')}Add Item</button>
    ${items.length ? `<div class="check-foot"><span>${done} of ${items.length} done</span>${done ? `<button type="button" class="btn link" data-act="note-items-clear-done">Remove Done</button>` : ''}</div>` : ''}
  </div>`;
}

// ----- Saving, like the daily log: as you type, a moment after you stop

let noteSave = null; // { form, timer }
function readNoteForm(form) {
  const current = get(form.dataset.id);
  if (!current) return null;
  const n = clone(current);
  n.title = form.elements.title?.value ?? n.title;
  if (n.kind === 'checklist') {
    const texts = [...form.querySelectorAll('.check-text')].map((i) => i.value);
    const dones = [...form.querySelectorAll('.check-box')].map((i) => i.checked);
    n.items = (n.items || []).map((it, i) => ({ ...it, text: texts[i] ?? it.text, done: dones[i] ?? it.done }));
  } else {
    n.body = form.elements.body?.value ?? n.body;
  }
  return n;
}
function flushNoteSave() {
  if (!noteSave) return;
  const { form } = noteSave;
  clearTimeout(noteSave.timer);
  noteSave = null;
  if (!form.isConnected) return;
  const n = readNoteForm(form);
  if (!n || JSON.stringify(n) === JSON.stringify(get(form.dataset.id))) { setSavedNote('Saved'); return; }
  saveRecord('note', n).then(() => { setSavedNote(navigator.onLine ? 'Saved' : 'Saved on this device'); const h = $('#top h1'); if (h) h.textContent = noteTitle(n); });
}
function queueNoteSave(form, immediate = false) {
  if (noteSave) clearTimeout(noteSave.timer);
  noteSave = { form, timer: setTimeout(flushNoteSave, NOTE_SAVE_DELAY) };
  setSavedNote('Saving…');
  if (immediate) flushNoteSave();
}

/** The note on screen with any typing taken in, saved, so an action works on the latest. */
async function currentNote(id) {
  const form = $('#note-form');
  if (form && form.dataset.id === key(id)) {
    if (noteSave) { clearTimeout(noteSave.timer); noteSave = null; }
    const n = readNoteForm(form);
    if (n && JSON.stringify(n) !== JSON.stringify(get(id))) await saveRecord('note', n);
  }
  return get(id);
}

async function newNote({ kind = 'text', body = '', projectID = null, folder = '' } = {}) {
  const now = toSec(new Date());
  const n = { id: newId(), title: '', body, kind, items: kind === 'checklist' ? [{ id: newId(), text: '', done: false }] : [], folder, projectID, pinned: false, createdAt: now, updatedAt: now };
  await saveRecord('note', n);
  return n;
}

const newItem = () => ({ id: newId(), text: '', done: false });

// ----- Sheets

function sheetNoteMore(n) {
  const nid = esc(key(n.id));
  const row = (act, ic, label, extra = '') => `<button class="row static menu-row" data-act="${act}" data-id="${nid}" ${extra}>${icon(ic, 'ic glyph')}<div class="main"><div class="t">${label}</div></div></button>`;
  openSheet(`${sheetHead(noteTitle(n))}
    <div class="card flush" style="padding:0">
      ${row('note-kind', n.kind === 'checklist' ? 'note' : 'checkCircle', n.kind === 'checklist' ? 'Turn Into Text' : 'Turn Into Checklist')}
      ${row('note-folder', 'folder', 'Move to Folder…')}
      ${row('note-project', 'house', n.projectID ? 'Change Project…' : 'Tie to a Project…')}
      ${row('note-share', 'share', 'Share…')}
      ${row('note-copy', 'copy', 'Copy Text')}
      ${row('note-duplicate', 'plus', 'Duplicate')}
      ${row('note-delete', 'trash', '<span style="color:var(--danger)">Delete Note…</span>')}
    </div>`);
}

function sheetNoteFolder(n) {
  const nid = esc(key(n.id));
  const folders = noteFolders();
  openSheet(`${sheetHead('Folder', 'Folders are just names; make one by typing it.')}
    <div class="form-section"><div class="form-card">
      <label class="field"><span>Folder</span><input id="note-folder-name" list="note-folder-list" value="${esc(n.folder || '')}" placeholder="Ideas, To Buy, 610 E 54th…" autocomplete="off"><datalist id="note-folder-list">${folders.map((f) => `<option value="${esc(f)}">`).join('')}</datalist></label>
      ${folders.length ? `<div class="chips">${folders.map((f) => `<button type="button" data-act="note-folder-chip" data-folder="${esc(f)}" class="${(n.folder || '') === f ? 'on' : ''}">${esc(f)}</button>`).join('')}</div>` : ''}
    </div></div>
    <div class="sheet-actions"><button class="btn" data-act="sheet-close">Cancel</button>${n.folder ? `<button class="btn" data-act="note-folder-set" data-id="${nid}" data-clear="1">No Folder</button>` : ''}<button class="btn primary" data-act="note-folder-set" data-id="${nid}">Move</button></div>`,
  (el) => { setTimeout(() => $('#note-folder-name', el)?.focus(), 50); });
}

function sheetNoteProject(n) {
  const nid = esc(key(n.id));
  const jobs = projects().slice().sort((a, b) => projectName(a).localeCompare(projectName(b)));
  openSheet(`${sheetHead('Project', 'A note on a project is found by searching the project’s name too.')}
    <div class="form-section"><div class="form-card">
      <label class="field"><span>Project</span><select id="note-project-pick"><option value="">None</option>${jobs.map((p) => `<option value="${esc(key(p.id))}" ${sameId(p.id, n.projectID) ? 'selected' : ''}>${esc(projectName(p))}</option>`).join('')}</select></label>
    </div></div>
    <div class="sheet-actions"><button class="btn" data-act="sheet-close">Cancel</button><button class="btn primary" data-act="note-project-set" data-id="${nid}">Save</button></div>`);
}

// ----- Actions

Object.assign(ACTIONS, {
  'note-new': async (el) => {
    const n = await newNote({ kind: el.dataset.kind || 'text', folder: S.ui.notesFolder && !S.ui.notesFolder.startsWith('*') ? S.ui.notesFolder : '' });
    location.hash = `#/note/${key(n.id)}`;
    // Straight into typing.
    setTimeout(() => $(`#note-form ${n.kind === 'checklist' ? '.check-text' : 'textarea[name=body]'}`)?.focus(), 80);
  },
  // Listening starts on the tap (that's what lets the mic open); the words land in the new note.
  'note-voice': async () => {
    if (!Dictation.start(null, { field: 'body' })) return;
    const n = await newNote({ folder: S.ui.notesFolder && !S.ui.notesFolder.startsWith('*') ? S.ui.notesFolder : '' });
    location.hash = `#/note/${key(n.id)}`;
  },
  'note-folder-pick': (el) => { S.ui.notesFolder = el.dataset.folder; render(); },
  'note-pin': async (el) => {
    const n = await currentNote(el.dataset.id);
    if (!n) return;
    const c = clone(n); c.pinned = !c.pinned;
    await saveRecord('note', c);
    toast(c.pinned ? 'Pinned' : 'Unpinned');
    render();
  },
  'note-more': async (el) => { const n = await currentNote(el.dataset.id); if (n) sheetNoteMore(n); },
  'note-kind': async (el) => {
    const n = await currentNote(el.dataset.id);
    if (!n) return;
    const c = clone(n);
    if (c.kind === 'checklist') {
      c.kind = 'text';
      c.body = [c.body, ...(c.items || []).map((i) => `${i.done ? '☑' : '☐'} ${i.text || ''}`)].filter((l) => (l || '').trim()).join('\n');
      c.items = [];
    } else {
      c.kind = 'checklist';
      const lines = (c.body || '').split('\n').map((l) => l.trim()).filter(Boolean);
      c.items = (lines.length ? lines : ['']).map((l) => ({ id: newId(), text: l.replace(/^[☐☑\-*•]\s*/, '').replace(/^\[( |x)\]\s*/i, ''), done: /^(☑|\[x\])/i.test(l) }));
      c.body = '';
    }
    await saveRecord('note', c);
    closeSheet();
  },
  'note-folder': async (el) => { const n = await currentNote(el.dataset.id); if (n) sheetNoteFolder(n); },
  'note-folder-chip': (el) => { const i = $('#note-folder-name'); if (i) i.value = el.dataset.folder; $$('[data-act="note-folder-chip"]').forEach((b) => b.classList.toggle('on', b === el)); },
  'note-folder-set': async (el) => {
    const n = get(el.dataset.id);
    if (!n) return;
    const c = clone(n); c.folder = el.dataset.clear ? '' : ($('#note-folder-name')?.value || '').trim();
    await saveRecord('note', c);
    closeSheet();
  },
  'note-project': async (el) => { const n = await currentNote(el.dataset.id); if (n) sheetNoteProject(n); },
  'note-project-set': async (el) => {
    const n = get(el.dataset.id);
    if (!n) return;
    const c = clone(n); const pid = $('#note-project-pick')?.value || ''; c.projectID = pid ? project(pid)?.id || null : null;
    await saveRecord('note', c);
    closeSheet();
  },
  'note-share': async (el) => {
    const n = await currentNote(el.dataset.id);
    if (!n) return;
    const text = shareText(n);
    closeSheet();
    if (navigator.share) {
      try { await navigator.share({ title: noteTitle(n), text }); return; } catch (e) { if (e?.name === 'AbortError') return; }
    }
    await copyText(text);
  },
  'note-copy': async (el) => { const n = await currentNote(el.dataset.id); if (!n) return; closeSheet(); await copyText(shareText(n)); },
  'note-duplicate': async (el) => {
    const n = await currentNote(el.dataset.id);
    if (!n) return;
    const now = toSec(new Date());
    const c = { ...clone(n), id: newId(), title: `${noteTitle(n)} copy`, pinned: false, createdAt: now, updatedAt: now };
    c.items = (c.items || []).map((i) => ({ ...i, id: newId() }));
    await saveRecord('note', c);
    closeSheet();
    location.hash = `#/note/${key(c.id)}`;
  },
  'note-delete': async (el) => {
    const n = get(el.dataset.id);
    if (!n || !confirm(`Delete “${noteTitle(n)}”?\n\nThis can't be undone.`)) return;
    if (noteSave) { clearTimeout(noteSave.timer); noteSave = null; }
    if (Dictation.target?.closest('#note-form')) Dictation.stop();
    await deleteRecord('note', n.id);
    closeSheet();
    location.hash = '#/notes';
    toast('Note deleted');
  },
  // Checklist items. Each change saves through the form, like typing.
  'note-item-add': async () => {
    const form = $('#note-form');
    const n = await currentNote(form.dataset.id);
    if (!n) return;
    const c = clone(n); c.items = [...(c.items || []), newItem()];
    await saveRecord('note', c);
    render();
    setTimeout(() => { const boxes = $$('#note-form .check-text'); boxes[boxes.length - 1]?.focus(); }, 30);
  },
  'note-item-remove': async (el) => {
    const form = $('#note-form');
    const n = await currentNote(form.dataset.id);
    if (!n) return;
    const c = clone(n); c.items = (c.items || []).filter((_, i) => i !== Number(el.dataset.index));
    await saveRecord('note', c);
    render();
  },
  'note-items-clear-done': async () => {
    const form = $('#note-form');
    const n = await currentNote(form.dataset.id);
    if (!n) return;
    const c = clone(n); c.items = (c.items || []).filter((i) => !i.done);
    await saveRecord('note', c);
    render();
  },
});

function shareText(n) {
  const title = (n.title || '').trim();
  const body = n.kind === 'checklist' ? (n.items || []).map((i) => `${i.done ? '☑' : '☐'} ${i.text || ''}`).join('\n') : n.body || '';
  return [title, body].filter((s) => s.trim()).join('\n\n');
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Couldn’t copy.'); }
}

// Typing in a note saves it; Enter on a checklist item adds the next one; Backspace on an empty
// item removes it.
document.addEventListener('input', (e) => {
  if (e.target.id === 'note-search') {
    S.ui.notesSearch = e.target.value;
    const r = $('#note-results'); if (r) r.innerHTML = noteResults();
    return;
  }
  const form = e.target.closest?.('#note-form');
  if (form) queueNoteSave(form);
});
document.addEventListener('change', (e) => {
  if (!e.target.matches?.('#note-form .check-box')) return;
  e.target.closest('.check-row')?.classList.toggle('done', e.target.checked);
  queueNoteSave(e.target.closest('#note-form'), true);
});
document.addEventListener('keydown', async (e) => {
  const box = e.target;
  if (!box.matches?.('#note-form .check-text')) return;
  const form = box.closest('#note-form');
  const index = Number(box.dataset.index);
  if (e.key === 'Enter') {
    e.preventDefault();
    const n = await currentNote(form.dataset.id);
    if (!n) return;
    const c = clone(n); c.items = [...(c.items || [])]; c.items.splice(index + 1, 0, newItem());
    await saveRecord('note', c);
    render();
    setTimeout(() => $(`#note-form .check-text[data-index="${index + 1}"]`)?.focus(), 30);
  } else if (e.key === 'Backspace' && !box.value && (get(form.dataset.id)?.items || []).length > 1) {
    e.preventDefault();
    const n = await currentNote(form.dataset.id);
    if (!n) return;
    const c = clone(n); c.items = (c.items || []).filter((_, i) => i !== index);
    await saveRecord('note', c);
    render();
    setTimeout(() => { const prev = $(`#note-form .check-text[data-index="${Math.max(0, index - 1)}"]`); if (prev) { prev.focus(); prev.setSelectionRange(prev.value.length, prev.value.length); } }, 30);
  }
});
