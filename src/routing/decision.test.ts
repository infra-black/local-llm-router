import { describe, it, expect } from 'vitest'
import { decide } from './decision.js'
import type { HealthChecker, HealthState } from '../health/checkup.js'

// helper funcs
function stubHealthChecker(states: Record<string, HealthState>): HealthChecker {
  return { getState: (name: string) => states[name] ?? 'UNKNOWN' } as any
}

const policy = {
  backends: {
    local: { type: 'ollama', endpoint: 'http://localhost:11434' },
    cloud: { type: 'openai', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o' },
    fallback: { type: 'sarmalink', endpoint: 'http://localhost:9999/v1' },
  },
  routes: [
    {
      match: { task: 'code' },
      backend: 'local',
      fallbackChain: ['cloud', 'fallback'],
      reason: 'code task',
    },
    { default: 'cloud', fallbackChain: ['fallback'] },
  ],
}

const cls = { task: 'code', complexity: 'low', sensitivity: 'normal', modalities: ['text'] }

// tests
describe('decide', () => {
  describe('without health checker', () => {
    it('selects matching backend with full chain', () => {
      const result = decide(cls, policy as any)
      expect(result.backend).toBe('local')
      expect(result.fallbackChain).toEqual(['cloud', 'fallback'])
      expect(result.reason).toBe('code task')
    })

    it('selects default backend when no match', () => {
      const noMatch = { task: 'translation', complexity: 'low', sensitivity: 'normal', modalities: ['text'] }
      const result = decide(noMatch, policy as any)
      expect(result.backend).toBe('cloud')
      expect(result.fallbackChain).toEqual(['fallback'])
    })
  })

  describe('with health checker', () => {
    it('passes through when all backends are healthy', () => {
      const health = stubHealthChecker({
        local: 'HEALTHY', cloud: 'HEALTHY', fallback: 'HEALTHY',
      })
      const result = decide(cls, policy as any, health)
      expect(result.backend).toBe('local')
      expect(result.fallbackChain).toEqual(['cloud', 'fallback'])
      expect(result.reason).toBe('code task')
    })

    it('skips UNHEALTHY primary and promotes first healthy fallback', () => {
      const health = stubHealthChecker({
        local: 'UNHEALTHY', cloud: 'HEALTHY', fallback: 'HEALTHY',
      })
      const result = decide(cls, policy as any, health)
      expect(result.backend).toBe('cloud')
      expect(result.fallbackChain).toEqual(['fallback'])
      expect(result.reason).toContain('skipped unhealthy: local')
    })

    it('skips UNHEALTHY entries within the fallback chain', () => {
      const health = stubHealthChecker({
        local: 'HEALTHY', cloud: 'UNHEALTHY', fallback: 'HEALTHY',
      })
      const result = decide(cls, policy as any, health)
      expect(result.backend).toBe('local')
      expect(result.fallbackChain).toEqual(['fallback'])
      expect(result.reason).toContain('skipped unhealthy: cloud')
    })

    it('skips multiple UNHEALTHY backends preserving healthy order', () => {
      const health = stubHealthChecker({
        local: 'UNHEALTHY', cloud: 'UNHEALTHY', fallback: 'HEALTHY',
      })
      const result = decide(cls, policy as any, health)
      expect(result.backend).toBe('fallback')
      expect(result.fallbackChain).toEqual([])
      expect(result.reason).toContain('skipped unhealthy: local, cloud')
    })

    it('returns empty backend when all backends are UNHEALTHY', () => {
      const health = stubHealthChecker({
        local: 'UNHEALTHY', cloud: 'UNHEALTHY', fallback: 'UNHEALTHY',
      })
      const result = decide(cls, policy as any, health)
      expect(result.backend).toBe('')
      expect(result.fallbackChain).toEqual([])
      expect(result.reason).toContain('all backends unhealthy')
    })

    it('treats UNKNOWN backends as usable (not skipped)', () => {
      const health = stubHealthChecker({
        local: 'UNKNOWN', cloud: 'HEALTHY', fallback: 'HEALTHY',
      })
      const result = decide(cls, policy as any, health)
      expect(result.backend).toBe('local')
      expect(result.fallbackChain).toEqual(['cloud', 'fallback'])
      // No skipped, UNKNOWN is not UNHEALTHY
      expect(result.reason).not.toContain('skipped')
    })
  })

  describe('modality matching', () => {
    const modalityPolicy = {
      backends: {
        local: { type: 'ollama', endpoint: 'http://localhost:11434' },
        cloud: { type: 'openai', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o' },
        zai: { type: 'openai', endpoint: 'https://open.bigmodel.cn/api/paas', model: 'glm-5v' },
      },
      routes: [
        {
          match: { modalities: ['video'] },
          backend: 'zai',
          fallbackChain: [],
          reason: 'video requires cloud',
        },
        {
          match: { modalities: ['audio'] },
          backend: 'cloud',
          fallbackChain: ['zai'],
          reason: 'audio requires cloud',
        },
        {
          match: { modalities: ['image'] },
          backend: 'cloud',
          fallbackChain: ['local'],
          reason: 'image preferred cloud',
        },
        { default: 'local', fallbackChain: ['cloud'] },
      ],
    }

    it('matches a single-modality request to the correct route', () => {
      const c = {
        task: 'general',
        complexity: 'medium',
        sensitivity: 'normal',
        modalities: ['text', 'video'],
      }
      const result = decide(c, modalityPolicy as any)
      expect(result.backend).toBe('zai')
      expect(result.reason).toBe('video requires cloud')
    })

    it('matches image modality', () => {
      const c = {
        task: 'general',
        complexity: 'medium',
        sensitivity: 'normal',
        modalities: ['text', 'image'],
      }
      const result = decide(c, modalityPolicy as any)
      expect(result.backend).toBe('cloud')
      expect(result.fallbackChain).toEqual(['local'])
    })

    it('matches audio with fallback', () => {
      const c = {
        task: 'general',
        complexity: 'medium',
        sensitivity: 'normal',
        modalities: ['text', 'audio'],
      }
      const result = decide(c, modalityPolicy as any)
      expect(result.backend).toBe('cloud')
      expect(result.fallbackChain).toEqual(['zai'])
    })

    it('falls to default for text-only requests', () => {
      const c = {
        task: 'general',
        complexity: 'medium',
        sensitivity: 'normal',
        modalities: ['text'],
      }
      const result = decide(c, modalityPolicy as any)
      expect(result.backend).toBe('local')
      expect(result.fallbackChain).toEqual(['cloud'])
    })

    it('matches first applicable route when multiple modalities qualify', () => {
      const c = {
        task: 'general',
        complexity: 'medium',
        sensitivity: 'normal',
        modalities: ['text', 'video', 'audio'],
      }
      const result = decide(c, modalityPolicy as any)
      expect(result.backend).toBe('zai')
      expect(result.fallbackChain).toEqual([])
    })

    it('returns empty backend when modality route has no fallback and backend is unhealthy', () => {
      const health = stubHealthChecker({ zai: 'UNHEALTHY' })
      const c = {
        task: 'general',
        complexity: 'medium',
        sensitivity: 'normal',
        modalities: ['text', 'video'],
      }
      const result = decide(c, modalityPolicy as any, health)
      expect(result.backend).toBe('')
      expect(result.fallbackChain).toEqual([])
      expect(result.reason).toContain('all backends unhealthy')
    })

    it('carries classification in the decision', () => {
      const c = {
        task: 'code',
        complexity: 'high',
        sensitivity: 'normal',
        modalities: ['text', 'image'],
      }
      const result = decide(c, modalityPolicy as any)
      expect(result.classification).toEqual(c)
    })

    it('does not match modality route when request lacks that modality', () => {
      const c = {
        task: 'general',
        complexity: 'medium',
        sensitivity: 'normal',
        modalities: ['text'],
      }
      const result = decide(c, modalityPolicy as any)
      expect(result.backend).toBe('local')
    })
  })

})
