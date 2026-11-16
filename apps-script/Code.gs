/**
 * Hudson Planner back office (Google Apps Script).
 *
 * Runs in the owner's Google account. Stores everything in a Google Sheet,
 * reads the class assignment calendars, writes teacher visits to the plan
 * calendar, and creates the two daily reminder events.
 *
 * Personal settings live in Config.gs (not in the public repository).
 */

const FIELDS = ['id', 'source', 'sourceId', 'cls', 'title', 'type', 'due', 'doDay', 'status', 'paper',
  'pinned', 'createdAt', 'doneAt', 'turnedInAt', 'minutes', 'slipReason', 'slipDate', 'visitFor',
  'visitSlot', 'fixit', 'note', 'pointsGiven', 'updatedAt'];
const OPEN = ['todo', 'doing'];
const SHEETS = {
  Tasks: FIELDS,
  Points: ['date', 'points', 'reason', 'taskId'],
  Study: ['date', 'item', 'done'],
  Grades: ['pastedAt', 'by', 'text'],
};

/* ------------------------------------------------------------------ setup */

/** Run once from the editor after filling in Config.gs. */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SHEET_ID');
  if (!id) {
    const ss = SpreadsheetApp.create('Hudson Planner Data');
    id = ss.getId();
    props.setProperty('SHEET_ID', id);
  }
  const ss = SpreadsheetApp.openById(id);
  Object.keys(SHEETS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  const blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1) ss.deleteSheet(blank);

  [CONFIG.PLAN_CALENDAR, CONFIG.REMINDER_CALENDAR].forEach(name => {
    if (!CalendarApp.getCalendarsByName(name).length) {
      CalendarApp.createCalendar(name, { timeZone: CONFIG.TIMEZONE });
    }
  });

  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('hourly').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('parentDigest').timeBased().atHour(20).everyDays(1).inTimezone(CONFIG.TIMEZONE).create();

  checkCalendars();
  syncAll();
  Logger.log('Setup done. Data sheet: ' + ss.getUrl());
}

/** Lists which configured calendars were found. Run from the editor to debug. */
function checkCalendars() {
  const names = Object.values(CONFIG.CLASS_CALENDARS).concat([CONFIG.SCHOOL_CALENDAR], CONFIG.BUSY_CALENDARS);
  names.forEach(n => Logger.log((CalendarApp.getCalendarsByName(n).length ? 'OK       ' : 'MISSING  ') + n));
}

function hourly() {
  syncAll();
}

/* ------------------------------------------------------------------ dates */

function todayStr() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
}
function dstr(date) {
  return Utilities.formatDate(date, CONFIG.TIMEZONE, 'yyyy-MM-dd');
}
function addDays(s, n) {
  const d = new Date(s + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekday(s) {
  return new Date(s + 'T12:00:00Z').getUTCDay();
}
function toDate(s, hhmm) {
  // Local wall-clock time in CONFIG.TIMEZONE.
  const probe = new Date(s + 'T12:00:00Z');
  const offset = Utilities.formatDate(probe, CONFIG.TIMEZONE, 'XXX');
  return new Date(s + 'T' + (hhmm || '00:00') + ':00' + offset);
}
function nowStamp() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm");
}
function nowHHMM() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'HH:mm');
}

/* ------------------------------------------------------------------ storage */

function sheet(name) {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return SpreadsheetApp.openById(id).getSheetByName(name);
}

function readRows(name) {
  const sh = sheet(name);
  const values = sh.getDataRange().getValues();
  const head = values.shift();
  return values.filter(r => r.join('') !== '').map(r => {
    const o = {};
    head.forEach((h, i) => {
      let v = r[i];
      if (v instanceof Date) v = dstr(v);
      o[h] = v;
    });
    return o;
  });
}

function readTasks() {
  return readRows('Tasks').map(t => {
    t.paper = t.paper === true || t.paper === 'TRUE';
    t.pinned = t.pinned === true || t.pinned === 'TRUE';
    t.fixit = t.fixit === true || t.fixit === 'TRUE';
    t.minutes = t.minutes ? Number(t.minutes) : '';
    t.id = String(t.id);
    return t;
  });
}

