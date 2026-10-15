import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { CompactageEnAttente } from '../types'
import {
  chargerReglages,
  instructionsDuResume,
  messageDuNiveau,
  NOM,
  type Reglages,
  type Source,
} from './reglages'

const NIVEAU = { plugin: 'proactive-compact-mod', key: 'niveau' } as const
const EN_ATTENTE = { plugin: 'proactive-compact-mod', key: 'enAttente' } as const

const OUTIL_COMPACTER = `mcp__${NOM}__compacter_session`

// Un compactage échoue tant qu'un tour tourne : on retente jusqu'à ce que la
// session soit au repos, environ deux minutes au plus.
const ESSAIS_MAX = 40
const ATTENTE_ENTRE_ESSAIS_MS = 3000

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await Promise.all([
      $.tool.register({
        name: 'contexte_session',
        description:
          "Donne le remplissage du contexte de la session principale : tokens, fenêtre, pourcentage, seuils de demande et de relance, plancher de compactage. Avec `detail: true`, ajoute la ventilation estimée par catégorie et le seuil de compactage automatique.",
        inputSchema: {
          type: 'object',
          properties: { detail: { type: 'boolean', description: 'Ajoute la ventilation par catégorie.' } },
        },
        isDeferred: false,
      }),
      $.tool.register({
        name: 'compacter_session',
        description:
          "Programme le compactage de la session principale, exécuté dès la fin du tour en cours. À appeler une fois les mémoires et documents de suivi à jour, à un moment calme. Refusé sous le plancher réglé. Après l'appel, termine ton tour sans autre outil.",
        inputSchema: {
          type: 'object',
          properties: {
            instructions: {
              type: 'string',
              description: 'Ce que le résumé doit garder ou souligner, comme après /compact.',
            },
          },
        },
        isDeferred: false,
      }),
      $.command.register({
        name: 'compactage',
        description: 'Demandes de compactage : état, on, off, réglages',
        argumentHint: '[statut|on|off|reglages]',
      }),
    ])
    return next(e)
  })

  on('tool.call', { tool: 'mcp__proactive-compact-mod__contexte_session' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: 'Réservé à la session principale.' }
    const detail = (e as { detail?: unknown }).detail === true
    return { result: await decrireContexte($, options, detail) }
  })

  on('tool.call', { tool: 'mcp__proactive-compact-mod__compacter_session' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: 'Réservé à la session principale.' }
    const { valeurs } = await chargerReglages($, options)
    const pourcentage = (await $.session.usage()).context.percent ?? 0
    if (pourcentage < valeurs.plancher) {
      return {
        deny: `Compactage refusé : le contexte est à ${pourcentage} %, sous le plancher de ${valeurs.plancher} %.`,
      }
    }
    const brut = (e as { instructions?: unknown }).instructions
    const instructions = typeof brut === 'string' && brut.trim() !== '' ? brut : null
    await $.state.set(EN_ATTENTE, { instructions })
    $.ui.status('compactage programmé')
    return {
      result:
        'Compactage programmé : il partira dès la fin de ce tour. Termine ton tour maintenant, en une phrase, sans autre appel d’outil.',
    }
  })

  on('turn.complete', async ($, e, next) => {
    const reponse = await next(e)
    if (e.agentId !== undefined) return reponse

    const { value: enAttente = null } = await $.state.get(EN_ATTENTE)
    if (enAttente !== null) {
      if (e.reason === 'answer') {
        $.clock.after(300, () => void compacter($, options, enAttente, 0))
      } else {
        await $.state.set(EN_ATTENTE, null)
        $.ui.status(undefined)
        $.ui.toast('Compactage annulé : le tour a été interrompu.')
      }
      return reponse
    }

    if (e.reason === 'answer') await envoyerSiBesoin($, options)
    return reponse
  })

  // Un compactage venu d'ailleurs (/compact, l'automatique) réarme aussi la demande et la relance.
  on('session.compact', async ($, e, next) => {
    const resultat = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && !('skip' in resultat && resultat.skip)) {
      await reinitialiser($)
    }
    return resultat
  })

  on('command.run', { command: 'compactage' }, async ($, e) => {
    const verbe = e.args.trim().toLowerCase()
    if (verbe === 'on' || verbe === 'off') return { text: await basculer($, options, verbe === 'on') }
    if (verbe === 'reglages' || verbe === 'réglages') return { text: AIDE_REGLAGES }
    if (verbe === '' || verbe === 'statut') return { text: await decrireContexte($, options, false) }
    return { text: `Argument inconnu : « ${verbe} ». Attendu : statut, on, off ou reglages.` }
  })
}

async function envoyerSiBesoin($: EngineInterface, options: PluginOptions): Promise<void> {
  const { valeurs } = await chargerReglages($, options)
  const pourcentage = (await $.session.usage()).context.percent ?? 0
  const { value: niveau = 0 } = await $.state.get(NIVEAU)

  if (pourcentage < valeurs.seuilDemande) {
    if (niveau > 0) await reinitialiser($)
    return
  }
  if (!valeurs.actif) return

  const cible = pourcentage >= valeurs.seuilRelance && niveau < 2 ? 2 : niveau < 1 ? 1 : 0
  if (cible === 0) return

  await $.state.set(NIVEAU, cible)
  $.ui.status(`${cible === 2 ? 'relance envoyée' : 'demande de compactage envoyée'} à ${pourcentage} %`)
  const text = messageDuNiveau(valeurs, cible, pourcentage, OUTIL_COMPACTER)
  // Le prompt démarre un tour à lui dès que la session est au repos.
  $.clock.after(0, () => void $.prompt.submit({ text }))
}

