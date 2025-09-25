// ==UserScript==
// @name         Fastmail Customizations
// @namespace    http://tampermonkey.net/
// @version      0.6
// @description  Marks email as unread and returns to inbox. Overrides 'g' to archive email.
// @author       Brian Davis
// @match        https://betaapp.fastmail.com/mail/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    console.log('Fastmail Customizations Script Loaded - v0.6');

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

