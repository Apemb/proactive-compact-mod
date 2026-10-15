import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const COMPACT = 'mcp__proactive-compact-mod__compact_session'
const CONTEXT = 'mcp__proactive-compact-mod__context_usage'

type World = {
  percent: number
  sent: string[]
  compactions: (string | undefined)[]
  project: Record<string, unknown>
}

function world(on: On, start: Partial<World> = {}): World {
  const w: World = { percent: 0, sent: [], compactions: [], project: {}, ...start }
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: w.percent * 10_000, window: 1_000_000, percent: w.percent },
      rateLimits: [],
    },
  }))
  on('settings.read', (_$, e) => ({
    value: (e.source === 'project'
      ? { pluginConfigs: { 'proactive-compact-mod': { options: w.project } } }
      : {}) as never,
  }))
  on('prompt.submit', (_$, e) => {
    w.sent.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.status', () => ({ value: undefined }))
  on('session.compact', (_$, e) => {
    w.compactions.push(e.instructions)
    return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }
  })
  return w
}

async function endTurn($: Engine, agentId?: string): Promise<void> {
  await $.turn.complete({
    answer: 'done',
    durationMs: 1,
    isAborted: false,
    turnId: `t${Math.random()}`,
    reason: 'answer',
    ...(agentId === undefined ? {} : { agentId }),
  })
}

describe('compact request and reminder', () => {
  test('below the threshold, no message', async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on, { percent: 59 })
    await endTurn($)
    await clock.advance(10)
    expect(w.sent).toEqual([])
  })

  test('one compact request at 60%, then a single reminder at 80%', async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on, { percent: 62 })
    await endTurn($)
    await clock.advance(10)
    w.percent = 70
    await endTurn($)
    await clock.advance(10)
    expect(w.sent.length).toBe(1)
    expect(w.sent[0]).toContain('62%')
    expect(w.sent[0]).toContain(COMPACT)

    w.percent = 81
    await endTurn($)
    await clock.advance(10)
    await endTurn($)
    await clock.advance(10)
    expect(w.sent.length).toBe(2)
    expect(w.sent[1]).toContain('threshold 80%')
  })

  test('the reminder uses its own text when it has one', { options: { reminderMessage: 'Last call at {percent}%.' } }, async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on, { percent: 85 })
    await endTurn($)
    await clock.advance(10)
    expect(w.sent).toEqual(['Last call at 85%.'])
  })

  test('subagent turns are ignored', async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on, { percent: 90 })
    await endTurn($, 'agent-1')
    await clock.advance(10)
    expect(w.sent).toEqual([])
  })

  test('disabled, no message', { options: { enabled: false } }, async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on, { percent: 90 })
    await endTurn($)
    await clock.advance(10)
    expect(w.sent).toEqual([])
  })

  test('the project overrides the threshold and appends its suffix', async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on, { percent: 52, project: { requestThreshold: 50, messageSuffix: 'Mind the task log.' } })
    await endTurn($)
    await clock.advance(10)
    expect(w.sent.length).toBe(1)
    expect(w.sent[0]).toContain('threshold 50%')
    expect(w.sent[0]!.endsWith('\n\nMind the task log.')).toBe(true)
  })
})

describe('tools', () => {
  test('compact_session refuses below the floor', async ($, on) => {
    mock.clock(on)
    const w = world(on, { percent: 30 })
    const r = await $.tool.call({ tool: COMPACT, instructions: 'x' })
    expect(r.deny).toContain('below the 40% floor')
    expect(w.compactions).toEqual([])
  })

  test('compact_session compacts when the turn ends and rearms the compact request', { options: { compactInstructions: 'Keep the decisions.' } }, async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on, { percent: 65 })
    await endTurn($)
    await clock.advance(10)
    expect(w.sent.length).toBe(1)

    const r = await $.tool.call({ tool: COMPACT, instructions: 'Keep PR #630.' })
    expect(r.deny).toBeUndefined()
    expect(w.compactions).toEqual([])
    await endTurn($)
    await clock.advance(500)
    expect(w.compactions).toEqual(['Keep the decisions.\n\nKeep PR #630.'])

    await endTurn($)
    await clock.advance(10)
    expect(w.sent.length).toBe(2)
  })

  test('context_usage reports the fill and the thresholds', async ($, on) => {
    mock.clock(on)
    world(on, { percent: 31 })
    const r = await $.tool.call({ tool: CONTEXT })
    expect(String(r.result)).toContain('(31%)')
    expect(String(r.result)).toContain('compact request at 60%, reminder at 80%, floor 40%')
  })
})
