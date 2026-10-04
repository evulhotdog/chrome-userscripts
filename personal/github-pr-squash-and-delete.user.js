// ==UserScript==
// @name         GitHub PR: squash merge + delete branch
// @namespace    https://github.com/evulhotdog/chrome-userscripts
// @version      1.1.1
// @description  Adds a button left of Ready to merge in the PR header: squash merge, confirm the dialog, delete the branch.
// @match        https://github.com/*/*/pull/*
// @run-at       document-idle
// @grant        none
// @source       https://github.com/evulhotdog/chrome-userscripts/blob/main/personal/github-pr-squash-and-delete.user.js
// @downloadURL  https://raw.githubusercontent.com/evulhotdog/chrome-userscripts/main/personal/github-pr-squash-and-delete.user.js
// @updateURL    https://raw.githubusercontent.com/evulhotdog/chrome-userscripts/main/personal/github-pr-squash-and-delete.user.js
// ==/UserScript==

/*
 * Changelog
 * 1.1.1 - Fixed the anchor: match the merge-status chip by class (its text contains a hidden "View status" label).
 * 1.1.0 - Anchored the button left of Ready to merge in the PR header (floating pill covered the header icons).
 * 1.0.0 - Initial version.
 */

(function () {
  'use strict';

  const ID = 'gh-squash-delete-helper';
  let running = false;

  // GitHub's React merge controls ignore plain .click() from userscripts —
  // a full pointer + mouse sequence at the button's centre is required.
  function press(el) {
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
    };
    for (const type of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ev = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ev(type, opts));
    }
  }

  function findButton(text) {
    return [...document.querySelectorAll('button, a')].find(
      el => el.textContent.trim() === text && el.offsetParent !== null
    );
  }

  // GitHub re-renders asynchronously between steps; poll rather than sleep.
  function waitForButton(text, timeoutMs) {
    return new Promise(resolve => {
      const started = Date.now();
      const timer = setInterval(() => {
        const el = findButton(text);
        if (el) {
          clearInterval(timer);
          resolve(el);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, 300);
    });
  }

  async function run() {
    const squash = findButton('Squash and merge');
    if (!squash) return;
    press(squash);

    const confirm = await waitForButton('Confirm squash and merge', 10000);
    if (!confirm) throw new Error('confirm dialog never opened');
    press(confirm);

    // Absent button usually means auto-delete already removed the head branch.
    const del = await waitForButton('Delete branch', 20000);
    if (del) press(del);
  }

  setInterval(() => {
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(location.href)) return;
    if (running || document.getElementById(ID)) return;
    const squash = findButton('Squash and merge');
    if (!squash) return; // merged, closed, or draft
    // The chip's text is "View statusReady to merge" (hidden label included),
    // so anchor by its module class instead of text.
    const chip = document.querySelector('button[class*="MergeStatusButton-module__mergeStatusButton"]');
    if (!chip) return;

    // Sits left of the chip, styled like it. GitHub's React rerenders wipe
    // injected nodes; the interval re-adds them.
    const chipWrap = chip.parentElement;
    const slot = chipWrap.children.length === 1 ? chipWrap.parentElement : chipWrap;
    const before = chipWrap.children.length === 1 ? chipWrap : chip;
    const item = document.createElement('div');
    item.id = ID;
    item.className = chipWrap === slot ? '' : chipWrap.className;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = chip.className.replace(/\bflex-1\b/g, '').trim();
    for (const { name, value } of chip.attributes) {
      if (name !== 'class' && name !== 'aria-disabled' && name !== 'id') btn.setAttribute(name, value);
    }
    btn.textContent = 'Squash + delete';
    btn.addEventListener('click', async () => {
      if (running) return;
      running = true;
      try {
        await run();
      } finally {
        running = false;
        if (btn.isConnected) btn.textContent = 'Squash + delete';
      }
    });
    item.appendChild(btn);
    slot.insertBefore(item, before);
  }, 1000);
})();