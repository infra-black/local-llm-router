import { Hono } from 'hono'
import { loadPolicy } from './config/loader.js'
import { decide } from './routing/decision.js'
import { classify } from './routing/classifier.js'
import { runBackend } from './backends/registry.js'
import { record } from './metrics/collector.js'

function isRetryable(err: any): boolean {
  if (err?.code === 'ETIMEDOUT' || err?.code === 'ECONNREFUSED') return true
  if (typeof err?.status === 'number' && err.status >= 500 && err.status < 600) return true
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return true
  return false
}

export function createApp(policyPath: string = process.env.LLR_POLICY || './policy.yaml') {
  const app = new Hono()
  const policy = loadPolicy(policyPath)

  app.get('/health', (c) => c.json({ ok: true, version: '1.0.0', backends: Object.keys(policy.backends) }))

  app.get('/v1/models', (c) =>
    c.json({
      object: 'list',
      data: Object.keys(policy.backends).map((id) => ({
        id,
        object: 'model',
        owned_by: policy.backends[id].type,
      })),
    }),
  )

  app.post('/v1/chat/completions', async (c) => {
    const body = await c.req.json()
    const sensitivity = c.req.header('x-llr-sensitivity') || 'normal'
    const classification = classify(body, sensitivity)
    const decision = decide(classification, policy)
    const chain = [decision.backend, ...decision.fallbackChain]
    const start = Date.now()

    let lastError: any

    for (let hop = 0; hop < chain.length; hop++) {
      const backend = chain[hop]
      try {
        const result = await runBackend(backend, policy.backends[backend], body)
        record({
          backend,
          latency: Date.now() - start,
          ok: true,
          hop,
          fallbackFor: hop > 0 ? chain[hop - 1] : undefined,
        })
        return c.json(result)
      } catch (err: any) {
        lastError = err
        record({
          backend,
          latency: Date.now() - start,
          ok: false,
          error: String(err),
          hop,
          fallbackFor: hop > 0 ? chain[hop - 1] : undefined,
        })

        if (!isRetryable(err)) {
          return c.json({ error: { message: String(err), code: 'backend_failed' } }, 502)
        }
        if (hop < chain.length - 1) {
          console.warn(
            `[lllm-rt] Backend '${backend}' failed (hop ${hop}/${chain.length - 1}), ` +
            `falling over to '${chain[hop + 1]}': ${err.message || err}`,
          )
        }
      }
    }
    const hadFallbacks = decision.fallbackChain.length > 0
    return c.json(
      { error: { message: String(lastError), code: hadFallbacks ? 'chain_exhausted' : 'backend_failed' } },
      502,
    )
  })

  return { app, policy }
}