/** Writes every task back in one call. Small data set, so this is simplest. */
function writeTasks(tasks) {
  const sh = sheet('Tasks');
  const rows = tasks.map(t => FIELDS.map(f => (t[f] === undefined || t[f] === null) ? '' : t[f]));
  sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), FIELDS.length).clearContent();
  if (rows.length) {
    sh.getRange(2, 1, rows.length, FIELDS.length).setNumberFormat('@').setValues(rows);
  }
}

function appendRow(name, obj) {
  sheet(name).appendRow(SHEETS[name].map(h => obj[h] === undefined ? '' : obj[h]));
}

function newId() {
  return Utilities.getUuid().slice(0, 8);
}

/* ------------------------------------------------------------------ calendar context */

/**
 * School days come from "Day N (CODE periods ...)" events in the all-school
 * calendar, e.g. "Day 1 (RB 23456)", "Day 7 (LCB 5671 Late Start 9:10 AM)".
 * RB = Regular Bell, the only schedule with tutorial and activities.
 * The digits are the periods that meet that day.
 */
function parseDay(title) {
  const m = title.match(/^Day\s+(\d+)\s*(?:\(\s*([A-Za-z]+)\s+(\d+)([^)]*)\))?/i);
  if (!m) return null;
  return { day: Number(m[1]), code: (m[2] || '').toUpperCase(), periods: m[3] || '', title: title, rb: (m[2] || '').toUpperCase() === 'RB' };
}

function schoolDays(from, to) {
  const out = {};
  const cal = CalendarApp.getCalendarsByName(CONFIG.SCHOOL_CALENDAR)[0];
  if (!cal) return out;
  cal.getEvents(toDate(from), toDate(addDays(to, 1))).forEach(ev => {
    const info = parseDay(ev.getTitle().trim());
    if (!info) return;
    const date = dstr(ev.isAllDayEvent() ? ev.getAllDayStartDate() : ev.getStartTime());
    out[date] = info;
  });
  return out;
}

/** Period number of each class, read from its calendar name, e.g. "CHEMISTRY (1) Assignments". */
function classPeriods() {
  const out = {};
  Object.keys(CONFIG.CLASS_CALENDARS).forEach(cls => {
    const m = CONFIG.CLASS_CALENDARS[cls].match(/\((\d)\)/);
    if (m) out[cls] = m[1];
  });
  return out;
}

/** Afternoons with a busy event between 3:30 and 7 pm count as short. */
function shortDays(from, to) {
  const out = {};
  CONFIG.BUSY_CALENDARS.forEach(name => {
    const cal = CalendarApp.getCalendarsByName(name)[0];
    if (!cal) return;
    cal.getEvents(toDate(from), toDate(addDays(to, 1))).forEach(ev => {
      if (ev.isAllDayEvent()) return;
      const s = ev.getStartTime(), e = ev.getEndTime();
      const date = dstr(s);
      if (s < toDate(date, '19:00') && e > toDate(date, '15:30')) {
        (out[date] = out[date] || []).push(ev.getTitle());
      }
    });
  });
  return out;
}

function context(tasks) {
  const today = todayStr();
  const from = addDays(today, -7), to = addDays(today, 60);
  const load = {};
  tasks.forEach(t => { if (OPEN.indexOf(t.status) >= 0 && t.doDay) load[t.doDay] = (load[t.doDay] || 0) + 1; });
  return { today: today, school: schoolDays(from, to), short: shortDays(from, to), load: load };
}

/* ------------------------------------------------------------------ planning rules */

function classify(title) {
  if (/\b(quiz|prueba|check-?in quiz)\b/i.test(title)) return 'quiz';
  if (/\b(test|exam|assessment|examen|midterm|final)\b/i.test(title)) return 'test';
  return 'assignment';
}

/**
 * Suggested do-day: about two days before the due date, never the due date
 * unless there is no other choice, avoiding short afternoons and busy days.
 */
