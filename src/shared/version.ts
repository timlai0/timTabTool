export const APP_VERSION = '1.1.26'
export const BUILD_NUMBER = '99'
export const BUILD_HASH = typeof __BUILD_HASH__ !== 'undefined' ? __BUILD_HASH__ : 'dev'
export const BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : ''

export const BUILD_STRING = `v${APP_VERSION} (Build ${BUILD_NUMBER}${BUILD_HASH && BUILD_HASH !== 'dev' ? ` · ${BUILD_HASH}` : ''})`
