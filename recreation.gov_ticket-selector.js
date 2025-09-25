// ==UserScript==
// @name         Automatic Date and Ticket Selector
// @version      1.7
// @description  Automatically clicks a calendar icon, selects a date, and sets the ticket count to 2.
// @author       Brian Davis
// @match        https://www.recreation.gov/timed-entry/10112683/ticket/10112684
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- CONFIGURATION ---
    // Set these to true or false to enable or disable parts of the script.
    const ENABLE_DATE_PICKER = true;
    const ENABLE_QUANTITY_PICKER = true;
    // ---------------------

    /**
     * Generates a random delay to make actions seem more human.
     * @param {number} base - The base delay in milliseconds.
     * @param {number} range - The random range to add to the base (e.g., 100 means 0-100ms).
     * @returns {number} The total randomized delay.
     */
    function randomDelay(base, range) {
        return base + Math.floor(Math.random() * (range + 1));
    }

    /**
     * This function finds and clicks the calendar icon.
     */
    function clickCalendarIcon() {
        const calendarIcon = document.querySelector('svg.rec-icon-calendar');
        if (!calendarIcon) {
            console.error('Error: Could not find the calendar icon button.');
            return;
        }

        console.log('Calendar icon found. Clicking it...');
        calendarIcon.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        selectDateCell();
    }

    /**
     * This function finds and clicks the specific date cell.
     */
    function selectDateCell() {
        setTimeout(() => {
            // Find the date cell by looking for an aria-label that STARTS with the new date.
            const dateCell = document.querySelector('div[aria-label^="Thursday, August 21, 2025"]');
            if (!dateCell) {
                console.error('Error: Could not find the date cell for August 21.');
                return;
            }

            console.log('Date cell for August 21 found. Clicking it...');
            dateCell.click();
            console.log('Successfully clicked on August 21, 2025.');

            if (ENABLE_QUANTITY_PICKER) {
                setTicketCount();
            }
        }, randomDelay(100, 50)); // Wait for calendar to open (100-150ms).
    }

    /**
     * This function opens the ticket counter and increases the count to 2.
     */
    function setTicketCount() {
        setTimeout(() => {
            const ticketDropdown = document.querySelector('button#guest-counter');
            if (!ticketDropdown) {
                console.error('Error: Could not find the ticket dropdown.');
                return;
            }

            console.log('Ticket dropdown found. Clicking it...');
            ticketDropdown.click();

            setTimeout(() => {
                const addButton = document.querySelector('button[aria-label="Add General Admissions"]');
                if (!addButton) {
                    console.error('Error: Could not find the "Add General Admissions" button.');
                    return;
                }

                console.log('Add button found. Clicking it to set tickets to 2...');
                addButton.click();

                setTimeout(() => {
                    const closeButton = document.querySelector('.sarsa-dropdown-base-popup-actions button');
                     if (closeButton && closeButton.innerText.trim() === 'Close') {
                        console.log('Closing the ticket dropdown.');
                        closeButton.click();
                    }
                }, randomDelay(50, 50)); // Wait before closing (50-100ms).

            }, randomDelay(100, 75)); // Wait for the popup to appear (100-175ms).

        }, randomDelay(200, 100)); // Wait before interacting with ticket counter (200-300ms).
    }


    // --- Main Execution ---
    // Use a setInterval to wait for the page to be ready.
    const checkInterval = setInterval(() => {
        // We check for the calendar icon as a sign that the page is loaded enough to begin.
        const readyElement = document.querySelector('svg.rec-icon-calendar');

        if (readyElement) {
            clearInterval(checkInterval);

            // Decide which action to take based on the configuration variables.
            if (ENABLE_DATE_PICKER) {
                clickCalendarIcon(); // This will also trigger the ticket count if enabled.
            } else if (ENABLE_QUANTITY_PICKER) {
                setTicketCount(); // Run only the ticket selection part.
            }
        }
    }, 100); // Check for the element every 100 milliseconds.
})();
