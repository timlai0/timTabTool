import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const shadowAddEventListener = vi.fn()

describe('Search Overlay', () => {
  beforeEach(() => {
    shadowAddEventListener.mockClear()
    ;(globalThis as any).window = {
      addEventListener: vi.fn(),
      matchMedia: vi.fn().mockReturnValue({ matches: false }),
      location: { href: 'https://example.com', protocol: 'https:', pathname: '/' },
      __ATM_SEARCH_LOADED__: false
    } as any

    ;(globalThis as any).document = {
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
            addEventListener: shadowAddEventListener,
            querySelector: vi.fn(),
            querySelectorAll: vi.fn(() => []),
            elementFromPoint: vi.fn(),
          }),
          setAttribute: vi.fn(),
          removeAttribute: vi.fn(),
          hasAttribute: vi.fn(),
          replaceChildren: vi.fn(),
          append: vi.fn(),
          focus: vi.fn(),
          select: vi.fn(),
          querySelector: vi.fn(),
          querySelectorAll: vi.fn(() => []),
          classList: {
            add: vi.fn(),
            remove: vi.fn(),
            contains: vi.fn().mockReturnValue(false),
          },
        }
      }),
      documentElement: {
        appendChild: vi.fn()
      }
    } as any

    ;(globalThis as any).DOMParser = class {
      parseFromString() {
        return {
          documentElement: {},
          body: {
            childNodes: [],
            firstElementChild: {
              cloneNode: vi.fn().mockReturnValue({}),
            },
          },
        }
      }
    }

    ;(globalThis as any).chrome = {
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
    expect((globalThis as any).window.__ATM_SEARCH_LOADED__).toBe(true)
    expect((globalThis as any).window.addEventListener).toHaveBeenCalled()
  })

  it('handles concurrent background operations messages and windowId filtering', async () => {
    let messageListener: any = null
    chrome.runtime.onMessage.addListener = vi.fn((fn) => {
      messageListener = fn
    })

    await import('../src/content/search-overlay')
    expect(messageListener).toBeDefined()

    expect(() => {
      messageListener({
        action: 'ACTIVE_OPERATIONS_UPDATED',
        payload: {
          101: { type: 'group', statusText: 'Window 101 grouping' },
          102: { type: 'classify', statusText: 'Window 102 classifying' },
        },
      })
    }).not.toThrow()

    expect(() => {
      messageListener({
        action: 'START_AI_PROGRESS',
        payload: { windowId: 9999, commandAction: 'GROUP_TABS' },
      })
    }).not.toThrow()

    expect(() => {
      messageListener({
        action: 'AI_OPERATION_PROGRESS',
        payload: { windowId: 9999, status: { statusText: 'working' } },
      })
    }).not.toThrow()

    expect(() => {
      messageListener({
        action: 'AI_OPERATION_COMPLETE',
        payload: { windowId: 9999 },
      })
    }).not.toThrow()

    expect(() => {
      messageListener({
        action: 'AI_OPERATION_FAILED',
        payload: { windowId: 9999, error: 'Network failure' },
      })
    }).not.toThrow()
  })

  it('allows toggle and hide during operations without throwing', async () => {
    await import('../src/content/search-overlay')
    const toggle = (globalThis as any).window.__ATM_TOGGLE_SEARCH__
    expect(typeof toggle).toBe('function')

    expect(() => {
      toggle()
      toggle()
    }).not.toThrow()
  })

  it('stops keyboard and text events from bubbling out of the overlay to the page', async () => {
    await import('../src/content/search-overlay')
    ;(globalThis as any).window.__ATM_TOGGLE_SEARCH__()

    const types = shadowAddEventListener.mock.calls.map(call => call[0])
    for (const type of ['keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'paste']) {
      expect(types).toContain(type)
    }
    const handler = shadowAddEventListener.mock.calls.find(call => call[0] === 'keyup')![1]
    const event = { stopPropagation: vi.fn() }
    handler(event)
    expect(event.stopPropagation).toHaveBeenCalled()
  })
})

