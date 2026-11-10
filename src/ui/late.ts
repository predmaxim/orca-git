/**
 * The results of this panel's changes that Orca stopped waiting for (it gives up on a request after 120 s while git
 * goes on), matched by the request id the worker echoes in `action.done`.
 */
export function lateResults<R>() {
  const changes = new Map<string, { result?: R; finish?: (result: R) => void }>()
  let next = 0
  const prefix = Math.random().toString(36).slice(2)
  return {
    /** A new id for a change about to be sent. */
    start(): string {
      const id = `${prefix}-${++next}`
      changes.set(id, {})
      return id
    },
    /** Its request returned: nothing to wait for. */
    end(id: string): void {
      changes.delete(id)
    },
    /** Its request timed out: `finish` gets the result, at once if it already came. Whether it is still to come. */
    wait(id: string, finish: (result: R) => void): boolean {
      const change = changes.get(id)
      if (change && 'result' in change) {
        changes.delete(id)
        finish(change.result as R)
        return false
      }
      changes.set(id, { finish })
      return true
    },
    /** The worker posted the result of change `id`; ids of other panels are not here. */
    done(id: string, result: R): void {
      const change = changes.get(id)
      if (!change) return
      if (!change.finish) return void changes.set(id, { result })
      changes.delete(id)
      change.finish(result)
    },
    /** The worker started again: what the old one ran is never posted. Whether a change was waiting for it. */
    restart(): boolean {
      const waiting = [...changes.values()].some((change) => change.finish)
      changes.clear()
      return waiting
    }
  }
}
