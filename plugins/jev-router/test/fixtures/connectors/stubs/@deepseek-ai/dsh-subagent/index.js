// A stand-in for dsh-subagent 0.1.5-rc.2, the five helpers the connectors import, each as the pinned
// package has it, less its diagnostic limits: a run's result settles to completed, aborted or error
// (with the error itself, for a test to read), and its handle's dispose() cancels the run and tears
// its process down once.
export const NO_START_CAPABILITIES = Object.freeze({ agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false })

export function assertPositiveFinite(prefix, name, value) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${prefix}: ${name} must be a positive finite number`)
}

export function resolveChildCwd(prefix, configured, parentCwd) {
  if (configured !== undefined) return configured
  if (parentCwd === undefined) throw new Error(`${prefix}: no working directory for the child`)
  return parentCwd
}

export async function settleRunResult(parts) {
  try {
    const result = await parts.attempt()
    return parts.cancelled() ? { output: parts.collectOutput(), stopReason: 'aborted' } : result
  } catch (error) {
    if (parts.cancelled()) return { output: parts.collectOutput(), stopReason: 'aborted' }
    try { parts.onError?.(error, 'error') } catch {}
    const diagnostic = parts.collectDiagnostic?.()
    return { output: parts.collectOutput(), ...(diagnostic === undefined ? {} : { diagnostic }), stopReason: 'error', error }
  } finally {
    parts.signal.removeEventListener('abort', parts.onAbort)
  }
}

export function subprocessRunHandle(parts) {
  let disposal
  return {
    id: parts.id,
    localAgent: undefined,
    result: parts.result,
    dispose() {
      if (disposal !== undefined) return disposal
      parts.signal.removeEventListener('abort', parts.onAbort)
      parts.requestCancel()
      disposal = parts.teardown()
      return disposal
    },
  }
}
