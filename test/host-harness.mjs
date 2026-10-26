// Minimal fake of the DSH host context: enough to drive index.js through its public route and hook.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Starts the Host half against a throw-away $DSH_HOME.
 * index.js reads the state path once at import, so one process shares one home;
 * each call wipes the state file first, and tests should `dispose()` when done.
 */
export async function startHost() {
  if (!process.env.DSH_HOME) process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'cost-meter-'))
  rmSync(join(process.env.DSH_HOME, 'cost-meter.json'), { force: true })
  const { apply } = await import('../index.js')
  const handlers = {}
  let route
  let dispose = () => {}
  apply({
    on: (event, handler) => { if (event === 'dispose') dispose = handler; else handlers[event] = handler },
    webServer: { register: (spec) => { route = spec; return () => {} } },
  })

  const post = async (body) => {
    const req = {
      method: 'POST',
      headers: { host: '127.0.0.1:3000', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
    }
    let out = ''
    await route.handler(req, { setHeader() {}, end(text) { out = text } })
    return JSON.parse(out)
  }
  const get = () => {
    let out = ''
    route.handler({ method: 'GET', headers: { host: 'localhost' } }, { setHeader() {}, end(text) { out = text } })
    return JSON.parse(out)
  }
  /** Runs one fake LLM call through the llm/stream hook; `usage: null` simulates an aborted call. */
  const call = async ({ model = 'm', sessionId = 's1', usage }) => {
    const stream = handlers['llm/stream']({ model, sessionId }, async function* () {
      if (usage) yield { type: 'usage', usage }
    })
    for await (const chunk of stream) void chunk
  }
  /** Drives the llm/stream hook with a hand-written upstream, e.g. to emit content chunks between fake-clock ticks. */
  const run = async (options, upstream) => {
    for await (const chunk of handlers['llm/stream'](options, upstream)) void chunk
  }
  /** Delivers one `session/event` (what the host emits for turn/start, assistant/message, ...). */
  const sessionEvent = (session, event) => handlers['session/event'](session, event)
  /** Delivers one `tools/result` event (what the host emits after a tool finishes). */
  const tool = (exec, result) => handlers['tools/result'](exec, result)
  return { post, get, call, run, tool, sessionEvent, dispose: () => dispose(), home: process.env.DSH_HOME }
}
