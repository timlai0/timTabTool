'use strict';

import '../shared/polyfill';
// Logic: Import the search overlay content for standalone search
// Programming logic: Import search overlay content for the standalone search
import '../content/search-overlay.ts';

import { createApp } from 'vue'
import App from './App.vue'
import '../styles/global.css'

// Logic: Initialize the Vue application for the left column (flyout)
// Programming logic: Initialize the Vue application for the left column (flyout)
createApp(App).mount('#app')
