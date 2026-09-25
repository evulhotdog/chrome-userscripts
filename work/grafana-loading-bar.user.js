// ==UserScript==
// @name         Grafana: loading progress bar
// @namespace    https://github.com/evulhotdog/chrome-userscripts
// @version      1.1.3
// @description  Thin progress bar at the top of the window for Grafana page loads, dashboard refreshes and time range changes.
// @author       smart.pear3631@replicat.es
// @source       https://github.com/evulhotdog/chrome-userscripts/blob/main/work/grafana-loading-bar.user.js
// @match        https://*.coralogix.us/grafana/*
// @match        https://*.coralogix.com/grafana/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/evulhotdog/chrome-userscripts/main/work/grafana-loading-bar.user.js
// @updateURL    https://raw.githubusercontent.com/evulhotdog/chrome-userscripts/main/work/grafana-loading-bar.user.js
// ==/UserScript==

/*
 * Changelog
 * 1.1.3 - Dropped the download token and the author name.
 * 1.1.2 - Added author and source.
 * 1.1.1 - TESTED_GRAFANA is a list, so more than one Grafana version can be marked as tested.
 * 1.1.0 - Shows a warning badge next to the dashboard time picker when the Grafana version
 *         differs from TESTED_GRAFANA, because the tracker reads Grafana internals.
 * 1.0.0 - Initial version. Progress counts page boot, dashboard load, template variables, data
 *         API requests and each panel query runner that is loading or about to reload.
 */

