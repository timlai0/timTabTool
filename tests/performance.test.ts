import { describe, it, expect, vi, beforeAll } from 'vitest'
import { classify, classifyTabs } from '../src/background/classifier'
import { sortTabsByDomainAndTitleHelper } from '../src/background/tab-manager'

describe('Performance Benchmarks for Large Batches of Tabs', () => {
  beforeAll(() => {
    let mockStorage: Record<string, any> = {}
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn((key: string) => Promise.resolve(mockStorage)),
          set: vi.fn((obj: Record<string, any>) => {
            mockStorage = { ...mockStorage, ...obj }
            return Promise.resolve()
          }),
        },
      },
    })
  })
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

  it('benchmarks recordTabVisit batching with 2,000 tabs', async () => {
    const { recordTabVisit, getHistoryEntries, flushTabHistory } = await import('../src/background/storage')
    const start = performance.now()

    for (let i = 0; i < 2000; i++) {
      await recordTabVisit(`https://example.com/item-${i}`, `Title ${i}`)
    }
    const writeDuration = performance.now() - start
    console.log(`recordTabVisit 2,000 tabs (in-memory batched): ${writeDuration.toFixed(2)} ms`)

    const entries = await getHistoryEntries()
    expect(entries.length).toBeGreaterThan(0)

    await flushTabHistory()
  })

  it('benchmarks detectDuplicateTabs with 5,000 tabs', async () => {
    const { detectDuplicateTabs } = await import('../src/shared/utils')
    const mockTabs = Array.from({ length: 5000 }, (_, i) => ({
      id: i + 1,
      url: `https://${['github.com', 'youtube.com', 'amazon.com', 'news.ycombinator.com'][i % 4]}/item/${i % 500}?utm_source=src_${i % 10}&srsltid=tag_${i}`,
      title: `Tab Title ${i}`,
      active: i === 10,
      pinned: i === 20,
    }))

    const start = performance.now()
    const result = detectDuplicateTabs(mockTabs)
    const duration = performance.now() - start

    console.log(`detectDuplicateTabs (5,000 tabs): ${duration.toFixed(2)} ms`)
    expect(result.possibleDuplicateCount).toBeGreaterThan(0)
    expect(result.possibleDuplicates.length).toBeGreaterThan(0)
  })
})

