// Approving Claude's connection to Eagle Creek (the Claude connector, supabase/functions/eaglecreek-mcp
// in the Mac project). Supabase Auth's OAuth server sends the browser here with ?authorization_id=…
// (Authentication › OAuth Server › Authorization Path = /connect.html). Whoever approves signs in
// with Claude's own team sign-in, never the owner's, so everything Claude does is recorded as
// Claude's and limited to the access set for it in Eagle Creek › Settings › Team.
//
// The sign-in lives only in this page's memory and is signed out once the answer is sent.
'use strict';

(() => {
  const PROJECT = (typeof BUILT_IN_PROJECT === 'object' && BUILT_IN_PROJECT) || {};
  const BASE = String(PROJECT.url || '').trim().replace(/\/+$/, '');
  const KEY = String(PROJECT.key || '').trim();
  const TEAM_DOMAIN = 'team.eaglecreek.invalid';
  const CLAUDE_USERNAME = 'claude';
  const AREAS = [
    ['projects', 'Projects & Schedule'], ['files', 'Files & Photos'], ['contacts', 'Contacts'], ['jobCosts', 'Budgets & Contracts'],
    ['time', 'Timesheets'], ['money', 'Books & Banking'], ['travel', 'Trips & Mileage'],
  ];
  const card = document.getElementById('card');
  const authorizationId = new URLSearchParams(location.search).get('authorization_id') || '';
  let session = null;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const show = (html) => { card.innerHTML = html; };
  const loginName = (email) => { const e = String(email || ''); return e.toLowerCase().endsWith(`@${TEAM_DOMAIN}`) ? e.slice(0, -(TEAM_DOMAIN.length + 1)) : e; };

  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }

  async function api(path, { method = 'GET', token = session?.token, body, headers = {} } = {}) {
    const res = await fetch(BASE + path, {
      method,
      headers: { apikey: KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) throw new ApiError((data && (data.msg || data.message || data.error_description || data.error)) || `Supabase answered ${res.status}`, res.status);
    return data;
  }

  const OAUTH_HEADERS = { 'X-Supabase-Api-Version': '2024-01-01' };

  /** Ends this page's own sign-in (only this one: Claude's connection is a separate session). */
  async function signOut() {
    const token = session?.token;
    session = null;
    if (!token) return;
    try { await api('/auth/v1/logout?scope=local', { method: 'POST', token }); } catch { /* it expires on its own */ }
  }

  /** Back to Claude, but only to a real web address. */
  function goTo(url) {
    let target;
    try { target = new URL(url); } catch { target = null; }
    const local = target && ['localhost', '127.0.0.1'].includes(target.hostname);
    if (!target || !(target.protocol === 'https:' || (local && target.protocol === 'http:'))) {
      show('<h1>Something went wrong</h1><p>Supabase sent back an address this page won\'t open. Go back to Claude and click Connect again.</p>');
      return;
    }
    show('<h1>Returning to Claude…</h1><p class="muted">You can close this page if it doesn\'t move on by itself.</p>');
    location.assign(target.href);
  }

  function showIntro() {
    show(`<h1>Connecting Claude to Eagle Creek</h1>
      <p>Claude sends you to this page when you connect it to Eagle Creek: in Claude, open <b>Settings › Connectors</b>, find <b>Eagle Creek</b> and click <b>Connect</b>.</p>
      <p class="muted">Setting it up the first time? See "The Claude connector" in the Eagle Creek README.</p>`);
  }

  function showSignIn(error = '') {
    show(`<h1>Connect Claude to Eagle Creek</h1>
      <p>Sign in with <b>Claude's own</b> Eagle Creek sign-in (username <b>claude</b>), not your own.</p>
      <p class="muted">Only continue if you just clicked Connect in your own Claude. If someone sent you this link, close it.</p>
      <form id="signin" autocomplete="on" novalidate>
        <label for="login">Username</label>
        <input id="login" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" value="claude" required>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
        <div class="buttons"><button class="primary" type="submit" id="go">Sign In</button></div>
      </form>`);
    const form = document.getElementById('signin');
    const password = document.getElementById('password');
    password.focus();
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      signIn(document.getElementById('login').value, password.value);
    });
  }

  async function signIn(login, password) {
    const name = String(login || '').trim();
    if (!name || !password) return showSignIn('Type the username and password.');
    document.getElementById('go').disabled = true;
    const email = name.includes('@') ? name : `${name.toLowerCase()}@${TEAM_DOMAIN}`;
    let auth;
    try {
      auth = await api('/auth/v1/token?grant_type=password', { method: 'POST', token: null, body: { email, password } });
    } catch (e) {
      return showSignIn(e.status === 400 ? "That username and password don't match." : `Couldn't sign in: ${e.message}`);
    }
    session = { token: auth.access_token, userId: String(auth.user?.id || '').toLowerCase(), email: auth.user?.email || email };

    // Only Claude's own team sign-in, turned on, may connect (the owner's sign-in is refused, and
    // the request isn't even looked at, so it never gets tied to the owner).
    let row = null;
    try {
      const rows = await api(`/rest/v1/team_members?user_id=eq.${encodeURIComponent(session.userId)}&select=role,access,disabled,username,name`);
      row = Array.isArray(rows) ? rows[0] : null;
    } catch {
      row = null;
    }
    if (!row || row.role !== 'member' || String(row.username || '').toLowerCase() !== CLAUDE_USERNAME) {
      await signOut();
      return showSignIn("That isn't Claude's sign-in. Claude connects with its own sign-in (username claude), so everything it does is recorded as Claude's. Add it in Eagle Creek › Settings › Team › Claude Connector, then sign in with it here.");
    }
    if (row.disabled) {
      await signOut();
      return showSignIn('That sign-in is turned off. Turn it back on in Eagle Creek › Settings › Team.');
    }

    let details;
    try {
      details = await api(`/auth/v1/oauth/authorizations/${encodeURIComponent(authorizationId)}`, { headers: OAUTH_HEADERS });
    } catch (e) {
      await signOut();
      return showExpired(e);
    }
    if (details && details.redirect_url && !details.authorization_id) {
      // Approved for this sign-in before: straight back.
      await signOut();
      return goTo(details.redirect_url);
    }
    showConsent(details || {}, row);
  }

  function showExpired(e) {
    const gone = e && (e.status === 404 || e.status === 400);
    show(`<h1>${gone ? 'This request has expired' : 'Something went wrong'}</h1>
      <p>${gone ? 'It was already used, or it took too long.' : esc(e?.message || '')} Go back to Claude and click <b>Connect</b> again.</p>`);
  }

  function showConsent(details, row) {
    const app = String(details.client?.name || '').trim() || 'An app';
    let host = '';
    try { host = new URL(details.redirect_uri).host; } catch { host = String(details.redirect_uri || ''); }
    const isClaude = /^(.+\.)?claude\.(ai|com)$/i.test(host);
    const access = AREAS.map(([area, label]) => {
      const level = row.access?.[area];
      return `<li><span>${esc(label)}</span><span>${level === 'edit' ? 'View and change' : level === 'view' ? 'View only' : 'No access'}</span></li>`;
    }).join('');
    show(`<h1>${esc(app)} wants to work in Eagle Creek</h1>
      ${isClaude ? '' : `<p class="warn">This doesn't return to Claude (claude.ai). Only allow it if you set this app up yourself.</p>`}
      <dl>
        <dt>Signed in as</dt><dd>${esc(row.username || loginName(session?.email))}</dd>
        <dt>Returns to</dt><dd>${esc(host)}</dd>
      </dl>
      <p>It will work as <b>${esc(row.username || 'this team member')}</b>, with this access:</p>
      <ul class="access">${access}</ul>
      <p class="muted">It can't delete records, see bank connections or the personal books, or change the team. Every change it makes is kept in the change history as its own.</p>
      <div class="buttons">
        <button type="button" id="deny">Deny</button>
        <button type="button" class="primary" id="allow">Allow</button>
      </div>`);
    document.getElementById('allow').addEventListener('click', () => decide('approve'));
    document.getElementById('deny').addEventListener('click', () => decide('deny'));
  }

  async function decide(action) {
    for (const id of ['allow', 'deny']) document.getElementById(id).disabled = true;
    let answer;
    try {
      answer = await api(`/auth/v1/oauth/authorizations/${encodeURIComponent(authorizationId)}/consent`, { method: 'POST', body: { action }, headers: OAUTH_HEADERS });
    } catch (e) {
      await signOut();
      return showExpired(e);
    }
    await signOut();
    if (!answer?.redirect_url) return showExpired(null);
    goTo(answer.redirect_url);
  }

  // Not inside someone else's page (so nobody can trick a click on Allow).
  if (window.top !== window.self) {
    show("<h1>Open this page on its own</h1><p>For safety it won't work inside another page.</p>");
    return;
  }
  if (!BASE || !KEY) {
    show('<h1>Not set up</h1><p>This copy of Eagle Creek has no Supabase project built in (config.js).</p>');
    return;
  }
  if (!/^[A-Za-z0-9]{16,128}$/.test(authorizationId)) {
    showIntro();
    return;
  }
  showSignIn();
})();
