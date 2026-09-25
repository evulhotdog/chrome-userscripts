// ==UserScript==
// @name         Grafana: Datadog-style time picker
// @namespace    https://github.com/evulhotdog/chrome-userscripts
// @version      1.2.3
// @description  Replaces the Grafana dashboard time picker with a port of the Datadog date/time picker.
// @author       smart.pear3631@replicat.es
// @source       https://github.com/evulhotdog/chrome-userscripts/blob/main/work/grafana-datadog-time-picker.user.js
// @match        https://*.coralogix.us/grafana/*
// @match        https://*.coralogix.com/grafana/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/evulhotdog/chrome-userscripts/main/work/grafana-datadog-time-picker.user.js
// @updateURL    https://raw.githubusercontent.com/evulhotdog/chrome-userscripts/main/work/grafana-datadog-time-picker.user.js
// ==/UserScript==

/*
 * Changelog
 * 1.2.3 - Dropped the download token and the author name.
 * 1.2.2 - Added author and source.
 * 1.2.1 - TESTED_GRAFANA is a list, so more than one Grafana version can be marked as tested.
 * 1.2.0 - Shows a warning badge next to the picker when the Grafana version differs from
 *         TESTED_GRAFANA, because the picker depends on Grafana internals.
 * 1.1.0 - Choosing a time frame no longer changes auto-refresh. Grafana's pause-on-absolute-range
 *         is undone, so the refresh picker is the only thing that controls refresh.
 * 1.0.0 - Initial port of the Datadog time picker: typed time frames, presets, calendar-time
 *         items, calendar range picker, help panel, ↑/↓ segment increments, step/play/pause/zoom.
 */

