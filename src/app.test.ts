import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Decision } from './routing/decision.js'

// --- Mocks ---

const mockHealthStart = vi.fn().mockResolvedValue(undefined)
const mockHealthGetAllStates = vi.fn().mockReturnValue({
  local: 'HEALTHY',
  sarmalink: 'HEALTHY',
  frontier: 'HEALTHY',
})
const mockHealthGetState = vi.fn().mockReturnValue('HEALTHY')

vi.mock('./health/checkup.js', () => ({
  HealthChecker: vi.fn(() => ({
    start: mockHealthStart,
    getAllStates: mockHealthGetAllStates,
    getState: mockHealthGetState,
    onTransition: vi.fn(),
    stop: vi.fn(),
  })),
}))

vi.mock('./config/loader.js', () => ({
  loadPolicy: () => ({
    backends: {
      local: { type: 'ollama', endpoint: 'http://localhost:11434' },
      sarmalink: { type: 'sarmalink', endpoint: 'https://api.sarmalink.ai/v1' },
      frontier: { type: 'openai', model: 'gpt-4o' },
    },
  }),
}))

vi.mock('./routing/classifier.js', () => ({
  classify: vi.fn(() => ({ task: 'code', complexity: 'low', sensitivity: 'normal' })),
  modalities: ['text']
}))

const mockDecide = vi.fn()
vi.mock('./routing/decision.js', () => ({
  decide: (...args: any[]) => mockDecide(...args),
}))

const mockRunBackend = vi.fn()
vi.mock('./backends/registry.js', () => ({
  runBackend: (...args: any[]) => mockRunBackend(...args),
}))

const mockRecord = vi.fn()
vi.mock('./metrics/collector.js', () => ({
  record: (...args: any[]) => mockRecord(...args),
}))

import { createApp } from './app.js'

// --- Helpers ---

function postCompletions(app: ReturnType<typeof createApp>['app'], headers: Record<string, string> = {}) {
  return app.fetch(
    new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    }),
  )
}

function retryableError(code: string, message: string) {
  return Object.assign(new Error(message), { code })
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status })
}

// --- Tests ---

