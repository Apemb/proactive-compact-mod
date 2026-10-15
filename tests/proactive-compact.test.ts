import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const COMPACTER = 'mcp__proactive-compact-mod__compacter_session'
const CONTEXTE = 'mcp__proactive-compact-mod__contexte_session'

type Monde = {
  pourcentage: number
  envoyes: string[]
  compactages: (string | undefined)[]
  projet: Record<string, unknown>
}

function monde(on: On, depart: Partial<Monde> = {}): Monde {
  const m: Monde = { pourcentage: 0, envoyes: [], compactages: [], projet: {}, ...depart }
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: m.pourcentage * 10_000, window: 1_000_000, percent: m.pourcentage },
      rateLimits: [],
    },
  }))
  on('settings.read', (_$, e) => ({
    value: (e.source === 'project'
      ? { pluginConfigs: { 'proactive-compact-mod': { options: m.projet } } }
      : {}) as never,
  }))
  on('prompt.submit', (_$, e) => {
    m.envoyes.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.status', () => ({ value: undefined }))
  on('session.compact', (_$, e) => {
    m.compactages.push(e.instructions)
    return { messages: [{ role: 'user' as const, text: 'résumé', toolUses: [] }] }
  })
  return m
}

async function finDeTour($: Engine, agentId?: string): Promise<void> {
  await $.turn.complete({
    answer: 'fait',
    durationMs: 1,
    isAborted: false,
    turnId: `t${Math.random()}`,
    reason: 'answer',
    ...(agentId === undefined ? {} : { agentId }),
  })
}

describe('demande et relance', () => {
  test('sous le seuil, aucun message', async ($, on) => {
    const horloge = mock.clock(on)
    const m = monde(on, { pourcentage: 59 })
    await finDeTour($)
    await horloge.advance(10)
    expect(m.envoyes).toEqual([])
  })

  test('une demande à 60 %, puis une seule relance à 80 %', async ($, on) => {
    const horloge = mock.clock(on)
    const m = monde(on, { pourcentage: 62 })
    await finDeTour($)
    await horloge.advance(10)
    m.pourcentage = 70
    await finDeTour($)
    await horloge.advance(10)
    expect(m.envoyes.length).toBe(1)
    expect(m.envoyes[0]).toContain('62 %')
    expect(m.envoyes[0]).toContain(COMPACTER)

    m.pourcentage = 81
    await finDeTour($)
    await horloge.advance(10)
    await finDeTour($)
    await horloge.advance(10)
    expect(m.envoyes.length).toBe(2)
    expect(m.envoyes[1]).toContain('seuil 80 %')
  })

  test('la relance prend son propre texte quand elle en a un', { options: { messageRelance: 'Dernier appel à {pourcentage} %.' } }, async ($, on) => {
    const horloge = mock.clock(on)
    const m = monde(on, { pourcentage: 85 })
    await finDeTour($)
    await horloge.advance(10)
    expect(m.envoyes).toEqual(['Dernier appel à 85 %.'])
  })

  test('les tours des sous-agents sont ignorés', async ($, on) => {
    const horloge = mock.clock(on)
    const m = monde(on, { pourcentage: 90 })
    await finDeTour($, 'agent-1')
    await horloge.advance(10)
    expect(m.envoyes).toEqual([])
  })

  test('désactivé, aucun message', { options: { actif: false } }, async ($, on) => {
    const horloge = mock.clock(on)
    const m = monde(on, { pourcentage: 90 })
    await finDeTour($)
    await horloge.advance(10)
    expect(m.envoyes).toEqual([])
  })

  test('le projet surcharge le seuil et ajoute son complément', async ($, on) => {
    const horloge = mock.clock(on)
    const m = monde(on, { pourcentage: 52, projet: { seuilDemande: 50, complement: 'Pense au relevé.' } })
    await finDeTour($)
    await horloge.advance(10)
    expect(m.envoyes.length).toBe(1)
    expect(m.envoyes[0]).toContain('seuil 50 %')
    expect(m.envoyes[0]!.endsWith('\n\nPense au relevé.')).toBe(true)
  })
})

describe('outils', () => {
  test('compacter_session refuse sous le plancher', async ($, on) => {
    mock.clock(on)
    const m = monde(on, { pourcentage: 30 })
    const r = await $.tool.call({ tool: COMPACTER, instructions: 'x' })
    expect(r.deny).toContain('sous le plancher de 40 %')
    expect(m.compactages).toEqual([])
  })

  test('compacter_session compacte à la fin du tour et réarme la demande', { options: { instructionsCompactage: 'Garde les décisions.' } }, async ($, on) => {
    const horloge = mock.clock(on)
    const m = monde(on, { pourcentage: 65 })
    await finDeTour($)
    await horloge.advance(10)
    expect(m.envoyes.length).toBe(1)

    const r = await $.tool.call({ tool: COMPACTER, instructions: 'Garde la PR #630.' })
    expect(r.deny).toBeUndefined()
    expect(m.compactages).toEqual([])
    await finDeTour($)
    await horloge.advance(500)
    expect(m.compactages).toEqual(['Garde les décisions.\n\nGarde la PR #630.'])

    await finDeTour($)
    await horloge.advance(10)
    expect(m.envoyes.length).toBe(2)
  })

  test('contexte_session décrit le remplissage et les seuils', async ($, on) => {
    mock.clock(on)
    monde(on, { pourcentage: 31 })
    const r = await $.tool.call({ tool: CONTEXTE })
    expect(String(r.result)).toContain('(31 %)')
    expect(String(r.result)).toContain('demande à 60 %, relance à 80 %, plancher 40 %')
  })
})
