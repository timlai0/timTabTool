'use strict';

import '../shared/polyfill';
// Logik: Importieren des Such-Overlay-Inhalts für die Standalone-Suche
// Programming logic: Import search overlay content for the standalone search
import '../content/search-overlay.ts';

import { createApp } from 'vue'
import App from './App.vue'
import '../styles/global.css'

// Logik: Initialisieren der Vue-Anwendung für die linke Spalte (Flyout)
// Programming logic: Initialize the Vue application for the left column (flyout)
createApp(App).mount('#app')
