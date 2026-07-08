import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('Search Overlay', () => {
  beforeEach(() => {
    global.window = {
      addEventListener: vi.fn(),
      matchMedia: vi.fn().mockReturnValue({ matches: false }),
      location: { href: 'https://example.com' },
      __ATM_SEARCH_LOADED__: false
    } as any

    global.document = {
      createElement: vi.fn((tag) => {
        return {
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
        }
      }),
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

  it('should initialize without errors', async () => {
    await import('../src/content/search-overlay')
    expect(global.window.__ATM_SEARCH_LOADED__).toBe(true)
    expect(global.window.addEventListener).toHaveBeenCalled()
  })
})
