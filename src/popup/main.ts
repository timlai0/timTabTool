// Synchronous theme init to prevent flash of wrong theme
;(function () {
  try {
    const raw = localStorage.getItem('atm_theme')
    const theme = raw || 'system'
    const isDark =
      theme === 'dark' ||
      (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    if (isDark) document.documentElement.classList.add('dark')
  } catch (e) {}
})()

import { createApp } from 'vue'
import App from './App.vue'
import '../styles/global.css'

createApp(App).mount('#app')
