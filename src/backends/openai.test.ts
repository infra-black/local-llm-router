import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock fetch globally
const mockFetch = vi.fn()
globalThis.fetch = mockFetch

// Import after mock setup
const { runOpenAI } = await import('./openai')

const okResponse = (body: any) => ({
  ok: true,
  json: () => Promise.resolve(body),
})

beforeEach(() => {
  vi.restoreAllMocks()
  mockFetch.mockResolvedValue(okResponse({ choices: [] }))
})

describe('runOpenAI — API key resolution', () => {
  it('uses api_key_env when set and env var exists', async () => {
    process.env.MY_SPECIAL_KEY = 'sk-from-env'
    delete process.env.OPENAI_API_KEY

    await runOpenAI(
      { api_key_env: 'MY_SPECIAL_KEY', model: 'gpt-4o', endpoint: 'https://api.openai.com/v1' },
      { messages: [] }
    )

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-from-env',
        }),
      })
    )

    delete process.env.MY_SPECIAL_KEY
  })

  it('falls back to api_key when api_key_env is set but env var is empty', async () => {
    process.env.MY_SPECIAL_KEY = ''
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await runOpenAI(
      { api_key_env: 'MY_SPECIAL_KEY', api_key: 'sk-static', model: 'gpt-4o', endpoint: 'https://api.openai.com/v1' },
      { messages: [] }
    )

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("api_key_env 'MY_SPECIAL_KEY'")
    )
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-static',
        }),
      })
    )

    delete process.env.MY_SPECIAL_KEY
    warnSpy.mockRestore()
  })

  it('falls back to api_key when api_key_env env var is not set', async () => {
    delete process.env.MY_SPECIAL_KEY
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await runOpenAI(
      { api_key_env: 'MY_SPECIAL_KEY', api_key: 'sk-static', model: 'gpt-4o', endpoint: 'https://api.openai.com/v1' },
      { messages: [] }
    )

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not set'))
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-static',
        }),
      })
    )

    warnSpy.mockRestore()
  })

  it('uses static api_key when no api_key_env', async () => {
    delete process.env.OPENAI_API_KEY

    await runOpenAI(
      { api_key: 'sk-static', model: 'gpt-4o', endpoint: 'https://api.openai.com/v1' },
      { messages: [] }
    )

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-static',
        }),
      })
    )
  })

  it('falls back to OPENAI_API_KEY when no per-backend key is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-global'

    await runOpenAI(
      { model: 'gpt-4o', endpoint: 'https://api.openai.com/v1' },
      { messages: [] }
    )

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-global',
        }),
      })
    )

    delete process.env.OPENAI_API_KEY
  })

  it('api_key_env takes priority over api_key', async () => {
    process.env.MY_KEY = 'sk-from-env'

    await runOpenAI(
      { api_key_env: 'MY_KEY', api_key: 'sk-static', model: 'gpt-4o', endpoint: 'https://api.openai.com/v1' },
      { messages: [] }
    )

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-from-env',
        }),
      })
    )

    delete process.env.MY_KEY
  })

  it('throws with descriptive error when no key is available', async () => {
    delete process.env.OPENAI_API_KEY
    delete process.env.MY_KEY

    await expect(
      runOpenAI(
        { api_key_env: 'MY_KEY', model: 'gpt-4o', endpoint: 'https://api.openai.com/v1' },
        { messages: [] }
      )
    ).rejects.toThrow(/No API key configured/)
  })
})

