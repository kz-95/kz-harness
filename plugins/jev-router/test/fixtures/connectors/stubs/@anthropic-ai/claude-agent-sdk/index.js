// A stand-in for @anthropic-ai/claude-agent-sdk's query(), driven by the test. Each call is kept in
// `runs` with the prompt and options it was given. Like the SDK, it spawns the CLI through the
// caller's spawnClaudeCodeProcess as it is called, and reads an iterable prompt as it comes, one
// message at a time. The test hands the run what the CLI would stream (`say`) and ends that stream
// (`end`), and reads what the run wrote to the CLI (`written`), whether its input ended
// (`inputEnded`), and what it asked of the query (`interrupts`, `thinking`).
export const runs = []

export function query({ prompt, options }) {
  const run = { prompt, options, written: [], inputEnded: false, interrupts: 0, thinking: [], closed: false }
  const queue = []
  let wake = null
  let ended = false
  run.say = (...messages) => { queue.push(...messages); wake?.() }
  run.end = () => { ended = true; wake?.() }
  run.process = options.spawnClaudeCodeProcess({ command: 'claude', args: ['--output-format', 'stream-json'], cwd: options.cwd, env: options.env ?? {}, signal: options.abortController?.signal })
  if (typeof prompt === 'string') run.written.push(prompt)
  else {
    ;(async () => {
      for await (const message of prompt) run.written.push(message)
      run.inputEnded = true
    })().catch((error) => { run.inputError = error })
  }
  runs.push(run)
  const stream = (async function* messages() {
    while (true) {
      while (queue.length > 0) yield queue.shift()
      if (ended || run.closed) return
      await new Promise((resolve) => { wake = resolve })
      wake = null
    }
  })()
  return Object.assign(stream, {
    async interrupt() { run.interrupts++ },
    async setMaxThinkingTokens(tokens, display) { run.thinking.push([tokens, display]) },
    close() { run.closed = true; wake?.() },
  })
}
