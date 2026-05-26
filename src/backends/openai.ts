export async function runOpenAI(config: any, body: any): Promise<any> {
  let apiKey: string | undefined
  const warnings: string[] = []

  // Priority 1: api_key_env - named environment variable
  if (config.api_key_env) {
    const resolved = process.env[config.api_key_env]
    if (resolved) {
      apiKey = resolved
    } else {
      warnings.push(
        `api_key_env '${config.api_key_env}' is defined but ` +
        `is ${resolved === '' ? 'empty' : 'not set'}; falling back to lower-priority sources.`
      )
    }
  }

  // Priority 2: api_key - static string
  if (!apiKey && config.api_key) {
    apiKey = config.api_key
  }

  // Priority 3: OPENAI_API_KEY - global fallback
  if (!apiKey) {
    apiKey = process.env.OPENAI_API_KEY
  }

  // Emit warnings
  for (const w of warnings) {
    console.warn(`[local-llm-router] ${w}`)
  }

  // No key? Cry about it.
  if (!apiKey) {
    const label = config.label || config.model || 'unnamed'
    const tried = [
      config.api_key_env && `env var '${config.api_key_env}' (via api_key_env)`,
      config.api_key && `static api_key`,
      `env var 'OPENAI_API_KEY'`,
    ].filter(Boolean)

    throw new Error(
      `No API key configured for OpenAI backend '${label}'.\n` +
      `Tried ${tried.join(', ')} but ${tried.length > 1 ? 'all ' : ''}empty or missing.\n` +
      `Please set api_key_env, api_key, or OPENAI_API_KEY.`
    )
  }

  // Build and submit request
  const res = await fetch(`${config.endpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ ...body, model: config.model }),
  })
  if (!res.ok) throw new Error(`OpenAI error: ${res.status}: ${await res.text()}`)
  return res.json()
}