function suggestDoDay(due, ctx) {
  const today = ctx.today;
  if (due <= today) return today;
  const cands = [];
  for (let d = addDays(due, -4); d < due; d = addDays(d, 1)) if (d >= today) cands.push(d);
  if (!cands.length) return today;
  const target = addDays(due, -2);
  let best = null, bestScore = 1e9;
  cands.forEach(d => {
    let score = Math.abs((new Date(d) - new Date(target)) / 864e5);
    if (ctx.short[d]) score += 6;
    const wd = weekday(d);
    if (wd === 0 || wd === 6) score += 1;
    score += (ctx.load[d] || 0) * 1.5;
    if (score < bestScore) { best = d; bestScore = score; }
  });
  ctx.load[best] = (ctx.load[best] || 0) + 1;
  return best;
}

/** School days before a date with a free slot: Regular Bell (tutorial, activities) or 6th period meeting. */
function schoolDaysBefore(date, ctx) {
  const all = Object.keys(ctx.school).filter(d => d < date && d >= ctx.today).sort().reverse();
  const open = all.filter(d => ctx.school[d].rb || ctx.school[d].periods.indexOf('6') >= 0);
  return open.length ? open : all;
}

/** Visit day: the school day before a quiz, 2 school days before a test. */
function visitDay(assess, tasks, ctx) {
  const before = schoolDaysBefore(assess.due, ctx);
  let idx = assess.type === 'test' ? 1 : 0;
  if (!before.length) return assess.due > ctx.today ? ctx.today : null;
  idx = Math.min(idx, before.length - 1);
  const taken = {};
  tasks.forEach(t => { if (t.type === 'visit' && t.visitFor && t.visitFor !== assess.id) taken[t.doDay] = true; });
  // Two assessments close together: both get a visit, the later one moves earlier.
  while (taken[before[idx]] && idx < before.length - 1) idx++;
  return before[idx];
}

function ensureExtras(assess, tasks, ctx, teachers) {
  if (assess.type !== 'quiz' && assess.type !== 'test') return;
  if (assess.due < ctx.today) return;
  const hasVisit = tasks.some(t => t.type === 'visit' && t.visitFor === assess.id);
  if (!hasVisit) {
    const day = visitDay(assess, tasks, ctx);
    if (day) {
      tasks.push(makeTask({
        source: 'auto', sourceId: 'visit|' + assess.id, cls: assess.cls, type: 'visit', visitFor: assess.id,
        title: 'See ' + (teachers[assess.cls] || 'your teacher') + ' before: ' + assess.title,
        due: day, doDay: day,
      }));
    }
  }
  if (assess.type === 'test') {
    for (let n = 1; n <= 3; n++) {
      const sid = 'study|' + assess.id + '|' + n;
      if (tasks.some(t => t.sourceId === sid)) continue;
      const d = addDays(assess.due, n - 4);
      if (d < ctx.today) continue;
      tasks.push(makeTask({
        source: 'auto', sourceId: sid, cls: assess.cls, type: 'study',
        title: '15 min review for ' + assess.title + ' (' + n + ' of 3)', due: assess.due, doDay: d,
      }));
    }
  }
}

function makeTask(p) {
  return Object.assign({
    id: newId(), source: 'manual', sourceId: '', cls: '', title: '', type: 'assignment', due: '',
    doDay: '', status: 'todo', paper: false, pinned: false, createdAt: nowStamp(), doneAt: '',
    turnedInAt: '', minutes: '', slipReason: '', slipDate: '', visitFor: '', visitSlot: '', fixit: false,
    note: '', pointsGiven: '', updatedAt: nowStamp(),
  }, p);
}

