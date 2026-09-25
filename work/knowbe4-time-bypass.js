// ==UserScript==
// @name         KnowBe4: policy timer bypass
// @namespace    https://github.com/evulhotdog/chrome-userscripts
// @version      1.0.2
// @description  Speeds up the clock on KnowBe4 policy pages so the minimum reading timer finishes quickly.
// @author       smart.pear3631@replicat.es
// @source       https://github.com/evulhotdog/chrome-userscripts/blob/main/work/knowbe4-time-bypass.js
// @match        https://training.knowbe4.com/app/training/policies/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/evulhotdog/chrome-userscripts/main/work/knowbe4-time-bypass.js
// @updateURL    https://raw.githubusercontent.com/evulhotdog/chrome-userscripts/main/work/knowbe4-time-bypass.js
// ==/UserScript==

/*
 * Changelog
 * 1.0.2 - Dropped the download token and the author name.
 * 1.0.1 - Added author and source.
 * 1.0.0 - Initial version. Date.prototype.getTime, Date.prototype.valueOf and Date.now run
 *         SPEED times faster from page load, which shortens the policy page timer.
 */

(function() {
    'use strict';
    const SPEED = 60;

    const _getTime = Date.prototype.getTime;
    const t0 = _getTime.call(new Date());

    // App uses new Date().getTime() and storedDate.getTime()
    // Override Date.prototype so all .getTime() calls return accelerated time
    Date.prototype.getTime = function() {
        return t0 + (_getTime.call(this) - t0) * SPEED;
    };

    // valueOf delegates to getTime but be explicit
    Date.prototype.valueOf = Date.prototype.getTime;

    // Also override Date.now in case it's used elsewhere
    const _now = Date.now;
    Date.now = function() {
        return t0 + (_now() - t0) * SPEED;
    };
})();