(() => {
  'use strict';

  // Re-running the script (dev reload) replaces the previous instance cleanly.
  window.__gflb?.destroy();
  document.querySelectorAll('.gflb-bar, .gflb-warn, #gflb-style').forEach((n) => n.remove());

  // The Redux store and query runner shapes come from Grafana internals; re-test after upgrades.
  const TESTED_GRAFANA = ['10.1.2'];
  const PICKER = '.ddtp-root, [data-testid="data-testid TimePicker Open Button"]';
  const TICK_MS = 100;
  const SHOW_DELAY_MS = 150; // loads faster than this never show the bar
  const SETTLE_MS = 400; // wait this long for follow-up work (panels after variables) before finishing
  const HOLD = 0.95; // headroom kept until the batch is really finished
  const PHASE_SHARE = { boot: 0.15, variables: 0.4 }; // bar share per dashboard loading phase
  const FADE_MS = 350;
  const ROUTE_TIMEOUT_MS = 15000;
  const FIRST_RUN_WAIT_MS = 2000;
  const STORE_TRIES = 30;
  const BODY_TIMEOUT_MS = 10000;
  const BODY_READERS = ['json', 'text', 'arrayBuffer', 'blob', 'formData'];
  const DATA_API = /\/api\/(?:ds\/query|datasources\/|annotations|dashboards\/|search|library-elements|prometheus\/|ruler\/|alertmanager\/)/;
  const DASH_PATH = /\/d(?:-solo)?\/([^/?#]+)/;
  const K_DOM = { name: 'dom' };
  const K_LOAD = { name: 'load' };

  let destroyed = false;
  let store = null;
  let storeTries = 0;
  let lastPath = null;
  let route = null;
  let batch = null;
  let kickTimer = 0;
  let hideTimer = 0;
  let resetTimer = 0;
  let shown = false;
  const netTasks = new Set();
  // Panels expected to reload because variables are refreshing; keeps them counted across the gap.
  const anticipated = new WeakMap();

  // ---------------------------------------------------------------- DOM

  const style = document.createElement('style');
  style.id = 'gflb-style';
  style.textContent = `
    .gflb-bar {
      position: fixed; top: 0; left: 0; right: 0; height: 5px; z-index: 2147483647;
      pointer-events: none; opacity: 0; transform: scaleX(0); transform-origin: 0 50%;
      background: linear-gradient(90deg, #1f5fc4, #3d71d9 50%, #00b8ff);
      box-shadow: 0 1px 0 rgba(0, 0, 0, 0.45), 0 0 8px rgba(61, 113, 217, 0.9);
      transition: transform 250ms ease-out, opacity ${FADE_MS}ms ease;
      overflow: hidden;
    }
    .gflb-bar.gflb-active::after {
      content: ''; position: absolute; inset: 0; width: 30%;
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.55), transparent);
      animation: gflb-shimmer 1.1s linear infinite;
    }
    @keyframes gflb-shimmer { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
    @media (prefers-reduced-motion: reduce) {
      .gflb-bar { transition: opacity ${FADE_MS}ms ease; }
      .gflb-bar.gflb-active::after { animation: none; }
    }
    body.theme-dark { --gflb-warn: #f8d06b; --gflb-warn-bg: #181b1f; }
    body.theme-light { --gflb-warn: #8a4b00; --gflb-warn-bg: #fff; }
    .gflb-warn {
      flex: none; display: flex; align-items: center; height: 32px; padding: 0 8px; margin-right: 8px;
      box-sizing: border-box; border: 1px solid var(--gflb-warn); border-radius: 2px;
      background: var(--gflb-warn-bg); color: var(--gflb-warn);
      font: 500 12px Inter, Helvetica, Arial, sans-serif; white-space: nowrap; cursor: help;
    }
  `;
  const bar = document.createElement('div');
  bar.className = 'gflb-bar';
  bar.setAttribute('aria-hidden', 'true');
  // Created once grafanaBootData exists, and only when the version differs.
  let warn;

  function mount() {
    const root = document.documentElement; // can be missing at document-start
    if (!root) return;
    if (!style.isConnected) root.append(style);
    if (!bar.isConnected) root.append(bar);
  }

  function mountWarning() {
    if (warn === undefined) {
      const info = window.grafanaBootData?.settings?.buildInfo;
      if (!info) return;
      const version = info.version ?? 'unknown';
      warn = null;
      if (!TESTED_GRAFANA.includes(version)) {
        warn = document.createElement('span');
        warn.className = 'gflb-warn';
        warn.setAttribute('role', 'status');
        warn.textContent = `⚠ Loading bar untested on Grafana ${version}`;
        warn.title = `This userscript was tested on Grafana ${TESTED_GRAFANA.join(', ')}. Check that it still works, then add this version to TESTED_GRAFANA in the script.`;
      }
    }
    if (!warn) return;
    const picker = document.querySelector(PICKER);
    const anchor = picker?.classList.contains('ddtp-root') ? picker : picker?.closest('.button-group');
    if (!anchor) warn.remove();
    else if (warn.nextSibling !== anchor) anchor.before(warn);
  }

  function setScale(p, animate) {
    bar.style.transition = animate ? '' : 'none';
    bar.style.transform = `scaleX(${p})`;
    if (!animate) void bar.offsetWidth; // commit the jump before transitions come back
  }

  function show(p) {
    clearTimeout(hideTimer);
    clearTimeout(resetTimer);
    if (!shown) {
      setScale(0, false);
      bar.style.transition = '';
      bar.style.opacity = '1';
      bar.classList.add('gflb-active');
      shown = true;
    }
    bar.style.transform = `scaleX(${Math.max(p, 0.02)})`;
  }

  function finish() {
    if (!shown) return;
    shown = false;
    bar.classList.remove('gflb-active');
    bar.style.transform = 'scaleX(1)';
    hideTimer = setTimeout(() => {
      bar.style.opacity = '0';
      resetTimer = setTimeout(() => setScale(0, false), FADE_MS);
    }, 200);
  }

  // ---------------------------------------------------------------- Grafana state

  // The Redux store comes from the react-redux Provider near the root of the React tree.
  function findStore() {
    if (store || storeTries >= STORE_TRIES || !window.grafanaRuntime) return;
    storeTries++;
    const root = document.getElementById('reactRoot');
    const key = root && Object.keys(root).find((k) => k.startsWith('__reactContainer'));
    const stack = key ? [root[key]] : [];
    for (let visited = 0; stack.length && visited < 5000; visited++) {
      const fiber = stack.pop();
      const s = fiber.memoizedProps?.store;
      if (s && typeof s.getState === 'function' && typeof s.subscribe === 'function') {
        store = s;
        return;
      }
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
  }

  const currentDashboard = (state = store?.getState()) => state?.dashboard?.getModel?.() ?? null;

  function panelsOf(d) {
    const panels = d.panels.slice();
    if (d.panelInEdit) panels.push(d.panelInEdit);
    return panels;
  }

  function ownedByPanel(requestId) {
    const d = currentDashboard();
    if (!d) return false;
    // Mixed data source panels send derived ids, so match any id token.
    const tokens = new Set(requestId.split(/[^A-Za-z0-9]+/));
    return panelsOf(d).some((p) => tokens.has(p.queryRunner?.lastRequest?.requestId));
  }

  function runnerPending(r, now) {
    const last = r.lastRequest;
    if (last && (r.lastResult?.request !== last || r.lastResult.state === 'Loading')) return true;
    const a = anticipated.get(r);
    if (!a) return false;
    if (last !== a.request || now > a.until) {
      anticipated.delete(r);
      return false;
    }
    return true;
  }

  // Adds pending template variables to keys; returns whether any variable is refreshing.
  function collectVariables(state, keys) {
    const uid = state.templating?.lastKey;
    const variables = uid && state.templating.keys?.[uid]?.variables;
    if (!variables) return false;
    // Before init completes, variables that have not started yet are still work to come.
    const initializing = state.dashboard?.initPhase !== 'Completed';
    let loading = false;
    for (const v of Object.values(variables)) {
      if (v.type === 'system') continue;
      if (v.state === 'Loading' || (initializing && v.state === 'NotStarted')) {
        keys.add(`var:${uid}:${v.id ?? v.name}`);
        loading = true;
      }
    }
    return loading;
  }

  // ---------------------------------------------------------------- network tracking

  function isTrackedRequest(input) {
    let url;
    try {
      url = new URL(input instanceof Request ? input.url : String(input), document.baseURI);
    } catch {
      return false;
    }
    if (url.origin !== location.origin || !DATA_API.test(url.pathname)) return false;
    // Panel queries are already counted through their query runner.
    const requestId = url.pathname.endsWith('/api/ds/query') && url.searchParams.get('requestId');
    return !(requestId && ownedByPanel(requestId));
  }

  function trackNet(promise) {
    const task = {};
    netTasks.add(task);
    const end = () => {
      netTasks.delete(task);
      kick();
    };
    promise.then(end, end);
    kick();
  }

  // fetch() resolves on headers; large query bodies keep downloading after that.
  function untilBodyRead(res) {
    if (!res.body) return undefined;
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, BODY_TIMEOUT_MS);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      for (const name of BODY_READERS) {
        const read = res[name];
        res[name] = function () {
          const q = read.apply(this, arguments);
          q.then(done, done);
          return q;
        };
      }
    });
  }

  const origFetch = window.fetch;
  function trackedFetch(input) {
    const p = origFetch.apply(this, arguments);
    // Registered before the caller's handlers, so the body readers are wrapped in time.
    if (!destroyed && isTrackedRequest(input)) trackNet(p.then(untilBodyRead));
    return p;
  }
  window.fetch = trackedFetch;

  // ---------------------------------------------------------------- work collection

  function trackRoute(now) {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    route = { key: {}, path: lastPath, since: now, dashSince: 0 };
  }

  // null while the grid is not rendered yet; false when only rows (or nothing) are visible.
  function panelsOnScreen() {
    if (!document.querySelector('.react-grid-layout')) return null;
    for (const el of document.querySelectorAll('.react-grid-item')) {
      if (el.firstElementChild?.classList.contains('dashboard-row')) continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.bottom > 0 && r.top < innerHeight) return true;
    }
    return false;
  }

  // A route is pending until its dashboard is initialized and its first panels have started.
  // Returns the route's current phase, or null once it is done.
  function routePhase(state, now) {
    if (!route) return null;
    const m = route.path.match(DASH_PATH);
    let phase = window.grafanaRuntime ? null : 'boot';
    if (!phase && m) {
      const init = state?.dashboard?.initPhase;
      const d = currentDashboard(state);
      if (!state) {
        if (storeTries < STORE_TRIES) phase = 'boot';
      } else if (init === 'Services') {
        phase = 'variables';
      } else if (init !== 'Completed' || d?.uid !== m[1]) {
        if (init !== 'Failed') phase = 'boot';
      } else {
        route.dashSince ||= now;
        const started = d.panels.some((p) => p.queryRunner?.lastRequest);
        if (!started && panelsOnScreen() !== false && now - route.dashSince < FIRST_RUN_WAIT_MS) phase = 'panels';
      }
    }
    if (phase && now - route.since < ROUTE_TIMEOUT_MS) return phase;
    route = null;
    return null;
  }

  function collectPending(now) {
    const keys = new Set();
    const state = store?.getState();
    if (document.readyState === 'loading') keys.add(K_DOM);
    if (document.readyState !== 'complete') keys.add(K_LOAD);
    const phase = routePhase(state, now);
    if (phase) keys.add(route.key);
    for (const t of netTasks) keys.add(t);
    const variablesLoading = state ? collectVariables(state, keys) : false;
    const d = currentDashboard(state);
    if (d) {
      for (const p of panelsOf(d)) {
        const r = p.queryRunner;
        if (!r) continue;
        if (variablesLoading && p.isInView) {
          const a = anticipated.get(r);
          anticipated.set(r, { request: a ? a.request : r.lastRequest, until: now + SETTLE_MS });
        }
        if (runnerPending(r, now)) keys.add(r);
      }
    }
    return { keys, phase };
  }

  // ---------------------------------------------------------------- progress

  // Within a segment the bar never moves back: work that joins splits the space that is left.
  const segmentProgress = (b) => (b.baseCount ? b.base + ((1 - b.base) * (b.done - b.baseDone)) / b.baseCount : b.base);
  const displayed = (b) => b.floor + (b.ceil - b.floor) * Math.min(segmentProgress(b), HOLD);

  function tick() {
    if (destroyed) return;
    const now = performance.now();
    mount();
    mountWarning();
    findStore();
    trackRoute(now);
    const { keys, phase } = collectPending(now);
    if (!batch) {
      if (!keys.size) return;
      batch = {
        start: now, pending: new Set(), done: 0, base: 0, baseDone: 0, baseCount: 0,
        floor: 0, ceil: 1, segment: 'work', idleSince: 0, boot: document.readyState !== 'complete',
      };
    }
    for (const k of batch.pending) {
      if (!keys.has(k)) {
        batch.pending.delete(k);
        batch.done++;
      }
    }
    let joined = false;
    for (const k of keys) {
      if (!batch.pending.has(k)) {
        batch.pending.add(k);
        joined = true;
      }
    }
    // While a dashboard loads, the panel work is unknown until it renders, so each loading
    // phase gets a fixed share of the bar that is left.
    const segment = phase in PHASE_SHARE ? phase : 'work';
    if (segment !== batch.segment) {
      batch.floor = displayed(batch);
      batch.ceil = batch.floor + (1 - batch.floor) * (PHASE_SHARE[segment] ?? 1);
      batch.segment = segment;
      batch.base = 0;
      batch.baseDone = batch.done;
      batch.baseCount = batch.pending.size;
    } else if (joined) {
      batch.base = Math.min(segmentProgress(batch), HOLD);
      batch.baseDone = batch.done;
      batch.baseCount = batch.pending.size;
    }
    if (batch.pending.size) batch.idleSince = 0;
    else batch.idleSince ||= now;

    bar.dataset.tasks = `${batch.done}/${batch.done + batch.pending.size}`;
    if (batch.idleSince && now - batch.idleSince >= SETTLE_MS) {
      batch = null;
      finish();
      return;
    }
    if (shown || batch.boot || now - batch.start >= SHOW_DELAY_MS) show(displayed(batch));
  }

  function kick() {
    if (kickTimer || destroyed) return;
    kickTimer = setTimeout(() => {
      kickTimer = 0;
      tick();
    }, 0);
  }

  const interval = setInterval(tick, TICK_MS);
  document.addEventListener('readystatechange', kick);
  tick();

  window.__gflb = {
    destroy() {
      destroyed = true;
      clearInterval(interval);
      clearTimeout(kickTimer);
      clearTimeout(hideTimer);
      clearTimeout(resetTimer);
      document.removeEventListener('readystatechange', kick);
      if (window.fetch === trackedFetch) window.fetch = origFetch;
      bar.remove();
      warn?.remove();
      style.remove();
    },
  };
})();
