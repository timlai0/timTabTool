import { describe, it, expect } from 'vitest'
import { classify, classifyTabs } from '../src/background/classifier'
import { sortTabsByDomainAndTitleHelper } from '../src/background/tab-manager'

describe('Performance Benchmarks for Large Batches of Tabs', () => {
  it('benchmarks classifyTabs with 5,000 tabs', () => {
    const mockTabs = Array.from({ length: 5000 }, (_, i) => ({
      id: i + 1,
      url: `https://${['github.com', 'youtube.com', 'amazon.com', 'mail.google.com', 'news.ycombinator.com', 'unknown-site-123.org'][i % 6]}/path/${i}`,
      title: `Tab Title ${i} - ${['Fix PR issue', 'Watch tutorial video', 'Buy product item', 'Inbox message', 'Discussion thread', 'Random content'][i % 6]}`,
    }))

    const start = performance.now()
    const groups = classifyTabs(mockTabs)
    const duration = performance.now() - start

    console.log(`classifyTabs (5,000 tabs): ${duration.toFixed(2)} ms`)
    expect(groups.size).toBeGreaterThan(0)
  })

  it('benchmarks sortTabsByDomainAndTitleHelper with 5,000 tabs', () => {
    const mockTabs = Array.from({ length: 5000 }, (_, i) => ({
      id: i + 1,
      url: `https://${['github.com', 'youtube.com', 'amazon.com', 'mail.google.com', 'news.ycombinator.com', 'unknown-site-123.org'][i % 6]}/path/${i}`,
      title: `Tab Title ${5000 - i} - ${['Fix PR issue', 'Watch tutorial video', 'Buy product item', 'Inbox message', 'Discussion thread', 'Random content'][i % 6]}`,
    }))

    const start = performance.now()
    const sorted = sortTabsByDomainAndTitleHelper(mockTabs as any)
    const duration = performance.now() - start

    console.log(`sortTabsByDomainAndTitleHelper (5,000 tabs): ${duration.toFixed(2)} ms`)
    expect(sorted.length).toBe(5000)
  })
})
