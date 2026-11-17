/* Hudson's Planner front end. Talks to the Apps Script back office. */
(() => {
  'use strict';

  const CFG = window.HP_CONFIG || {};
  const CLASSES = {
    Chem: { name: 'Chemistry', color: 'var(--chem)', turnIn: 'In person', late: 'Late work accepted until the end of the unit.' },
    Photo: { name: 'Photography', color: 'var(--photo)', turnIn: 'Sketchbook in person; edited photos to the shared drive', late: '' },
    Alg: { name: 'Algebra 2', color: 'var(--alg)', turnIn: 'IXL online; worksheets in person', late: 'Late work accepted for partial credit.' },
    Hist: { name: 'History', color: 'var(--hist)', turnIn: 'In person', late: '' },
    Span: { name: 'Spanish 3', color: 'var(--span)', turnIn: 'Conjuguemos online; other work in person', late: '' },
    Eng: { name: 'English 10', color: 'var(--eng)', turnIn: 'Paper in person; Membean online; essays on Google Classroom or Turnitin', late: '' },
  };
  const ALIASES = {
    chem: 'Chem', chemistry: 'Chem', photo: 'Photo', photography: 'Photo', alg: 'Alg', algebra: 'Alg', math: 'Alg',
    hist: 'Hist', history: 'Hist', span: 'Span', spanish: 'Span', esp: 'Span', eng: 'Eng', english: 'Eng',
  };
  const STATUS = [['todo', 'Not started'], ['doing', 'In progress'], ['done', 'Done'], ['in', 'Turned in']];
  const OPEN = ['todo', 'doing'];
  const WORK_TYPES = ['assignment', 'study', 'routine', 'sweep'];
  const SLIP_REASONS = ['Ran out of time', 'Forgot', "Didn't understand it", 'Basketball or plans', 'Felt stuck', 'Other'];
  const MINUTES = [['15 min', 15], ['30 min', 30], ['1 hr', 60], ['2+ hr', 120]];
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // Short day labels for calendar grids and headers.
  const WD2 = ['Su', 'M', 'Tu', 'W', 'Th', 'F', 'Sa'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let S = null;            // server state
  let token = null;
  let view = 'today';
  let weekOffset = 0;
  let classTab = 'Chem';
  let todayVisitCls = '';
  let undoFn = null;
  let askedSlip = {};

  /* ---------------- dates ---------------- */
  const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const wd = s => new Date(s + 'T12:00:00Z').getUTCDay();
  const nice = s => s ? `${WD[wd(s)]} ${MONTHS[+s.slice(5, 7) - 1]} ${+s.slice(8, 10)}` : '';
  const short = s => {
    if (!S) return nice(s);
    if (s === S.today) return 'today';
    if (s === addDays(S.today, 1)) return 'tomorrow';
    if (s === addDays(S.today, -1)) return 'yesterday';
    const diff = (new Date(s) - new Date(S.today)) / 864e5;
    return diff > 0 && diff < 7 ? WD[wd(s)] : nice(s);
  };
  // '15:30', '17:30' -> '3:30–5:30 PM'
  const clock = (st, en) => {
    const f = hm => { const h = +hm.slice(0, 2) % 24, m = hm.slice(3, 5); return { t: `${h % 12 || 12}${m === '00' ? '' : ':' + m}`, ap: h < 12 ? 'AM' : 'PM' }; };
    const a = f(st);
    if (!en || en === st) return `${a.t} ${a.ap}`;
    const b = f(en);
    return a.ap === b.ap ? `${a.t}–${b.t} ${b.ap}` : `${a.t} ${a.ap}–${b.t} ${b.ap}`;
  };
  const mondayOf = s => addDays(s, -((wd(s) + 6) % 7));
  // Calendars show weeks Sunday to Saturday.
  const sundayOf = s => addDays(s, -wd(s));

  /* ---------------- auth ---------------- */
  function loadToken() {
    try {
      const t = JSON.parse(localStorage.getItem('hp_token') || 'null');
      if (t && t.exp > Date.now() / 1000 + 60) return t.jwt;
    } catch (e) { /* storage blocked */ }
    return null;
  }
  // First name from the Google sign-in, e.g. "Stephanie".
  function signerName() {
    try { return JSON.parse(decodeURIComponent(escape(atob(String(token || loadToken()).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))))).given_name || ''; } catch (e) { return ''; }
  }
  function saveToken(jwt) {
    try {
      const p = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      localStorage.setItem('hp_token', JSON.stringify({ jwt, exp: p.exp }));
    } catch (e) { /* ignore */ }
  }
  function noAuto() { try { return sessionStorage.getItem('hp_noauto') === '1'; } catch (e) { return false; } }
  function showSignin(msg) {
    $('#app').hidden = true;
    $('#signin').hidden = false;
    $('#signin-msg').textContent = msg || '';
    const tryInit = () => {
      if (!window.google || !google.accounts) return setTimeout(tryInit, 200);
      google.accounts.id.initialize({
        client_id: CFG.CLIENT_ID, auto_select: !noAuto(), itp_support: true,
        callback: r => { try { sessionStorage.removeItem('hp_noauto'); } catch (e) { /* ignore */ } token = r.credential; saveToken(token); start(); },
      });
      google.accounts.id.renderButton($('#gbutton'), { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'signin_with' });
      if (!noAuto()) google.accounts.id.prompt();
    };
    tryInit();
  }

  /* ---------------- api ---------------- */
  // Taps are sent one at a time, in order. The screen keeps the quick local
  // changes and only takes the server's copy once nothing is still on its way,
  // so a slow answer to an earlier tap can't undo a later one.
  let queue = Promise.resolve();
  let pending = 0;
  let gainedSoFar = 0;
  function api(action, body) {
    if (action === 'load' && pending > 0) return queue;
    pending++;
    const run = queue.then(() => send(action, body));
    queue = run.catch(() => {});
    return run.then(data => {
      pending--;
      gainedSoFar += data.gained || 0;
      if (pending === 0) apply(data);
      return data;
    }, err => {
      pending--;
      if (pending === 0 && err.message !== 'auth' && err.message !== 'signin') send('load').then(apply).catch(() => {});
      throw err;
    });
  }
  function apply(data) {
    S = data;
    try { localStorage.setItem('hp_cache', JSON.stringify(data)); } catch (e) { /* ignore */ }
    if (gainedSoFar) bumpPoints(gainedSoFar);
    gainedSoFar = 0;
    render();
  }

  async function send(action, body) {
    if (!token) token = loadToken();
    if (!token) { showSignin(); throw new Error('signin'); }
    const res = await fetch(CFG.API_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ idToken: token, action }, body || {})),
    });
    const data = await res.json();
    if (data.error === 'auth') {
      token = null;
      try { localStorage.removeItem('hp_token'); } catch (e) { /* ignore */ }
      // Stop the automatic re-sign-in so a rejected account doesn't loop.
      try { sessionStorage.setItem('hp_noauto', '1'); } catch (e) { /* ignore */ }
      if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
      showSignin(data.reason ? 'Sign-in was turned away: ' + data.reason
        : "Sign-in was turned away by the planner's Google script. Check CLIENT_ID in Config, then deploy a new version.");
      throw new Error('auth');
    }
    if (data.error) { toast(data.error); throw new Error(data.error); }
    return data;
  }

  async function start() {
    $('#signin').hidden = true;
    $('#app').hidden = false;
    try {
      const cached = JSON.parse(localStorage.getItem('hp_cache') || 'null');
      if (cached && !S) { S = cached; render(); }
    } catch (e) { /* ignore */ }
    try { await api('load'); } catch (e) { return; }
    if (S.role === 'parent' && view === 'today') { view = 'parent'; render(); }
    checkSlips();
  }

  /* ---------------- helpers ---------------- */
  const T = id => S.tasks.find(t => String(t.id) === String(id));
  const isStudent = () => S && S.role === 'student';
  const cls = t => CLASSES[t.cls] || { name: '', color: 'var(--muted)' };
  const isWork = t => WORK_TYPES.indexOf(t.type) >= 0;
  // Finished: turned in, graded, or done on work that has nothing to hand in.
  const finished = t => ['in', 'graded'].indexOf(t.status) >= 0 || (t.status === 'done' && !!t.noTurnIn);
  const needsTurnIn = t => t.type === 'assignment' && !t.noTurnIn;
  const missing = t => t.type === 'assignment' && t.due < S.today && !finished(t) && t.status !== 'suggested';

  function saveTask(t, patch, msg) {
    const before = Object.assign({}, t);
    Object.assign(t, patch);
    render();
    undoFn = () => api('save', { task: Object.assign({ id: t.id }, pick(before, Object.keys(patch))) });
    if (msg) toast(msg, true);
    return api('save', { task: Object.assign({ id: t.id }, patch) }).catch(() => { Object.assign(t, before); render(); });
  }
  const pick = (o, keys) => keys.reduce((a, k) => (a[k] = o[k], a), {});

  function toast(m, withUndo) {
    $('#toastmsg').textContent = m;
    $('#undo').hidden = !withUndo;
    $('#toast').hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { $('#toast').hidden = true; }, 4500);
  }
  $('#undo').onclick = () => { if (undoFn) undoFn(); undoFn = null; $('#toast').hidden = true; };

  function bumpPoints(n) {
    const e = $('#pts');
    e.parentElement.classList.remove('pop'); void e.offsetWidth; e.parentElement.classList.add('pop');
    if (n >= 10 && window.confetti && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      confetti({ particleCount: 70, spread: 70, origin: { y: 0.8 } });
    }
    toast(`+${n} points`);
  }

  function sheet(html, onReady) {
    $('#sheetpanel').innerHTML = html;
    $('#sheet').hidden = false;
    if (onReady) onReady($('#sheetpanel'));
  }
  function closeSheet() { $('#sheet').hidden = true; }
  $('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

  /* ---------------- quick add ---------------- */
  function parseQuick(text) {
    const words = text.trim().split(/\s+/);
    let c = ALIASES[(words[0] || '').toLowerCase()] || '';
    let rest = c ? words.slice(1).join(' ') : text.trim();
    let due = null;
    const m = rest.match(/\b(?:due\s+)?(today|tomorrow|tmrw|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday)?\b/i);
    const md = rest.match(/\b(?:due\s+)?(\d{1,2})\/(\d{1,2})\b/);
    if (md) {
      const y = +S.today.slice(0, 4);
      due = `${y}-${String(md[1]).padStart(2, '0')}-${String(md[2]).padStart(2, '0')}`;
      if (due < addDays(S.today, -60)) due = `${y + 1}${due.slice(4)}`;
      rest = rest.replace(md[0], '');
    } else if (m) {
      const k = m[1].toLowerCase();
      if (k === 'today') due = S.today;
      else if (k === 'tomorrow' || k === 'tmrw') due = addDays(S.today, 1);
      else {
        const idx = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(k.slice(0, 3));
        let d = addDays(S.today, 1);
        while (wd(d) !== idx) d = addDays(d, 1);
        due = d;
      }
      rest = rest.replace(m[0], '');
    }
    rest = rest.replace(/\bdue\b/i, '').replace(/\s{2,}/g, ' ').trim();
    const paper = /\b(worksheet|paper|handout|sketchbook|packet)\b/i.test(rest);
    return { cls: c, title: rest || text, due: due || addDays(S.today, 1), paper, guessed: !due };
  }
  $('#quickadd').addEventListener('input', () => {
    const v = $('#quickadd').value.trim();
    if (!v || !S) { $('#quickpreview').textContent = ''; return; }
    const p = parseQuick(v);
    $('#quickpreview').textContent = `${p.cls ? CLASSES[p.cls].name : 'No class yet'} · "${p.title}" · due ${short(p.due)}${p.guessed ? ' (guess)' : ''}`;
  });
  $('#quickform').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('#quickadd').value.trim();
    if (!v) return;
    const p = parseQuick(v);
    $('#quickadd').value = ''; $('#quickpreview').textContent = '';
    api('add', { task: p }).then(() => toast(S.role === 'parent' ? 'Suggested. It shows up for approval.' : `Added to ${p.cls ? CLASSES[p.cls].name : 'your list'}`));
  });

  /* ---------------- task card ---------------- */
  function taskEl(t, opts) {
    opts = opts || {};
    const d = document.createElement('div');
    const c = cls(t);
    d.className = 'task' + (t.fixit ? ' fix' : '') + (t.status === 'suggested' ? ' suggested' : '') + (isStudent() ? '' : ' ro');
    d.dataset.id = t.id;
    d.style.setProperty('--c', c.color);
    const tags = [];
    if (c.name) tags.push(`<span class="tag">${esc(c.name)}</span>`);
    if (t.type === 'quiz' || t.type === 'test') tags.push(`<span class="tag warn">${t.type === 'test' ? 'Test' : 'Quiz'} ${esc(short(t.due))}</span>`);
    else if (t.type !== 'visit') tags.push(`<span>${missing(t) ? 'Was due' : 'Due'} ${esc(short(t.due))}</span>`);
    if (t.type === 'visit') tags.push(`<span>${t.visitSlot ? esc(t.visitSlot) : 'Pick a slot'}</span>`);
    if (opts.showDo && t.doDay && t.type !== 'visit') tags.push(`<span>Plan: ${esc(short(t.doDay))}</span>`);
    if (isWork(t) && t.type === 'assignment' && OPEN.indexOf(t.status) >= 0 && t.doDay === t.due && t.due >= S.today) tags.push('<span class="tag warn">Planned on due day</span>');
    if (t.paper) tags.push('<span class="tag">Paper</span>');
    if (t.status === 'done' && needsTurnIn(t)) tags.push('<span class="tag warn">Not turned in</span>');
    if (t.status === 'done' && t.noTurnIn) tags.push('<span class="tag good">Done</span>');
    if (t.status === 'in') tags.push('<span class="tag good">Turned in</span>');
    if (t.fixit) tags.push('<span class="tag">Fix-it</span>');
    if (t.source === 'parent') tags.push('<span class="tag">From parent</span>');
    d.innerHTML = `${opts.drag && isStudent() ? '<span class="grip" aria-hidden="true">⋮⋮</span>' : ''}<div class="main"><div class="t">${esc(t.title)}</div><div class="meta">${tags.join('')}</div></div>`;
    if (opts.action && isStudent()) {
      let label = null, fn = null, primary = false;
      if (t.status === 'suggested') { label = 'Accept'; primary = true; fn = () => api('accept', { id: t.id, accept: true }); }
      else if (t.type === 'visit' && t.status !== 'done') { label = 'I went'; fn = () => saveTask(t, { status: 'done' }, 'Visit logged'); }
      else if (t.status === 'done' && needsTurnIn(t)) { label = 'I turned it in'; primary = true; fn = () => saveTask(t, { status: 'in' }); }
      else if (OPEN.indexOf(t.status) >= 0) { label = 'Done'; fn = () => markDone(t); }
      if (label) {
        const b = document.createElement('button');
        b.className = 'act' + (primary ? ' primary' : '');
        b.textContent = label;
        b.onclick = e => { e.stopPropagation(); fn(); };
        d.appendChild(b);
      }
      if (t.status === 'suggested') {
        const no = document.createElement('button');
        no.className = 'act'; no.textContent = 'No thanks';
        no.onclick = e => { e.stopPropagation(); api('accept', { id: t.id, accept: false }); };
        d.appendChild(no);
      }
    }
    d.querySelector('.main').onclick = () => (t.type === 'visit' ? visitSheet(t) : detailSheet(t));
    return d;
  }

  function markDone(t, after) {
    const patch = { status: 'done' };
    if (t.type !== 'assignment') patch.status = 'done';
    saveTask(t, patch, 'Marked done');
    if (t.type === 'visit') return after && after();
    const fin = () => { closeSheet(); if (after) setTimeout(after, 400); };
    sheet(`<h3>Nice. How long did it take?</h3><div class="picks">${MINUTES.map(([l, m]) => `<button data-m="${m}">${l}</button>`).join('')}</div><button class="act" data-skip>Skip</button>`, p => {
      p.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { fin(); saveTask(t, { minutes: +b.dataset.m }); });
      p.querySelector('[data-skip]').onclick = fin;
    });
  }

  // Parents only: delete a task for good. Two taps, so a stray tap can't remove anything.
  function delHtml(t) {
    if (S.role !== 'parent') return '';
    const linked = (t.type === 'quiz' || t.type === 'test') ? ' Its teacher visit and study sessions go too.' : '';
    return `<div class="row"><button class="act danger" id="f-del">Delete for good</button></div><div class="hint">Removes it for everyone. It won't come back from the calendar.${linked}</div>`;
  }
  function wireDelete(p, t) {
    const b = p.querySelector('#f-del');
    if (!b) return;
    b.onclick = () => {
      if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Tap again to delete'; return; }
      closeSheet();
      api('delete', { id: t.id }).then(() => toast('Deleted'), e => toast('Could not delete: ' + e.message));
    };
  }
  function detailSheet(t) {
    const ro = !isStudent() || t.status === 'suggested';
    const c = cls(t);
    sheet(`
      <h3>${esc(t.title)}</h3>
      <div class="hint">${esc(c.name)}${c.turnIn ? ' · Turn in: ' + esc(c.turnIn) : ''}${c.late ? ' · ' + esc(c.late) : ''}</div>
      ${ro ? '' : `<div class="seg" id="segstat">${STATUS.filter(([k]) => k !== 'in' || needsTurnIn(t) || t.status === 'in').map(([k, l]) => `<button data-s="${k}" aria-pressed="${t.status === k}">${l}</button>`).join('')}</div>`}
      <div class="row">
        <label class="field">Due<input type="date" id="f-due" value="${esc(t.due)}" ${ro ? 'disabled' : ''}></label>
        <label class="field">Plan to do it<input type="date" id="f-do" value="${esc(t.doDay)}" ${ro ? 'disabled' : ''}></label>
      </div>
      <label class="field">Class<select id="f-cls" ${ro ? 'disabled' : ''}><option value="">None</option>${Object.keys(CLASSES).map(k => `<option value="${k}" ${t.cls === k ? 'selected' : ''}>${CLASSES[k].name}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" id="f-paper" ${t.paper ? 'checked' : ''} ${ro ? 'disabled' : ''}><span>Check box if assignment is paper to hand in</span></label>
      ${t.type === 'assignment' ? `<label class="check"><input type="checkbox" id="f-noturn" ${t.noTurnIn ? 'checked' : ''} ${ro ? 'disabled' : ''}><span>Nothing to turn in (practice, prep or in-class work). Done means finished.</span></label>` : ''}
      <label class="field">Note<textarea id="f-note" rows="2" ${ro ? 'disabled' : ''}>${esc(t.note)}</textarea></label>
      ${t.minutes ? `<div class="hint">Took ${t.minutes >= 120 ? '2+ hr' : t.minutes + ' min'}</div>` : ''}
      <div class="row">${ro ? '' : '<button class="act primary" id="f-save">Save</button>'}<button class="act" id="f-close">Close</button></div>
      ${delHtml(t)}`, p => {
      p.querySelector('#f-close').onclick = closeSheet;
      wireDelete(p, t);
      if (ro) return;
      p.querySelectorAll('#segstat button').forEach(b => b.onclick = () => {
        closeSheet();
        if (b.dataset.s === 'done' && t.status !== 'done') markDone(t);
        else saveTask(t, { status: b.dataset.s }, 'Status changed');
      });
      p.querySelector('#f-save').onclick = () => {
        closeSheet();
        saveTask(t, {
          due: p.querySelector('#f-due').value, doDay: p.querySelector('#f-do').value, cls: p.querySelector('#f-cls').value,
          paper: p.querySelector('#f-paper').checked, noTurnIn: !!(p.querySelector('#f-noturn') || {}).checked, note: p.querySelector('#f-note').value,
        }, 'Saved');
      };
    });
  }

  /* ---------------- teacher visits ---------------- */
  // Email drafts open in Gmail, never the phone's default mail app. On an iPhone or iPad this
  // opens the Gmail app's compose screen; everywhere else (Chromebook, laptop, Android) it opens
  // Gmail compose in a new browser tab.
  const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const MAIL_TARGET = IOS ? '' : 'target="_blank" rel="noopener"';
  const gmailHref = (subject, body) => IOS
    ? `googlegmail:///co?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    : `https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const SLOT_TUT = 'Tutorial 11:35', SLOT_ACT = 'Activities 12:00', SLOT_SIX = '6th period', SLOT_EMAIL = 'Before or after school (email first)';
  const canVisit = info => !!info && (info.rb || (info.periods || '').indexOf('6') >= 0);
  // The standard visit times on one school day; times the day's schedule doesn't have are left out.
  function slotsForDay(d, t) {
    const info = (S.school || {})[d];
    const out = [];
    if (info && info.rb) { out.push(SLOT_TUT); out.push(SLOT_ACT); }
    if (info && (info.periods || '').indexOf('6') >= 0) out.push(SLOT_SIX);
    if (t.cls === 'Alg') out.push(`Any time (email ${(S.teachers || {}).Alg || 'your teacher'} first)`);
    out.push(SLOT_EMAIL);
    return out;
  }
  function slotOptions(t) {
    const out = [];
    const days = Object.keys(S.school || {}).filter(d => d >= S.today && d <= t.doDay).sort().reverse().slice(0, 3);
    days.forEach(d => {
      const info = S.school[d];
      if (info.rb) { out.push([d, SLOT_TUT]); out.push([d, SLOT_ACT]); }
      if (info.periods && info.periods.indexOf('6') >= 0) out.push([d, SLOT_SIX]);
    });
    if (t.cls === 'Alg') out.push([t.doDay, `Any time (email ${(S.teachers || {}).Alg || 'your teacher'} first)`]);
    out.push([t.doDay, SLOT_EMAIL]);
    return out;
  }
  // Days he can choose in the date picker: school days with tutorial, activities or 6th period,
  // from today up to the day before the quiz or test (or through Friday for the weekly visit).
  function pickableDays(t, target) {
    const last = target ? addDays(target.due, -1) : (t.due || addDays(S.today, 6));
    return Object.keys(S.school || {}).filter(d => d >= S.today && d <= last && canVisit(S.school[d])).sort();
  }
  function scheduleHtml(d) {
    const info = (S.school || {})[d];
    if (!info) return '<div class="hint">No school schedule found for this day.</div>';
    const byPeriod = {};
    Object.keys(S.periods || {}).forEach(k => { byPeriod[S.periods[k]] = k; });
    const extra = String(info.title || '').replace(/^Day\s+\d+\s*\(\s*[A-Za-z]+\s+\d+\s*/i, '').replace(/\)\s*$/, '').trim();
    const codeName = info.code === 'RB' ? 'Regular Bell' : info.code;
    const periods = String(info.periods || '').split('').map(n => {
      const k = byPeriod[n];
      return `<li style="--c:${k && CLASSES[k] ? CLASSES[k].color : 'var(--line)'}"><b>${esc(n)}</b>${k && CLASSES[k] ? esc(CLASSES[k].name) : n === '6' ? 'Free period' : 'Period ' + esc(n)}</li>`;
    }).join('');
    return `<div class="sched"><div class="sched-h"><strong>${esc(nice(d))}</strong> · Day ${esc(info.day)}${codeName ? ' · ' + esc(codeName) : ''}${extra ? ' · ' + esc(extra) : ''}</div>
      <ol class="sched-p">${periods}</ol>
      ${info.rb ? '<div class="hint">Tutorial 11:35–12:00 · Activities 12:00–12:35</div>' : '<div class="hint">No tutorial or activities on this schedule.</div>'}</div>`;
  }
  function pickerHtml(days, sel) {
    const ok = {}; days.forEach(d => { ok[d] = true; });
    let html = '<div class="dpick" role="group" aria-label="Pick a day">' + WD2.map(w => `<div class="dh">${w}</div>`).join('');
    for (let wk = sundayOf(S.today); wk <= days[days.length - 1]; wk = addDays(wk, 7)) {
      for (let i = 0; i < 7; i++) {
        const d = addDays(wk, i);
        const label = `<span>${MONTHS[+d.slice(5, 7) - 1]}</span>${+d.slice(8)}`;
        html += ok[d] ? `<button class="pday" data-d="${d}" aria-pressed="${d === sel}">${label}</button>` : `<div class="pday off" aria-hidden="true">${label}</div>`;
      }
    }
    return html + '</div>';
  }
  function visitSheet(t) {
    const target = t.visitFor ? T(t.visitFor) : null;
    const teacher = (S.teachers || {})[t.cls] || 'your teacher';
    const opts = slotOptions(t);
    const days = isStudent() ? pickableDays(t, target) : [];
    const showPicker = target ? days.length > 1 : days.length > 0;
    const draftFor = (d, slot) => {
      const what = target ? `${target.title} on ${nice(target.due)}` : 'how I am doing in class';
      return `Hi ${teacher},\n\nCould I come see you ${/^(Tutorial|Activities|6th)/.test(slot) ? 'during ' + slot.replace(/ \d.*$/, '').toLowerCase() : 'at a time that works for you'} on ${nice(d)}? I'd like to go over ${what}.\n\nThank you,\n${S.studentName || ''}`;
    };
    let chosen = t.visitSlot || '';
    const pickSel = days.indexOf(t.doDay) >= 0 ? t.doDay : '';
    const slotBtn = (d, s, label) => `<button class="slot" data-d="${d}" data-s="${esc(s)}" aria-pressed="${!!chosen && chosen === s && t.doDay === d}">${esc(label)}</button>`;
    sheet(`
      <h3>${esc(t.title)}</h3>
      ${target ? `<div class="hint">${target.type === 'test' ? 'Test' : 'Quiz'} ${esc(nice(target.due))}. Bring 2–3 questions.</div>` : '<div class="hint">Pick any class. A quick check-in counts.</div>'}
      ${isStudent() ? `${showPicker ? '<h4 class="sub">Suggested</h4>' : ''}<div class="slots">${opts.map(([d, s]) => slotBtn(d, s, `${s} · ${short(d)}`)).join('')}</div>` : ''}
      ${showPicker ? `<h4 class="sub">Or pick a day</h4>${pickerHtml(days, pickSel)}<div id="dayinfo"></div>` : ''}
      <div class="email" id="draft">${esc(draftFor(t.doDay, chosen || (opts[0] || [])[1] || ''))}</div>
      <div class="row">${isStudent() ? `<button class="act" id="copy">Copy email</button><a class="act" id="mail" href="#" ${MAIL_TARGET}>Open in Gmail</a>` : ''}</div>
      <div class="row">${isStudent() && t.status !== 'done' ? '<button class="act primary" id="went">I went</button>' : ''}<button class="act" id="close">Close</button></div>
      ${delHtml(t)}`, p => {
      p.querySelector('#close').onclick = closeSheet;
      wireDelete(p, t);
      if (!isStudent()) return;
      const setMail = () => {
        const txt = p.querySelector('#draft').textContent;
        p.querySelector('#mail').href = gmailHref('Could I come see you?', txt);
      };
      setMail();
      const wireSlots = () => p.querySelectorAll('.slot').forEach(b => b.onclick = () => {
        const d = b.dataset.d, s = b.dataset.s;
        chosen = s;
        p.querySelectorAll('.slot').forEach(o => o.setAttribute('aria-pressed', o.dataset.d === d && o.dataset.s === s));
        p.querySelector('#draft').textContent = draftFor(d, s);
        setMail();
        saveTask(t, { visitSlot: s, doDay: d }, `Visit set for ${short(d)}`);
      });
      const showDay = d => {
        const box = p.querySelector('#dayinfo');
        if (!box) return;
        box.innerHTML = d ? `${scheduleHtml(d)}<div class="slots">${slotsForDay(d, t).map(s => slotBtn(d, s, s)).join('')}</div>` : '';
        wireSlots();
      };
      p.querySelectorAll('.pday[data-d]').forEach(b => b.onclick = () => {
        p.querySelectorAll('.pday[data-d]').forEach(o => o.setAttribute('aria-pressed', o === b));
        showDay(b.dataset.d);
      });
      showDay(pickSel);
      wireSlots();
      p.querySelector('#copy').onclick = () => {
        const txt = p.querySelector('#draft').textContent;
        navigator.clipboard.writeText(txt).then(() => toast('Copied. Paste it into your school email.'), () => toast('Select the text and copy it.'));
      };
      const went = p.querySelector('#went');
      if (went) went.onclick = () => { closeSheet(); saveTask(t, { status: 'done' }, 'Visit logged'); };
    });
  }

  /* ---------------- slips ---------------- */
  function checkSlips() {
    if (!isStudent()) return;
    const slipped = S.tasks.filter(t => isWork(t) && OPEN.indexOf(t.status) >= 0 && t.doDay && t.doDay < S.today && t.slipDate !== S.today && !askedSlip[t.id]);
    if (!slipped.length) return;
    const t = slipped[0];
    askedSlip[t.id] = true;
    const turnIn = needsTurnIn(t);
    sheet(`<h3>Did you get to ${esc(t.title)}? It was planned for ${esc(short(t.doDay))}.</h3>
      <div class="picks">${turnIn ? '<button data-ok="in">Yes, and I turned it in</button>' : ''}<button data-ok="done">${turnIn ? 'Yes, I did it (not turned in yet)' : 'Yes, I did it'}</button></div>
      <div class="hint">Not yet? No big deal. Pick what got in the way and the app finds a new day.</div>
      <div class="picks">${SLIP_REASONS.map(r => `<button data-r="${esc(r)}">${esc(r)}</button>`).join('')}</div>`, p => {
      p.querySelectorAll('[data-ok]').forEach(b => b.onclick = () => {
        closeSheet();
        if (b.dataset.ok === 'in') { saveTask(t, { status: 'in' }, 'Turned in. Nice.'); setTimeout(checkSlips, 600); }
        else { markDone(t, checkSlips); }
      });
      p.querySelectorAll('[data-r]').forEach(b => b.onclick = () => {
        closeSheet();
        api('slip', { id: t.id, reason: b.dataset.r }).then(() => { toast('Rescheduled'); setTimeout(checkSlips, 600); });
      });
    });
  }

  /* ---------------- rendering ---------------- */
  function tabsFor() {
    const t = [['today', 'Today'], ['week', 'Week'], ['status', 'Status'], ['classes', 'Classes'], ['tests', 'Tests & visits'], ['missing', 'Missing'], ['archive', 'Archive']];
    if (S.role === 'parent') t.unshift(['parent', 'Parent view']);
    return t;
  }

  function render() {
    if (!S) return;
    const info = (S.school || {})[S.today];
    $('#hello').textContent = S.role === 'parent' ? `Parent view${signerName() ? ' – ' + signerName() : ''}` : `Hey ${S.studentName || 'there'}`;
    const shortToday = (S.short || {})[S.today];
    $('#dayline').textContent = `${nice(S.today)}${info ? ' · ' + info.title : ''}${shortToday ? ' · ' + shortToday.join(', ') : ''}`;
    $('#streak').textContent = S.streak || 0;
    $('#pts').textContent = S.points || 0;
    $('#quickadd').placeholder = S.role === 'parent' ? 'Suggest a task: "Span study guide due Thu"' : 'Add: "Hist reading p.212 due Thu"';
    $('#tabs').innerHTML = tabsFor().map(([k, l]) => `<button role="tab" data-v="${k}" aria-selected="${view === k}">${l}</button>`).join('');
    $('#tabs').querySelectorAll('button').forEach(b => b.onclick = () => { view = b.dataset.v; render(); });
    $('#foot').innerHTML = `Last calendar check ${esc(S.lastSync || 'not yet')} · <button class="act" id="refresh">Check calendars now</button> · <button class="act" id="signout">Sign out</button>`;
    $('#refresh').onclick = () => { toast('Checking calendars…'); api('sync'); };
    $('#signout').onclick = () => { try { localStorage.removeItem('hp_token'); localStorage.removeItem('hp_cache'); } catch (e) { /* ignore */ } token = null; S = null; if (window.google) google.accounts.id.disableAutoSelect(); showSignin(); };
    const v = $('#view');
    v.innerHTML = '';
    ({ today: renderToday, week: renderWeek, status: renderStatus, classes: renderClasses, tests: renderTests, missing: renderMissing, archive: renderArchive, parent: renderParent }[view] || renderToday)(v);
  }

  function section(parent, title, items, opts, emptyText) {
    const h = document.createElement('h2'); h.textContent = title; parent.appendChild(h);
    const list = document.createElement('div'); list.className = 'list';
    if (!items.length) list.innerHTML = `<div class="empty">${esc(emptyText || 'Nothing here.')}</div>`;
    items.forEach(t => list.appendChild(taskEl(t, opts)));
    parent.appendChild(list);
    return list;
  }

  /* ---------------- gradebook conflicts ---------------- */
  const openConflicts = () => S.tasks.filter(t => t.conflictState === 'open').sort((a, b) => a.due < b.due ? -1 : 1);
  const conflictName = t => `${cls(t).name ? cls(t).name + ': ' : ''}${t.title}`;
  function conflictList(parent, items, heading) {
    if (heading) { const h = document.createElement('h2'); h.textContent = heading; parent.appendChild(h); }
    const list = document.createElement('div'); list.className = 'list';
    items.forEach(t => {
      const el = document.createElement('div');
      const done = t.conflictState === 'resolved';
      el.className = 'conflict' + (done ? ' done' : '');
      const marked = t.turnedInAt ? ` on ${nice(t.turnedInAt.slice(0, 10))}` : '';
      el.innerHTML = `<div class="t">${esc(conflictName(t))}</div>
        <div class="hint">Due ${esc(nice(t.due))} · ${isStudent() ? 'You' : 'Hudson'} marked it turned in${esc(marked)}</div>
        ${done ? `<div><b>Grade:</b> ${esc(t.confirmedGrade || '—')}${t.confirmedNote ? ' · ' + esc(t.confirmedNote) : ''}</div><div class="hint">Gradebook said ${esc(t.conflict)}. Confirmed ${esc(nice(String(t.confirmedAt).slice(0, 10)))}</div>`
          : `<div class="says">Gradebook says: ${esc(t.conflict)}</div>`}
        <button class="act">${isStudent() ? 'Find solution' : done ? 'Edit grade' : 'Confirm grade'}</button>`;
      el.querySelector('button').onclick = () => (isStudent() ? solutionSheet(t) : confirmSheet(t));
      list.appendChild(el);
    });
    parent.appendChild(list);
  }
  function solutionSheet(t) {
    sheet(`<h3>${esc(conflictName(t))}</h3>
      <div class="conflict"><div class="says">The grade book has marked this assignment as ${esc(t.conflict)}.</div><div>You marked it turned in${t.turnedInAt ? ' on ' + esc(nice(t.turnedInAt.slice(0, 10))) : ''}.</div></div>
      <p>To clear this assignment, talk with Mom and Dad to find a solution. Bring what you know: where you turned it in, and whether you still have the work.</p>
      <div class="row"><button class="act" id="close">Got it</button></div>`, p => { p.querySelector('#close').onclick = closeSheet; });
  }
  function confirmSheet(t) {
    sheet(`<h3>${esc(conflictName(t))}</h3>
      <div class="hint">Due ${esc(nice(t.due))}. Gradebook said ${esc(t.conflict)}${t.gradebookItem ? ' (' + esc(t.gradebookItem) + ')' : ''}.</div>
      <label class="field">Grade<input id="cg" maxlength="40" value="${esc(t.confirmedGrade || '')}" placeholder="8/10, 85%, or Excused"></label>
      <label class="field">Note<textarea id="cn" rows="3" maxlength="500" placeholder="What you agreed on">${esc(t.confirmedNote || '')}</textarea></label>
      <div class="row"><button class="act primary" id="csave">${t.conflictState === 'resolved' ? 'Save changes' : 'Confirm grade'}</button><button class="act" id="close">Cancel</button></div>
      <div class="hint">Confirming clears it from Hudson's Needs Attention.</div>`, p => {
      p.querySelector('#close').onclick = closeSheet;
      p.querySelector('#csave').onclick = () => {
        const grade = p.querySelector('#cg').value.trim(), note = p.querySelector('#cn').value.trim();
        if (!grade && !note) { toast('Add a grade or a note'); return; }
        closeSheet();
        api('confirmGrade', { id: t.id, grade, note }).then(() => toast('Grade confirmed'), () => {});
      };
    });
  }

  function renderToday(v) {
    const grid = document.createElement('div'); grid.className = 'grid';
    const left = document.createElement('div'); left.className = 'block';
    const right = document.createElement('div'); right.className = 'block';
    grid.append(left, right); v.appendChild(grid);
    const tasks = S.tasks;
    const conflicts = openConflicts();
    if (conflicts.length) conflictList(left, conflicts, 'Needs attention');
    const sugg = tasks.filter(t => t.status === 'suggested');
    if (sugg.length) section(left, 'Suggested by a parent', sugg, { action: true });
    const fix = tasks.filter(t => t.fixit && !finished(t));
    if (fix.length) section(left, 'Fix-it list', fix, { action: true });
    section(left, 'Pack before school', tasks.filter(t => t.paper && t.due === S.today && !finished(t) && t.status !== 'suggested'), { action: true }, 'No paper to hand in today.');
    section(left, 'Done, not turned in yet', tasks.filter(t => t.status === 'done' && needsTurnIn(t) && !(t.paper && t.due === S.today)), { action: true }, 'All caught up.');
    const plan = tasks.filter(t => isWork(t) && OPEN.indexOf(t.status) >= 0 && t.doDay && t.doDay <= S.today && !t.fixit)
      .sort((a, b) => orderOf(a) - orderOf(b) || (a.due < b.due ? -1 : 1));
    const list = section(left, 'Plan for today', plan, { action: true, drag: true }, 'Nothing planned today. Nice work.');
    if (isStudent() && window.Sortable && plan.length > 1) {
      Sortable.create(list, { animation: 150, delay: 180, delayOnTouchOnly: true, handle: '.grip', onEnd: () => {
        const ids = [...list.querySelectorAll('.task')].map(e => e.dataset.id);
        try { localStorage.setItem('hp_order_' + S.today, JSON.stringify(ids)); } catch (e) { /* ignore */ }
      } });
    }

    const visits = tasks.filter(t => t.type === 'visit' && t.status !== 'done' && t.visitSlot && t.doDay === S.today);
    section(right, "Today's teacher visits", visits, { action: true }, 'No teacher visits booked for today.');
    if (isStudent()) bookVisitCard(right, todayVisitCls, true);
    getAhead(right);
  }
  /* ---------------- get ahead: suggestions with a one-tap fix ---------------- */
  // Looks at the plan and the next two weeks and offers a few small moves that build
  // preparation and an "extra credit" habit. Each one has a button that makes the change.
  function suggestions() {
    const T0 = S.today, out = [];
    const open = t => OPEN.indexOf(t.status) >= 0;
    const work = S.tasks.filter(t => isWork(t) && open(t));
    const load = d => work.filter(t => t.doDay === d).length;
    // Study nights: Sun–Thu, not a striped (busy) afternoon.
    const studyNight = d => wd(d) <= 4 && !(S.short || {})[d];
    const on = d => (d === T0 || d === addDays(T0, 1)) ? short(d) : 'on ' + short(d);
    const cap = x => x.charAt(0).toUpperCase() + x.slice(1);
    const nextDays = n => Array.from({ length: n }, (_, i) => addDays(T0, i));
    const tests = S.tasks.filter(t => (t.type === 'test' || t.type === 'quiz') && t.due > T0 && t.due <= addDays(T0, 10) && open(t)).sort((a, b) => a.due < b.due ? -1 : 1);

    // 1. A test is coming: add one more short review on the lightest night before it.
    tests.filter(t => t.type === 'test' || t.due <= addDays(T0, 5)).forEach(t => {
      if (S.tasks.some(x => x.type === 'study' && x.title.indexOf('Extra review') === 0 && x.title.indexOf(t.title) >= 0)) return;
      const nights = nextDays(10).filter(d => d < t.due && studyNight(d) && d >= T0);
      if (!nights.length) return;
      const day = nights.slice().sort((a, b) => load(a) - load(b) || (a < b ? 1 : -1))[0];
      out.push({ key: 'study|' + t.id, why: `${t.type === 'test' ? 'Test' : 'Quiz'} ${short(t.due)}`,
        text: `Add an extra 15-minute review for ${cls(t).name ? cls(t).name + ' ' : ''}${t.title} ${on(day)}.`,
        run: () => api('add', { task: { type: 'study', cls: t.cls, title: `Extra review for ${t.title}`, due: day } }).then(() => toast(`Extra review added ${on(day)}`), () => {}) });
    });

    // 2. A heavy or busy night coming up, a light night before it: move one assignment earlier.
    const days = nextDays(7);
    for (const d of days.slice(1)) {
      const heavy = load(d) >= 3 || ((S.short || {})[d] && load(d) >= 1);
      if (!heavy) continue;
      const light = days.filter(e => e < d && studyNight(e) && load(e) <= 1)[0];
      const move = work.filter(t => t.doDay === d && t.type === 'assignment').sort((a, b) => a.due < b.due ? -1 : 1)[0];
      if (!light || !move) continue;
      out.push({ key: 'move|' + move.id + '|' + light, why: cap(short(d)) + ((S.short || {})[d] ? ' is busy' : ' is heavy'),
        text: `${cap(short(light))} is light. Do ${move.title} (${cls(move).name}) ${on(light)} instead of ${short(d)}?`,
        run: () => saveTask(move, { doDay: light }, `Moved to ${short(light)}`) });
      break;
    }

    // 3. Extra-credit mindset: a light night today, start something due later.
    if (load(T0) <= 1 && studyNight(T0)) {
      const ahead = work.filter(t => t.type === 'assignment' && t.doDay > T0 && t.due >= addDays(T0, 3)).sort((a, b) => a.due < b.due ? -1 : 1)[0];
      if (ahead) out.push({ key: 'ahead|' + ahead.id, why: 'Light night', text: `Tonight is light. Get ahead and do ${ahead.title} (${cls(ahead).name}, due ${short(ahead.due)}) today?`,
        run: () => saveTask(ahead, { doDay: T0 }, 'Moved to today. Nice!') });
    }

    // 4. Missing work in a class that still takes it late: put it on today's plan.
    const late = S.tasks.filter(t => missing(t) && (t.cls === 'Alg' || t.cls === 'Chem') && !(t.doDay && t.doDay <= T0)).sort((a, b) => a.due < b.due ? 1 : -1)[0];
    if (late) out.push({ key: 'late|' + late.id, why: 'Partial credit', text: `${cls(late).name} still takes late work. Finish ${late.title} today for partial credit?`,
      run: () => saveTask(late, { doDay: T0 }, 'Added to today') });

    let skipped = {};
    try { skipped = JSON.parse(localStorage.getItem('hp_skip_' + T0) || '{}'); } catch (e) { skipped = {}; }
    return out.filter(x => !skipped[x.key]).slice(0, 4);
  }
  function getAhead(parent) {
    const h = document.createElement('h2'); h.textContent = 'Get ahead'; parent.appendChild(h);
    const list = document.createElement('div'); list.className = 'list';
    const items = suggestions();
    if (!items.length) list.innerHTML = '<div class="empty">Nothing to suggest right now. Your plan looks solid.</div>';
    items.forEach(x => {
      const el = document.createElement('div'); el.className = 'tip';
      el.innerHTML = `<div class="hint">${esc(x.why)}</div><div>${esc(x.text)}</div>${isStudent() ? '<div class="row"><button class="act primary yes">Yes, do this!</button><button class="act skip">Not now</button></div>' : ''}`;
      if (isStudent()) {
        el.querySelector('.yes').onclick = () => x.run();
        el.querySelector('.skip').onclick = () => {
          try { const k = 'hp_skip_' + S.today; const o = JSON.parse(localStorage.getItem(k) || '{}'); o[x.key] = 1; localStorage.setItem(k, JSON.stringify(o)); } catch (e) { /* ignore */ }
          render();
        };
      }
      list.appendChild(el);
    });
    parent.appendChild(list);
  }
  function orderOf(t) {
    try { const o = JSON.parse(localStorage.getItem('hp_order_' + S.today) || '[]'); const i = o.indexOf(String(t.id)); return i < 0 ? 999 : i; } catch (e) { return 999; }
  }
  function renderWeek(v) {
    const mon = addDays(sundayOf(S.today), weekOffset * 7);
    const nav = document.createElement('div'); nav.className = 'weeknav';
    nav.innerHTML = `<button class="act" id="wprev" aria-label="Previous week">‹</button><strong>Week of ${esc(nice(mon))}</strong><button class="act" id="wnext" aria-label="Next week">›</button>`;
    v.appendChild(nav);
    nav.querySelector('#wprev').onclick = () => { weekOffset--; render(); };
    nav.querySelector('#wnext').onclick = () => { weekOffset++; render(); };
    if (isStudent()) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'Each assignment starts on a suggested day. Drag it to another day (long-press on the phone). Striped days have practice or family plans in the afternoon, so less time to study.'; v.appendChild(p); }
    const board = document.createElement('div'); board.className = 'board week';
    for (let i = 0; i < 7; i++) {
      const d = addDays(mon, i);
      const shortDay = (S.short || {})[d];
      const info = (S.school || {})[d];
      const col = document.createElement('div');
      col.className = 'col' + (shortDay ? ' short' : '') + (d === S.today ? ' today' : '');
      const pins = S.tasks.filter(t => ((t.type === 'quiz' || t.type === 'test') && t.due === d) || (t.type === 'visit' && t.doDay === d && t.status !== 'done'));
      col.innerHTML = `<header><strong>${WD2[wd(d)]}</strong><span>${MONTHS[+d.slice(5, 7) - 1]} ${+d.slice(8)}${info ? ' · ' + esc(info.code ? info.code + (info.periods ? ' ' + info.periods : '') : 'Day ' + info.day) : ''}</span></header>` +
        pins.map(t => `<div class="pin" style="--c:${cls(t).color}">${t.type === 'visit' ? 'Visit: ' + esc(t.title.replace(/^See /, '')) : (t.type === 'test' ? 'Test: ' : 'Quiz: ') + esc(cls(t).name || t.title)}</div>`).join('');
      col.innerHTML += ((S.busy || {})[d] || []).map(e => `<div class="cev${e.cal ? ' fam' : ''}">${e.all ? '' : `<b>${esc(clock(e.s, e.e))}</b> `}${esc(e.t)}</div>`).join('');
      const drop = document.createElement('div'); drop.className = 'drop'; drop.dataset.day = d;
      S.tasks.filter(t => isWork(t) && t.doDay === d && !finished(t) && t.status !== 'suggested').forEach(t => drop.appendChild(taskEl(t)));
      col.appendChild(drop);
      board.appendChild(col);
      if (isStudent() && window.Sortable) {
        Sortable.create(drop, { group: 'week', animation: 150, delay: 180, delayOnTouchOnly: true, onAdd: e => {
          const t = T(e.item.dataset.id);
          saveTask(t, { doDay: e.to.dataset.day }, `Moved to ${short(e.to.dataset.day)}`);
        } });
      }
    }
    v.appendChild(board);
  }

  function renderStatus(v) {
    if (isStudent()) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'Drag a card across when its status changes.'; v.appendChild(p); }
    const board = document.createElement('div'); board.className = 'board';
    const live = S.tasks.filter(t => isWork(t) && (t.due >= addDays(S.today, -14) || OPEN.indexOf(t.status) >= 0 || t.status === 'done'));
    STATUS.forEach(([k, l]) => {
      const items = live.filter(t => t.status === k).sort((a, b) => a.due < b.due ? -1 : 1);
      const col = document.createElement('div'); col.className = 'col';
      col.innerHTML = `<header><strong>${l}</strong><span>${items.length}</span></header>`;
      const drop = document.createElement('div'); drop.className = 'drop'; drop.dataset.s = k;
      items.forEach(t => drop.appendChild(taskEl(t)));
      col.appendChild(drop); board.appendChild(col);
      if (isStudent() && window.Sortable) {
        Sortable.create(drop, { group: 'status', animation: 150, delay: 180, delayOnTouchOnly: true, onAdd: e => {
          const t = T(e.item.dataset.id);
          const to = e.to.dataset.s;
          if (to === 'done' && t.status !== 'done') markDone(t); else saveTask(t, { status: to }, 'Status changed');
        } });
      }
    });
    v.appendChild(board);
  }

  function renderClasses(v) {
    const sub = document.createElement('div'); sub.className = 'subtabs';
    sub.innerHTML = Object.keys(CLASSES).map(k => `<button data-c="${k}" style="--c:${CLASSES[k].color}" aria-pressed="${classTab === k}">${CLASSES[k].name}</button>`).join('');
    sub.querySelectorAll('button').forEach(b => b.onclick = () => { classTab = b.dataset.c; render(); });
    v.appendChild(sub);
    // Two columns on wide screens (visit card on the right). On a phone the visit card sits
    // between "Coming up" and "Recently turned in".
    const grid = document.createElement('div'); grid.className = 'cgrid';
    const left = document.createElement('div'); left.className = 'c-left';
    const main = document.createElement('div'); main.className = 'block c-main';
    const recent = document.createElement('div'); recent.className = 'block c-recent';
    const side = document.createElement('div'); side.className = 'block c-side';
    left.append(main, recent); grid.append(left, side); v.appendChild(grid);
    const c = CLASSES[classTab];
    const card = document.createElement('div'); card.className = 'card';
    card.innerHTML = `<h3>${esc(c.name)}</h3><div class="hint">Teacher: ${esc((S.teachers || {})[classTab] || '')}${S.periods && S.periods[classTab] ? ' · Period ' + esc(S.periods[classTab]) : ''}</div><div>Turn in: ${esc(c.turnIn)}</div>${c.late ? `<div>${esc(c.late)}</div>` : ''}`;
    main.appendChild(card);
    const mine = S.tasks.filter(t => t.cls === classTab);
    section(main, 'Missing', mine.filter(missing), { action: true }, 'Nothing missing.');
    section(main, 'Coming up', mine.filter(t => t.due >= S.today && !finished(t) && t.type !== 'visit').sort((a, b) => a.due < b.due ? -1 : 1), { action: true, showDo: true }, 'Nothing posted yet.');
    if (isStudent()) bookVisitCard(side, classTab); else side.remove();
    section(recent, 'Recently turned in', mine.filter(t => t.status === 'in').sort((a, b) => a.due > b.due ? -1 : 1).slice(0, 8), {}, 'Nothing yet.');
  }

  // Classes page: book a visit with this class's teacher. Pick a day, see its schedule, pick a time, add it.
  // pickClass: the Today page version, where he chooses the class first. It also lists visits
  // the app planned (before a quiz or test, the weekly one) that still need a time.
  function bookVisitCard(v, k, pickClass) {
    const teacher = (S.teachers || {})[k] || 'your teacher';
    if (pickClass) {
      const due = S.tasks.filter(t => t.type === 'visit' && t.status !== 'done' && !t.visitSlot && t.doDay >= S.today).sort((a, b) => a.doDay < b.doDay ? -1 : 1);
      const box = document.createElement('div'); box.className = 'card bookv';
      box.innerHTML = `<h3>Schedule a teacher visit</h3>
        ${due.length ? `<div class="hint">Needs a time:</div><div class="slots">${due.map(t => `<button class="slot" data-id="${esc(t.id)}">${esc(t.title.replace(/^See /, ''))} · by ${esc(short(t.doDay))}</button>`).join('')}</div>` : ''}
        <label class="field">Class<select id="bv-cls"><option value="">Pick a class</option>${Object.keys(CLASSES).map(c => `<option value="${c}" ${c === k ? 'selected' : ''}>${esc(CLASSES[c].name)} · ${esc((S.teachers || {})[c] || '')}</option>`).join('')}</select></label>`;
      v.appendChild(box);
      box.querySelectorAll('.slot[data-id]').forEach(b => b.onclick = () => visitSheet(T(b.dataset.id)));
      box.querySelector('#bv-cls').onchange = e => { todayVisitCls = e.target.value; render(); };
      if (!k) return;
      v = box;
    }
    const days = Object.keys(S.school || {}).filter(d => d >= S.today && d <= addDays(S.today, 21) && canVisit(S.school[d])).sort();
    const booked = S.tasks.filter(t => t.type === 'visit' && t.cls === k && t.status !== 'done' && t.visitSlot && t.doDay >= S.today).sort((a, b) => a.doDay < b.doDay ? -1 : 1);
    const card = document.createElement('div'); card.className = pickClass ? 'bookv-in' : 'card bookv';
    card.innerHTML = `${pickClass ? '' : `<h3>See ${esc(teacher)}</h3>`}
      <div class="hint">Book a one-on-one visit. Pick a day, then a time.</div>
      ${booked.length ? `<div class="hint">Already booked: ${booked.map(t => esc(t.visitSlot.replace(/ \(.*\)$/, '') + ' · ' + short(t.doDay))).join(', ')}</div>` : ''}
      ${days.length ? pickerHtml(days, '') : '<div class="hint">No school days with tutorial, activities or 6th period in the next three weeks.</div>'}
      <div id="bv-day"></div>
      <div id="bv-rest" hidden>
        <label class="field">What do you want to go over?<input id="bv-what" maxlength="120" placeholder="the Unit 4 quiz, my missing work…"></label>
        <div class="email" id="bv-draft"></div>
        <div class="row"><button class="act" id="bv-copy">Copy email</button><a class="act" id="bv-mail" href="#" ${MAIL_TARGET}>Open in Gmail</a></div>
        <div class="row"><button class="act primary" id="bv-add">Add visit to my plan</button></div>
      </div>`;
    v.appendChild(card);
    let day = '', slot = '';
    const t = { cls: k };
    const draft = () => {
      const what = card.querySelector('#bv-what').value.trim() || 'how I am doing in class';
      const txt = `Hi ${teacher},\n\nCould I come see you ${/^(Tutorial|Activities|6th)/.test(slot) ? 'during ' + slot.replace(/ \d.*$/, '').toLowerCase() : 'at a time that works for you'} on ${nice(day)}? I'd like to go over ${what}.\n\nThank you,\n${S.studentName || ''}`;
      card.querySelector('#bv-draft').textContent = txt;
      card.querySelector('#bv-mail').href = gmailHref('Could I come see you?', txt);
    };
    const showDay = d => {
      day = d; slot = '';
      card.querySelector('#bv-rest').hidden = true;
      card.querySelector('#bv-day').innerHTML = `${scheduleHtml(d)}<div class="slots">${slotsForDay(d, t).map(x => `<button class="slot" data-s="${esc(x)}" aria-pressed="false">${esc(x)}</button>`).join('')}</div>`;
      card.querySelectorAll('#bv-day .slot').forEach(b => b.onclick = () => {
        slot = b.dataset.s;
        card.querySelectorAll('#bv-day .slot').forEach(o => o.setAttribute('aria-pressed', o === b));
        card.querySelector('#bv-rest').hidden = false;
        draft();
      });
    };
    card.querySelectorAll('.pday[data-d]').forEach(b => b.onclick = () => {
      card.querySelectorAll('.pday[data-d]').forEach(o => o.setAttribute('aria-pressed', o === b));
      showDay(b.dataset.d);
    });
    card.querySelector('#bv-what').oninput = draft;
    card.querySelector('#bv-copy').onclick = () => {
      navigator.clipboard.writeText(card.querySelector('#bv-draft').textContent).then(() => toast('Copied. Paste it into your school email.'), () => toast('Select the text and copy it.'));
    };
    card.querySelector('#bv-add').onclick = () => {
      if (!day || !slot) return;
      const what = card.querySelector('#bv-what').value.trim();
      api('add', { task: { type: 'visit', cls: k, due: day, visitSlot: slot, title: `See ${teacher}${what ? ': ' + what : ''}` } })
        .then(() => toast(`Visit added for ${short(day)}`), () => {});
    };
  }

  // What a calendar item is: Test, Quiz, Exam, Essay, Project or Paper.
  function kindOf(t) {
    if (t.type === 'test') return /exam/i.test(t.title) ? 'Exam' : 'Test';
    if (t.type === 'quiz') return 'Quiz';
    const m = String(t.title).match(/exam|essay|project|paper/i);
    return m ? m[0].charAt(0).toUpperCase() + m[0].slice(1).toLowerCase() : 'Due';
  }
  function renderTests(v) {
    const tests = S.tasks.filter(t => (t.type === 'quiz' || t.type === 'test') && t.due >= S.today).sort((a, b) => a.due < b.due ? -1 : 1);
    const h = document.createElement('h2'); h.textContent = 'Quizzes and tests'; v.appendChild(h);
    const list = document.createElement('div'); list.className = 'list';
    if (!tests.length) list.innerHTML = '<div class="empty">None posted yet.</div>';
    tests.forEach(t => {
      const visit = S.tasks.find(x => x.type === 'visit' && x.visitFor === t.id);
      const el = taskEl(t);
      const st = document.createElement('span');
      st.className = 'tag ' + (visit && visit.status === 'done' ? 'good' : visit && visit.visitSlot ? '' : 'warn');
      st.textContent = !visit ? 'No visit' : visit.status === 'done' ? 'Visited' : visit.visitSlot ? 'Visit booked ' + short(visit.doDay) : 'Book visit by ' + short(visit.doDay);
      el.querySelector('.meta').appendChild(st);
      if (visit) el.querySelector('.main').onclick = () => visitSheet(visit);
      list.appendChild(el);
    });
    v.appendChild(list);
    section(v, 'Teacher visits', S.tasks.filter(t => t.type === 'visit' && t.status !== 'done').sort((a, b) => a.doDay < b.doDay ? -1 : 1), { action: true }, 'No visits planned.');
    // Month grid
    const h2 = document.createElement('h2'); h2.textContent = 'This month and next'; v.appendChild(h2);
    [0, 1].forEach(offset => {
      const first = new Date(S.today.slice(0, 7) + '-01T12:00:00Z');
      first.setUTCMonth(first.getUTCMonth() + offset);
      const f = first.toISOString().slice(0, 10);
      const cap = document.createElement('div'); cap.className = 'hint'; cap.textContent = MONTHS[first.getUTCMonth()] + ' ' + first.getUTCFullYear(); v.appendChild(cap);
      const grid = document.createElement('div'); grid.className = 'month';
      grid.innerHTML = WD2.map(w => `<div class="dh">${w}</div>`).join('');
      let d = sundayOf(f);
      for (let i = 0; i < 42; i++, d = addDays(d, 1)) {
        if (i === 35 && d.slice(0, 7) !== f.slice(0, 7)) break;
        const evs = S.tasks.filter(t => t.due === d && (t.type === 'quiz' || t.type === 'test' || /project|essay|paper|exam/i.test(t.title)));
        grid.insertAdjacentHTML('beforeend', `<div class="cell${d.slice(0, 7) !== f.slice(0, 7) ? ' out' : ''}${d === S.today ? ' today' : ''}"><span>${+d.slice(8)}</span>${evs.map(t => `<button class="ev" data-id="${esc(t.id)}" style="--c:${cls(t).color}" title="${esc(kindOf(t) + ': ' + t.title)}">${esc(kindOf(t))}${cls(t).name ? ' · ' + esc(cls(t).name) : ''}</button>`).join('')}</div>`);
      }
      grid.querySelectorAll('.ev[data-id]').forEach(b => b.onclick = () => detailSheet(T(b.dataset.id)));
      v.appendChild(grid);
    });
  }

  function renderMissing(v) {
    if (isStudent()) {
      const row = document.createElement('div'); row.className = 'row';
      row.innerHTML = '<button class="act" id="reset">Reset: fold overdue into one fix-it list</button><button class="act" id="absent">I was out today</button>';
      v.appendChild(row);
      row.querySelector('#reset').onclick = () => api('reset').then(() => { view = 'today'; render(); toast('Your fix-it list is on Today.'); });
      row.querySelector('#absent').onclick = () => api('absent', { date: S.today }).then(() => toast('Added a catch-up item for each class.'));
    }
    const conflicts = openConflicts();
    if (conflicts.length) conflictList(v, conflicts, 'Needs attention');
    section(v, 'Missing (past due, not turned in)', S.tasks.filter(missing).sort((a, b) => a.due < b.due ? -1 : 1), { action: true }, 'Nothing missing. Great job.');
    section(v, 'Done, not turned in', S.tasks.filter(t => t.status === 'done' && needsTurnIn(t)), { action: true }, 'All caught up.');
    const note = document.createElement('p'); note.className = 'hint';
    note.textContent = 'Algebra takes late work for partial credit. Chemistry takes it until the end of the unit. Check Veracross for anything showing 0 or "Not Turned In".';
    v.appendChild(note);
  }

  /* ---------------- archive ---------------- */
  // Every assignment ever kept, searchable. Data loads on first use and is kept for a minute.
  const ARC = { data: null, at: 0, loading: null, q: '', cls: '', status: '', type: '', from: '', to: '' };
  const ARC_STATUS = [['', 'Any status'], ['todo', 'Not started'], ['doing', 'In progress'], ['done', 'Done'], ['in', 'Turned in'], ['missing', 'Missing'], ['slipped', 'Missed a plan'], ['gradebook', 'Gradebook flag']];
  const ARC_TYPES = [['', 'Any kind'], ['assignment', 'Assignments'], ['test', 'Tests'], ['quiz', 'Quizzes'], ['study', 'Study sessions'], ['visit', 'Teacher visits'], ['other', 'Other']];
  const STATUS_LABEL = { todo: 'Not started', doing: 'In progress', done: 'Done', in: 'Turned in', graded: 'Graded', suggested: 'Suggested' };
  const SOURCE_LABEL = { feed: 'Class calendar', manual: 'Added by hand', parent: 'Suggested by a parent', auto: 'Added by the planner' };
  function loadArchive() {
    if (ARC.data && Date.now() - ARC.at < 60000) return Promise.resolve(ARC.data);
    if (!ARC.loading) {
      ARC.loading = send('archive').then(d => { ARC.data = d; ARC.at = Date.now(); ARC.loading = null; return d; }, e => { ARC.loading = null; throw e; });
    }
    return ARC.loading;
  }
  const arcActive = () => !!(ARC.q.trim() || ARC.cls || ARC.status || ARC.type || ARC.from || ARC.to);
  function arcText(t) {
    const h = ((ARC.data.history || {})[t.id] || []).map(x => x.event).join(' ');
    return [t.title, cls(t).name, t.note, t.slipReason, t.conflict, t.confirmedGrade, t.confirmedNote, STATUS_LABEL[t.status], kindOf(t), h].join(' ').toLowerCase();
  }
  function arcMatch(t) {
    if (ARC.cls && t.cls !== ARC.cls) return false;
    if (ARC.type === 'other' ? ['assignment', 'test', 'quiz', 'study', 'visit'].indexOf(t.type) >= 0 : ARC.type && t.type !== ARC.type) return false;
    if (ARC.from && t.due < ARC.from) return false;
    if (ARC.to && t.due > ARC.to) return false;
    const st = ARC.status;
    if (st === 'missing' && !missing(t)) return false;
    if (st === 'slipped' && !t.slipReason && !((ARC.data.history || {})[t.id] || []).some(x => /^Missed the plan/.test(x.event))) return false;
    if (st === 'gradebook' && !t.conflictState) return false;
    if (st === 'done' && t.status !== 'done') return false;
    if (st === 'in' && ['in', 'graded'].indexOf(t.status) < 0) return false;
    if ((st === 'todo' || st === 'doing') && t.status !== st) return false;
    const words = ARC.q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    // Each typed word has to start a word in the assignment (so "ch" finds "Chem", not "History").
    if (words.length) { const ws = arcText(t).split(/[^a-z0-9]+/); if (!words.every(w => ws.some(x => x.indexOf(w) === 0))) return false; }
    return true;
  }
  function renderArchive(v) {
    const box = document.createElement('div'); box.className = 'arch';
    box.innerHTML = `
      <input type="search" id="arc-q" placeholder="Search assignments: title, class, note…" value="${esc(ARC.q)}" aria-label="Search the archive">
      <div class="arch-f">
        <label class="field">Class<select id="arc-cls"><option value="">Any class</option>${Object.keys(CLASSES).map(k => `<option value="${k}" ${ARC.cls === k ? 'selected' : ''}>${esc(CLASSES[k].name)}</option>`).join('')}</select></label>
        <label class="field">Status<select id="arc-status">${ARC_STATUS.map(([k, l]) => `<option value="${k}" ${ARC.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field">Kind<select id="arc-type">${ARC_TYPES.map(([k, l]) => `<option value="${k}" ${ARC.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field">Due from<input type="date" id="arc-from" value="${esc(ARC.from)}"></label>
        <label class="field">Due to<input type="date" id="arc-to" value="${esc(ARC.to)}"></label>
      </div>
      <p class="hint" id="arc-help">Type a word from the assignment's title or note, or pick a class, status, kind or due date range. Matching assignments, past and current, show up below. Tap one to see its whole story.</p>
      <div class="list" id="arc-res"></div>`;
    v.appendChild(box);
    const res = box.querySelector('#arc-res');
    const draw = () => {
      if (!arcActive()) { res.innerHTML = ''; return; }
      if (!ARC.data) {
        res.innerHTML = '<div class="empty">Loading the archive…</div>';
        loadArchive().then(() => { if (view === 'archive') draw(); }, () => { res.innerHTML = '<div class="empty">Could not load the archive. Try again in a moment.</div>'; });
        return;
      }
      const hits = (ARC.data.archive || []).filter(t => t.status !== 'suggested' || !isStudent()).filter(arcMatch).sort((a, b) => a.due > b.due ? -1 : a.due < b.due ? 1 : 0);
      res.innerHTML = `<div class="hint">${hits.length} found${hits.length > 200 ? ', showing the first 200' : ''}</div>`;
      hits.slice(0, 200).forEach(t => {
        const b = document.createElement('button'); b.className = 'arow'; b.style.setProperty('--c', cls(t).color);
        const stTag = missing(t) ? '<span class="tag bad">Missing</span>' : `<span class="tag${finished(t) ? ' good' : ''}">${esc(STATUS_LABEL[t.status] || t.status)}</span>`;
        b.innerHTML = `<span class="t">${esc(t.title)}</span><span class="meta">${cls(t).name ? `<span class="tag">${esc(cls(t).name)}</span>` : ''}<span>${esc(kindOf(t) === 'Due' ? 'Due' : kindOf(t))} ${esc(nice(t.due))}</span>${stTag}${t.slipReason ? '<span class="tag warn">Missed plan</span>' : ''}${t.conflictState ? '<span class="tag bad">Gradebook</span>' : ''}</span>`;
        b.onclick = () => storySheet(t);
        res.appendChild(b);
      });
      if (!hits.length) res.innerHTML = '<div class="empty">Nothing matches. Try fewer words or clear a filter.</div>';
    };
    const bind = (id, key, ev) => box.querySelector(id).addEventListener(ev || 'change', e => { ARC[key] = e.target.value; draw(); });
    bind('#arc-q', 'q', 'input'); bind('#arc-cls', 'cls'); bind('#arc-status', 'status'); bind('#arc-type', 'type'); bind('#arc-from', 'from'); bind('#arc-to', 'to');
    loadArchive().catch(() => {});
    draw();
  }
  const stamp = s => {
    s = String(s || '');
    if (!s) return '';
    const d = s.slice(0, 10), tm = s.slice(11, 16);
    return `${nice(d)}${tm ? ', ' + clock(tm) : ''}`;
  };
  // The story of one task: read-only details, then everything that happened to it in time order.
  function storySheet(t) {
    const hist = ((ARC.data && ARC.data.history) || {})[t.id] || [];
    const pts = ((ARC.data && ARC.data.points) || {})[t.id] || [];
    const has = re => hist.some(h => re.test(h.event));
    const ev = hist.map(h => ({ at: String(h.at), who: h.who, text: h.event }));
    // Older tasks were kept before the history log existed, so fill in from their saved dates.
    if (t.createdAt && !has(/^(Posted|Added|Suggested)/)) ev.push({ at: t.createdAt, who: '', text: SOURCE_LABEL[t.source] ? `${SOURCE_LABEL[t.source]}: added to the planner` : 'Added to the planner' });
    if (t.doneAt && !has(/^Marked (Done|Turned in)/)) ev.push({ at: t.doneAt, who: '', text: 'Marked Done' });
    if (t.turnedInAt && !has(/^Marked Turned in/)) ev.push({ at: t.turnedInAt, who: '', text: 'Marked Turned in' });
    if (t.slipDate && t.slipReason && !has(/^Missed the plan/)) ev.push({ at: t.slipDate, who: '', text: `Missed the plan. Reason: ${t.slipReason}` });
    if (t.conflictAt && !has(/^Gradebook says/)) ev.push({ at: t.conflictAt, who: 'Gradebook check', text: `Gradebook says ${t.conflict}` });
    if (t.confirmedAt && !has(/^Parent confirmed/)) ev.push({ at: t.confirmedAt, who: 'Parent', text: `Parent confirmed the grade: ${t.confirmedGrade || '(none)'}${t.confirmedNote ? '. Note: ' + t.confirmedNote : ''}` });
    pts.forEach(p => ev.push({ at: String(p.date), who: '', text: `${+p.points > 0 ? '+' : ''}${p.points} points: ${p.reason}`, pts: true }));
    const key = e => e.at.length > 10 ? e.at : e.at + 'T99'; // date-only entries go at the end of their day
    ev.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
    const all = (ARC.data && ARC.data.archive) || S.tasks;
    const related = all.filter(x => x.id !== t.id && (x.visitFor === t.id || x.id === t.visitFor || String(x.sourceId).indexOf('study|' + t.id + '|') === 0
      || (t.sourceId && String(t.sourceId).indexOf('study|') === 0 && String(t.sourceId).split('|')[1] === x.id)));
    const row = (k, v) => v ? `<dt>${k}</dt><dd>${v}</dd>` : '';
    sheet(`
      <h3>${esc(t.title)}</h3>
      <dl class="facts">
        ${row('Class', esc(cls(t).name || 'None'))}
        ${row('Kind', esc(kindOf(t) === 'Due' ? (t.type === 'study' ? 'Study session' : t.type === 'visit' ? 'Teacher visit' : 'Assignment') : kindOf(t)))}
        ${row('Due', esc(nice(t.due)))}
        ${row('Planned for', esc(nice(t.doDay)))}
        ${row('Status', esc(missing(t) ? 'Missing' : (STATUS_LABEL[t.status] || t.status)))}
        ${row('Done', esc(stamp(t.doneAt)))}
        ${row('Turned in', esc(stamp(t.turnedInAt)))}
        ${row('Time it took', t.minutes ? (t.minutes >= 120 ? '2+ hours' : t.minutes + ' min') : '')}
        ${row('Paper', t.paper ? 'Paper to hand in' : '')}
        ${row('Turn in', t.noTurnIn ? 'Nothing to turn in' : '')}
        ${row('Visit time', esc(t.visitSlot))}
        ${row('Came from', esc(SOURCE_LABEL[t.source] || ''))}
        ${row('Gradebook', t.conflict ? esc(`Said ${t.conflict}`) + (t.confirmedGrade || t.confirmedNote ? esc(` · Confirmed grade ${t.confirmedGrade || '—'}${t.confirmedNote ? ': ' + t.confirmedNote : ''}`) : '') : '')}
        ${row('Note', esc(t.note))}
      </dl>
      <h4>What happened</h4>
      <ol class="story">${ev.length ? ev.map(e => `<li class="${e.pts ? 'pts' : ''}"><span class="when">${esc(stamp(e.at))}${e.who ? ' · ' + esc(e.who) : ''}</span>${esc(e.text)}</li>`).join('') : '<li>No history recorded yet.</li>'}</ol>
      ${related.length ? `<h4>Linked</h4><div class="list">${related.map(x => `<button class="arow" data-rel="${esc(x.id)}" style="--c:${cls(x).color}"><span class="t">${esc(x.title)}</span><span class="meta"><span>${esc(nice(x.doDay || x.due))}</span><span class="tag${finished(x) || (x.type !== 'assignment' && x.status === 'done') ? ' good' : ''}">${esc(STATUS_LABEL[x.status] || x.status)}</span></span></button>`).join('')}</div>` : ''}
      <div class="row"><button class="act" id="s-close">Close</button></div>`, p => {
      p.querySelector('#s-close').onclick = closeSheet;
      p.querySelectorAll('[data-rel]').forEach(b => b.onclick = () => { const x = all.find(y => y.id === b.dataset.rel); if (x) storySheet(x); });
    });
  }

  // Dismissing only hides the alert; the assignment itself is not changed. It is logged in the Archive.
  function dismissSheet(f) {
    sheet(`<h3>Dismiss this alert?</h3>
      <div class="flag"><b>${esc(f.kind)}</b><span>${esc(f.text)}</span></div>
      <div class="hint">It comes off Needs attention. Nothing else about the assignment changes, and the dismissal shows in its Archive story.</div>
      <label class="field">Points to remove<input type="number" id="dpts" min="1" max="1000" step="1" inputmode="numeric" placeholder="e.g. 5"></label>
      <div class="row"><button class="act primary" id="dpen">Remove points</button><button class="act" id="dfree">Dismiss without penalty</button></div>
      <div class="row"><button class="act" id="dcancel">Cancel</button></div>`, p => {
      p.querySelector('#dcancel').onclick = closeSheet;
      const go = pts => { closeSheet(); api('dismiss', { key: f.key, points: pts }).then(() => toast(pts ? `Dismissed and removed ${pts} point${pts === 1 ? '' : 's'}` : 'Dismissed'), () => {}); };
      p.querySelector('#dfree').onclick = () => go(0);
      p.querySelector('#dpen').onclick = () => {
        const n = Math.round(Number(p.querySelector('#dpts').value));
        if (!(n >= 1 && n <= 1000)) { toast('Enter how many points to remove'); return; }
        go(n);
      };
    });
  }

  function renderParent(v) {
    const h = document.createElement('h2'); h.textContent = 'Needs attention'; v.appendChild(h);
    const flags = (S.flags || []).filter(f => f.kind !== 'Gradebook disagrees');
    const conflicts = openConflicts();
    if (conflicts.length) conflictList(v, conflicts);
    const fl = document.createElement('div'); fl.className = 'list';
    fl.innerHTML = flags.length ? flags.map((f, i) => `<div class="flag"><b>${esc(f.kind)}</b><span>${esc(f.text)}</span>${f.key ? `<button class="act" data-dis="${i}">Dismiss</button>` : ''}</div>`).join('') : (conflicts.length ? '' : '<div class="flag ok"><b>All clear</b><span>Nothing missing or overdue.</span></div>');
    v.appendChild(fl);
    fl.querySelectorAll('[data-dis]').forEach(b => b.onclick = () => dismissSheet(flags[+b.dataset.dis]));
    const wk = mondayOf(S.today);
    const thisWeek = S.tasks.filter(t => t.type === 'assignment' && t.due >= wk && t.due < addDays(wk, 7));
    const ahead = thisWeek.filter(t => t.doDay && t.doDay < t.due).length;
    const tests = S.tasks.filter(t => (t.type === 'quiz' || t.type === 'test') && t.due >= wk && t.due < addDays(wk, 7));
    const visited = tests.filter(t => S.tasks.some(x => x.type === 'visit' && x.visitFor === t.id && (x.visitSlot || x.status === 'done'))).length;
    const h2 = document.createElement('h2'); h2.textContent = 'This week'; v.appendChild(h2);
    const stat = document.createElement('div'); stat.className = 'stat';
    stat.innerHTML = `<div><strong>${ahead} of ${thisWeek.length}</strong>planned ahead</div><div><strong>${S.tasks.filter(missing).length}</strong>missing</div><div><strong>${visited} of ${tests.length}</strong>tests with a visit booked</div><div><strong>${S.points || 0}</strong>points · ${S.streak || 0}-day streak</div>`;
    v.appendChild(stat);
    const h3 = document.createElement('h2'); h3.textContent = 'Paste grades'; v.appendChild(h3);
    const box = document.createElement('div'); box.className = 'block';
    box.innerHTML = `<textarea id="grades" rows="4" class="field" style="font:14px var(--body);padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--surface);color:var(--fg)" placeholder="Paste the whole Veracross Grade Detail page, any day. One class or all of them."></textarea><div class="row"><button class="act primary" id="savegrades">Save grades</button></div><div class="hint">${S.lastGrades ? 'Last pasted ' + esc(S.lastGrades.pastedAt) : 'Nothing pasted yet.'}</div>`;
    v.appendChild(box);
    box.querySelector('#savegrades').onclick = () => {
      const t = box.querySelector('#grades').value.trim();
      if (!t) return;
      toast('Checking grades…');
      api('grades', { text: t }).then(d => {
        const r = d.gradeResult || {};
        toast(!r.read ? 'No assignments found. Paste the whole Grade Detail page.' : `Read ${r.read} assignments in ${(r.classes || []).length} classes. ${r.newConflicts ? r.newConflicts + ' new to check.' : 'No new conflicts.'}`);
      }, () => {});
    };
    const gc = S.gradeCheck;
    if (gc) {
      const info = document.createElement('div'); info.className = 'block';
      const probs = gc.problems || [];
      info.innerHTML = `<div class="hint">Last check ${esc(nice(String(gc.checkedAt).slice(0, 10)))}: read ${esc(gc.read)} assignments in ${esc((gc.classes || []).length)} classes.</div>` +
        (probs.length ? `<details><summary class="hint">Other gradebook problems he hasn't marked turned in (${probs.length})</summary>${probs.map(x => `<div class="gprob"><b>${esc((CLASSES[x.cls] || {}).name || '')}</b> ${esc(x.name)} · ${esc(nice(x.date))} · <span class="tag warn">${esc(x.says)}</span>${x.inPlanner ? '' : ' <span class="hint">not in planner</span>'}</div>`).join('')}</details>` : '');
      v.appendChild(info);
    }
    const resolved = S.tasks.filter(t => t.conflictState === 'resolved').sort((a, b) => a.confirmedAt < b.confirmedAt ? 1 : -1);
    if (resolved.length) conflictList(v, resolved, 'Confirmed grades');
    const hin = document.createElement('h2'); hin.textContent = 'Recently turned in'; v.appendChild(hin);
    const since = addDays(S.today, -14);
    const turned = S.tasks.filter(t => t.turnedInAt && t.turnedInAt.slice(0, 10) >= since && isWork(t))
      .sort((a, b) => a.turnedInAt < b.turnedInAt ? 1 : -1).slice(0, 20);
    const tl = document.createElement('div'); tl.className = 'list';
    tl.innerHTML = turned.map(t => {
      const doneDay = (t.doneAt || t.turnedInAt).slice(0, 10), inDay = t.turnedInAt.slice(0, 10);
      const tags = [];
      if (t.due && doneDay > t.due) tags.push('<span class="tag warn">Done late</span>');
      if (t.due && inDay > t.due) tags.push('<span class="tag warn">Turned in late</span>');
      if (t.conflictState === 'open') tags.push('<span class="tag bad">Gradebook disagrees</span>');
      if (!tags.length) tags.push('<span class="tag good">On time</span>');
      return `<div class="task" style="--c:${cls(t).color}"><div class="main"><div class="t">${esc(cls(t).name ? cls(t).name + ': ' : '')}${esc(t.title)}</div><div class="meta"><span>Due ${esc(nice(t.due))}</span><span>Done ${esc(nice(doneDay))}</span><span>Turned in ${esc(nice(inDay))}</span>${tags.join('')}</div></div></div>`;
    }).join('') || '<div class="empty">Nothing turned in over the last two weeks.</div>';
    v.appendChild(tl);
    const hr = document.createElement('h2'); hr.textContent = 'Reward points'; v.appendChild(hr);
    const rw = document.createElement('div'); rw.className = 'block';
    rw.innerHTML = `<div class="row adj"><label class="field">Points<input type="number" id="bpts" inputmode="numeric" step="1" value="10"></label><label class="field grow">Reason (optional)<input id="bwhy" maxlength="100" placeholder="Great week of turning things in"></label></div>
      <div class="row"><button class="act primary" id="bgive">Give points</button></div><div class="hint">Use a minus number to take points back.</div>`;
    v.appendChild(rw);
    rw.querySelector('#bgive').onclick = () => {
      const n = Math.round(Number(rw.querySelector('#bpts').value));
      if (!n) { toast('Enter a number of points'); return; }
      api('bonus', { points: n, reason: rw.querySelector('#bwhy').value }).then(() => { toast(`${n > 0 ? '+' : ''}${n} points given`); }, e => toast(e.message));
    };
    const hs = document.createElement('h2'); hs.textContent = 'Streak'; v.appendChild(hs);
    const sk = document.createElement('div'); sk.className = 'block';
    sk.innerHTML = `<div class="row adj"><label class="field">Set streak to<input type="number" id="snum" inputmode="numeric" min="0" step="1" value="${esc(S.streak || 0)}"></label></div>
      <div class="row"><button class="act" id="sset">Set streak</button></div><div class="hint">It keeps counting from this number. A day with planned work left undone still resets it.</div>`;
    v.appendChild(sk);
    sk.querySelector('#sset').onclick = () => {
      const n = Math.round(Number(sk.querySelector('#snum').value));
      if (!(n >= 0)) { toast('Enter 0 or more'); return; }
      api('setStreak', { streak: n }).then(() => toast(`Streak set to ${n}`), e => toast(e.message));
    };
    const h4 = document.createElement('h2'); h4.textContent = 'Recent points'; v.appendChild(h4);
    const pts = document.createElement('div'); pts.className = 'list';
    pts.innerHTML = (S.recentPoints || []).map(r => `<div class="hint">${esc(r.date)} · +${esc(r.points)} · ${esc(r.reason)}</div>`).join('') || '<div class="empty">No points yet.</div>';
    v.appendChild(pts);
    const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'To suggest a task, type it in the box at the top. Your student can accept or decline it.'; v.appendChild(p);
  }

  /* ---------------- boot ---------------- */
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  // New version check: when the app comes back on screen (switching back to the tab or reopening
  // the phone app), ask GitHub whether app.js or styles.css changed. If so, reload once so new
  // features show right away. Skipped while a pop-up is open so nothing typed is lost.
  const verOf = () => Promise.all(['app.js', 'styles.css', 'index.html'].map(f => fetch(f, { method: 'HEAD', cache: 'no-store' })
    .then(r => r.headers.get('etag') || r.headers.get('last-modified') || '').catch(() => ''))).then(v => v.join('|'));
  let ver = null;
  verOf().then(v => { ver = v; });
  function checkVersion() {
    if (!ver || !$('#sheet').hidden) return;
    verOf().then(v => { if (v && v.replace(/\|/g, '') && v !== ver) location.reload(); });
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });
  setInterval(() => { if (!document.hidden) checkVersion(); }, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && token) api('load').then(checkSlips).catch(() => {}); });
  if (!CFG.API_URL || !CFG.CLIENT_ID) {
    showSignin('Setup is not finished: add the API URL and client ID to config.js.');
  } else {
    token = loadToken();
    if (token) start(); else showSignin();
  }
})();
