// diagnostic, remove once the blank Diff tab is explained: runs before anything else of the page and says, in `orca plugin logs`
// (worker frame.trace), that the page loaded, which of its files did not, and whether the module (diff-app.ts) started.
;(() => {
  const id = Math.random().toString(36).slice(2, 6)
  const trace = (what) =>
    window.orca?.plugin
      .request('frame.trace', { line: `${id} boot ${what} | ${innerWidth}x${innerHeight} ${document.visibilityState}`, locale: window.orca.locale })
      .catch(() => undefined)
  trace(window.orca ? 'html' : 'html, no window.orca')
  addEventListener(
    'error',
    (event) => {
      const target = event.target
      if (target && target !== window) trace(`file failed ${target.src || target.href || target.tagName}`)
    },
    true
  )
  addEventListener('load', () => trace(`load, module ${window.__gitLogDiffStarted ? 'started' : 'NOT started'}`))
})()
