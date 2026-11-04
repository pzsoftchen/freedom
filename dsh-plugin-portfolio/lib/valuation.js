/**
 * Valuation bands: the single place where "cheap or expensive" is decided.
 *
 * Two families of signal, deliberately kept apart:
 *
 *  - A shares: the Yingmi market temperature (0–100, PE + PB + risk-premium
 *    weighted, official bands <30 undervalued / >70 overvalued).
 *  - Everything else: price position — drawdown from the 1-year high plus the
 *    deviation from the 200-day moving average. That is a *position* signal,
 *    not a valuation signal; it only answers "is this cheaper than its recent
 *    high and is it below its trend".
 *
 * Hysteresis: bands are reported with their buy thresholds, but the caller
 * should act at most once a month and use the wider "stop" threshold (e.g.
 * A shares buy below 30, stop adding above 40) so a price hovering at a
 * boundary cannot flip the decision every week.
 */

/** Official Yingmi bands for A-share temperature. */
export const TEMPERATURE_BANDS = [
  { max: 10, band: '极低估', fraction: 1, note: '买满剩余额度' },
  { max: 30, band: '低估', fraction: 2 / 3, note: '买 2/3' },
  { max: 50, band: '合理', fraction: 1 / 3, note: '买 1/3（慢）' },
  { max: 70, band: '偏高', fraction: 1 / 4, note: '买 1/4 或等' },
  { max: Infinity, band: '高估', fraction: 0, note: '不买' },
]

/** Classify an A-share temperature reading. */
export function classifyTemperature(temperature) {
  const value = Number(temperature)
  if (!Number.isFinite(value)) return { band: '未知', fraction: 0, note: '缺少温度数据' }
  const found = TEMPERATURE_BANDS.find((entry) => value < entry.max) ?? TEMPERATURE_BANDS.at(-1)
  return {
    band: found.band,
    fraction: found.fraction,
    note: found.note,
    temperature: value,
  }
}

/**
 * Compute position metrics from a newest-first NAV series.
 * @param {Array<{ date: string, nav: number }>} series
 */
export function seriesMetrics(series) {
  if (!Array.isArray(series) || series.length === 0) return null
  const sorted = [...series]
    .filter((row) => row && Number.isFinite(row.nav) && typeof row.date === 'string')
    .sort((a, b) => b.date.localeCompare(a.date))
  if (sorted.length === 0) return null
  const latest = sorted[0]
  const window = sorted.slice(0, 243)
  const high = window.reduce((best, row) => (row.nav > best.nav ? row : best), window[0])
  const maWindow = sorted.slice(0, Math.min(200, sorted.length))
  const ma = maWindow.reduce((sum, row) => sum + row.nav, 0) / maWindow.length
  return {
    latest,
    high,
    points: sorted.length,
    maPoints: maWindow.length,
    ma200: Number.isFinite(ma) && ma > 0 ? ma : null,
    drawdownPct: Number.isFinite(latest.nav / high.nav) ? (latest.nav / high.nav - 1) * 100 : null,
    deviationPct: Number.isFinite(ma) && ma > 0 ? (latest.nav / ma - 1) * 100 : null,
  }
}

/**
 * Position-based band for overseas equity, gold and long bonds.
 * Score comes from drawdown (vs 1-year high) and deviation (vs 200DMA).
 */
export function classifyPosition({ drawdownPct, deviationPct } = {}) {
  const dd = Number.isFinite(drawdownPct) ? drawdownPct : null
  const dev = Number.isFinite(deviationPct) ? deviationPct : null
  if (dd === null && dev === null) return { band: '未知', fraction: 0, score: 0, note: '缺少净值序列' }

  // Deviation from the 200-day average is the primary signal; drawdown from
  // the 1-year high only confirms it (the two are correlated, so weighting
  // both equally double-counted the same price move).
  let score = 0
  if (dev !== null) {
    if (dev <= -5) score += 2
    else if (dev <= -2) score += 1
    else if (dev >= 10) score -= 2
    else if (dev >= 3) score -= 1
  }
  if (dd !== null) {
    if (dd <= -20) score += 1
    else if (dd >= -3) score -= 1
  }

  if (score >= 3) return { band: '便宜', fraction: 1, score, note: '回撤深且低于趋势' }
  if (score === 2) return { band: '偏低', fraction: 1 / 2, score, note: '买 1/2' }
  if (score === 1) return { band: '合理偏低', fraction: 1 / 3, score, note: '买 1/3' }
  if (score === 0) return { band: '合理', fraction: 1 / 4, score, note: '买 1/4' }
  if (score === -1) return { band: '偏高', fraction: 1 / 10, score, note: '只买 1/10 或等' }
  return { band: '贵', fraction: 0, score, note: '不买' }
}

/** Gold cap: long-run gains stay high, so never fill the sleeve on one signal. */
export function capGold(fraction) {
  const value = Number(fraction)
  if (!Number.isFinite(value)) return 0
  return Math.min(value, 0.5)
}

const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100

/** Percent helper for reports. */
export function pct(value, digits = 2) {
  return Number.isFinite(value) ? `${value.toFixed(digits)}%` : '—'
}

