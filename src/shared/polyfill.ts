'use strict';

// Logic: Polyfill for Firefox to route chrome APIs via the promise-based browser object
// Programming logic: Firefox polyfill to route chrome API calls through the Promise-based browser object
if (typeof (globalThis as any).browser !== 'undefined' && typeof chrome !== 'undefined') {
  ;(globalThis as any).chrome = (globalThis as any).browser
}
