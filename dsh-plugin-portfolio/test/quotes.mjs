/**
 * Unit test for the qieman payload parser.
 *
 * qieman's MCP server answers with formatted text (a token-efficient table
 * rendering), not JSON, so the parser has to read that text. The fixture is a
 * real `BatchGetFundNavHistory` response captured from the live server.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mcpToolName, normalizeDate, parseNavHistory } from '../lib/quotes.js'

const fixture = await readFile(new URL('./fixtures/nav-history.toon.txt', import.meta.url), 'utf8')

// 1. The tool name matches what the MCP client registers on the profile.
assert.equal(mcpToolName('qieman'), 'mcp__qieman__BatchGetFundNavHistory')
assert.equal(mcpToolName('qieman', 'GetFundDiagnosis'), 'mcp__qieman__GetFundDiagnosis')

// 2. Chinese and ISO dates normalize to YYYY-MM-DD.
assert.equal(normalizeDate('2026年10月27日'), '2026-10-27')
assert.equal(normalizeDate('2026-9-7T00:00:00Z'), '2026-09-07')
assert.equal(normalizeDate('nonsense'), '')

// 3. Text payload wrapped in MCP content blocks parses to the newest NAV.
const fromContent = parseNavHistory({ content: [{ type: 'text', text: fixture }] })
assert.equal(fromContent.size, 2)
assert.deepEqual(fromContent.get('110011'), {
  price: 3.9349,
  date: '2026-10-27',
  prevPrice: 3.9411,
  prevDate: '2026-10-26',
  dailyReturn: '-0.16%',
})
assert.deepEqual(fromContent.get('161725'), {
  price: 0.5406,
  date: '2026-10-27',
  prevPrice: 0.5459,
  prevDate: '2026-10-26',
  dailyReturn: '-0.97%',
})

// 4. A bare text payload (no content wrapper) parses the same way.
assert.equal(parseNavHistory(fixture).get('110011').price, 3.9349)

// 5. JSON-shaped results still work (future server revisions).
const structured = parseNavHistory([
  { fundCode: '110011', data: { code: '110011', data: [{ navDate: '2026年10月27日', nav: 3.93, dailyReturn: '-0.1%' }] } },
])
assert.deepEqual(structured.get('110011'), {
  price: 3.93,
  date: '2026-10-27',
  prevPrice: null,
  prevDate: null,
  dailyReturn: '-0.1%',
})

// 6. Unknown or empty payloads produce an empty map instead of throwing.
assert.equal(parseNavHistory(undefined).size, 0)
assert.equal(parseNavHistory({ content: [{ type: 'text', text: 'nothing here' }] }).size, 0)

console.log('portfolio quotes test OK — text rendering, JSON fallback and date normalization')

// --- intraday quotes (stubbed feed; same field layout as the real one)
globalThis.fetch = async () => ({
  ok: true,
  async arrayBuffer() {
    const payload =
      'v_sh000300="1~沪深300~000300~4100.00~4083.87~0.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0.39";\n' +
      'v_sh518880="1~黄金ETF~518880~8.400~8.226~0.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~2.12";'
    return new TextEncoder().encode(payload).buffer
  },
})
const { fetchEtfQuotes } = await import('../lib/quotes.js')
const quotes = await fetchEtfQuotes(['sh000300', 'sh518880'])
assert.equal(quotes.size, 2)
assert.ok(Math.abs(quotes.get('sh000300').changePct - 0.395) < 0.01, 'index change computed from price/prevClose')
assert.ok(Math.abs(quotes.get('sh518880').changePct - 2.116) < 0.01, 'ETF change computed from price/prevClose')
assert.equal((await fetchEtfQuotes([])).size, 0)

// --- kline history (stubbed Eastmoney response)
globalThis.fetch = async () => ({
  ok: true,
  async json() {
    return {
      data: {
        klines: ['2026-10-28,7.1000', '2026-10-29,7.0500', 'bad,0', '2026-10-30,6.9900'],
      },
    }
  },
})
const { fetchKlineSeries, percentileRank } = await import('../lib/quotes.js')
const kline = await fetchKlineSeries('133.USDCNH', { limit: 3 })
assert.equal(kline.length, 3, 'invalid kline rows are dropped')
assert.equal(kline[2].date, '2026-10-30')
assert.ok(Math.abs(kline[2].close - 6.99) < 1e-9)

assert.equal(percentileRank([1, 2, 3, 4], 3), 50, 'percentile rank counts values below')
assert.equal(percentileRank([1, 2, 3, 4], 5), 100)
assert.equal(percentileRank([], 3), null)

// --- Sina fallback parsers (stubbed JSONP)
globalThis.fetch = async (url) => {
  const body = String(url).includes('GlobalFutures')
    ? '/*<script>location.href=\'//sina.com\';</script>*/ var t=([{"date":"2026-11-03","close":"3966.5"},{"date":"2026-11-04","close":"3978.2"}]);'
    : '/*<script></script>*/ var t=("2026-11-02,6.70,6.71,6.68,6.69,|2026-11-03,6.69,6.70,6.66,6.6699,");'
  return { ok: true, async text() { return body } }
}
const { fetchSinaFuturesDaily, fetchSinaUsdcnhDaily } = await import('../lib/quotes.js')
const sinaGold = await fetchSinaFuturesDaily({ limit: 10 })
const sinaFx = await fetchSinaUsdcnhDaily({ limit: 10 })
assert.equal(sinaGold.length, 2)
assert.ok(Math.abs(sinaGold[1].close - 3978.2) < 1e-9)
assert.equal(sinaFx.length, 2)
assert.ok(Math.abs(sinaFx[1].close - 6.6699) < 1e-9)

console.log('portfolio quotes test OK — text rendering, JSON fallback, date normalization, intraday quotes, kline history and percentile')