function recurring(tasks, ctx) {
  const today = ctx.today;
  const has = sid => tasks.some(t => t.sourceId === sid);
  // Monday of this week and next week.
  const monday = addDays(today, -((weekday(today) + 6) % 7));
  [monday, addDays(monday, 7)].forEach(mon => {
    const fri = addDays(mon, 4);
    if (fri >= today && !has('sweep|' + fri)) {
      tasks.push(makeTask({ source: 'auto', sourceId: 'sweep|' + fri, type: 'sweep', cls: '',
        title: 'Missing-work sweep: check Veracross for 0s and "Not Turned In"', due: fri, doDay: fri }));
    }
    if (fri >= today && !has('weekly|' + mon)) {
      const visitDays = {};
      tasks.forEach(t => { if (t.type === 'visit') visitDays[t.doDay] = true; });
      let day = null;
      for (let d = mon; d <= fri; d = addDays(d, 1)) {
        if (d >= today && ctx.school[d] && ctx.school[d].rb && !visitDays[d]) { day = d; break; }
      }
      day = day || (mon >= today ? mon : today);
      tasks.push(makeTask({ source: 'auto', sourceId: 'weekly|' + mon, type: 'visit', cls: '',
        title: 'Weekly teacher visit: pick a class', due: fri, doDay: day }));
    }
  });
  // Membean: 4 x 10 minutes per 2-week cycle.
  const start = CONFIG.MEMBEAN_CYCLE_START;
  if (start) {
    const days = Math.floor((new Date(today) - new Date(start)) / 864e5);
    const cycle = addDays(start, Math.max(0, Math.floor(days / 14)) * 14);
    [cycle, addDays(cycle, 14)].forEach(c => {
      [0, 2, 7, 9].forEach((off, i) => {
        const sid = 'membean|' + c + '|' + (i + 1);
        const d = addDays(c, off);
        if (d < today || has(sid)) return;
        tasks.push(makeTask({ source: 'auto', sourceId: sid, type: 'routine', cls: 'Eng',
          title: 'Membean 10 min (' + (i + 1) + ' of 4)', due: addDays(c, 13), doDay: d }));
      });
    });
  }
}

/* ------------------------------------------------------------------ sync */

function syncAll() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const props = PropertiesService.getScriptProperties();
    const tasks = readTasks();
    const ctx = context(tasks);
    const teachers = CONFIG.TEACHERS || {};
    const first = !props.getProperty('INITIALIZED');
    const from = first ? ctx.today : addDays(ctx.today, -14);
    const bySource = {};
    tasks.forEach(t => { if (t.sourceId) bySource[t.sourceId] = t; });

    Object.keys(CONFIG.CLASS_CALENDARS).forEach(cls => {
      const cal = CalendarApp.getCalendarsByName(CONFIG.CLASS_CALENDARS[cls])[0];
      if (!cal) return;
      cal.getEvents(toDate(from), toDate(addDays(ctx.today, 60))).forEach(ev => {
        const due = dstr(ev.isAllDayEvent() ? ev.getAllDayStartDate() : ev.getStartTime());
        const sid = 'feed|' + ev.getId() + '|' + due;
        const title = ev.getTitle().trim();
        const existing = bySource[sid] || tasks.find(t => t.source === 'feed' && t.sourceId.indexOf('feed|' + ev.getId() + '|') === 0);
        if (existing) {
          if (existing.title !== title) { existing.title = title; existing.updatedAt = nowStamp(); }
          if (existing.due !== due) {
            existing.due = due;
            existing.sourceId = sid;
            if (!existing.pinned && OPEN.indexOf(existing.status) >= 0) existing.doDay = suggestDoDay(due, ctx);
            existing.updatedAt = nowStamp();
          }
          return;
        }
        const type = classify(title);
        const t = makeTask({ source: 'feed', sourceId: sid, cls: cls, title: title, type: type, due: due,
          doDay: type === 'assignment' ? suggestDoDay(due, ctx) : due });
        tasks.push(t);
        bySource[sid] = t;
      });
    });

    // Sketchbooks come from the Photography calendar; remove the old automatic copies.
    for (let i = tasks.length - 1; i >= 0; i--) {
      if (String(tasks[i].sourceId).indexOf('sketch|') === 0) tasks.splice(i, 1);
    }
    tasks.forEach(t => ensureExtras(t, tasks, ctx, teachers));
    recurring(tasks, ctx);
    writeTasks(tasks);
    props.setProperty('INITIALIZED', '1');
    props.setProperty('LAST_SYNC', nowStamp());
    refreshReminders(tasks, ctx);
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ reminders */

const CLASS_NAMES = { Chem: 'Chemistry', Alg: 'Algebra 2', Eng: 'English 10', Hist: 'History', Span: 'Spanish 3', Photo: 'Photography' };

