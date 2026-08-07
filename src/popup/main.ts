import '../shared/polyfill'

/**
 * Synchronous theme init to prevent flash of wrong theme
 * @function
 */
// Logic: Initialize theme before Vue app mounts to avoid flashing
;(function () {
  try {
    const raw = localStorage.getItem('atm_theme')
    const theme = raw || 'system'
    const isDark =
      theme === 'dark' ||
      (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    // Logic: Apply dark class if dark theme is matched
    if (isDark) document.documentElement.classList.add('dark')
  } catch (e) {}
})()

import { createApp } from 'vue'
import App from './App.vue'
import '../styles/global.css'

/**
 * Creates and mounts the main Vue application instance.
 */
// Logic: Mount Vue app
createApp(App).mount('#app')
