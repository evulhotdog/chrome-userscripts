// ==UserScript==
// @name         AWS: device confirm auto-click
// @namespace    https://github.com/evulhotdog/chrome-userscripts
// @version      1.2.0
// @description  Auto-clicks the "Confirm and continue" and "Allow" buttons on any AWS access portal device page.
// @author       smart.pear3631@replicat.es
// @source       https://github.com/evulhotdog/chrome-userscripts/blob/main/work/aws-device-confirm.user.js
// @match        https://*.awsapps.com/start/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/evulhotdog/chrome-userscripts/main/work/aws-device-confirm.user.js
// @updateURL    https://raw.githubusercontent.com/evulhotdog/chrome-userscripts/main/work/aws-device-confirm.user.js
// ==/UserScript==

/*
 * Changelog
 * 1.2.0 - Matches any AWS access portal instead of one Identity Center host.
 * 1.1.2 - Dropped the download token and the author name.
 * 1.1.1 - Added author and source.
 * 1.1.0 - Clicks "Confirm and continue", then "Allow", on the AWS access portal device page.
 *         Stops once both are clicked, or after 60 seconds.
 */

(function () {
  'use strict';

  const confirmSelector = '#cli_verification_btn';

  function findAllowButton() {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent && btn.textContent.trim() === 'Allow') {
        return btn;
      }
    }
    return null;
  }

  let clickedConfirm = false;
  let clickedAllow = false;

  function tryClick() {
    if (!clickedConfirm) {
      const confirmBtn = document.querySelector(confirmSelector);
      if (confirmBtn && !confirmBtn.disabled) {
        confirmBtn.click();
        clickedConfirm = true;
      }
    }

    if (!clickedAllow) {
      const allowBtn = findAllowButton();
      if (allowBtn && !allowBtn.disabled) {
        allowBtn.click();
        clickedAllow = true;
      }
    }

    return clickedConfirm && clickedAllow;
  }

  if (tryClick()) return;

  const observer = new MutationObserver(() => {
    if (tryClick()) {
      observer.disconnect();
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Safety: stop observing after 60s
  setTimeout(() => observer.disconnect(), 60000);
})();
