/**
 * @constant {string} APP_VERSION - The current application version.
 */
export const APP_VERSION = '1.1.31'

/**
 * @constant {string} BUILD_NUMBER - The current build number.
 */
export const BUILD_NUMBER = '144'

/**
 * @constant {string} BUILD_HASH - The git commit hash of the build.
 */
export const BUILD_HASH = typeof __BUILD_HASH__ !== 'undefined' ? __BUILD_HASH__ : 'dev'

/**
 * @constant {string} BUILD_TIME - The timestamp of the build.
 */
export const BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : ''

/**
 * @constant {string} BUILD_STRING - Formatted build string including version, number, and hash.
 */
export const BUILD_STRING = `v${APP_VERSION} (Build ${BUILD_NUMBER}${BUILD_HASH && BUILD_HASH !== 'dev' ? ` · ${BUILD_HASH}` : ''})`