/**
 * Dividend sleeve tilt: keep the dividend target inside a band, and let the
 * A-share temperature move it within (and only within) that band.
 * The offset is taken from one funding sleeve (short bonds) so the total stays 100.
 *
 * @param {Record<string, number>} byCode base target weights (percent)
 * @param {{dividendCodes: string[], bandMin: number, bandMax: number, cheapBelow: number, expensiveAbove: number, fundingCode: string}} options
 * @param {number|null} temperature A-share temperature, null when unknown
 * @returns {{byCode: Record<string, number>, meta: object}}
 */
export function tiltDividend(byCode, options, temperature) {
  const codes = options.dividendCodes ?? []
  const current = round2(codes.reduce((sum, code) => sum + (Number(byCode[code]) || 0), 0))
  if (codes.length === 0 || current <= 0) return { byCode: { ...byCode }, meta: { applied: false, current } }

  const bandMin = Number.isFinite(options.bandMin) ? options.bandMin : 20
  const bandMax = Number.isFinite(options.bandMax) ? options.bandMax : 25
  const temp = Number.isFinite(temperature) ? temperature : null
  let target = current
  let reason = '温度未知，保持现状'
  if (temp !== null) {
    const blockedBands = options.blockUpTiltBands ?? []
    const currentBands = (options.dividendBands ?? {}) || {}
    const blocked = codes.filter((code) => blockedBands.includes(currentBands[code]))
    if (temp < (Number.isFinite(options.cheapBelow) ? options.cheapBelow : 10) && blocked.length > 0) {
      target = current
      reason = `温度 ${temp}° 便宜，但红利自身位置（${blocked
        .map((code) => `${code}:${currentBands[code]}`)
        .join('、')}）不便宜，暂不提高目标`
    } else if (temp < (Number.isFinite(options.cheapBelow) ? options.cheapBelow : 10)) {
      target = bandMax
      reason = `温度 ${temp}° < 便宜阈值，红利提到区间上限 ${bandMax}%`
    } else if (temp > (Number.isFinite(options.expensiveAbove) ? options.expensiveAbove : 50)) {
      target = bandMin
      reason = `温度 ${temp}° > 贵阈值，红利压回区间下限 ${bandMin}%`
    } else {
      target = Math.min(bandMax, Math.max(bandMin, current))
      reason = `温度 ${temp}° 在区间内，红利保持 ${target}%`
    }
  }
  target = round2(Math.min(bandMax, Math.max(bandMin, target)))
  const delta = round2(target - current)
  if (Math.abs(delta) < 0.01) {
    return { byCode: { ...byCode }, meta: { applied: false, current, target, delta: 0, temperature: temp, reason } }
  }

  const next = { ...byCode }
  let allocated = 0
  codes.forEach((code, index) => {
    const weight = Number(byCode[code]) || 0
    const share = current > 0 ? weight / current : 1 / codes.length
    let add = round2(delta * share)
    if (index === codes.length - 1) add = round2(delta - allocated)
    allocated = round2(allocated + add)
    next[code] = round2(weight + add)
  })
  const funding = options.fundingCode ?? '007169'
  next[funding] = round2((Number(byCode[funding]) || 0) - delta)
  return {
    byCode: next,
    meta: { applied: true, current, target, delta, temperature: temp, reason, fundingCode: funding },
  }
}

/**
 * Trend regime from moving-average alignment + slopes.
 * Gold has long cycles, so the position window should be multi-year and the
 * trend filter should look at alignment rather than a single 200-day line.
 * @param {{price:number, ma20:number, ma60:number, ma200:number, ma20SlopePct:number, ma200SlopePct:number}} input
 * @returns {{state: '下跌'|'震荡'|'上涨', cap: number, note: string}}
 */
export function classifyTrend(input) {
  const { price, ma20, ma60, ma200, ma20SlopePct, ma200SlopePct } = input ?? {}
  if (![price, ma20, ma60, ma200].every((value) => Number.isFinite(value))) {
    return { state: '震荡', cap: 0.375, note: '趋势数据不足，按震荡处理' }
  }
  const belowAll = price < ma20 && ma20 < ma60 && ma60 < ma200
  const aboveAll = price > ma20 && ma20 > ma60 && ma60 > ma200
  const falling = Number.isFinite(ma20SlopePct) && Number.isFinite(ma200SlopePct) && ma20SlopePct < 0 && ma200SlopePct < 0
  const rising = Number.isFinite(ma20SlopePct) && Number.isFinite(ma200SlopePct) && ma20SlopePct > 0 && ma200SlopePct > 0
  if (belowAll && falling) {
    return { state: '下跌', cap: 0.25, note: '空头排列（价<20<60<200 日线）且均线走低 → 单次上限降到 1/4' }
  }
  if (aboveAll && rising) {
    return { state: '上涨', cap: 0.5, note: '多头排列（价>20>60>200 日线）→ 恢复 1/2 上限' }
  }
  return { state: '震荡', cap: 0.375, note: '均线纠缠/方向不一致 → 单次上限 3/8' }
}
