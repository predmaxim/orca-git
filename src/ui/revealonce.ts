import type { DiffTabState } from '../shared/protocol.ts'

/**
 * The note the Diff tab scrolls to on this state: its `reveal`, unless the tab did it already for this `open` (`done`, the
 * last one it did, kept by root in localStorage); null otherwise. The tab may read the same state again: on `diff.show`
 * after it started, or when its frame reloads.
 */
export const revealToDo = (state: Pick<DiffTabState, 'root' | 'open' | 'reveal'>, done: string | null): string | null =>
  state.reveal && state.open !== done ? state.reveal : null
