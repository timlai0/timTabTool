'use strict';

/**
 * Extracts the domain from a URL.
 * @param {string | undefined} url
 * @returns {string}
 */
export function extractDomain(url: string | undefined): string {
  if (!url) return ''
  const match = url.match(/^https?:\/\/(?:www\.)?([^\/]+)/i)
  return match ? match[1] : ''
}

export const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic', 'utm_name',
  'fbclid', 'gclid', 'gbraid', 'wbraid', '_gl', 'msclkid', 'mc_cid', 'mc_eid',
  'ref', 'referrer', 'source', 'feature', 'si', 'igshid', 'igsh', 'fb_action_ids', 'fb_action_types', 'fb_source', 'fb_ref', 'mibextid',
  'twclid', 'ttclid', 'yclid', 'mkt_tok', '_hsenc', '_hsmi', 'hsctatracking', '_openstat', 'gad_source',
  'spm', 'spm_id_from', 'scm', 'pvid', 'algo_pvid', 'algo_exp_id', 'btsid', 'ws_ab_test',
  'origin', 'vd_source', 'callback', '_t', 'from_source', 'from', 'is_from_webapp',
  'sender_device', 'refer', 'bd_vid', 'kwd', 'search_id', 'cmpid', 'via', 's_kwcid', 'dclid', 'zanpid',
  'srsltid', 'rdt_cid', 'share_id', 'li_fat_id', 'tt_medium', 'tt_content', 'is_copy_url',
  'pk_campaign', 'pk_kwd', 'matomo_campaign', 'matomo_keyword', 'piwik_campaign', 'piwik_kwd', 'wt_mc', 'vgo_ee',
  'aff_id', 'aff_sub', 'affiliate_id', 'click_id', 'subid', 'campaign_id',
  'session_id', 'phpsessid', 'jsessionid', 'asid', 'ab_channel', 'ref_src', 'ref_url', 'usp'
])

export const DEFAULT_DOC_REGEX = /\/(index\.(html?|php)|default\.aspx?)$/i

/**
 * Checks if a parameter key is an analytics/tracking tag or click identifier.
 * @param {string} key
 * @returns {boolean}
 */
export function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase()
  if (TRACKING_PARAMS.has(lower)) return true
  return (
    lower.startsWith('utm_') ||
    lower.startsWith('hsa_') ||
    lower.startsWith('ga_') ||
    lower.startsWith('fb_') ||
    lower.startsWith('mc_') ||
    lower.startsWith('pk_') ||
    lower.startsWith('matomo_') ||
    lower.startsWith('piwik_')
  )
}

/**
 * Checks if a query parameter on a given URL is a document subview or tracking parameter that should be normalized.
 * @param {string} key
 * @param {URL} url
 * @returns {boolean}
 */
export function isIgnoredSearchParam(key: string, url: URL): boolean {
  if (isTrackingParam(key)) return true

  const hostname = url.hostname.toLowerCase()
  const pathname = url.pathname.toLowerCase()

  // Google Docs, Sheets, Slides, Drive
  if (hostname === 'docs.google.com' || hostname.endsWith('.docs.google.com')) {
    if (pathname.includes('/spreadsheets/')) {
      if (key === 'gid') return true
    }
    if (pathname.includes('/document/')) {
      if (key === 'tab') return true
    }
    if (key === 'authuser' || key === 'usp' || key === 'ouid') return true
  }

  if (hostname === 'drive.google.com' || hostname.endsWith('.drive.google.com')) {
    if (key === 'authuser' || key === 'usp') return true
  }

  return false
}

/**
 * Checks if a hash string represents a client-side SPA route rather than a section anchor.
 * @param {string | undefined} hash
 * @returns {boolean}
 */
export function isSpaHashRoute(hash: string | undefined): boolean {
  if (!hash) return false
  return hash.startsWith('#/') || hash.startsWith('#!/')
}

/**
 * Strips default index documents from URL pathname.
 * @param {string} pathname
 * @returns {{ path: string; strippedDoc?: string }}
 */
export function stripDefaultDocumentFromPath(pathname: string): { path: string; strippedDoc?: string } {
  const match = pathname.match(DEFAULT_DOC_REGEX)
  if (match) {
    const stripped = pathname.replace(DEFAULT_DOC_REGEX, '')
    return { path: stripped === '' ? '/' : stripped, strippedDoc: match[1] }
  }
  return { path: pathname }
}

/**
 * Cleans tracking query parameters and document subviews and sorts parameters deterministically.
 * @param {URL} url
 * @returns {{ strippedParams: string[] }}
 */
export function cleanUrlSearchParams(url: URL): { strippedParams: string[] } {
  const keysToDelete: string[] = []
  url.searchParams.forEach((_, key) => {
    if (isIgnoredSearchParam(key, url)) {
      keysToDelete.push(key)
    }
  })

  let delKey = ''
  for (let i = 0; i < keysToDelete.length; i++) {
    delKey = keysToDelete[i]
    url.searchParams.delete(delKey)
  }

  url.searchParams.sort()
  return { strippedParams: keysToDelete }
}

export interface NormalizeUrlOptions {
  removeHash?: boolean
  preserveSpaHashRoutes?: boolean
  stripWww?: boolean
  normalizeProtocol?: boolean
  stripDefaultDocument?: boolean
}

/**
 * Normalizes a URL by stripping tracking parameters, protocol variants, and default documents.
 * @param {string} urlString
 * @param {NormalizeUrlOptions} [options]
 * @returns {string}
 */
export function normalizeUrl(urlString: string, options: NormalizeUrlOptions = {}): string {
  if (!urlString) return ''
  try {
    const url = new URL(urlString)

    if (options.normalizeProtocol && (url.protocol === 'http:' || url.protocol === 'https:')) {
      const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
      if (!isLocal) url.protocol = 'https:'
    }

    url.hostname = url.hostname.toLowerCase()
    if (options.stripWww && url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4)
    }

    if (options.stripDefaultDocument) {
      url.pathname = stripDefaultDocumentFromPath(url.pathname).path
    }

    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1)
    }

    cleanUrlSearchParams(url)

    if (options.removeHash !== false) {
      if (options.preserveSpaHashRoutes !== false && isSpaHashRoute(url.hash)) {
        // Preserve client-side SPA routing hash
      } else {
        url.hash = ''
      }
    }

    return url.toString()
  } catch {
    return urlString
  }
}
