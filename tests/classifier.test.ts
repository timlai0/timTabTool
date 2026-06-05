import { describe, it, expect } from 'vitest'
import { classify } from '../src/background/classifier'

describe('classify', () => {
  describe('domain matching', () => {
    it('classifies github.com as dev', () => {
      const result = classify('https://github.com/user/repo', 'My Repository')
      expect(result.category).toBe('dev')
      expect(result.confidence).toBe(0.95)
      expect(result.method).toBe('domain')
    })

    it('classifies youtube.com as media', () => {
      const result = classify('https://www.youtube.com/watch?v=123', 'Funny Video')
      expect(result.category).toBe('media')
      expect(result.confidence).toBe(0.95)
      expect(result.method).toBe('domain')
    })

    it('classifies taobao.com as shop', () => {
      const result = classify('https://www.taobao.com/item/123', '商品详情')
      expect(result.category).toBe('shop')
      expect(result.confidence).toBe(0.95)
      expect(result.method).toBe('domain')
    })

    it('classifies subdomain via parent domain match', () => {
      const result = classify('https://gist.github.com/user/abc', 'Gist File')
      expect(result.category).toBe('dev')
      expect(result.confidence).toBe(0.85)
      expect(result.method).toBe('domain')
    })

    it('classifies mail.google.com as work', () => {
      const result = classify('https://mail.google.com/mail/u/0/', 'Gmail')
      expect(result.category).toBe('work')
      expect(result.confidence).toBe(0.95)
      expect(result.method).toBe('domain')
    })
  })

  describe('keyword matching', () => {
    it('classifies by title when domain is unknown', () => {
      const result = classify('https://example.com/page', 'How to fix pull request conflicts')
      expect(result.category).toBe('dev')
      expect(result.confidence).toBe(0.7)
      expect(result.method).toBe('keyword')
    })

    it('classifies Chinese shopping keywords', () => {
      const result = classify('https://unknown.com/', '我的购物车 - 3件商品')
      expect(result.category).toBe('shop')
      expect(result.method).toBe('keyword')
    })

    it('classifies learning content', () => {
      const result = classify('https://unknown-site.com/page', 'Python Course - Beginner Level')
      expect(result.category).toBe('learn')
      expect(result.method).toBe('keyword')
    })
  })

  describe('default fallback', () => {
    it('returns "other" for unrecognized tabs', () => {
      const result = classify('https://example.com/', 'Example Page')
      expect(result.category).toBe('other')
      expect(result.confidence).toBe(0.3)
      expect(result.method).toBe('default')
    })

    it('handles empty inputs', () => {
      const result = classify(undefined, undefined)
      expect(result.category).toBe('other')
      expect(result.method).toBe('default')
    })
  })

  describe('priority', () => {
    it('domain match takes priority over keyword match', () => {
      // youtube.com should be 'media' even if title contains 'course'
      const result = classify('https://youtube.com/watch', 'Python Course Tutorial')
      expect(result.category).toBe('media')
      expect(result.method).toBe('domain')
    })
  })

  describe('groupTabsFreelyWithAI', () => {
    it('shuffles tabs before sending to AIClient when sendRandomOrder is true', async () => {
      // We will mock AIClient.prototype.groupTabsFreely to check the order of tabs passed
      const { AIClient } = await import('../src/shared/ai-client')
      const mockGroupTabsFreely = vi.spyOn(AIClient.prototype, 'groupTabsFreely')
        .mockResolvedValue([
          { name: 'Group 1', color: 'blue', tabIndices: [1, 2] }
        ])

      const { groupTabsFreelyWithAI } = await import('../src/background/classifier')

      const tabs = [
        { id: 1, url: 'https://google.com', title: 'Google' },
        { id: 2, url: 'https://github.com', title: 'GitHub' },
        { id: 3, url: 'https://youtube.com', title: 'YouTube' },
        { id: 4, url: 'https://netflix.com', title: 'Netflix' },
        { id: 5, url: 'https://amazon.com', title: 'Amazon' },
      ]

      // Mock Math.random to return a deterministic shuffle order
      // For this test, we want to ensure it actually shuffles differently from the original
      let randIndex = 0
      const randValues = [0.1, 0.9, 0.4, 0.2, 0.8]
      const spyMathRandom = vi.spyOn(Math, 'random').mockImplementation(() => {
        const val = randValues[randIndex]
        randIndex = (randIndex + 1) % randValues.length
        return val
      })

      const aiConfig = {
        enabled: true,
        provider: 'openai' as const,
        apiKey: 'test-key',
        sendRandomOrder: true,
      }

      await groupTabsFreelyWithAI(tabs, aiConfig)

      expect(mockGroupTabsFreely).toHaveBeenCalled()
      const passedTabs = mockGroupTabsFreely.mock.calls[0][0]
      
      // The length must be the same
      expect(passedTabs.length).toBe(5)
      
      // Verify that at least some tabs are in a different order due to shuffling
      const originalUrls = tabs.map(t => t.url)
      const passedUrls = passedTabs.map(t => t.url)
      expect(passedUrls).not.toEqual(originalUrls)

      spyMathRandom.mockRestore()
      mockGroupTabsFreely.mockRestore()
    })

    it('keeps tab order intact when sendRandomOrder is false', async () => {
      const { AIClient } = await import('../src/shared/ai-client')
      const mockGroupTabsFreely = vi.spyOn(AIClient.prototype, 'groupTabsFreely')
        .mockResolvedValue([
          { name: 'Group 1', color: 'blue', tabIndices: [1, 2] }
        ])

      const { groupTabsFreelyWithAI } = await import('../src/background/classifier')

      const tabs = [
        { id: 1, url: 'https://google.com', title: 'Google' },
        { id: 2, url: 'https://github.com', title: 'GitHub' },
        { id: 3, url: 'https://youtube.com', title: 'YouTube' },
      ]

      const aiConfig = {
        enabled: true,
        provider: 'openai' as const,
        apiKey: 'test-key',
        sendRandomOrder: false,
      }

      await groupTabsFreelyWithAI(tabs, aiConfig)

      expect(mockGroupTabsFreely).toHaveBeenCalled()
      const passedTabs = mockGroupTabsFreely.mock.calls[0][0]
      const originalUrls = tabs.map(t => t.url)
      const passedUrls = passedTabs.map(t => t.url)
      expect(passedUrls).toEqual(originalUrls)

      mockGroupTabsFreely.mockRestore()
    })
  })
})
