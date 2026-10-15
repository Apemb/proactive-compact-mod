import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { PendingCompact } from '../types'
import {
  messageForLevel,
  NAME,
  resolveSettings,
  summaryInstructions,
  type Settings,
  type Source,
} from './settings'

const LEVEL = { plugin: 'proactive-compact-mod', key: 'level' } as const
const PENDING = { plugin: 'proactive-compact-mod', key: 'pending' } as const

const COMPACT_TOOL = `mcp__${NAME}__compact_session`

// Compacting fails while a turn runs: retry until the session is idle, for
// about two minutes at most.
const MAX_ATTEMPTS = 40
const RETRY_DELAY_MS = 3000

const LEVEL_NAMES = ['none', 'compact request', 'reminder'] as const
const NUMERIC: readonly (keyof Settings)[] = ['enabled', 'requestThreshold', 'reminderThreshold', 'compactFloor']

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await Promise.all([
      $.tool.register({
        name: 'context_usage',
        description:
          'Reports how full the main session context is: tokens, window, percentage, compact request and reminder thresholds, compact floor. With `detail: true`, adds the estimated breakdown by category and the auto-compact threshold.',
        inputSchema: {
          type: 'object',
          properties: { detail: { type: 'boolean', description: 'Adds the breakdown by category.' } },
        },
        isDeferred: false,
      }),
      $.tool.register({
        name: 'compact_session',
        description:
          'Schedules a compaction of the main session, run as soon as the current turn ends. Call it once memories and tracking documents are up to date, at a quiet moment. Refused below the configured floor. After calling it, end your turn without any other tool call.',
        inputSchema: {
          type: 'object',
          properties: {
            instructions: {
              type: 'string',
              description: 'What the summary must keep or stress, as after /compact.',
            },
          },
        },
        isDeferred: false,
      }),
      $.command.register({
        name: 'proactive-compact',
        description: 'Proactive compaction: status, on, off, settings',
        argumentHint: '[status|on|off|settings]',
      }),
    ])
    return next(e)
  })

  on('tool.call', { tool: 'mcp__proactive-compact-mod__context_usage' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: 'Main session only.' }
    const detail = (e as { detail?: unknown }).detail === true
    return { result: await describeContext($, options, detail) }
  })

  on('tool.call', { tool: 'mcp__proactive-compact-mod__compact_session' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: 'Main session only.' }
    const { values } = await resolveSettings($, options)
    const percent = (await $.session.usage()).context.percent ?? 0
    if (percent < values.compactFloor) {
      return {
        deny: `Compaction refused: the context is at ${percent}%, below the ${values.compactFloor}% floor.`,
      }
    }
    const raw = (e as { instructions?: unknown }).instructions
    const instructions = typeof raw === 'string' && raw.trim() !== '' ? raw : null
    await $.state.set(PENDING, { instructions })
    $.ui.status('compaction scheduled')
    return {
      result:
        'Compaction scheduled: it will run as soon as this turn ends. End your turn now, in one sentence, without any other tool call.',
    }
  })

  on('turn.complete', async ($, e, next) => {
    const answer = await next(e)
    if (e.agentId !== undefined) return answer

    const { value: pending = null } = await $.state.get(PENDING)
    if (pending !== null) {
      if (e.reason === 'answer') {
        $.clock.after(300, () => void compact($, options, pending, 0))
      } else {
        await $.state.set(PENDING, null)
        $.ui.status(undefined)
        $.ui.toast('Compaction cancelled: the turn was interrupted.')
      }
      return answer
    }

    if (e.reason === 'answer') await sendIfDue($, options)
    return answer
  })

  // A compaction from elsewhere (/compact, auto-compact) also rearms the messages.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && !('skip' in result && result.skip)) {
      await reset($)
    }
    return result
  })

  on('command.run', { command: 'proactive-compact' }, async ($, e) => {
    const verb = e.args.trim().toLowerCase()
    if (verb === 'on' || verb === 'off') return { text: await toggle($, options, verb === 'on') }
    if (verb === 'settings') return { text: SETTINGS_HELP }
    if (verb === '' || verb === 'status') return { text: await describeContext($, options, false) }
    return { text: `Unknown argument "${verb}". Expected: status, on, off or settings.` }
  })
}

async function sendIfDue($: EngineInterface, options: PluginOptions): Promise<void> {
  const { values } = await resolveSettings($, options)
  const percent = (await $.session.usage()).context.percent ?? 0
  const { value: level = 0 } = await $.state.get(LEVEL)

  if (percent < values.requestThreshold) {
    if (level > 0) await reset($)
    return
  }
  if (!values.enabled) return

  const target = percent >= values.reminderThreshold && level < 2 ? 2 : level < 1 ? 1 : 0
  if (target === 0) return

  await $.state.set(LEVEL, target)
  $.ui.status(`${target === 2 ? 'reminder sent' : 'compact requested'} at ${percent}%`)
  const text = messageForLevel(values, target, percent, COMPACT_TOOL)
  // The prompt starts a turn of its own as soon as the session is idle.
  $.clock.after(0, () => void $.prompt.submit({ text }))
}

