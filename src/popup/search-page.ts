'use strict';

import '../shared/polyfill';
// Logic: Import the search overlay content for standalone search
import '../content/search-overlay.ts';

import { createApp } from 'vue'
import App from './App.vue'
import '../styles/global.css'

/**
 * Initializes the Vue application for the standalone search page.
 * Mounts the main App component to the DOM.
 */
// Logic: Initialize the Vue application for the left column (flyout)
createApp(App).mount('#app')