function label(t) {
  return (CLASS_NAMES[t.cls] ? CLASS_NAMES[t.cls] + ': ' : '') + t.title;
}

/**
 * Builds at most two reminder events per day in the reminders calendar:
 * a morning one (only when there is paper to pack or a visit) and the 3:25 plan.
 */
function refreshReminders(tasks, ctx) {
  const cal = CalendarApp.getCalendarsByName(CONFIG.REMINDER_CALENDAR)[0];
  if (!cal) return;
  const today = ctx.today, now = nowHHMM();
  [today, addDays(today, 1)].forEach(date => {
    cal.getEventsForDay(toDate(date, '12:00')).forEach(ev => { if (ev.getTag('hp')) ev.deleteEvent(); });

    const pack = tasks.filter(t => t.paper && t.due === date && ['in', 'graded'].indexOf(t.status) < 0 && t.type === 'assignment');
    const visits = tasks.filter(t => t.type === 'visit' && t.doDay === date && t.status !== 'done');
    if ((pack.length || visits.length) && !(date === today && now >= CONFIG.MORNING_REMINDER)) {
      const parts = [];
      if (pack.length) parts.push('Pack ' + pack.length + ' paper item' + (pack.length > 1 ? 's' : ''));
      if (visits.length) parts.push('Teacher visit today');
      const desc = pack.map(t => '• Pack: ' + label(t)).concat(visits.map(t => '• ' + t.title + (t.visitSlot ? ' (' + t.visitSlot + ')' : ''))).join('\n');
      addReminder(cal, date, CONFIG.MORNING_REMINDER, parts.join(' · '), desc);
    }

    const plan = tasks.filter(t => t.doDay === date && OPEN.indexOf(t.status) >= 0 && t.type !== 'visit');
    const tomorrow = addDays(date, 1);
    const tests = tasks.filter(t => (t.type === 'quiz' || t.type === 'test') && t.due === tomorrow);
    const visitsTomorrow = tasks.filter(t => t.type === 'visit' && t.doDay === tomorrow && t.status !== 'done');
    if ((plan.length || tests.length || visitsTomorrow.length) && !(date === today && now >= CONFIG.AFTERNOON_REMINDER)) {
      const bits = [];
      if (plan.length) bits.push(plan.length + ' to do today');
      tests.forEach(t => bits.push((t.type === 'test' ? 'Test' : 'Quiz') + ' tomorrow: ' + (CLASS_NAMES[t.cls] || t.cls)));
      if (visitsTomorrow.length) bits.push('Teacher visit tomorrow');
      const desc = plan.map(t => '• ' + label(t)).concat(
        tests.map(t => '• Tomorrow: ' + label(t)),
        visitsTomorrow.map(t => '• Tomorrow: ' + t.title + (t.visitSlot ? ' (' + t.visitSlot + ')' : ' — pick a slot in the app')),
      ).join('\n');
      addReminder(cal, date, CONFIG.AFTERNOON_REMINDER, "Today's plan: " + bits.join(' · '), desc);
    }
  });
}

function addReminder(cal, date, hhmm, title, desc) {
  const start = toDate(date, hhmm);
  const ev = cal.createEvent(title, start, new Date(start.getTime() + 5 * 60000), { description: desc });
  ev.setTag('hp', '1');
  ev.removeAllReminders();
  ev.addPopupReminder(0);
}

const SLOT_TIMES = { 'Tutorial': ['11:35', '12:00'], 'Activities': ['12:00', '12:35'] };

/** Puts a booked teacher visit on the plan calendar. */
function syncVisitEvent(t) {
  const cal = CalendarApp.getCalendarsByName(CONFIG.PLAN_CALENDAR)[0];
  if (!cal) return;
  const from = toDate(addDays(t.doDay, -30)), to = toDate(addDays(t.doDay, 30));
  cal.getEvents(from, to).forEach(ev => { if (ev.getTag('task') === t.id) ev.deleteEvent(); });
  if (!t.visitSlot || t.status === 'done') return;
  const key = Object.keys(SLOT_TIMES).find(k => t.visitSlot.indexOf(k) === 0);
  let ev;
  if (key) {
    ev = cal.createEvent(t.title, toDate(t.doDay, SLOT_TIMES[key][0]), toDate(t.doDay, SLOT_TIMES[key][1]));
  } else {
    ev = cal.createAllDayEvent(t.title + ' (' + t.visitSlot + ')', toDate(t.doDay, '12:00'));
  }
  ev.setTag('task', t.id);
  ev.removeAllReminders();
}

