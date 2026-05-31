import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HealthChecker } from './checkup.js'
import type { HealthState } from './checkup.js'

describe('HealthChecker', () => {
  let checker: HealthChecker
  let mockFetch: ReturnType<typeof vi.fn>

  const policy = {
    backends: {
      local: {
        type: 'ollama',
        endpoint: 'http://localhost:11434',
        health_check: {
          path: '/v1/models',
          interval_seconds: 30,
          timeout_seconds: 5,
          unhealthy_threshold: 2,
          healthy_threshold: 1,
        },
      },
      cloud: {
        type: 'openai',
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        health_check: {
          path: '/v1/models',
          interval_seconds: 60,
          timeout_seconds: 10,
          unhealthy_threshold: 3,
          healthy_threshold: 2,
        },
      },
      bare: {
        type: 'sarmalink',
        endpoint: 'http://localhost:9999/v1',
        // no health_check — always HEALTHY
      },
    },
    routes: [],
  }

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)
    checker = new HealthChecker(policy as any)
  })

  afterEach(() => {
    checker.stop()
    vi.restoreAllMocks()
  })

  // Initialization
  describe('initialization', () => {
    it('starts backends with health_check as UNKNOWN', () => {
      expect(checker.getState('local')).toBe('UNKNOWN')
      expect(checker.getState('cloud')).toBe('UNKNOWN')
    })

    it('returns HEALTHY for backends without health_check config', () => {
      expect(checker.getState('bare')).toBe('HEALTHY')
    })

    it('returns UNKNOWN for non-existent backends', () => {
      expect(checker.getState('nope')).toBe('UNKNOWN')
    })
  })

  // Startup probe
  describe('startup probe via start()', () => {
    it('transitions UNKNOWN -> HEALTHY on successful probe', async () => {
      await checker.start()
      expect(checker.getState('local')).toBe('HEALTHY')
      expect(checker.getState('cloud')).toBe('HEALTHY')
    })

    it('stays UNKNOWN on first failure when below threshold', async () => {
      mockFetch.mockResolvedValue(new Response(null, { status: 500 }))
      await checker.start()
      // local: 1 failure (threshold 2), cloud: 1 failure (threshold 3)
      expect(checker.getState('local')).toBe('UNKNOWN')
      expect(checker.getState('cloud')).toBe('UNKNOWN')
    })

    it('transitions UNKNOWN -> UNHEALTHY after enough consecutive failures', async () => {
      mockFetch.mockResolvedValue(new Response(null, { status: 500 }))
      await checker.start() // 1st failure each
      await (checker as any).probe('local') // 2nd — threshold met
      await (checker as any).probe('cloud') // 2nd — not yet
      expect(checker.getState('local')).toBe('UNHEALTHY')
      expect(checker.getState('cloud')).toBe('UNKNOWN')
      await (checker as any).probe('cloud') // 3rd — threshold met
      expect(checker.getState('cloud')).toBe('UNHEALTHY')
    })
  })

  // State transitions
  describe('HEALTHY -> UNHEALTHY', () => {
    it('transitions after unhealthy_threshold consecutive failures', async () => {
      await checker.start() // HEALTHY
      mockFetch.mockResolvedValue(new Response(null, { status: 500 }))
      await (checker as any).probe('local') // 1st failure
      expect(checker.getState('local')).toBe('HEALTHY')
      await (checker as any).probe('local') // 2nd — threshold met
      expect(checker.getState('local')).toBe('UNHEALTHY')
    })
  })

  describe('UNHEALTHY -> HEALTHY', () => {
    it('transitions after healthy_threshold consecutive successes', async () => {
      // Make 'local' UNHEALTHY first (threshold 2)
      mockFetch.mockResolvedValue(new Response(null, { status: 500 }))
      await checker.start()
      await (checker as any).probe('local') // 2nd failure -> UNHEALTHY
      expect(checker.getState('local')).toBe('UNHEALTHY')
      // Recover — healthy_threshold is 1
      mockFetch.mockResolvedValue(new Response(null, { status: 200 }))
      await (checker as any).probe('local')
      expect(checker.getState('local')).toBe('HEALTHY')
    })

    it('requires multiple successes for higher healthy_threshold', async () => {
      // 'cloud' has healthy_threshold: 2
      mockFetch.mockResolvedValue(new Response(null, { status: 500 }))
      await checker.start()
      await (checker as any).probe('cloud')
      await (checker as any).probe('cloud') // 3rd failure -> UNHEALTHY
      expect(checker.getState('cloud')).toBe('UNHEALTHY')
      // 1st success, not enough
      mockFetch.mockResolvedValue(new Response(null, { status: 200 }))
      await (checker as any).probe('cloud')
      expect(checker.getState('cloud')).toBe('UNHEALTHY')
      // 2nd success, threshold met
      await (checker as any).probe('cloud')
      expect(checker.getState('cloud')).toBe('HEALTHY')
    })
  })

  describe('counter resets', () => {
    it('resets failure counter on success', async () => {
      mockFetch.mockResolvedValue(new Response(null, { status: 200 }))
      await checker.start() // HEALTHY
      // 1 failure, not enough
      mockFetch.mockResolvedValue(new Response(null, { status: 500 }))
      await (checker as any).probe('local')
      expect(checker.getState('local')).toBe('HEALTHY')
      // Success resets failure counter
      mockFetch.mockResolvedValue(new Response(null, { status: 200 }))
      await (checker as any).probe('local')
      // Now 2 more failures needed from scratch
      mockFetch.mockResolvedValue(new Response(null, { status: 500 }))
      await (checker as any).probe('local') // 1st
      expect(checker.getState('local')).toBe('HEALTHY')
      await (checker as any).probe('local') // 2nd -> UNHEALTHY
      expect(checker.getState('local')).toBe('UNHEALTHY')
    })

    it('resets success counter on failure', async () => {
      // Make 'cloud' UNHEALTHY (healthy_threshold: 2)
      mockFetch.mockResolvedValue(new Response(null, { status: 500 }))
      await checker.start()
      await (checker as any).probe('cloud')
      await (checker as any).probe('cloud')
      expect(checker.getState('cloud')).toBe('UNHEALTHY')
      // 1 success, not enough
      mockFetch.mockResolvedValue(new Response(null, { status: 200 }))
      await (checker as any).probe('cloud')
      expect(checker.getState('cloud')).toBe('UNHEALTHY')
      // Failure resets success counter
      mockFetch.mockResolvedValue(new Response(null, { status: 500 }))
      await (checker as any).probe('cloud')
      // Need 2 consecutive successes again
      mockFetch.mockResolvedValue(new Response(null, { status: 200 }))
      await (checker as any).probe('cloud') // 1st
      expect(checker.getState('cloud')).toBe('UNHEALTHY')
      await (checker as any).probe('cloud') // 2nd -> HEALTHY
      expect(checker.getState('cloud')).toBe('HEALTHY')
    })
  })

  // Transition callbacks
  describe('transition callbacks', () => {
    it('logs warning on state change', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await checker.start()
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[lllm-rt] Health state of backend 'local' transitioned: UNKNOWN -> HEALTHY"),
      )
      warnSpy.mockRestore()
    })

    it('fires onTransition callback on state change', async () => {
      const callback = vi.fn()
      checker.onTransition(callback)
      await checker.start()
      expect(callback).toHaveBeenCalledWith('local', 'UNKNOWN', 'HEALTHY')
      expect(callback).toHaveBeenCalledWith('cloud', 'UNKNOWN', 'HEALTHY')
    })

    it('does not fire callback when state does not change', async () => {
      const callback = vi.fn()
      await checker.start() // transitions fire
      callback.mockClear()
      // Another successful probe - no transition
      await (checker as any).probe('local')
      expect(callback).not.toHaveBeenCalled()
    })
  })

  // Network handling
  describe('network handling', () => {
    it('treats non-2xx responses as failure', async () => {
      mockFetch.mockResolvedValue(new Response(null, { status: 403 }))
      await checker.start()
      expect(checker.getState('local')).toBe('UNKNOWN') // 1 failure < threshold 2
    })

    it('treats network errors as failure', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))
      await checker.start()
      expect(checker.getState('local')).toBe('UNKNOWN') // 1 failure < threshold 2
    })

    it('treats aborted requests (timeout) as failure', async () => {
      mockFetch.mockRejectedValue(new DOMException('Aborted', 'AbortError'))
      await checker.start()
      expect(checker.getState('local')).toBe('UNKNOWN')
    })
  })

  // Periodic probes
  describe('periodic probes', () => {
    it('triggers probes at configured interval', async () => {
      vi.useFakeTimers()
      try {
        const periodicChecker = new HealthChecker(policy as any)
        await periodicChecker.start()
        mockFetch.mockClear()
        await vi.advanceTimersByTimeAsync(30_000)
        expect(mockFetch).toHaveBeenCalled()
        periodicChecker.stop()
      } finally {
        vi.useRealTimers()
      }
    })

    it('stops all timers on stop()', async () => {
      vi.useFakeTimers()
      try {
        const periodicChecker = new HealthChecker(policy as any)
        await periodicChecker.start()
        periodicChecker.stop()
        mockFetch.mockClear()
        await vi.advanceTimersByTimeAsync(60_000)
        expect(mockFetch).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // allResolved
  describe('allResolved', () => {
    it('returns false when backends are still UNKNOWN', () => {
      expect(checker.allResolved()).toBe(false)
    })

    it('returns true after startup probes complete', async () => {
      await checker.start()
      expect(checker.allResolved()).toBe(true)
    })

    it('ignores backends without health_check', () => {
      // Only 'local' and 'cloud' have health_check and are UNKNOWN
      // 'bare' has none — doesn't affect allResolved
      expect(checker.allResolved()).toBe(false)
    })
  })

  // getAllStates
  describe('getAllStates', () => {
    it('returns snapshot of all backend states', async () => {
      await checker.start()
      const states = checker.getAllStates()
      expect(states).toEqual({
        local: 'HEALTHY',
        cloud: 'HEALTHY',
        bare: 'HEALTHY',
      })
    })
  })
})

