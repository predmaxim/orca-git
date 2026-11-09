import assert from 'node:assert/strict'
import { test } from 'node:test'
import { highlightLines, languageFor, markRange } from './highlight.ts'

test('a token spanning lines is closed and reopened on each line', () => {
  const out = highlightLines(['const a = `x', 'y`'], 'typescript')
  assert.ok(out[0].endsWith('</span>'))
  assert.ok(out[1].startsWith('<span class="hljs-string">'))
})

test('unknown languages and long lines are only escaped', () => {
  assert.deepEqual(highlightLines(['<b>'], null), ['&lt;b&gt;'])
  const long = highlightLines(['const a = 1', 'x'.repeat(2001)], 'typescript')
  assert.ok(!long.join('').includes('<span'))
})

test('markRange wraps text across token boundaries', () => {
  const out = markRange('<span class="hljs-keyword">const</span> a', 3, 7, 'word')
  assert.equal(out, '<span class="hljs-keyword">con<span class="word">st</span></span><span class="word"> a</span>')
  assert.equal((out.match(/<span/g) ?? []).length, (out.match(/<\/span>/g) ?? []).length)
})

test('markRange counts an entity as one character', () => {
  assert.equal(markRange('a &lt; b', 2, 3, 'word'), 'a <span class="word">&lt;</span> b')
})

test('languageFor maps extensions and well-known names', () => {
  assert.equal(languageFor('a/b.ts'), 'typescript')
  assert.equal(languageFor('Dockerfile'), 'dockerfile')
  assert.equal(languageFor('x.unknown'), null)
})