/* ------------------------------------------------------------------ points */

function award(t, key, pts, reason) {
  const given = String(t.pointsGiven || '').split(',').filter(Boolean);
  if (given.indexOf(key) >= 0) return 0;
  given.push(key);
  t.pointsGiven = given.join(',');
  appendRow('Points', { date: todayStr(), points: pts, reason: reason, taskId: t.id });
  return pts;
}

function applyPoints(before, after) {
  const today = todayStr();
  let got = 0;
  if (after.status === 'in' && before.status !== 'in') {
    got += award(after, 'in', today <= after.due ? 10 : 5, today <= after.due ? 'Turned in on time' : 'Turned in late');
  }
  if ((after.status === 'done' || after.status === 'in') && OPEN.indexOf(before.status) >= 0 && after.type !== 'visit' && today < after.due) {
    got += award(after, 'early', 5, 'Finished before the due date');
  }
  if (after.minutes && !before.minutes) got += award(after, 'time', 2, 'Logged time');
  if (after.type === 'visit' && after.status === 'done' && before.status !== 'done') got += award(after, 'visit', 10, 'Teacher visit');
  return got;
}

function pointsTotal() {
  return readRows('Points').reduce((s, r) => s + Number(r.points || 0), 0);
}

/** Days in a row (most recent first) where everything planned for that day got done. */
function streak(tasks, today) {
  let n = 0;
  for (let i = 1; i <= 60; i++) {
    const d = addDays(today, -i);
    const planned = tasks.filter(t => t.doDay === d && t.type !== 'visit');
    if (!planned.length) continue;
    const ok = planned.every(t => (t.doneAt && t.doneAt.slice(0, 10) <= d) || (t.turnedInAt && t.turnedInAt.slice(0, 10) <= d));
    if (!ok) break;
    n++;
  }
  return n;
}

/* ------------------------------------------------------------------ red flags */

function redFlags(tasks, today) {
  const flags = [];
  tasks.forEach(t => {
    if (t.type === 'assignment' && t.due < today && ['in', 'graded'].indexOf(t.status) < 0 && t.status !== 'suggested') {
      flags.push({ kind: 'Missing', text: label(t) + ' (due ' + t.due + ')', id: t.id });
    } else if (t.type === 'assignment' && t.status === 'done' && t.due <= today) {
      flags.push({ kind: 'Done, not turned in', text: label(t), id: t.id });
    }
    if (t.type === 'visit' && t.visitFor && t.status !== 'done' && !t.visitSlot && t.doDay <= addDays(today, 1) && t.doDay >= today) {
      flags.push({ kind: 'Visit not booked', text: t.title + ' (by ' + t.doDay + ')', id: t.id });
    }
    if (t.type === 'visit' && t.visitFor && t.status !== 'done' && t.doDay < today) {
      flags.push({ kind: 'Visit missed', text: t.title, id: t.id });
    }
    if (t.slipReason && t.slipDate >= addDays(today, -7)) {
      flags.push({ kind: 'Missed plan', text: label(t) + ' — reason: ' + t.slipReason, id: t.id });
    }
    if (t.type === 'assignment' && OPEN.indexOf(t.status) >= 0 && t.doDay === t.due && t.due >= today) {
      flags.push({ kind: 'Planned for the due day', text: label(t), id: t.id });
    }
  });
  return flags;
}

function parentDigest() {
  const tasks = readTasks();
  const flags = redFlags(tasks, todayStr());
  if (!flags.length) return;
  const body = flags.map(f => f.kind + ': ' + f.text).join('\n') + '\n\nOpen the parent view for details.';
  MailApp.sendEmail([].concat(CONFIG.PARENT_EMAILS).join(','), 'Hudson Planner: ' + flags.length + ' thing' + (flags.length > 1 ? 's' : '') + ' to check', body);
}