(() => {
  'use strict';

  // Re-running the script (dev reload) replaces the previous instance cleanly.
  window.__ddtp?.destroy();
  document.querySelectorAll('.ddtp-root, .ddtp-pop, .ddtp-help, #ddtp-style').forEach((n) => n.remove());

  const MIN = 6e4, HOUR = 36e5, DAY = 864e5, WEEK = 7 * DAY;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_FULL = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const MONTHS_LONG = MONTHS_FULL.map((m) => m[0].toUpperCase() + m.slice(1));
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DOCS_URL = 'https://docs.datadoghq.com/dashboards/guide/custom_time_frames/';
  // The TimeSrv lookup and toolbar selectors come from Grafana internals; re-test after upgrades.
  const TESTED_GRAFANA = ['10.1.2'];

  // ---------------------------------------------------------------- time zone math

  const zoneOf = (tz) => (!tz || tz === 'browser' ? Intl.DateTimeFormat().resolvedOptions().timeZone : tz === 'utc' ? 'UTC' : tz);
  const fmtCache = new Map();
  function dtf(zone) {
    let f = fmtCache.get(zone);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23', weekday: 'short',
        year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
      });
      fmtCache.set(zone, f);
    }
    return f;
  }
  function parts(ms, zone) {
    const o = {};
    for (const p of dtf(zone).formatToParts(new Date(ms))) o[p.type] = p.value;
    return { y: +o.year, mo: +o.month - 1, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, ms: ((ms % 1000) + 1000) % 1000, dow: DOW.indexOf(o.weekday) };
  }
  function offsetMin(ms, zone) {
    const p = parts(ms, zone);
    return Math.round((Date.UTC(p.y, p.mo, p.d, p.h, p.mi, p.s) - (ms - p.ms)) / MIN);
  }
  // Wall-clock time in `zone` -> epoch ms. Out-of-range fields roll over like Date.UTC.
  function fromParts(zone, y, mo, d, h = 0, mi = 0, s = 0, msec = 0) {
    const guess = Date.UTC(y, mo, d, h, mi, s, msec);
    const t = guess - offsetMin(guess, zone) * MIN;
    return guess - offsetMin(t, zone) * MIN;
  }
  const daysIn = (y, mo) => new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const startOfDay = (ms, c) => { const p = parts(ms, c.zone); return fromParts(c.zone, p.y, p.mo, p.d); };
  const endOfDay = (ms, c) => { const p = parts(ms, c.zone); return fromParts(c.zone, p.y, p.mo, p.d + 1) - 1; };

  function startOf(ms, unit, c) {
    const p = parts(ms, c.zone);
    if (unit === 'd') return fromParts(c.zone, p.y, p.mo, p.d);
    if (unit === 'w') return fromParts(c.zone, p.y, p.mo, p.d - ((p.dow - c.weekStart + 7) % 7));
    if (unit === 'M') return fromParts(c.zone, p.y, p.mo, 1);
    return fromParts(c.zone, p.y, 0, 1);
  }
  function addUnits(ms, unit, n, c) {
    const p = parts(ms, c.zone);
    if (unit === 'd' || unit === 'w') return fromParts(c.zone, p.y, p.mo, p.d + n * (unit === 'w' ? 7 : 1), p.h, p.mi, p.s, p.ms);
    const y = unit === 'y' ? p.y + n : p.y + Math.floor((p.mo + n) / 12);
    const mo = unit === 'y' ? p.mo : (((p.mo + n) % 12) + 12) % 12;
    return fromParts(c.zone, y, mo, Math.min(p.d, daysIn(y, mo)), p.h, p.mi, p.s, p.ms);
  }
  // Subset of Grafana date math used by the picker: now, now-Nu, now/u, now-Nu/u.
  function evalExpr(expr, c, roundUp) {
    const m = /^now(?:-(\d+)([smhdwMy]))?(?:\/([dwMy]))?$/.exec(expr);
    if (!m) return NaN;
    let t = c.now;
    if (m[1]) t = 'smh'.includes(m[2]) ? t - +m[1] * { s: 1e3, m: MIN, h: HOUR }[m[2]] : addUnits(t, m[2], -m[1], c);
    if (m[3]) {
      t = startOf(t, m[3], c);
      if (roundUp) t = addUnits(t, m[3], 1, c) - 1;
    }
    return t;
  }

  // ---------------------------------------------------------------- formatting

  // Datadog's duration pill: 90m -> 2h, 36h -> 2d, exact 7d -> 1w, 7d-1ms -> 7d.
  function shortDur(ms, sliding) {
    if (!(ms > 0)) return '–';
    const mins = ms / MIN;
    if (mins < 59.5) return `${Math.max(1, Math.round(mins))}m`;
    const hours = ms / HOUR;
    if (sliding ? hours < 23.5 : Math.round(hours) <= 24) return `${Math.round(hours)}h`;
    const days = ms / DAY;
    const r = ms % WEEK;
    if (days < 28 && (r === 0 || Math.abs(r - HOUR) < 1 || Math.abs(r - (WEEK - HOUR)) < 1)) return `${Math.round(ms / WEEK)}w`;
    if (days < 27.5) return `${Math.round(days)}d`;
    const mo = days / 30.4375;
    if (mo < 11.5) return `${Math.round(mo)}mo`;
    return `${Math.round(days / 365.25)}y`;
  }
  const UNIT_NAMES = { m: 'Minute', h: 'Hour', d: 'Day', w: 'Week', mo: 'Month', y: 'Year' };
  function longDur(pill) {
    const m = /^(\d+)(mo|[mhdwy])$/.exec(pill);
    return m ? `${m[1]} ${UNIT_NAMES[m[2]]}${m[1] === '1' ? '' : 's'}` : pill;
  }
  function tzLabel(ms, zone) {
    const off = offsetMin(ms, zone);
    const a = Math.abs(off);
    return `UTC${off < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
  }

  // Renders a fixed/growing range and records editable token spans for ↑/↓ increments.
  function renderModel(kind, fromMs, toMs, c) {
    let text = '';
    const spans = [];
    const curY = parts(c.now, c.zone).y;
    const point = (ms, side) => {
      const p = parts(ms, c.zone);
      const push = (t, field) => {
        if (field) spans.push({ side, field, start: text.length, end: text.length + t.length });
        text += t;
      };
      push(MONTHS[p.mo], 'month'); push(' '); push(String(p.d), 'day');
      if (p.y !== curY) { push(', '); push(String(p.y), 'year'); }
      push(', '); push(String(p.h % 12 || 12), 'hour'); push(':'); push(String(p.mi).padStart(2, '0'), 'minute');
      push(' '); push(p.h < 12 ? 'am' : 'pm', 'ampm');
    };
    point(fromMs, 0);
    if (kind === 'growing') text += ' to Now';
    else { text += ' – '; point(toMs, 1); }
    return { kind, text, spans, fromMs, toMs, from: fromMs, to: kind === 'growing' ? 'now' : toMs };
  }

  function bump(ms, field, delta, c) {
    const p = parts(ms, c.zone);
    const z = c.zone;
    switch (field) {
      case 'month': case 'year': {
        const t = new Date(Date.UTC(p.y + (field === 'year' ? delta : 0), p.mo + (field === 'month' ? delta : 0), 1));
        const y = t.getUTCFullYear(), mo = t.getUTCMonth();
        return fromParts(z, y, mo, Math.min(p.d, daysIn(y, mo)), p.h, p.mi, p.s, p.ms);
      }
      case 'day': return fromParts(z, p.y, p.mo, p.d + delta, p.h, p.mi, p.s, p.ms);
      case 'hour': return fromParts(z, p.y, p.mo, p.d, p.h + delta, p.mi, p.s, p.ms);
      case 'minute': return fromParts(z, p.y, p.mo, p.d, p.h, p.mi + delta, p.s, p.ms);
      default: return fromParts(z, p.y, p.mo, p.d, p.h < 12 ? p.h + 12 : p.h - 12, p.mi, p.s, p.ms);
    }
  }

  // ---------------------------------------------------------------- input grammar

  const REL_UNITS = [
    ['m', /^(m|min|mins|minute|minutes)$/], ['h', /^(h|hr|hrs|hour|hours)$/], ['d', /^(d|day|days)$/],
    ['w', /^(w|wk|wks|week|weeks)$/], ['M', /^(mo|mos|mon|mons|month|months)$/], ['y', /^(y|yr|yrs|year|years)$/],
  ];
  const relUnit = (w) => REL_UNITS.find(([, re]) => re.test(w))?.[0];
  const calUnit = (w) => ({ day: 'd', days: 'd', week: 'w', weeks: 'w', month: 'M', months: 'M', year: 'y', years: 'y' })[w];
  const CAL_NAMES = { d: 'Day', w: 'Week', M: 'Month', y: 'Year' };

  function calLabel(from, to) {
    let m;
    if (to === 'now' && (m = /^now\/([dwMy])$/.exec(from))) return { d: 'Today', w: 'Week to Date', M: 'Month to Date', y: 'Year to Date' }[m[1]];
    if (from === to && (m = /^now-(\d+)([dwMy])\/\2$/.exec(from))) {
      const n = +m[1];
      if (n === 1) return m[2] === 'd' ? 'Yesterday' : `Previous ${CAL_NAMES[m[2]]}`;
      return `${n} ${CAL_NAMES[m[2]]}s Ago`;
    }
    return null;
  }
  const calendar = (from, to, c) => ({ kind: 'calendar', from, to, fromMs: evalExpr(from, c, false), toMs: to === 'now' ? c.now : evalExpr(to, c, true) });
  const sliding = (from, c) => ({ kind: 'sliding', from, to: 'now', fromMs: evalExpr(from, c, false), toMs: c.now });
  const monthIdx = (w) => (w.length >= 3 ? MONTHS_FULL.findIndex((f) => f.startsWith(w)) : -1);

  function parsePoint(str) {
    let s = str.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    if (/^\d{9,14}$/.test(s)) return { unix: s.length >= 12 ? +s : +s * 1000 };
    let time = null, date = null, m;
    if ((m = /(?:^| )(\d{1,2})(?::(\d{2}))? ?(am|pm|a|p)$/.exec(s))) {
      const h = +m[1], mi = m[2] ? +m[2] : 0;
      if (h < 1 || h > 12 || mi > 59) return null;
      time = { h: (h % 12) + (m[3][0] === 'p' ? 12 : 0), mi };
      s = s.slice(0, m.index).trim();
    } else if ((m = /(?:^| )(\d{1,2}):(\d{2})$/.exec(s))) {
      if (+m[1] > 23 || +m[2] > 59) return null;
      time = { h: +m[1], mi: +m[2] };
      s = s.slice(0, m.index).trim();
    }
    if (s) {
      if ((m = /^([a-z]+)\.? (\d{1,2})(?: (\d{4}))?$/.exec(s))) {
        date = { mo: monthIdx(m[1]), d: +m[2], y: m[3] ? +m[3] : null };
      } else if ((m = /^(\d{1,2})([/-])(\d{1,2})(?:\2(\d{4}|\d{2}))?$/.exec(s))) {
        date = { mo: +m[1] - 1, d: +m[3], y: m[4] ? (m[4].length === 2 ? 2000 + +m[4] : +m[4]) : null };
      } else return null;
      if (date.mo < 0 || date.mo > 11 || date.d < 1 || date.d > daysIn(date.y ?? 2000, date.mo)) return null;
    }
    return date || time ? { date, time } : null;
  }

  // Missing years resolve to the most recent occurrence that is not in the future.
  function resolveYear(date, c, hintYear) {
    if (date.y != null) return date.y;
    if (hintYear != null) return hintYear;
    const y = parts(c.now, c.zone).y;
    return fromParts(c.zone, y, date.mo, date.d) > c.now ? y - 1 : y;
  }
  function pointMs(pt, date, y, isEnd, c) {
    if (pt.unix != null) return pt.unix;
    if (pt.time) return fromParts(c.zone, y, date.mo, date.d, pt.time.h, pt.time.mi);
    return isEnd ? fromParts(c.zone, y, date.mo, date.d + 1) - 1 : fromParts(c.zone, y, date.mo, date.d);
  }
  const today = (c) => { const p = parts(c.now, c.zone); return { y: p.y, mo: p.mo, d: p.d }; };

  function growStart(str, c) {
    const m = /^(\d+) ?([a-z]+)$/.exec(str);
    if (m && relUnit(m[2])) return evalExpr(`now-${+m[1]}${relUnit(m[2])}`, c, false);
    const pt = parsePoint(str);
    if (!pt) return null;
    if (pt.unix != null) return pt.unix;
    const date = pt.date || today(c);
    return pointMs(pt, date, pt.date ? resolveYear(pt.date, c) : date.y, false, c);
  }

  function parseInput(raw, c) {
    const s = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!s) return null;
    let m, u;
    if (s === 'today' || s === 'this day') return calendar('now/d', 'now', c);
    if (s === 'yesterday') return calendar('now-1d/d', 'now-1d/d', c);
    if ((m = /^(?:this (\w+)|(\w+) to date)$/.exec(s)) && (u = calUnit(m[1] || m[2]))) return calendar(`now/${u}`, 'now', c);
    if ((m = /^(?:last|previous) (\w+)$/.exec(s)) && (u = calUnit(m[1]))) return calendar(`now-1${u}/${u}`, `now-1${u}/${u}`, c);
    if ((m = /^(\d+) (\w+) ago$/.exec(s)) && (u = calUnit(m[2])) && +m[1] > 0) {
      const e = `now-${+m[1]}${u}/${u}`;
      return calendar(e, e, c);
    }
    if ((m = /^(?:(?:past|last) )?(\d+) ?([a-z]+)$/.exec(s)) && (u = relUnit(m[2])) && +m[1] > 0) return sliding(`now-${+m[1]}${u}`, c);

    if ((m = /^(?:since|from) (.+)$/.exec(s)) || (m = /^(.+?) ?(?:to|-|–|—) ?now$/.exec(s))) {
      const f = growStart(m[1], c);
      return f != null && f < c.now ? { kind: 'growing', from: f, to: 'now', fromMs: f, toMs: c.now } : null;
    }

    const sides = s.split(/ (?:-|–|—|to) /);
    if (sides.length > 2) return null;
    const a = parsePoint(sides[0]);
    if (!a) return null;
    let fromMs, toMs;
    if (sides.length === 2) {
      const b = parsePoint(sides[1]);
      if (!b) return null;
      const dateA = a.date || b.date || today(c);
      const dateB = b.date || a.date || today(c);
      const yA = a.date ? resolveYear(a.date, c, b.date?.y) : resolveYear(dateA, c, b.date ? resolveYear(b.date, c) : null);
      const yB = b.date ? resolveYear(b.date, c, a.date?.y) : yA;
      fromMs = pointMs(a, dateA, yA, false, c);
      toMs = pointMs(b, dateB, yB, true, c);
    } else {
      // Datadog quirk: a lone date is the whole day; a lone date+time runs from that day's midnight.
      if (a.unix != null || !a.date) return null;
      const y = resolveYear(a.date, c);
      fromMs = pointMs({}, a.date, y, false, c);
      toMs = a.time ? pointMs(a, a.date, y, false, c) : pointMs({}, a.date, y, true, c);
    }
    if (!(fromMs < toMs) || toMs > c.now + 1000) return null;
    return { kind: 'fixed', from: fromMs, to: toMs, fromMs, toMs };
  }

  // Grafana raw time -> 'now…' string or epoch ms.
  function rawVal(x) {
    if (x == null) return x;
    if (typeof x === 'string') {
      if (/^\d+$/.test(x)) return +x;
      if (x.startsWith('now')) return x;
      const t = Date.parse(x);
      return Number.isNaN(t) ? x : t;
    }
    const n = +x;
    return Number.isNaN(n) ? String(x) : n;
  }

  function describe(st, c) {
    const { rawFrom: f, rawTo: t, fromMs, toMs } = st;
    const dur = toMs - fromMs;
    if (typeof f === 'string' && typeof t === 'string') {
      const label = calLabel(f, t);
      if (label) return { kind: 'calendar', text: label, pill: shortDur(dur, false), live: t === 'now' };
      if (t === 'now' && /^now-\d+[smhdwMy]$/.test(f)) {
        const pill = shortDur(dur, true);
        return { kind: 'sliding', text: `Past ${longDur(pill)}`, pill, live: true };
      }
      return { kind: 'other', text: `${f} to ${t}`, pill: shortDur(dur, false), live: t === 'now' };
    }
    const model = renderModel(t === 'now' ? 'growing' : 'fixed', fromMs, toMs, c);
    return { ...model, pill: shortDur(dur, false), live: t === 'now' };
  }

  // Shortest exact Grafana relative expression for a duration.
  function relExpr(ms) {
    const s = Math.max(1, Math.round(ms / 1000));
    for (const [u, n] of [['w', 604800], ['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) if (s % n === 0) return `now-${s / n}${u}`;
    return `now-${s}s`;
  }

  // ---------------------------------------------------------------- Grafana adapter

  const WEEK_START = { sunday: 0, monday: 1, saturday: 6 };
  let timeSrvCache;

  // Grafana 10 does not expose TimeSrv globally; find it in the webpack module registry by shape.
  function findTimeSrv() {
    if (timeSrvCache) return timeSrvCache;
    try {
      let req;
      window.webpackChunkgrafana?.push([[Symbol('ddtp')], {}, (r) => { req = r; }]);
      if (!req?.m) return null;
      for (const id of Object.keys(req.m)) {
        const src = Function.prototype.toString.call(req.m[id]);
        if (!src.includes('updateTimeRangeFromUrl') || !src.includes('setAutoRefresh')) continue;
        const ex = req(id);
        for (const k of Object.keys(ex)) {
          const v = ex[k];
          if (typeof v !== 'function' || v.length !== 0) continue;
          try {
            const s = v();
            if (s && typeof s.setTime === 'function' && typeof s.timeRange === 'function') return (timeSrvCache = s);
          } catch { /* not a service getter */ }
        }
      }
    } catch (e) {
      console.warn('[ddtp] TimeSrv lookup failed; using URL fallback', e);
    }
    return null;
  }

  const grafana = {
    read() {
      const s = findTimeSrv();
      const boot = window.grafanaBootData?.user || {};
      if (s?.timeModel) {
        const tr = s.timeRange();
        return {
          rawFrom: rawVal(s.time.from), rawTo: rawVal(s.time.to), fromMs: +tr.from, toMs: +tr.to,
          tz: s.timeModel.getTimezone?.() ?? s.timeModel.timezone, weekStart: s.timeModel.weekStart || boot.weekStart,
        };
      }
      const r = window.grafanaRuntime?.getDashboardTimeRange?.();
      if (!r) return null;
      const model = window.grafanaRuntime.getDashboardSaveModel?.() || {};
      return {
        rawFrom: rawVal(r.raw.from), rawTo: rawVal(r.raw.to), fromMs: +r.from, toMs: +r.to,
        tz: model.timezone || boot.timezone, weekStart: model.weekStart || boot.weekStart,
      };
    },
    apply(from, to) {
      const s = findTimeSrv();
      if (s?.timeModel) {
        // Grafana's setTime pauses refresh for absolute ranges and resumes it for relative ones; undo that
        // so only the refresh picker controls auto-refresh.
        const refresh = s.timeModel.refresh;
        const toDateTime = (ms) => { const d = s.timeRange().from.clone(); return d.add(ms - d.valueOf(), 'ms'); };
        s.setTime({ from: typeof from === 'number' ? toDateTime(from) : from, to: typeof to === 'number' ? toDateTime(to) : to });
        s.oldRefresh = undefined;
        if (s.timeModel.refresh !== refresh) s.setAutoRefresh(refresh);
        return;
      }
      const u = new URL(location.href);
      u.searchParams.set('from', String(from));
      u.searchParams.set('to', String(to));
      history.pushState(history.state, '', u);
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    },
  };

  function ctxFrom(st) {
    return { zone: zoneOf(st?.tz), weekStart: WEEK_START[st?.weekStart] ?? 0, now: Date.now() };
  }

  // ---------------------------------------------------------------- UI

  const ICON = {
    back: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 3 2 8l6 5zM14 3 8 8l6 5z"/></svg>',
    fwd: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 3v10l6-5zM8 3v10l6-5z"/></svg>',
    play: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11L13 8z"/></svg>',
    pause: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 3h3v10H4zM9 3h3v10H9z"/></svg>',
    zoom: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.75"/><path d="M4.75 7h4.5M10.5 10.5 14 14"/></svg>',
    caret: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 6h8l-4 5z"/></svg>',
    cal: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="3" width="12" height="11" rx="1"/><path d="M2 6.5h12M5 1.5v3M11 1.5v3"/></svg>',
    left: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 8H3m4-4-4 4 4 4"/></svg>',
    right: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 8h10M9 4l4 4-4 4"/></svg>',
    arrow: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 8h10M9 4l4 4-4 4"/></svg>',
  };

  const CSS = `
body.theme-dark { --ddtp-bg:#181b1f; --ddtp-bg2:#22252b; --ddtp-canvas:#111217; --ddtp-border:rgba(204,204,220,.2); --ddtp-border-weak:rgba(204,204,220,.12);
  --ddtp-text:#ccccdc; --ddtp-text2:rgba(204,204,220,.65); --ddtp-muted:rgba(204,204,220,.4); --ddtp-primary:#3d71d9; --ddtp-link:#6e9fff; --ddtp-hover:rgba(204,204,220,.12); --ddtp-range:rgba(61,113,217,.25); --ddtp-shadow:0 4px 12px rgba(1,4,9,.75); --ddtp-warn:#f8d06b; }
body.theme-light { --ddtp-bg:#fff; --ddtp-bg2:#f4f5f5; --ddtp-canvas:#f4f5f5; --ddtp-border:rgba(36,41,46,.3); --ddtp-border-weak:rgba(36,41,46,.12);
  --ddtp-text:#24292e; --ddtp-text2:rgba(36,41,46,.75); --ddtp-muted:rgba(36,41,46,.45); --ddtp-primary:#3871dc; --ddtp-link:#1f62e0; --ddtp-hover:rgba(36,41,46,.08); --ddtp-range:rgba(56,113,220,.18); --ddtp-shadow:0 4px 8px rgba(24,26,27,.2); --ddtp-warn:#8a4b00; }
.ddtp-hidden-native { display:none !important; }
.ddtp-root { display:flex; align-items:center; gap:8px; font-family:Inter,Helvetica,Arial,sans-serif; font-size:14px; color:var(--ddtp-text); }
.ddtp-warn { flex:none; display:flex; align-items:center; height:32px; padding:0 8px; box-sizing:border-box; border:1px solid var(--ddtp-warn); border-radius:2px;
  background:var(--ddtp-bg); color:var(--ddtp-warn); font-size:12px; font-weight:500; white-space:nowrap; cursor:help; }
.ddtp-field { position:relative; display:flex; align-items:center; gap:6px; width:330px; height:32px; box-sizing:border-box; padding:0 4px 0 5px;
  border:1px solid var(--ddtp-border); border-radius:2px; background:var(--ddtp-bg); cursor:text; }
.ddtp-field:hover { border-color:var(--ddtp-text2); }
.ddtp-root.ddtp-open .ddtp-field { border-color:var(--ddtp-primary); box-shadow:0 0 0 1px var(--ddtp-primary); }
.ddtp-tz { position:absolute; top:-7px; left:50px; padding:0 3px; font-size:10px; line-height:12px; color:var(--ddtp-text2); background:var(--ddtp-bg); pointer-events:none; }
.ddtp-pill { flex:none; min-width:30px; height:20px; padding:0 5px; box-sizing:border-box; border-radius:2px; background:var(--ddtp-bg2); color:var(--ddtp-text2);
  font-size:12px; line-height:20px; text-align:center; }
.ddtp-input { flex:1; min-width:0; height:100%; border:0; outline:0; padding:0; background:transparent; color:var(--ddtp-text); font:inherit; }
.ddtp-caret { flex:none; display:flex; width:16px; height:16px; padding:0; border:0; background:none; color:var(--ddtp-muted); cursor:pointer; }
.ddtp-caret svg, .ddtp-btn svg { width:100%; height:100%; }
.ddtp-group { display:flex; }
.ddtp-btn { display:flex; align-items:center; justify-content:center; width:32px; height:32px; box-sizing:border-box; padding:8px; border:1px solid var(--ddtp-border);
  background:var(--ddtp-bg); color:var(--ddtp-text2); cursor:pointer; border-radius:2px; }
.ddtp-group .ddtp-btn { border-radius:0; }
.ddtp-group .ddtp-btn + .ddtp-btn { margin-left:-1px; }
.ddtp-group .ddtp-btn:first-child { border-radius:2px 0 0 2px; }
.ddtp-group .ddtp-btn:last-child { border-radius:0 2px 2px 0; }
.ddtp-btn:hover { color:var(--ddtp-text); background:var(--ddtp-hover); position:relative; }
.ddtp-btn.ddtp-active { color:#fff; background:var(--ddtp-primary); border-color:var(--ddtp-primary); position:relative; }
.ddtp-pop, .ddtp-help { position:fixed; z-index:10000; box-sizing:border-box; font-family:Inter,Helvetica,Arial,sans-serif; font-size:13px; color:var(--ddtp-text);
  background:var(--ddtp-bg); border:1px solid var(--ddtp-border); border-radius:2px; box-shadow:var(--ddtp-shadow); }
.ddtp-pop { padding:4px 0; overflow:auto; }
.ddtp-item { display:flex; align-items:center; gap:8px; height:26px; padding:0 4px; cursor:pointer; white-space:nowrap; }
.ddtp-item .ddtp-pill { width:38px; }
.ddtp-item.ddtp-hl { background:var(--ddtp-primary); color:#fff; }
.ddtp-item.ddtp-hl .ddtp-pill { background:rgba(255,255,255,.2); color:#fff; }
.ddtp-item .ddtp-ico { width:38px; height:14px; display:flex; justify-content:center; color:var(--ddtp-text2); }
.ddtp-item.ddtp-hl .ddtp-ico { color:#fff; }
.ddtp-item .ddtp-ico svg { width:14px; height:14px; }
.ddtp-head { padding:8px 4px 4px; font-size:11px; font-weight:500; letter-spacing:.02em; text-transform:uppercase; color:var(--ddtp-text); }
.ddtp-grid { display:grid; grid-template-columns:1fr 1fr; }
.ddtp-help { width:300px; padding:0; display:flex; flex-direction:column; }
.ddtp-help-main { padding:10px 12px; flex:1; }
.ddtp-help-title { display:flex; justify-content:space-between; align-items:center; font-weight:500; margin-bottom:8px; }
.ddtp-help-title a { font-size:11px; padding:2px 6px; border:1px solid var(--ddtp-border); border-radius:2px; color:var(--ddtp-text); text-decoration:none; }
.ddtp-help h4 { margin:8px 0 4px; font-size:12px; font-weight:400; color:var(--ddtp-text2); }
.ddtp-chips { display:flex; flex-wrap:wrap; gap:4px 8px; }
.ddtp-chip { font-family:'Roboto Mono',Menlo,monospace; font-size:12px; padding:1px 4px; border-radius:2px; background:var(--ddtp-bg2); color:var(--ddtp-link); cursor:pointer; }
.ddtp-chip:hover { background:var(--ddtp-hover); }
.ddtp-help-foot { padding:10px 12px; background:var(--ddtp-canvas); border-top:1px solid var(--ddtp-border-weak); font-size:12px; }
.ddtp-help-foot a { display:flex; justify-content:space-between; color:var(--ddtp-link); text-decoration:none; font-weight:500; margin-bottom:4px; }
.ddtp-help-foot a svg { width:14px; height:14px; }
.ddtp-help-foot div { color:var(--ddtp-text2); }
.ddtp-cal { padding:4px 8px 8px; }
.ddtp-cal-head { display:flex; align-items:center; justify-content:space-between; height:30px; font-weight:500; font-size:14px; }
.ddtp-cal-nav { display:flex; gap:4px; }
.ddtp-cal-nav button { width:22px; height:22px; padding:3px; border:0; background:none; color:var(--ddtp-text2); cursor:pointer; }
.ddtp-cal-nav button:disabled { opacity:.3; cursor:default; }
.ddtp-cal-grid { display:grid; grid-template-columns:repeat(7,1fr); row-gap:2px; }
.ddtp-cal-dow { text-align:center; font-size:11px; color:var(--ddtp-text2); height:22px; line-height:22px; }
.ddtp-day { height:26px; border:1px solid transparent; background:none; color:var(--ddtp-text); font:inherit; font-size:12px; cursor:pointer; border-radius:2px; padding:0; }
.ddtp-day:hover:not(:disabled) { border-color:var(--ddtp-primary); }
.ddtp-day:disabled { color:var(--ddtp-muted); cursor:default; }
.ddtp-day.ddtp-in { background:var(--ddtp-range); }
.ddtp-day.ddtp-edge { background:var(--ddtp-primary); color:#fff; }
`;

  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };

  const style = el('style');
  style.id = 'ddtp-style';
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = el('div', 'ddtp-root');
  root.innerHTML = `
    <div class="ddtp-field">
      <span class="ddtp-tz"></span>
      <span class="ddtp-pill"></span>
      <input class="ddtp-input" spellcheck="false" autocomplete="off" aria-label="Time frame">
      <button class="ddtp-caret" type="button" tabindex="-1" aria-label="Open time frame options">${ICON.caret}</button>
    </div>
    <div class="ddtp-group">
      <button class="ddtp-btn" type="button" data-act="back" aria-label="Step back" title="Step back">${ICON.back}</button>
      <button class="ddtp-btn" type="button" data-act="play" aria-label="Play" title="Play"></button>
      <button class="ddtp-btn" type="button" data-act="fwd" aria-label="Step forward" title="Step forward">${ICON.fwd}</button>
    </div>
    <button class="ddtp-btn" type="button" data-act="zoom" aria-label="Zoom out time frame" title="Zoom out time frame">${ICON.zoom}</button>`;
  const field = root.querySelector('.ddtp-field');
  const grafanaVersion = window.grafanaBootData?.settings?.buildInfo?.version ?? 'unknown';
  if (!TESTED_GRAFANA.includes(grafanaVersion)) {
    const warn = el('span', 'ddtp-warn');
    warn.setAttribute('role', 'status');
    warn.textContent = `⚠ Time picker untested on Grafana ${grafanaVersion}`;
    warn.title = `This userscript was tested on Grafana ${TESTED_GRAFANA.join(', ')}. Check that it still works, then add this version to TESTED_GRAFANA in the script.`;
    root.prepend(warn);
  }
  const input = root.querySelector('.ddtp-input');
  const pill = root.querySelector('.ddtp-pill');
  const tzEl = root.querySelector('.ddtp-tz');
  const playBtn = root.querySelector('[data-act="play"]');
  const pop = el('div', 'ddtp-pop');
  const help = el('div', 'ddtp-help');
  pop.hidden = help.hidden = true;
  document.body.append(pop, help);

  const ui = { open: false, view: 'list', items: [], hl: -1, edit: null, current: null, helpSticky: false, hoverMore: false, hoverHelp: false, calMonth: null, anchor: null, hoverDay: null };

  function state() {
    const st = grafana.read();
    return st ? { st, c: ctxFrom(st) } : null;
  }

  function sync() {
    const s = state();
    if (!s) return;
    const view = describe(s.st, s.c);
    ui.current = { ...view, st: s.st, c: s.c };
    tzEl.textContent = tzLabel(s.c.now, s.c.zone);
    tzEl.title = s.c.zone;
    playBtn.innerHTML = view.live ? ICON.pause : ICON.play;
    playBtn.setAttribute('aria-label', view.live ? 'Pause' : 'Play');
    playBtn.title = view.live ? 'Pause' : 'Play';
    playBtn.classList.toggle('ddtp-active', view.live);
    if (!ui.open) {
      if (input.value !== view.text) input.value = view.text;
      pill.textContent = view.pill;
    }
  }

  function apply(from, to) {
    if (typeof from === 'number' && typeof to === 'number' && !(from < to)) return;
    grafana.apply(from, to);
    close();
    sync();
  }

  // ---- popover

  const PRESETS = [
    ['now-5m', 'Past 5 Minutes', '5m'], ['now-15m', 'Past 15 Minutes', '15m'], ['now-30m', 'Past 30 Minutes', '30m'],
    ['now-1h', 'Past 1 Hour', '1h'], ['now-4h', 'Past 4 Hours', '4h'], ['now-1d', 'Past 1 Day', '1d'],
    ['now-2d', 'Past 2 Days', '2d'], ['now-1w', 'Past 1 Week', '1w'], ['now-1M', 'Past 1 Month', '1mo'],
  ];
  const CAL_PRESETS = [
    ['now/d', 'now'], ['now-1d/d', 'now-1d/d'], ['now/w', 'now'], ['now-1w/w', 'now-1w/w'],
    ['now/M', 'now'], ['now-1M/M', 'now-1M/M'], ['now/y', 'now'], ['now-1y/y', 'now-1y/y'],
  ];

  function itemEl(pillText, label, run, icon) {
    const e = el('div', 'ddtp-item');
    e.setAttribute('role', 'option');
    e.innerHTML = icon ? `<span class="ddtp-ico">${icon}</span>` : '<span class="ddtp-pill"></span>';
    if (!icon) e.firstChild.textContent = pillText;
    e.append(document.createTextNode(label));
    const idx = ui.items.length;
    ui.items.push({ e, run });
    e.addEventListener('mouseenter', () => setHl(idx));
    e.addEventListener('mousedown', (ev) => { ev.preventDefault(); run(); });
    return e;
  }

  function renderList() {
    const c = ui.current.c;
    ui.items = [];
    ui.hl = -1;
    pop.replaceChildren();
    for (const [expr, label, p] of PRESETS) pop.append(itemEl(p, label, () => apply(expr, 'now')));
    pop.append(el('div', 'ddtp-head', 'Calendar time'));
    const grid = el('div', 'ddtp-grid');
    for (const [f, t] of CAL_PRESETS) {
      const r = calendar(f, t, c);
      grid.append(itemEl(shortDur(r.toMs - r.fromMs, false), calLabel(f, t), () => apply(f, t)));
    }
    pop.append(grid);
    pop.append(itemEl('', 'Select from calendar…', () => showCalendar(), ICON.cal));
    const more = itemEl('', 'More', () => { ui.helpSticky = !ui.helpSticky; renderHelp(); }, '•••');
    more.addEventListener('mouseenter', () => { ui.hoverMore = true; renderHelp(); });
    more.addEventListener('mouseleave', () => { ui.hoverMore = false; setTimeout(renderHelp, 50); });
    pop.append(more);
  }

  function setHl(i) {
    ui.hl = i;
    ui.items.forEach((it, j) => it.e.classList.toggle('ddtp-hl', j === i));
    ui.items[i]?.e.scrollIntoView({ block: 'nearest' });
  }

  function renderHelp() {
    const show = ui.open && ui.view === 'list' && (ui.helpSticky || ui.hoverMore || ui.hoverHelp);
    help.hidden = !show;
    if (!show) return;
    if (!help.firstChild) buildHelp();
    position();
  }

  function buildHelp() {
    const c = ui.current.c;
    const p = parts(c.now, c.zone);
    const mon = MONTHS[p.mo];
    const nowS = Math.floor(c.now / 1000);
    const sections = [
      ['Relative', ['45m', '12 hours', '10d', '2 weeks', 'last month', 'yesterday', 'today']],
      ['Fixed', [`${mon} 1`, `${mon} 1 - ${mon} 2`, `${p.mo + 1}/1`, `${p.mo + 1}/1 - ${p.mo + 1}/2`, '8:00 am - 2:00 pm']],
      ['Growing', [`since ${p.mo + 1}/1`, `${mon} 2 12pm to now`]],
      ['Unix timestamps', [`${nowS - 604800} - ${nowS}`]],
    ];
    const main = el('div', 'ddtp-help-main');
    main.innerHTML = `<div class="ddtp-help-title"><span>Type custom times like:</span><a href="${DOCS_URL}" target="_blank" rel="noopener noreferrer">View Docs</a></div>`;
    for (const [title, chips] of sections) {
      main.append(el('h4', null, title));
      const row = el('div', 'ddtp-chips');
      for (const ch of chips) {
        const chip = el('span', 'ddtp-chip');
        chip.textContent = ch;
        chip.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          input.value = ch;
          onType();
          input.focus();
        });
        row.append(chip);
      }
      main.append(row);
    }
    const foot = el('div', 'ddtp-help-foot');
    const sub = window.grafanaBootData?.settings?.appSubUrl || '';
    foot.innerHTML = `<a href="${sub}/profile">My account preferences ${ICON.arrow}</a><div></div><div>12-hour format</div>`;
    foot.children[1].textContent = `${tzLabel(c.now, c.zone)} (${c.zone})`;
    help.replaceChildren(main, foot);
    help.addEventListener('mouseenter', () => { ui.hoverHelp = true; });
    help.addEventListener('mouseleave', () => { ui.hoverHelp = false; setTimeout(renderHelp, 50); });
  }

  // ---- calendar

  function showCalendar() {
    const c = ui.current.c;
    const p = parts(ui.current.st.toMs, c.zone);
    ui.view = 'calendar';
    ui.calMonth = { y: p.y, mo: p.mo };
    ui.anchor = null;
    ui.hoverDay = null;
    renderHelp();
    renderCalendar();
  }

  function renderCalendar() {
    const c = ui.current.c;
    const { y, mo } = ui.calMonth;
    const nowP = parts(c.now, c.zone);
    const dayMs = (d) => fromParts(c.zone, y, mo, d);
    const days = [];
    // Repaint classes in place; rebuilding on hover would swap the button under the cursor mid-click.
    const paint = () => {
      let lo, hi;
      if (ui.anchor != null) {
        const other = ui.hoverDay ?? ui.anchor;
        lo = Math.min(ui.anchor, other);
        hi = Math.max(ui.anchor, other);
      } else {
        lo = startOfDay(ui.current.st.fromMs, c);
        hi = startOfDay(ui.current.st.toMs - 1, c);
      }
      for (const [b, ms] of days) {
        const inside = ms >= lo && ms <= hi;
        b.classList.toggle('ddtp-edge', inside && (ms === lo || ms === hi));
        b.classList.toggle('ddtp-in', inside && ms !== lo && ms !== hi);
      }
    };
    const wrap = el('div', 'ddtp-cal');
    const head = el('div', 'ddtp-cal-head');
    head.append(document.createTextNode(`${MONTHS_LONG[mo]} ${y}`));
    const nav = el('div', 'ddtp-cal-nav');
    const prev = el('button', null, ICON.left);
    const next = el('button', null, ICON.right);
    prev.setAttribute('aria-label', 'Previous month');
    next.setAttribute('aria-label', 'Next month');
    next.disabled = y > nowP.y || (y === nowP.y && mo >= nowP.mo);
    const step = (n) => (ev) => {
      ev.preventDefault();
      const t = new Date(Date.UTC(y, mo + n, 1));
      ui.calMonth = { y: t.getUTCFullYear(), mo: t.getUTCMonth() };
      renderCalendar();
    };
    prev.addEventListener('mousedown', step(-1));
    next.addEventListener('mousedown', step(1));
    nav.append(prev, next);
    head.append(nav);
    const grid = el('div', 'ddtp-cal-grid');
    for (let i = 0; i < 7; i++) grid.append(el('div', 'ddtp-cal-dow', DOW[(i + c.weekStart) % 7]));
    const lead = (new Date(Date.UTC(y, mo, 1)).getUTCDay() - c.weekStart + 7) % 7;
    for (let i = 0; i < lead; i++) grid.append(el('div'));
    for (let d = 1, n = daysIn(y, mo); d <= n; d++) {
      const ms = dayMs(d);
      const b = el('button', 'ddtp-day', String(d));
      b.type = 'button';
      b.setAttribute('aria-label', `${MONTHS_LONG[mo]} ${d}, ${y}`);
      b.disabled = ms > c.now;
      b.addEventListener('mouseenter', () => {
        if (ui.anchor == null || b.disabled) return;
        ui.hoverDay = ms;
        paint();
      });
      b.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        if (b.disabled) return;
        if (ui.anchor == null) {
          ui.anchor = ms;
          ui.hoverDay = ms;
          paint();
          return;
        }
        const start = Math.min(ui.anchor, ms);
        const end = Math.min(endOfDay(Math.max(ui.anchor, ms), c), Date.now());
        apply(start, end);
      });
      days.push([b, ms]);
      grid.append(b);
    }
    wrap.append(head, grid);
    paint();
    pop.replaceChildren(wrap);
    position();
  }

  // ---- open / close / position

  function position() {
    const r = field.getBoundingClientRect();
    pop.style.left = `${r.left}px`;
    pop.style.top = `${r.bottom + 2}px`;
    pop.style.width = `${r.width}px`;
    pop.style.maxHeight = `${Math.max(160, innerHeight - r.bottom - 10)}px`;
    if (!help.hidden) {
      const pr = pop.getBoundingClientRect();
      help.style.top = `${pr.top}px`;
      help.style.left = `${Math.max(4, pr.left - 300 + 1)}px`;
      help.style.minHeight = `${pr.height}px`;
    }
  }

  function open() {
    if (ui.open) return;
    sync();
    if (!ui.current) return;
    ui.open = true;
    ui.view = 'list';
    ui.helpSticky = ui.hoverMore = ui.hoverHelp = false;
    ui.edit = { ...ui.current };
    help.replaceChildren();
    renderList();
    root.classList.add('ddtp-open');
    pop.hidden = false;
    position();
    input.value = ui.current.text;
    requestAnimationFrame(() => input.select());
  }

  function close() {
    if (!ui.open) return;
    ui.open = false;
    root.classList.remove('ddtp-open');
    pop.hidden = help.hidden = true;
    input.blur();
    sync();
  }

  // ---- typing

  function onType() {
    if (!ui.open) open();
    if (ui.view !== 'list') { ui.view = 'list'; renderList(); }
    setHl(-1);
    ui.edit = null;
    const c = ctxFrom(ui.current.st);
    const r = parseInput(input.value, c);
    pill.textContent = r ? shortDur(r.toMs - r.fromMs, r.kind === 'sliding') : '–';
  }

  function tryBump(delta) {
    const c = ctxFrom(ui.current.st);
    let model = ui.edit?.spans && input.value === ui.edit.text ? ui.edit : null;
    if (!model) {
      const r = parseInput(input.value, c);
      if (!r || (r.kind !== 'fixed' && r.kind !== 'growing')) return false;
      model = renderModel(r.kind, r.fromMs, r.toMs, c);
    }
    const caret = input.selectionStart;
    const span = model.spans.find((s) => caret >= s.start && caret <= s.end);
    if (!span) return false;
    let { fromMs, toMs } = model;
    if (span.side === 0) fromMs = bump(fromMs, span.field, delta, c);
    else toMs = bump(toMs, span.field, delta, c);
    const next = renderModel(model.kind, fromMs, model.kind === 'growing' ? c.now : toMs, c);
    next.bumped = true;
    ui.edit = next;
    input.value = next.text;
    const ns = next.spans.find((s) => s.side === span.side && s.field === span.field);
    if (ns) input.setSelectionRange(ns.start, ns.end);
    pill.textContent = shortDur(next.toMs - next.fromMs, false);
    return true;
  }

  function onEnter() {
    if (ui.hl >= 0) return ui.items[ui.hl].run();
    if (ui.edit && input.value === ui.edit.text) {
      if (ui.edit.bumped) return apply(ui.edit.from, ui.edit.to);
      return close();
    }
    const r = parseInput(input.value, ctxFrom(ui.current.st));
    if (r) apply(r.from, r.to);
  }

  input.addEventListener('focus', open);
  input.addEventListener('mousedown', () => { if (!ui.open) open(); });
  input.addEventListener('input', onType);
  input.addEventListener('keydown', (ev) => {
    // Keep Grafana's global shortcuts (esc exits panel view, etc.) out of the picker.
    ev.stopPropagation();
    if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
    if (ev.key === 'Enter') { ev.preventDefault(); onEnter(); return; }
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (!ui.open) open();
      const delta = ev.key === 'ArrowUp' ? 1 : -1;
      const whole = input.selectionStart === 0 && input.selectionEnd === input.value.length;
      if (!whole && ui.view === 'list' && tryBump(delta)) return;
      if (ui.view !== 'list' || !ui.items.length) return;
      const n = ui.items.length;
      setHl(ui.hl < 0 ? (delta < 0 ? 0 : n - 1) : (ui.hl - delta + n) % n);
    }
  });
  root.querySelector('.ddtp-caret').addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    if (ui.open) close();
    else input.focus();
  });
  field.addEventListener('mousedown', (ev) => {
    if (ev.target === field || ev.target === pill || ev.target === tzEl) { ev.preventDefault(); input.focus(); }
  });

  function onOutside(ev) {
    if (!ui.open) return;
    const t = ev.target;
    if (root.contains(t) || pop.contains(t) || help.contains(t)) return;
    close();
  }
  document.addEventListener('mousedown', onOutside, true);
  const onReflow = () => { if (ui.open) position(); };
  addEventListener('resize', onReflow);
  addEventListener('scroll', onReflow, true);

  // ---- playback buttons

  root.querySelector('.ddtp-group').parentElement.addEventListener('click', (ev) => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    sync();
    const cur = ui.current;
    if (!cur) return;
    const { fromMs: f, toMs: t } = cur.st;
    const d = t - f;
    const now = Date.now();
    if (act === 'play') return cur.live ? apply(f, t) : apply(relExpr(d), 'now');
    if (act === 'back') return apply(f - d, t - d);
    if (act === 'fwd') {
      if (cur.live) return;
      return t + d >= now ? apply(relExpr(d), 'now') : apply(f + d, t + d);
    }
    if (act === 'zoom') {
      if (cur.live || t + d >= now) return apply(relExpr(3 * d), 'now');
      return apply(f - d, t + d);
    }
  });

  // ---------------------------------------------------------------- mounting

  const NATIVE = '[data-testid="data-testid TimePicker Open Button"]';
  let hiddenNative = null;

  let destroyed = false;
  function ensureMounted() {
    if (destroyed) return;
    const btn = /\/d(-solo)?\//.test(location.pathname) ? document.querySelector(NATIVE) : null;
    const group = btn?.closest('.button-group') || btn?.parentElement;
    if (!group || !grafana.read()) {
      if (root.isConnected) { close(); root.remove(); }
      return;
    }
    if (hiddenNative && hiddenNative !== group) hiddenNative.classList.remove('ddtp-hidden-native');
    group.classList.add('ddtp-hidden-native');
    hiddenNative = group;
    if (root.nextSibling !== group) group.parentElement.insertBefore(root, group);
    if (!ui.open) sync();
  }

  let raf = 0;
  const observer = new MutationObserver(() => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; ensureMounted(); });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const timer = setInterval(() => { ensureMounted(); }, 1000);
  ensureMounted();

  window.__ddtp = {
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      clearInterval(timer);
      document.removeEventListener('mousedown', onOutside, true);
      removeEventListener('resize', onReflow);
      removeEventListener('scroll', onReflow, true);
      hiddenNative?.classList.remove('ddtp-hidden-native');
      root.remove(); pop.remove(); help.remove(); style.remove();
      delete window.__ddtp;
    },
  };
})();
