/**
 * Retrieves the localized message for a given key.
 * @param {string} key - The i18n key to lookup.
 * @returns {string} The localized string or the key itself if not found.
 */
export function getMessage(key: string): string {
  // Logic: Lookup localized string from Chrome's i18n API, fallback to key
  return chrome.i18n.getMessage(key) || key
}

/**
 * @deprecated ABANDONED: Unused function to get UI language.
 * @returns {string} The current UI language code.
 */
function getUILanguage(): string {
  // Logic: Return the browser's UI language code
  return chrome.i18n.getUILanguage()
}
