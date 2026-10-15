/** A compaction the agent asked for, run when its turn ends. */
export type PendingCompact = { instructions: string | null }

declare module 'claude-code' {
  interface PluginState {
    'proactive-compact-mod': {
      /** Last message sent since the last compaction: 0 none, 1 compact request, 2 reminder. */
      level: number
      pending: PendingCompact | null
    }
  }
}
