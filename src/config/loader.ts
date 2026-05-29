import { readFileSync } from 'fs'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

export const HealthCheckSchema = z.object({
  path: z.string().default('/v1/models'),
  interval_seconds: z.number().positive().default(30),
  timeout_seconds: z.number().positive().default(5),
  unhealthy_threshold: z.number().int().positive().default(2),
  healthy_threshold: z.number().int().positive().default(1),
})

export type HealthCheckConfig = z.infer<typeof HealthCheckSchema>

export const BackendSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ollama'),
    endpoint: z.string(),
    models: z.array(z.string()).optional(),
    health_check: HealthCheckSchema.optional(),
  }),
  z.object({
    type: z.literal('sarmalink'),
    endpoint: z.string(),
    model: z.string().default('smart'),
    health_check: HealthCheckSchema.optional(),
  }),
  z.object({
    type: z.literal('openai'),
    endpoint: z.string().default('https://api.openai.com/v1'),
    model: z.string(),
    health_check: HealthCheckSchema.optional(),
  }),
])

export const RouteSchema = z.union([
  z.object({
    match: z.record(z.string(), z.any()),
    backend: z.string(),
    fallback: z.string().optional(),
    fallback_chain: z.array(z.string()).optional(),
    reason: z.string().optional(),
  }),
  z.object({
    default: z.string(),
    fallback: z.string().optional(),
    fallback_chain: z.array(z.string()).optional(),
  }),
])

const PolicySchema = z.object({
  backends: z.record(z.string(), BackendSchema),
  routes: z.array(RouteSchema),
}).transform(policy => ({
  ...policy,
  routes: policy.routes.map(route => {
    if (route.fallback_chain && route.fallback) {
      console.warn(
        `[policy] Route specifies both "fallback" and "fallback_chain" - "fallback" is ignored.`
      )
    }
    const fallbackChain = route.fallback_chain ?? (route.fallback ? [route.fallback] : [])
    return { ...route, fallbackChain }
  }),
}))

export type Policy = z.infer<typeof PolicySchema>

export function parsePolicy(data: unknown): Policy {
  return PolicySchema.parse(data)
}

export function loadPolicy(path: string): Policy {
  const raw = readFileSync(path, 'utf-8')
  const data = parseYaml(raw)
  return parsePolicy(data)
}


