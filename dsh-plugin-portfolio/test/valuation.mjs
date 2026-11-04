/**
 * Unit tests for the valuation bands and position metrics.
 * Pure functions — no MCP, no network.
 */
import assert from 'node:assert/strict'
import { capGold, classifyPosition, classifyTemperature, seriesMetrics } from '../lib/valuation.js'

// --- A-share temperature: official Yingmi bands (<30 undervalued, >70 overvalued)
assert.deepEqual(
  [classifyTemperature(8).band, classifyTemperature(8).fraction],
  ['极低估', 1],
)
assert.deepEqual([classifyTemperature(12.83).band, classifyTemperature(12.83).fraction], ['低估', 2 / 3])
assert.equal(classifyTemperature(36.63).band, '合理')
assert.equal(classifyTemperature(60).band, '偏高')
assert.equal(classifyTemperature(75).fraction, 0, 'above 70 stops buying')
assert.equal(classifyTemperature(undefined).band, '未知')
assert.equal(classifyTemperature(12.83).stopAbove, undefined, 'no separate stop threshold: it conflicted with the 30-50 band')

// --- position metrics from a synthetic series
const series = [
  { date: '2026-10-27', nav: 100 },
  { date: '2026-10-26', nav: 110 },
  { date: '2026-10-25', nav: 140 },
  { date: '2026-10-24', nav: 120 },
]
const metrics = seriesMetrics(series)
assert.equal(metrics.latest.nav, 100)
assert.equal(metrics.high.nav, 140)
assert.equal(metrics.high.date, '2026-10-25')
assert.ok(Math.abs(metrics.drawdownPct - -28.571) < 0.01)
const ma = (100 + 110 + 140 + 120) / 4
assert.ok(Math.abs(metrics.ma200 - ma) < 1e-9)
assert.ok(Math.abs(metrics.deviationPct - (100 / ma - 1) * 100) < 1e-9)
assert.equal(seriesMetrics([]), null)

// --- position bands: deep drawdown + below trend = cheap
const cheap = classifyPosition({ drawdownPct: -28.6, deviationPct: -9.2 })
assert.equal(cheap.band, '便宜')
assert.equal(cheap.fraction, 1)

// near the high and above trend = expensive
const expensive = classifyPosition({ drawdownPct: -1.3, deviationPct: 10.5 })
assert.equal(expensive.band, '贵')
assert.equal(expensive.fraction, 0)

// at trend (deviation ~0) regardless of drawdown → 合理, one quarter
const value = classifyPosition({ drawdownPct: -15, deviationPct: 0 })
assert.equal(value.band, '合理')
assert.equal(value.fraction, 0.25)
// slightly below trend → 合理偏低 (deviation is the primary signal)
const lower = classifyPosition({ drawdownPct: -15, deviationPct: -3 })
assert.equal(lower.band, '合理偏低')
assert.equal(lower.fraction, 1 / 3)

// missing data never buys
assert.equal(classifyPosition({}).fraction, 0)

// --- gold never fills on one signal
assert.equal(capGold(1), 0.5)
assert.equal(capGold(0.5), 0.5)
assert.equal(capGold(0), 0)

console.log('portfolio valuation test OK — official temperature bands, 200DMA position bands, gold cap')

// --- dividend band tilt: target stays inside 20-25, driven by temperature
const base = { '100032': 8, '008163': 5, '009051': 5, '020602': 4, '007169': 37 }
const options = { dividendCodes: ['100032', '008163', '009051', '020602'], bandMin: 20, bandMax: 25, cheapBelow: 10, expensiveAbove: 50, fundingCode: '007169' }
const { tiltDividend } = await import('../lib/valuation.js')
const cheapTilt = tiltDividend(base, options, 8)
const sumDiv = (map) => ['100032', '008163', '009051', '020602'].reduce((sum, code) => sum + map[code], 0)
assert.ok(Math.abs(sumDiv(cheapTilt.byCode) - 25) < 0.01, 'cheap temperature raises dividend to the band ceiling')
assert.ok(Math.abs(cheapTilt.byCode['007169'] - 34) < 0.01, 'the difference is funded from short bonds')
assert.equal(cheapTilt.meta.applied, true)
const expensiveTilt = tiltDividend(base, options, 60)
assert.ok(Math.abs(sumDiv(expensiveTilt.byCode) - 20) < 0.01, 'expensive temperature pushes dividend to the band floor')
const neutralTilt = tiltDividend(base, options, 12.8)
assert.ok(Math.abs(sumDiv(neutralTilt.byCode) - 22) < 0.01, 'inside the band the weight stays put')
assert.equal(neutralTilt.meta.applied, false)
const blockedTilt = tiltDividend(base, { ...options, dividendBands: { '100032': '偏高' }, blockUpTiltBands: ['偏高', '贵'] }, 8)
assert.ok(Math.abs(sumDiv(blockedTilt.byCode) - 22) < 0.01, 'dividend that is already expensive is not up-tilted')
assert.equal(blockedTilt.meta.applied, false)
const unknownTilt = tiltDividend(base, options, null)
assert.equal(unknownTilt.meta.applied, false, 'no temperature → no tilt')
assert.ok(Math.abs(Object.values(tiltDividend(base, options, 8).byCode).reduce((a, b) => a + b, 0) - 59) < 0.02, 'tilt is weight-neutral')

// --- trend regime (gold): alignment + slopes decide the per-run cap
const { classifyTrend } = await import('../lib/valuation.js')
const down = classifyTrend({ price: 3931, ma20: 4095, ma60: 4305, ma200: 4503, ma20SlopePct: -2, ma200SlopePct: -1 })
assert.equal(down.state, '下跌')
assert.equal(down.cap, 0.25)
const up = classifyTrend({ price: 5500, ma20: 5400, ma60: 5200, ma200: 5000, ma20SlopePct: 1.5, ma200SlopePct: 0.8 })
assert.equal(up.state, '上涨')
assert.equal(up.cap, 0.5)
const flat = classifyTrend({ price: 5000, ma20: 4990, ma60: 5000, ma200: 4980, ma20SlopePct: 0.1, ma200SlopePct: -0.1 })
assert.equal(flat.state, '震荡')
assert.equal(flat.cap, 0.375)

console.log('portfolio valuation test OK — official temperature bands, 200DMA position bands, gold cap, dividend tilt and gold trend regime')
