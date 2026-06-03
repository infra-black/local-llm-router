import type { Classification } from './classifier.js'
import type { Policy } from '../config/loader.js'
import type { HealthChecker } from '../health/checkup.js'

export interface Decision {
  backend: string
  fallbackChain: string[]
  reason: string
  classification: Classification
}

export function decide(cls: Classification, policy: Policy, health?: HealthChecker): Decision {
  for (const route of policy.routes) {
    if ('default' in route) {
      return resolveChain(route.default, route.fallbackChain, 'default', cls, health)
    }
    if (matches(cls, route.match)) {
      const reason = route.reason || `matched: ${JSON.stringify(route.match)}`
      return resolveChain(route.backend, route.fallbackChain, reason, cls, health)
    }
  }
  // Should not reach here if policy has a default
  throw new Error('No route matched and no default backend in policy')
}

function resolveChain(primary: string, fallbackChain: string[], reason: string, cls: Classification, health?: HealthChecker): Decision {
  const chain = [primary, ...fallbackChain]
  const skipped: string[] = []

  let wr = 0
  for (let rd = 0; rd < chain.length; rd++) {
    if (health && health.getState(chain[rd]) === 'UNHEALTHY') {
      skipped.push(chain[rd])
    } else {
      chain[wr++] = chain[rd]
    }
  }
  chain.length = wr

  if (chain.length === 0) {
    return {
      backend: '',
      fallbackChain: [],
      reason: `${reason} (all backends unhealthy!)`,
      classification: cls
    }
  }

  return {
    backend: chain[0],
    fallbackChain: chain.slice(1),
    reason: skipped.length > 0
      ? `${reason} (skipped unhealthy: ${skipped.join(', ')})`
      : reason,
    classification: cls
  }
}

function matches(cls: Classification, criteria: Record<string, any>): boolean {
  for (const [k, v] of Object.entries(criteria)) {
    if (k === 'modalities') {
      // Subset match: every required modality must be present in classification
      if (!Array.isArray(v)) return false
      for (const required of v) {
        if (!cls.modalities.includes(required)) return false
      }
    } else {
      if ((cls as any)[k] !== v) return false
    }
  }
  return true
}
