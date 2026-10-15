import type { EngineInterface, PluginOptions } from 'claude-code'

export const NOM = 'proactive-compact-mod'

export type Reglages = {
  actif: boolean
  seuilDemande: number
  seuilRelance: number
  plancher: number
  messageDemande: string
  messageRelance: string
  complement: string
  instructionsCompactage: string
}

export type Source = 'défaut' | 'global' | 'projet' | 'local'

export type ReglagesSources = { valeurs: Reglages; sources: Record<keyof Reglages, Source> }

const POURCENTAGES = ['seuilDemande', 'seuilRelance', 'plancher'] as const
const TEXTES = ['messageDemande', 'messageRelance', 'complement', 'instructionsCompactage'] as const

const CLES: readonly (keyof Reglages)[] = ['actif', ...POURCENTAGES, ...TEXTES]

// Les options reçues au chargement portent déjà les défauts du manifeste ;
// seules les surcharges de projet sont relues à chaque usage, pour qu'une
// modification du fichier du dépôt prenne effet sans recharger le mod.
export async function chargerReglages(
  $: EngineInterface,
  options: PluginOptions,
): Promise<ReglagesSources> {
  const [utilisateur, projet, local] = await Promise.all([
    lireSurcharges($, 'user'),
    lireSurcharges($, 'project'),
    lireSurcharges($, 'local'),
  ])
  const valeurs = {} as Record<keyof Reglages, unknown>
  const sources = {} as Record<keyof Reglages, Source>
  for (const cle of CLES) {
    valeurs[cle] = options[cle]
    sources[cle] = cle in utilisateur ? 'global' : 'défaut'
    for (const [couche, source] of [[projet, 'projet'], [local, 'local']] as const) {
      const valeur = valide(cle, couche[cle])
      if (valeur !== undefined) {
        valeurs[cle] = valeur
        sources[cle] = source
      }
    }
  }
  return { valeurs: valeurs as Reglages, sources }
}

async function lireSurcharges(
  $: EngineInterface,
  source: 'user' | 'project' | 'local',
): Promise<Record<string, unknown>> {
  const reglages = (await $.settings.read({ source })) as {
    pluginConfigs?: Record<string, { options?: Record<string, unknown> }>
  }
  const configs = reglages.pluginConfigs ?? {}
  const cle = Object.keys(configs).find(nom => nom === NOM || nom.startsWith(`${NOM}@`))
  return (cle && configs[cle]?.options) || {}
}

function valide(cle: keyof Reglages, valeur: unknown): unknown {
  if (valeur === undefined) return undefined
  if (cle === 'actif') return typeof valeur === 'boolean' ? valeur : undefined
  if ((POURCENTAGES as readonly string[]).includes(cle)) {
    const nombre = Number(valeur)
    return Number.isFinite(nombre) && nombre >= 0 && nombre <= 100 ? nombre : undefined
  }
  return typeof valeur === 'string' ? valeur : undefined
}

export function messageDuNiveau(
  reglages: Reglages,
  niveau: 1 | 2,
  pourcentage: number,
  outil: string,
): string {
  const gabarit =
    niveau === 2 && reglages.messageRelance.trim() !== ''
      ? reglages.messageRelance
      : reglages.messageDemande
  const seuil = niveau === 2 ? reglages.seuilRelance : reglages.seuilDemande
  const texte = gabarit
    .replaceAll('{pourcentage}', String(pourcentage))
    .replaceAll('{seuil}', String(seuil))
    .replaceAll('{plancher}', String(reglages.plancher))
    .replaceAll('{outil}', outil)
  const complement = reglages.complement.trim()
  return complement === '' ? texte : `${texte}\n\n${complement}`
}

export function instructionsDuResume(reglages: Reglages, deLAgent: string | null): string | undefined {
  const parties = [reglages.instructionsCompactage.trim(), deLAgent?.trim() ?? ''].filter(p => p !== '')
  return parties.length === 0 ? undefined : parties.join('\n\n')
}