/* ------------------------------------------------------------------ web API */

function doGet() {
  return json({ ok: true, app: 'hudson-planner' });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const who = verify(req.idToken);
    if (who.fail) {
      console.warn('Sign-in rejected: ' + who.fail);
      return json({ error: 'auth', reason: who.fail });
    }
    return json(handle(req, who));
  } catch (err) {
    return json({ error: String(err && err.message || err) });
  }
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** Returns { email, role } for a family account, or { fail: reason } explaining the rejection. */
function verify(idToken) {
  if (!idToken) return { fail: 'No sign-in token was sent.' };
  const cache = CacheService.getScriptCache();
  const key = 'tok' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  let email = cache.get(key);
  if (!email) {
    const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return { fail: 'Google did not accept the sign-in token (code ' + res.getResponseCode() + '). Try signing in again.' };
    const info = JSON.parse(res.getContentText());
    if (info.aud !== CONFIG.CLIENT_ID) {
      return { fail: 'Client ID mismatch. The website uses one ending "' + String(info.aud).slice(-30) + '", but the script\'s Config has "' + String(CONFIG.CLIENT_ID).slice(-30) + '". Fix Config, then deploy a new version.' };
    }
    if (String(info.email_verified) !== 'true') return { fail: 'This Google account\'s email is not verified.' };
    email = String(info.email).toLowerCase();
    cache.put(key, email, 1800);
  }
  if ([].concat(CONFIG.STUDENT_EMAIL).map(x => String(x).trim().toLowerCase()).indexOf(email) >= 0) return { email: email, role: 'student' };
  if ([].concat(CONFIG.PARENT_EMAILS).map(x => String(x).trim().toLowerCase()).indexOf(email) >= 0) return { email: email, role: 'parent' };
  return { fail: email + ' is not on the list in Config. Sign in with a family account, or add it and deploy a new version.' };
}

