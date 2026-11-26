// Exercises the HTML panel in Chromium. Orca's component test kit does not mount HTML entries.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import * as nodeModule from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('the Git panel restores each worktree through navigation and a fresh frame', async (t) => {
  const chromium = process.env.CHROMIUM_BIN || 'chromium'
  if (!nodeModule.stripTypeScriptTypes || spawnSync(chromium, ['--version']).status !== 0) {
    return t.skip('requires Chromium and Node with TypeScript stripping')
  }
  const result = Promise.withResolvers()
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    try {
      if (path === '/result' && req.method === 'POST') {
        let message = ''
        for await (const chunk of req) message += chunk
        res.end()
        result.resolve(message)
      } else if (path === '/') {
        res.end('<script type="module" src="/test/panel-selection.js"></script>')
      } else if (path === '/test/panel-selection.js' || /^\/src\/(?:[\w-]+\/)*[\w.-]+\.(?:js|ts|html|css|svg)$/.test(path)) {
        let source = await readFile(new URL('..' + path, import.meta.url), 'utf8')
        if (path.endsWith('.ts')) source = nodeModule.stripTypeScriptTypes(source)
        if (path.endsWith('panel.html')) source = source.replace('<script type="module"', '<script>window.orca = parent.bridge()</script><script type="module"')
        const type = path.endsWith('.html') ? 'text/html' : path.endsWith('.css') ? 'text/css' : path.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript'
        res.writeHead(200, { 'content-type': type + '; charset=utf-8' }).end(source)
      } else res.writeHead(404).end()
    } catch (error) {
      res.writeHead(500).end()
      result.reject(error)
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const profile = await mkdtemp(join(tmpdir(), 'git-log-panel-test-'))
  const browser = spawn(chromium, ['--headless', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--user-data-dir=' + profile, 'http://127.0.0.1:' + server.address().port], { stdio: 'ignore' })
  const exited = new Promise((resolve) => browser.once('exit', resolve))
  const timer = setTimeout(() => result.reject(new Error('panel test timed out')), 20000)
  try {
    assert.equal(await result.promise, 'ok')
  } finally {
    clearTimeout(timer)
    browser.kill()
    await exited
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