async function compacter(
  $: EngineInterface,
  options: PluginOptions,
  enAttente: CompactageEnAttente,
  essai: number,
): Promise<void> {
  const { valeurs } = await chargerReglages($, options)
  try {
    const resultat = await $.session.compact({
      instructions: instructionsDuResume(valeurs, enAttente.instructions),
    })
    if ('skip' in resultat && resultat.skip) {
      await $.state.set(EN_ATTENTE, null)
      $.ui.status(undefined)
      $.ui.toast(`Compactage refusé : ${resultat.skip}`)
      return
    }
    await reinitialiser($)
  } catch {
    if (essai + 1 < ESSAIS_MAX) {
      $.clock.after(ATTENTE_ENTRE_ESSAIS_MS, () => void compacter($, options, enAttente, essai + 1))
      return
    }
    await $.state.set(EN_ATTENTE, null)
    $.ui.status(undefined)
    $.ui.toast('Compactage abandonné : la session n’a pas été au repos assez longtemps.')
  }
}

async function reinitialiser($: EngineInterface): Promise<void> {
  await Promise.all([$.state.set(NIVEAU, 0), $.state.set(EN_ATTENTE, null)])
  $.ui.status(undefined)
}

async function basculer($: EngineInterface, options: PluginOptions, actif: boolean): Promise<string> {
  const ligne = (await $.config.list()).find(r => r.key === `${NOM}.actif` || r.key.startsWith(`${NOM}@`) && r.key.endsWith('.actif'))
  if (ligne === undefined) return 'Réglage « actif » introuvable dans /config.'
  const { deny } = await $.config.set({ key: ligne.key, value: actif })
  if (deny !== undefined) return `Refusé : ${deny}`
  const { sources } = await chargerReglages($, options)
  const avertissement =
    sources.actif === 'projet' || sources.actif === 'local'
      ? ` Attention : les réglages ${sources.actif === 'projet' ? 'du projet' : 'locaux'} fixent « actif » et l’emportent ici.`
      : ''
  return `Demandes de compactage ${actif ? 'activées' : 'désactivées'} pour tous les projets.${avertissement}`
}

async function decrireContexte($: EngineInterface, options: PluginOptions, detail: boolean): Promise<string> {
  const [{ valeurs, sources }, usage, niveau, enAttente] = await Promise.all([
    chargerReglages($, options),
    $.session.usage(detail ? { breakdown: 'summary' } : undefined),
    $.state.get(NIVEAU),
    $.state.get(EN_ATTENTE),
  ])
  const { tokens, window, percent } = usage.context
  const s = (cle: keyof Reglages) => (sources[cle] === 'défaut' ? '' : ` (${sources[cle]})`)
  const lignes = [
    `Contexte : ${tokens === undefined ? 'pas encore mesuré' : `${nombre(tokens)} tokens sur ${nombre(window)} (${percent ?? 0} %)`}.`,
    `Demandes : ${valeurs.actif ? 'actives' : 'désactivées'}${s('actif')} ; demande à ${valeurs.seuilDemande} %${s('seuilDemande')}, relance à ${valeurs.seuilRelance} %${s('seuilRelance')}, plancher ${valeurs.plancher} %${s('plancher')}.`,
    `Dernier message envoyé : ${['aucun', 'demande', 'relance'][niveau.value ?? 0] ?? 'aucun'}. Compactage programmé : ${enAttente.value ? 'oui' : 'non'}.`,
  ]
  const surcharges = (Object.entries(sources) as [keyof Reglages, Source][])
    .filter(([cle, source]) => (source === 'projet' || source === 'local') && !['actif', 'seuilDemande', 'seuilRelance', 'plancher'].includes(cle))
    .map(([cle, source]) => `${cle} (${source})`)
  if (surcharges.length > 0) lignes.push(`Textes surchargés : ${surcharges.join(', ')}.`)

  const ventilation = usage.context.breakdown
  if (ventilation !== undefined) {
    const auto = ventilation.isAutoCompactEnabled
      ? `compactage automatique vers ${nombre(ventilation.autoCompactThreshold ?? ventilation.maxTokens)} tokens`
      : 'compactage automatique désactivé'
    lignes.push(`Ventilation estimée (${auto}) :`)
    for (const c of ventilation.categories.filter(c => !c.isDeferred && c.tokens > 0)) {
      lignes.push(`- ${c.name} : ${nombre(c.tokens)}`)
    }
  }
  return lignes.join('\n')
}

function nombre(n: number): string {
  return n.toLocaleString('fr-FR')
}

const AIDE_REGLAGES = `Réglages globaux : /config, lignes « ${NOM} » (seuils, plancher, messages, complément, instructions).
Surcharge par projet : dans .claude/settings.json (partagé) ou .claude/settings.local.json (personnel) du dépôt, par exemple :
{ "pluginConfigs": { "${NOM}": { "options": { "seuilDemande": 50, "complement": "Mets aussi à jour docs/…" } } } }
Variables des messages : {pourcentage}, {seuil}, {plancher}, {outil}. Un message de relance vide reprend celui de la demande.`
