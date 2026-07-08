import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp } from 'vue'

vi.mock('vue', () => ({
  createApp: vi.fn(() => ({
    mount: vi.fn()
  }))
}))

vi.mock('../src/popup/App.vue', () => ({ default: {} }))
vi.mock('../src/styles/global.css', () => ({}))

describe('Search Page', () => {
  beforeEach(() => {
    global.window = {
      addEventListener: vi.fn(),
      matchMedia: vi.fn().mockReturnValue({ matches: false }),
      location: { href: 'chrome-extension://id/search.html' },
      __ATM_SEARCH_LOADED__: false
    } as any

    global.document = {
      createElement: vi.fn((tag) => ({
        id: '',
        className: '',
        style: {},
        innerHTML: '',
        textContent: '',
        appendChild: vi.fn(),
        addEventListener: vi.fn(),
        attachShadow: vi.fn().mockReturnValue({
          appendChild: vi.fn(),
          querySelector: vi.fn(),
          elementFromPoint: vi.fn()
        }),
        setAttribute: vi.fn(),
        removeAttribute: vi.fn(),
        hasAttribute: vi.fn(),
      })),
      documentElement: {
        appendChild: vi.fn()
      }
    } as any

    global.chrome = {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({}),
        onMessage: {
          addListener: vi.fn()
        }
      }
    } as any
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('should create and mount Vue app on #app', async () => {
    await import('../src/popup/search-page')
    expect(createApp).toHaveBeenCalled()
  })
})
