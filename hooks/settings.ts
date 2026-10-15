import type { EngineInterface, PluginOptions } from 'claude-code'

export const NAME = 'proactive-compact-mod'

export type Settings = {
  enabled: boolean
  requestThreshold: number
  reminderThreshold: number
  compactFloor: number
  requestMessage: string
  reminderMessage: string
  messageSuffix: string
  compactInstructions: string
}

export type Source = 'default' | 'user' | 'project' | 'local'

export type ResolvedSettings = { values: Settings; sources: Record<keyof Settings, Source> }

const PERCENTAGES = ['requestThreshold', 'reminderThreshold', 'compactFloor'] as const
const TEXTS = ['requestMessage', 'reminderMessage', 'messageSuffix', 'compactInstructions'] as const

export const KEYS: readonly (keyof Settings)[] = ['enabled', ...PERCENTAGES, ...TEXTS]

// The options handed over at load already carry the manifest's defaults; only
// the project overrides are read again on every use, so that editing the
// repository's settings file takes effect without reloading the mod.
export async function resolveSettings(
  $: EngineInterface,
  options: PluginOptions,
): Promise<ResolvedSettings> {
  const [user, project, local] = await Promise.all([
    readOverrides($, 'user'),
    readOverrides($, 'project'),
    readOverrides($, 'local'),
  ])
  const values = {} as Record<keyof Settings, unknown>
  const sources = {} as Record<keyof Settings, Source>
  for (const key of KEYS) {
    values[key] = options[key]
    sources[key] = key in user ? 'user' : 'default'
    for (const [layer, source] of [[project, 'project'], [local, 'local']] as const) {
      const value = validate(key, layer[key])
      if (value !== undefined) {
        values[key] = value
        sources[key] = source
      }
    }
  }
  return { values: values as Settings, sources }
}

async function readOverrides(
  $: EngineInterface,
  source: 'user' | 'project' | 'local',
): Promise<Record<string, unknown>> {
  const settings = (await $.settings.read({ source })) as {
    pluginConfigs?: Record<string, { options?: Record<string, unknown> }>
  }
  const configs = settings.pluginConfigs ?? {}
  const key = Object.keys(configs).find(name => name === NAME || name.startsWith(`${NAME}@`))
  return (key && configs[key]?.options) || {}
}

function validate(key: keyof Settings, value: unknown): unknown {
  if (value === undefined) return undefined
  if (key === 'enabled') return typeof value === 'boolean' ? value : undefined
  if ((PERCENTAGES as readonly string[]).includes(key)) {
    const number = Number(value)
    return Number.isFinite(number) && number >= 0 && number <= 100 ? number : undefined
  }
  return typeof value === 'string' ? value : undefined
}

export function messageForLevel(settings: Settings, level: 1 | 2, percent: number, tool: string): string {
  const template =
    level === 2 && settings.reminderMessage.trim() !== ''
      ? settings.reminderMessage
      : settings.requestMessage
  const threshold = level === 2 ? settings.reminderThreshold : settings.requestThreshold
  const text = template
    .replaceAll('{percent}', String(percent))
    .replaceAll('{threshold}', String(threshold))
    .replaceAll('{floor}', String(settings.compactFloor))
    .replaceAll('{tool}', tool)
  const suffix = settings.messageSuffix.trim()
  return suffix === '' ? text : `${text}\n\n${suffix}`
}

export function summaryInstructions(settings: Settings, fromAgent: string | null): string | undefined {
  const parts = [settings.compactInstructions.trim(), fromAgent?.trim() ?? ''].filter(p => p !== '')
  return parts.length === 0 ? undefined : parts.join('\n\n')
}
