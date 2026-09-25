// ==UserScript==
// @name         Fastmail: customizations
// @namespace    https://github.com/evulhotdog/chrome-userscripts
// @version      0.6.2
// @description  Clicking "Mark unread" on an email also returns you to the Inbox. Pressing 'g' (when not typing in a field) archives the current email instead of triggering Fastmail's default shortcut.
// @author       smart.pear3631@replicat.es
// @source       https://github.com/evulhotdog/chrome-userscripts/blob/main/personal/fastmail-customizations.js
// @match        https://betaapp.fastmail.com/mail/*
// @match        https://app.beta.fastmail.com/mail/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/evulhotdog/chrome-userscripts/main/personal/fastmail-customizations.js
// @updateURL    https://raw.githubusercontent.com/evulhotdog/chrome-userscripts/main/personal/fastmail-customizations.js
// ==/UserScript==

/*
 * Changelog
 * 0.6.2 - Dropped the download token and the author name.
 * 0.6.1 - Added author and source.
 * 0.6.0 - Clicking "Mark unread" returns to the Inbox. Pressing g outside a text field
 *         archives the open email instead of Fastmail's default shortcut.
 */

(function() {
    'use strict';

    console.log('Fastmail Customizations Script Loaded - v0.6.2');

    // --- Click listener for "Mark unread" button ---
    document.addEventListener('click', function(event) {
        const button = event.target.closest('button');
        if (button && button.textContent.trim() === 'Mark unread') {
            console.log('Mark unread button clicked.');
            const inboxLink = document.querySelector('.v-MailboxSource--inbox a');
            if (inboxLink) {
                console.log('Inbox link found. Navigating...');
                setTimeout(() => {
                    inboxLink.click();
                }, 250);
            } else {
                console.log('Could not find the Inbox link.');
            }
        }
    }, true);

    // --- Keydown listener for 'g' to archive ---
    document.addEventListener('keydown', function(event) {
        // Determine if the user is currently focused on an input field.
        const activeElement = document.activeElement;
        const isTyping = activeElement.tagName === 'INPUT' ||
                         activeElement.tagName === 'TEXTAREA' ||
                         activeElement.isContentEditable;

        // Proceed only if 'g' is pressed and the user is not typing.
        if (event.key === 'g' && !isTyping) {
            console.log("'g' key pressed. Attempting to archive.");

            // Prevent Fastmail's default action for this key to avoid conflicts.
            event.preventDefault();
            event.stopPropagation();

            // Find the archive button using its specific class name.
            const archiveButton = document.querySelector('.s-archive');

            if (archiveButton) {
                console.log('Archive button found. Clicking it.');
                archiveButton.click();
            } else {
                console.log('Could not find the Archive button.');
            }
        }
    }, true); // Use capture phase to catch the event early.

})();

