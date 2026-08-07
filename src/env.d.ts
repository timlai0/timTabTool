/// <reference types="vite/client" />

/**
 * @module
 * Vue component declaration for TypeScript.
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  /**
   * The Vue component instance type.
   */
  const component: DefineComponent<object, object, unknown>
  export default component
}

/** The application version. */
declare const __APP_VERSION__: string
/** The build number. */
declare const __BUILD_NUMBER__: string
/** The build commit hash. */
declare const __BUILD_HASH__: string
/** The build time string. */
declare const __BUILD_TIME__: string
