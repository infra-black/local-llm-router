import { serve } from '@hono/node-server'
import { createApp } from './app.js'

const { app, policy } = createApp()
const port = Number(process.env.LLR_PORT || 3030)

serve({ fetch: app.fetch, port }, () => {
  console.log(`local-llm-router listening on http://localhost:${port}`)
  console.log(`Policy: ${process.env.LLR_POLICY || './policy.yaml'}`)
  console.log(`Backends: ${Object.keys(policy.backends).join(', ')}`)
})
