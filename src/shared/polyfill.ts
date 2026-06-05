'use strict';

// Logik: Polyfill für Firefox, um chrome-APIs über das Promise-basierte browser-Objekt zu leiten
// Programming logic: Firefox polyfill to route chrome API calls through the Promise-based browser object
if (typeof browser !== 'undefined' && typeof chrome !== 'undefined') {
  ;(globalThis as any).chrome = browser
}
