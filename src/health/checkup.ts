import type { HealthCheckConfig, Policy } from '../config/loader.js'

export type HealthState = 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN'

interface BackendHealth {
  state: HealthState
  consecutiveSuccesses: number
  consecutiveFailures: number
  checkConfig: HealthCheckConfig | undefined
  endpoint: string
  timer: ReturnType<typeof setInterval> | null
}

export class HealthChecker {
  private backends: Map<string, BackendHealth> = new Map()
  private listeners: Array<(name: string, from: HealthState, to: HealthState) => void> = []

  constructor(policy: Policy) {
    for (const [name, cfg] of Object.entries(policy.backends)) {
      this.backends.set(name, {
        state: 'UNKNOWN',
        consecutiveSuccesses: 0,
        consecutiveFailures: 0,
        checkConfig: cfg.health_check,
        endpoint: cfg.endpoint,
        timer: null,
      })
    }
  }

  // --------------
  // Public Methods
  // --------------

  // callbacks for state transitions.
  onTransition(fn: (name: string, from: HealthState, to: HealthState) => void): void {
    this.listeners.push(fn)
  }

  // single backend state
  getState(name: string): HealthState {
    const bh = this.backends.get(name)
    if (!bh) return 'UNKNOWN'
    // NB: backends without health_check are always HEALTHY.
    if (!bh.checkConfig) return 'HEALTHY'
    return bh.state
  }

  // snapshot of all backend states.
  getAllStates(): Record<string, HealthState> {
    const out: Record<string, HealthState> = {}
    for (const [name, bh] of this.backends) {
      out[name] = this.getState(name)
    }
    return out
  }

  // verify if all backends have been checked
  allResolved(): boolean {
    for (const [, bh] of this.backends) {
      if (bh.checkConfig && bh.state === 'UNKNOWN') return false
    }
    return true
  }

  // run initial probes and start periodic timers.
  async start(): Promise<void> {
    // run initial checks in parallel
    const initialChecks = []
    for (const [name, bh] of this.backends) {
      if (bh.checkConfig) {
        initialChecks.push(this.probe(name))
      }
    }
    await Promise.allSettled(initialChecks)

    // start timers
    for (const [name, bh] of this.backends) {
      if (bh.checkConfig) {
        bh.timer = setInterval(() => this.probe(name), bh.checkConfig.interval_seconds * 1000)
      }
    }
  }

  // stop all periodic timers.
  stop(): void {
    for (const [, bh] of this.backends) {
      if (bh.timer) {
        clearInterval(bh.timer)
        bh.timer = null
      }
    }
  }

  // ---------
  // Internals
  // ---------
  private async probe(name: string): Promise<void> {
    const bh = this.backends.get(name)
    if (!bh || !bh.checkConfig) return

    const { path, timeout_seconds, unhealthy_threshold, healthy_threshold } = bh.checkConfig
    const url = `${bh.endpoint.replace(/\/$/, '')}${path}`

    let success = false
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeout_seconds * 1000)

      const res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      })
      clearTimeout(timeout)
      success = res.ok
    } catch {
      success = false
    }

    const prevState = bh.state

    if (success) {
      bh.consecutiveSuccesses++
      bh.consecutiveFailures = 0

      // push UNKNOWN -> HEALTHY on first success
      if (bh.state === 'UNKNOWN') {
        bh.state = 'HEALTHY'
      }
      // process UNHEALTHY -> HEALTHY after healthy_threshold consecutive successes
      else if (bh.state !== 'HEALTHY' && bh.consecutiveSuccesses >= healthy_threshold) {
        bh.state = 'HEALTHY'
      }
    } else {
      bh.consecutiveFailures++
      bh.consecutiveSuccesses = 0

      // process HEALTHY -> UNHEALTHY after unhealthy_threshold consecutive failures
      if (bh.state !== 'UNHEALTHY' && bh.consecutiveFailures >= unhealthy_threshold) {
        bh.state = 'UNHEALTHY'
      }
      // catch UNKNOWN -> UNHEALTHY if threshold is met on first check
      else if (bh.state === 'UNKNOWN' && bh.consecutiveFailures >= unhealthy_threshold) {
        bh.state = 'UNHEALTHY'
      }
    }

    if (bh.state !== prevState) {
      console.warn(
        `[lllm-rt] Health state of backend '${name}' transitioned: ${prevState} -> ${bh.state}`
      )
      for (const fn of this.listeners) {
        fn(name, prevState, bh.state)
      }
    }
  }
}

