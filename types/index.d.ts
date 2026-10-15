/** Un compactage demandé par l'agent, exécuté à la fin de son tour. */
export type CompactageEnAttente = { instructions: string | null }

declare module 'claude-code' {
  interface PluginState {
    'proactive-compact-mod': {
      /** Dernier message envoyé depuis le dernier compactage : 0 aucun, 1 demande, 2 relance. */
      niveau: number
      enAttente: CompactageEnAttente | null
    }
  }
}