function handle(req, who) {
  const today = todayStr();
  if (req.action === 'load') return loadAll(who);
  if (req.action === 'sync') { syncAll(); return loadAll(who); }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const tasks = readTasks();
    const byId = {};
    tasks.forEach(t => { byId[t.id] = t; });
    let gained = 0;

    if (req.action === 'save') {
      const t = byId[String(req.task.id)];
      if (!t) throw new Error('Task not found');
      if (who.role !== 'student') throw new Error('Only the student can change tasks');
      const before = Object.assign({}, t);
      ['title', 'cls', 'due', 'doDay', 'status', 'paper', 'minutes', 'visitSlot', 'note', 'fixit'].forEach(f => {
        if (req.task[f] !== undefined) t[f] = req.task[f];
      });
      if (req.task.doDay !== undefined && req.task.doDay !== before.doDay) t.pinned = true;
      if (t.status !== before.status) {
        if ((t.status === 'done' || t.status === 'in') && !t.doneAt) t.doneAt = nowStamp();
        if (t.status === 'in' && !t.turnedInAt) t.turnedInAt = nowStamp();
        if (OPEN.indexOf(t.status) >= 0) { t.doneAt = ''; t.turnedInAt = ''; }
        if (t.status === 'in' || t.status === 'graded') t.fixit = false;
      }
      t.updatedAt = nowStamp();
      gained = applyPoints(before, t);
      if (t.type === 'visit' && (t.visitSlot !== before.visitSlot || t.status !== before.status)) syncVisitEvent(t);
    } else if (req.action === 'add') {
      const ctx = context(tasks);
      const p = req.task || {};
      const due = p.due || addDays(today, 1);
      const type = p.type || classify(p.title || '');
      const isParent = who.role === 'parent';
      const t = makeTask({
        source: isParent ? 'parent' : 'manual', cls: p.cls || '', title: String(p.title || 'New task').slice(0, 200),
        type: type, due: due, paper: !!p.paper, status: isParent ? 'suggested' : 'todo',
        doDay: type === 'assignment' ? suggestDoDay(due, ctx) : due,
      });
      tasks.push(t);
      if (!isParent) ensureExtras(t, tasks, ctx, CONFIG.TEACHERS || {});
    } else if (req.action === 'accept') {
      const t = byId[String(req.id)];
      if (!t || who.role !== 'student') throw new Error('Not allowed');
      if (req.accept) {
        t.status = 'todo';
        const ctx = context(tasks);
        t.doDay = t.type === 'assignment' ? suggestDoDay(t.due, ctx) : t.due;
        ensureExtras(t, tasks, ctx, CONFIG.TEACHERS || {});
      } else {
        tasks.splice(tasks.indexOf(t), 1);
      }
    } else if (req.action === 'slip') {
      const t = byId[String(req.id)];
      if (!t || who.role !== 'student') throw new Error('Not allowed');
      t.slipReason = String(req.reason || '').slice(0, 80);
      t.slipDate = today;
      const ctx = context(tasks);
      t.doDay = t.due > today ? suggestDoDay(t.due, ctx) : today;
      if (t.doDay < today) t.doDay = today;
      t.pinned = false;
    } else if (req.action === 'reset') {
      if (who.role !== 'student') throw new Error('Not allowed');
      tasks.forEach(t => {
        if (t.type === 'assignment' && ['in', 'graded', 'suggested'].indexOf(t.status) < 0 && (t.doDay < today || t.due < today)) {
          t.fixit = true;
          t.doDay = today;
        }
      });
    } else if (req.action === 'absent') {
      if (who.role !== 'student') throw new Error('Not allowed');
      const ctx = context(tasks);
      const date = req.date || today;
      Object.keys(CONFIG.CLASS_CALENDARS).forEach(cls => {
        tasks.push(makeTask({ cls: cls, type: 'assignment', title: 'Catch up on what I missed (' + date + ')',
          due: addDays(date, 2), doDay: suggestDoDay(addDays(date, 2), ctx) }));
      });
    } else if (req.action === 'study') {
      if (who.role !== 'student') throw new Error('Not allowed');
      appendRow('Study', { date: today, item: String(req.item), done: req.done ? 'yes' : 'no' });
      if (req.done) {
        const already = readRows('Points').some(r => r.date === today && r.reason === 'Study: ' + req.item);
        if (!already) { appendRow('Points', { date: today, points: 1, reason: 'Study: ' + req.item, taskId: '' }); gained = 1; }
      }
    } else if (req.action === 'grades') {
      if (who.role !== 'parent') throw new Error('Not allowed');
      appendRow('Grades', { pastedAt: nowStamp(), by: who.email, text: String(req.text || '').slice(0, 45000) });
    } else {
      throw new Error('Unknown action');
    }

    writeTasks(tasks);
    const res = loadAll(who, tasks);
    res.gained = gained;
    return res;
  } finally {
    lock.releaseLock();
  }
}

function loadAll(who, tasksIn) {
  const tasks = tasksIn || readTasks();
  const today = todayStr();
  const cutoff = addDays(today, -45);
  const visible = tasks.filter(t => t.due >= cutoff || OPEN.indexOf(t.status) >= 0 || t.status === 'done' || t.fixit);
  const school = schoolDays(addDays(today, -7), addDays(today, 42));
  const short = shortDays(addDays(today, -7), addDays(today, 42));
  const studyRows = readRows('Study').filter(r => r.date === today);
  const study = {};
  studyRows.forEach(r => { study[r.item] = r.done === 'yes'; });
  const out = {
    role: who.role, today: today, now: nowHHMM(), tasks: visible, school: school, short: short,
    studentName: CONFIG.STUDENT_NAME || 'there', periods: classPeriods(), points: pointsTotal(), streak: streak(tasks, today), study: study, teachers: CONFIG.TEACHERS || {},
    lastSync: PropertiesService.getScriptProperties().getProperty('LAST_SYNC') || '',
  };
  if (who.role === 'parent') {
    out.flags = redFlags(tasks, today);
    const g = readRows('Grades');
    out.lastGrades = g.length ? g[g.length - 1] : null;
    out.recentPoints = readRows('Points').slice(-20).reverse();
  }
  return out;
}