async function compact(
  $: EngineInterface,
  options: PluginOptions,
  pending: PendingCompact,
  attempt: number,
): Promise<void> {
  const { values } = await resolveSettings($, options)
  try {
    const result = await $.session.compact({
      instructions: summaryInstructions(values, pending.instructions),
    })
    if ('skip' in result && result.skip) {
      await $.state.set(PENDING, null)
      $.ui.status(undefined)
      $.ui.toast(`Compaction refused: ${result.skip}`)
      return
    }
    await reset($)
  } catch {
    if (attempt + 1 < MAX_ATTEMPTS) {
      $.clock.after(RETRY_DELAY_MS, () => void compact($, options, pending, attempt + 1))
      return
    }
    await $.state.set(PENDING, null)
    $.ui.status(undefined)
    $.ui.toast('Compaction abandoned: the session was not idle long enough.')
  }
}

async function reset($: EngineInterface): Promise<void> {
  await Promise.all([$.state.set(LEVEL, 0), $.state.set(PENDING, null)])
  $.ui.status(undefined)
}

async function toggle($: EngineInterface, options: PluginOptions, enabled: boolean): Promise<string> {
  const row = (await $.config.list()).find(
    r => r.key === `${NAME}.enabled` || (r.key.startsWith(`${NAME}@`) && r.key.endsWith('.enabled')),
  )
  if (row === undefined) return 'The "enabled" setting was not found in /config.'
  const { deny } = await $.config.set({ key: row.key, value: enabled })
  if (deny !== undefined) return `Refused: ${deny}`
  const { sources } = await resolveSettings($, options)
  const warning =
    sources.enabled === 'project' || sources.enabled === 'local'
      ? ` Note: the ${sources.enabled} settings set "enabled" and take precedence here.`
      : ''
  return `Compact requests ${enabled ? 'enabled' : 'disabled'} for all projects.${warning}`
}

async function describeContext($: EngineInterface, options: PluginOptions, detail: boolean): Promise<string> {
  const [{ values, sources }, usage, level, pending] = await Promise.all([
    resolveSettings($, options),
    $.session.usage(detail ? { breakdown: 'summary' } : undefined),
    $.state.get(LEVEL),
    $.state.get(PENDING),
  ])
  const { tokens, window, percent } = usage.context
  const from = (key: keyof Settings) => (sources[key] === 'default' ? '' : ` (${sources[key]})`)
  const lines = [
    `Context: ${tokens === undefined ? 'not measured yet' : `${count(tokens)} tokens of ${count(window)} (${percent ?? 0}%)`}.`,
    `Messages: ${values.enabled ? 'enabled' : 'disabled'}${from('enabled')}; compact request at ${values.requestThreshold}%${from('requestThreshold')}, reminder at ${values.reminderThreshold}%${from('reminderThreshold')}, floor ${values.compactFloor}%${from('compactFloor')}.`,
    `Last message sent: ${LEVEL_NAMES[level.value ?? 0] ?? 'none'}. Compaction scheduled: ${pending.value ? 'yes' : 'no'}.`,
  ]
  const overridden = (Object.entries(sources) as [keyof Settings, Source][])
    .filter(([key, source]) => (source === 'project' || source === 'local') && !NUMERIC.includes(key))
    .map(([key, source]) => `${key} (${source})`)
  if (overridden.length > 0) lines.push(`Overridden texts: ${overridden.join(', ')}.`)

  const breakdown = usage.context.breakdown
  if (breakdown !== undefined) {
    const auto = breakdown.isAutoCompactEnabled
      ? `auto-compact around ${count(breakdown.autoCompactThreshold ?? breakdown.maxTokens)} tokens`
      : 'auto-compact disabled'
    lines.push(`Estimated breakdown (${auto}):`)
    for (const c of breakdown.categories.filter(c => !c.isDeferred && c.tokens > 0)) {
      lines.push(`- ${c.name}: ${count(c.tokens)}`)
    }
  }
  return lines.join('\n')
}

function count(n: number): string {
  return n.toLocaleString('en-US')
}

const SETTINGS_HELP = `Global settings: /config, rows "${NAME}" (thresholds, floor, messages, suffix, instructions).
Per-project override: in the repository's .claude/settings.json (shared) or .claude/settings.local.json (personal), for example:
{ "pluginConfigs": { "${NAME}": { "options": { "requestThreshold": 50, "messageSuffix": "Also update docs/…" } } } }
Message variables: {percent}, {threshold}, {floor}, {tool}. An empty reminder message reuses the compact request message.`
