import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseScriptMetadata } from '../src/script-sync.mjs'

const sourceUrl = new URL('../../worker/agent-scripts/rss_fetch/1.0.0.mjs', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')

test('RSS remote script metadata is valid and fetch results retain source IDs', async () => {
  const metadata = parseScriptMetadata(source)
  assert.equal(metadata.id, 'rss_fetch')
  assert.equal(metadata.reliability, 'best_effort')

  const root = await mkdtemp(join(process.cwd(), '.rss-remote-test-'))
  try {
    const path = join(root, 'rss-script.mjs')
    await writeFile(path, source)
    const module = await import(pathToFileURL(path).href + '?test=' + Date.now())
    const xml = [
      '<?xml version="1.0"?>',
      '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">',
      '<channel><title>Example</title><link>https://example.com</link>',
      '<item><guid>item-1</guid><title>First post</title>',
      '<link>https://example.com/posts/1</link>',
      '<pubDate>Fri, 13 Nov 2026 10:00:00 GMT</pubDate>',
      '<content:encoded><![CDATA[<p>Hello</p>]]></content:encoded>',
      '</item></channel></rss>',
    ].join('')
    const result = await module.run({
      signal: new AbortController().signal,
      fetch: async () => new Response(xml, { status: 200, headers: { 'content-type': 'application/rss+xml' } }),
      logger: { warn() {} },
    }, {
      sources: [{ sourceId: 'source-1', url: 'https://example.com/feed.xml' }],
    })
    assert.equal(result.items.length, 1)
    assert.equal(result.items[0].sourceId, 'source-1')
    assert.equal(result.items[0].externalId, 'item-1')
    assert.equal(result.items[0].title, 'First post')
    assert.equal(result.items[0].publishedAt, Date.parse('Fri, 13 Nov 2026 10:00:00 GMT'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
