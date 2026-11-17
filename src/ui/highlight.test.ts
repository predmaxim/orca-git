import assert from 'node:assert/strict'
import { test } from 'node:test'
import { highlightLines, languageFor, loadLanguage, markRange } from './highlight.ts'

await loadLanguage('typescript')

test('a token spanning lines is closed and reopened on each line', () => {
  const out = highlightLines(['const a = `x', 'y`'], 'typescript')
  assert.ok(out[0].endsWith('</span>'))
  assert.ok(out[1].startsWith('<span class="hljs-string">'))
})

test('a doc comment is marked apart from other comments, on each of its lines', () => {
  const out = highlightLines(['/** a', ' * b */', '// c', '/* d */', '/**/'], 'typescript')
  assert.ok(out[0].startsWith('<span class="hljs-comment hljs-doc">'))
  assert.ok(out[1].startsWith('<span class="hljs-comment hljs-doc">'))
  assert.ok(!out.slice(2).join('').includes('hljs-doc'))
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

test('a grammar loads when asked for, with those it embeds; until then the text is plain', async () => {
  assert.ok(!highlightLines(['def f(): pass'], 'python').join('').includes('<span'))
  assert.equal(await loadLanguage('python'), true)
  assert.ok(highlightLines(['def f(): pass'], 'python').join('').includes('hljs-keyword'))
  // xml hands <script> to javascript and <style> to css: both come with it, at once.
  assert.equal(await loadLanguage('xml'), true)
  assert.ok(highlightLines(['<script>const a = 1</script>'], 'xml').join('').includes('hljs-keyword'))
  assert.ok(highlightLines(['<style>a { color: red }</style>'], 'xml').join('').includes('hljs-selector-tag'))
  assert.equal(await loadLanguage(null), false)
  assert.equal(await loadLanguage('cobol'), false)
})
