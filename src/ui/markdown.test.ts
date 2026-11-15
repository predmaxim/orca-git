import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mdTree } from './markdown.ts'

const el = (tag: string, ...children: unknown[]) => ({ tag, children })

test('inline marks', () => {
  assert.deepEqual(mdTree('a **b** *c* `d <e>` ~~f~~'), [el('p', 'a ', el('strong', 'b'), ' ', el('em', 'c'), ' ', el('code', 'd <e>'), ' ', el('del', 'f'))])
})

test('raw HTML and unsafe links stay text', () => {
  assert.deepEqual(mdTree('<script>alert(1)</script>'), ['<script>alert(1)</script>'])
  assert.deepEqual(mdTree('x <img src=x onerror=alert(1)> [y](javascript:alert(1)) ![alt](https://a/b.png)'),
    [el('p', 'x <img src=x onerror=alert(1)> y alt')])
})

test('a web link keeps its address', () => {
  assert.deepEqual(mdTree('[docs](https://a.b/c)'), [el('p', { tag: 'a', href: 'https://a.b/c', children: ['docs'] })])
})

test('blocks', () => {
  assert.deepEqual(mdTree('# T\n\n- one\n- [x] two\n\n1. first\n\n> q\n\n```ts\na < b\n```\n\n---'), [
    el('h4', 'T'), el('ul', el('li', 'one'), el('li', '☑ two')), el('ol', el('li', 'first')),
    el('blockquote', el('p', 'q')), el('pre', el('code', 'a < b')), el('hr')
  ])
})

test('entities read as characters', () => {
  assert.deepEqual(mdTree('a &amp; b &lt;c&gt;'), [el('p', 'a & b <c>')])
})

test('a hard break', () => {
  assert.deepEqual(mdTree('one\ntwo  \nthree'), [el('p', 'one\ntwo', el('br'), 'three')])
})

test('a table', () => {
  assert.deepEqual(mdTree('| a | b |\n|---|---|\n| 1 | 2 |'), [el('table', el('tr', el('th', 'a'), el('th', 'b')), el('tr', el('td', '1'), el('td', '2')))])
})