describe('app', () => {
  let app: ReturnType<typeof createApp>['app']

  beforeEach(async () => {
    vi.clearAllMocks()
    mockHealthStart.mockResolvedValue(undefined)
    mockHealthGetAllStates.mockReturnValue({
      local: 'HEALTHY',
      sarmalink: 'HEALTHY',
      frontier: 'HEALTHY',
    })
    mockHealthGetState.mockReturnValue('HEALTHY')
    const created = await createApp()
    app = created.app
  })

  describe('GET /health', () => {
    it('returns ok with backend list', async () => {
      const res = await app.fetch(new Request('http://localhost/health'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ ok: true, version: '1.0.0', backends: ['local', 'sarmalink', 'frontier'] })
    })
  })

  describe('GET /v1/models', () => {
    it('returns model list from policy backends', async () => {
      const res = await app.fetch(new Request('http://localhost/v1/models'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.object).toBe('list')
      expect(body.data).toEqual([
        { id: 'local', object: 'model', owned_by: 'ollama' },
        { id: 'sarmalink', object: 'model', owned_by: 'sarmalink' },
        { id: 'frontier', object: 'model', owned_by: 'openai' },
      ])
    })
  })

  describe('GET /v1/health', () => {
    it('returns health status of all backends', async () => {
      mockHealthGetAllStates.mockReturnValue({
        local: 'HEALTHY',
        sarmalink: 'UNHEALTHY',
        frontier: 'HEALTHY',
      })
      const res = await app.fetch(new Request('http://localhost/v1/health'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ local: 'healthy', sarmalink: 'unhealthy', frontier: 'healthy' })
    })
  })

  describe('POST /v1/chat/completions', () => {
    it('returns 503 when all backends are unhealthy', async () => {
      mockDecide.mockReturnValue({
        backend: '',
        fallbackChain: [],
        reason: 'matched (all backends unhealthy!)',
        classification: {
          task: 'code',
          complexity: 'low',
          sensitivity: 'normal',
          modalities: ['text'],
        }
      })

      const res = await postCompletions(app)
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.error.type).toBe('upstream_unavailable')
      expect(body.error.code).toBe(503)
      expect(body.error.message).toContain('modalities=[text]')
      expect(body.error.message).toContain('healthy_backends=')
    })

    it('returns result when primary backend succeeds', async () => {
      mockDecide.mockReturnValue({ backend: 'local', fallbackChain: ['sarmalink'], reason: 'matched' })
      mockRunBackend.mockResolvedValue({ choices: [] })

      const res = await postCompletions(app)
      expect(res.status).toBe(200)
      expect(mockRunBackend).toHaveBeenCalledTimes(1)
      expect(mockRunBackend).toHaveBeenCalledWith('local', expect.anything(), expect.anything())
      expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({ backend: 'local', ok: true, hop: 0, fallbackFor: undefined }),
      )
    })

    it('falls over to next backend on timeout', async () => {
      mockDecide.mockReturnValue({ backend: 'local', fallbackChain: ['sarmalink'], reason: 'matched' })
      mockRunBackend
        .mockRejectedValueOnce(retryableError('ETIMEDOUT', 'timeout'))
        .mockResolvedValueOnce({ choices: [] })

      const res = await postCompletions(app)
      expect(res.status).toBe(200)
      expect(mockRunBackend).toHaveBeenCalledTimes(2)
      expect(mockRunBackend).toHaveBeenNthCalledWith(2, 'sarmalink', expect.anything(), expect.anything())

      expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({ backend: 'local', ok: false, hop: 0, fallbackFor: undefined }),
      )
      expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({ backend: 'sarmalink', ok: true, hop: 1, fallbackFor: 'local' }),
      )
    })

    it('falls over on connection refused', async () => {
      mockDecide.mockReturnValue({ backend: 'local', fallbackChain: ['sarmalink'], reason: 'matched' })
      mockRunBackend
        .mockRejectedValueOnce(retryableError('ECONNREFUSED', 'refused'))
        .mockResolvedValueOnce({ choices: [] })

      const res = await postCompletions(app)
      expect(res.status).toBe(200)
      expect(mockRunBackend).toHaveBeenCalledTimes(2)
    })

    it('falls over on 5xx errors', async () => {
      mockDecide.mockReturnValue({ backend: 'local', fallbackChain: ['sarmalink'], reason: 'matched' })
      mockRunBackend
        .mockRejectedValueOnce(httpError(502, 'bad gateway'))
        .mockResolvedValueOnce({ choices: [] })

      const res = await postCompletions(app)
      expect(res.status).toBe(200)
      expect(mockRunBackend).toHaveBeenCalledTimes(2)
    })

    it('walks the full chain on successive failures', async () => {
      mockDecide.mockReturnValue({
        backend: 'local',
        fallbackChain: ['sarmalink', 'frontier'],
        reason: 'matched',
      })
      mockRunBackend
        .mockRejectedValueOnce(retryableError('ETIMEDOUT', 'timeout'))
        .mockRejectedValueOnce(httpError(502, 'bad gateway'))
        .mockResolvedValueOnce({ choices: [] })

      const res = await postCompletions(app)
      expect(res.status).toBe(200)
      expect(mockRunBackend).toHaveBeenCalledTimes(3)

      expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({ backend: 'local', ok: false, hop: 0, fallbackFor: undefined }),
      )
      expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({ backend: 'sarmalink', ok: false, hop: 1, fallbackFor: 'local' }),
      )
      expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({ backend: 'frontier', ok: true, hop: 2, fallbackFor: 'sarmalink' }),
      )
    })

    it('returns chain_exhausted when all backends fail with retryable errors', async () => {
      mockDecide.mockReturnValue({
        backend: 'local',
        fallbackChain: ['sarmalink'],
        reason: 'matched',
      })
      mockRunBackend
        .mockRejectedValueOnce(retryableError('ETIMEDOUT', 'timeout'))
        .mockRejectedValueOnce(retryableError('ECONNREFUSED', 'refused'))

      const res = await postCompletions(app)
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body.error.code).toBe('chain_exhausted')
      expect(mockRunBackend).toHaveBeenCalledTimes(2)
    })

    it('returns backend_failed when primary fails with no fallbacks', async () => {
      mockDecide.mockReturnValue({ backend: 'local', fallbackChain: [], reason: 'matched' })
      mockRunBackend.mockRejectedValueOnce(retryableError('ETIMEDOUT', 'timeout'))

      const res = await postCompletions(app)
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body.error.code).toBe('backend_failed')
      expect(mockRunBackend).toHaveBeenCalledTimes(1)
    })

    it('does not fall over on 4xx errors', async () => {
      mockDecide.mockReturnValue({ backend: 'local', fallbackChain: ['sarmalink'], reason: 'matched' })
      mockRunBackend.mockRejectedValueOnce(httpError(400, 'bad request'))

      const res = await postCompletions(app)
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body.error.code).toBe('backend_failed')
      expect(mockRunBackend).toHaveBeenCalledTimes(1)
    })

    it('does not fall over on 401 auth errors', async () => {
      mockDecide.mockReturnValue({ backend: 'local', fallbackChain: ['sarmalink'], reason: 'matched' })
      mockRunBackend.mockRejectedValueOnce(httpError(401, 'unauthorized'))

      const res = await postCompletions(app)
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body.error.code).toBe('backend_failed')
      expect(mockRunBackend).toHaveBeenCalledTimes(1)
    })

    it('logs each fallback hop', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockDecide.mockReturnValue({
        backend: 'local',
        fallbackChain: ['sarmalink', 'frontier'],
        reason: 'matched',
      })
      mockRunBackend
        .mockRejectedValueOnce(retryableError('ETIMEDOUT', 'timeout'))
        .mockRejectedValueOnce(httpError(502, 'bad gateway'))
        .mockResolvedValueOnce({ choices: [] })

      await postCompletions(app)

      expect(warnSpy).toHaveBeenCalledTimes(2)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Backend 'local' failed (hop 0/2)"),
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("falling over to 'sarmalink'"),
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("falling over to 'frontier'"),
      )

      warnSpy.mockRestore()
    })

    it('does not log a hop warning on the final exhausted failure', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockDecide.mockReturnValue({
        backend: 'local',
        fallbackChain: ['sarmalink'],
        reason: 'matched',
      })
      mockRunBackend
        .mockRejectedValueOnce(retryableError('ETIMEDOUT', 'timeout'))
        .mockRejectedValueOnce(retryableError('ECONNREFUSED', 'refused'))

      await postCompletions(app)

      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("falling over to 'sarmalink'"),
      )

      warnSpy.mockRestore()
    })

    it('passes x-llr-sensitivity header to classifier', async () => {
      mockDecide.mockReturnValue({ backend: 'local', fallbackChain: [], reason: 'matched' })
      mockRunBackend.mockResolvedValue({ choices: [] })

      await postCompletions(app, { 'x-llr-sensitivity': 'high' })

      const { classify } = await import('./routing/classifier.js')
      expect(classify).toHaveBeenCalledWith(
        expect.anything(),
        'high',
      )
    })
  })
})

