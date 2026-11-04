/**
 * Deterministic portfolio math: market value, cost, P&L, weights, asset-class
 * mix, concentration, target drift and rebalance suggestions.
 *
 * This module never fetches prices. The agent supplies price/NAV values it got
 * from a market-data source (for example the qieman MCP tools), and this module
 * only does arithmetic and bookkeeping, so results are reproducible and cheap.
 */
import { KIND_LABELS, HOLDING_KINDS } from './store.js'

const round = (value, digits = 2) => {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

/** Market value of one holding. Cash defaults to price 1. */
export function holdingValue(holding) {
  const price =
    Number.isFinite(holding.price) ? holding.price : holding.kind === 'cash' ? 1 : undefined
  if (price === undefined) return { value: 0, priced: false }
  return { value: holding.units * price, priced: true }
}

function holdingCost(holding) {
  if (!Number.isFinite(holding.costPrice)) return 0
  return holding.units * holding.costPrice
}

/**
 * @param {object} doc portfolio document from the store
 * @param {{ staleAfterDays?: number, now?: Date }} [options]
 */
export function analyze(doc, options = {}) {
  const now = options.now ?? new Date()
  const staleAfterDays = Number.isFinite(options.staleAfterDays) ? options.staleAfterDays : 7
  const rows = []
  const warnings = []
  let unpriced = 0

  for (const holding of doc.holdings) {
    const { value, priced } = holdingValue(holding)
    if (!priced) unpriced += 1
    const cost = holdingCost(holding)
    const price = Number.isFinite(holding.price) ? holding.price : holding.kind === 'cash' ? 1 : null
    const prevPrice = Number.isFinite(holding.prevPrice) ? holding.prevPrice : null
    rows.push({
      code: holding.code,
      name: holding.name,
      kind: holding.kind,
      kindLabel: KIND_LABELS[holding.kind] ?? holding.kind,
      units: holding.units,
      price,
      priceDate: typeof holding.priceDate === 'string' ? holding.priceDate : null,
      prevPrice,
      prevPriceDate: typeof holding.prevPriceDate === 'string' ? holding.prevPriceDate : null,
      dayChange: prevPrice !== null && price !== null ? round(price - prevPrice, 4) : null,
      dayPnl: prevPrice !== null && price !== null ? round((price - prevPrice) * (Number(holding.units) || 0)) : null,
      dayChangePct:
        prevPrice !== null && price !== null && prevPrice !== 0 ? round(((price - prevPrice) / prevPrice) * 100) : null,
      costPrice: Number.isFinite(holding.costPrice) ? holding.costPrice : null,
      value: round(value),
      cost: round(cost),
      pnl: cost > 0 ? round(value - cost) : null,
      pnlPct: cost > 0 ? round(((value - cost) / cost) * 100) : null,
      priced,
    })
  }

  if (unpriced > 0) {
    warnings.push(`${unpriced} 条持仓缺少价格，市值按 0 计算；请先刷新价格再分析。`)
  }

  const value = round(rows.reduce((sum, row) => sum + row.value, 0))
  const cost = round(rows.reduce((sum, row) => sum + row.cost, 0))
  const pnl = round(value - cost)
  const pnlPct = cost > 0 ? round((pnl / cost) * 100) : null

  // Same-day move: only rows that carry a previous NAV contribute.
  const withPrevious = rows.filter((row) => row.prevPrice !== null && row.price !== null)
  const previousValue = round(withPrevious.reduce((sum, row) => sum + row.units * row.prevPrice, 0))
  const dayChange = round(withPrevious.reduce((sum, row) => sum + row.units * (row.price - row.prevPrice), 0))

  for (const row of rows) {
    row.weight = value > 0 ? round((row.value / value) * 100) : 0
  }
  const sorted = [...rows].sort((a, b) => b.weight - a.weight)

  // Asset-class mix: only classes that actually hold value.
  const byKindMap = new Map()
  for (const row of rows) {
    const bucket = byKindMap.get(row.kind) ?? { kind: row.kind, value: 0 }
    bucket.value += row.value
    byKindMap.set(row.kind, bucket)
  }
  const byKind = [...byKindMap.values()]
    .map((bucket) => ({
      kind: bucket.kind,
      label: KIND_LABELS[bucket.kind] ?? bucket.kind,
      value: round(bucket.value),
      weight: value > 0 ? round((bucket.value / value) * 100) : 0,
    }))
    .sort(
      (a, b) =>
        (HOLDING_KINDS.indexOf(a.kind) === -1 ? 99 : HOLDING_KINDS.indexOf(a.kind)) -
        (HOLDING_KINDS.indexOf(b.kind) === -1 ? 99 : HOLDING_KINDS.indexOf(b.kind)),
    )

  const concentration = {
    top1: sorted[0]?.weight ?? 0,
    top3: round(sorted.slice(0, 3).reduce((sum, row) => sum + row.weight, 0)),
    hhi: round(sorted.reduce((sum, row) => sum + (row.weight / 100) ** 2, 0), 3),
  }
  if (concentration.top1 >= 40) {
    warnings.push(`单一持仓占比 ${concentration.top1}% 偏高，注意集中度风险。`)
  }

  // Target drift, per holding code first, then per asset class.
  const byCodeTargets = doc.targets?.byCode ?? {}
  const byKindTargets = doc.targets?.byKind ?? {}
  const drift = []

  for (const row of rows) {
    const target = Number(byCodeTargets[row.code])
    if (!Number.isFinite(target)) continue
    const delta = round(target - row.weight)
    drift.push({
      scope: 'holding',
      key: row.code,
      label: `${row.name}(${row.code})`,
      current: row.weight,
      target: round(target),
      drift: delta,
      amount: round((delta / 100) * value),
      side: delta > 0 ? 'buy' : delta < 0 ? 'sell' : 'hold',
    })
  }
  for (const bucket of byKind) {
    const target = Number(byKindTargets[bucket.kind])
    if (!Number.isFinite(target)) continue
    const delta = round(target - bucket.weight)
    drift.push({
      scope: 'kind',
      key: bucket.kind,
      label: bucket.label,
      current: bucket.weight,
      target: round(target),
      drift: delta,
      amount: round((delta / 100) * value),
      side: delta > 0 ? 'buy' : delta < 0 ? 'sell' : 'hold',
    })
  }

  const hasTargets = drift.length > 0
  const targetSum = round(
    Object.values(byCodeTargets).reduce((sum, entry) => sum + (Number(entry) || 0), 0) +
      (Object.keys(byCodeTargets).length === 0
        ? Object.values(byKindTargets).reduce((sum, entry) => sum + (Number(entry) || 0), 0)
        : 0),
  )
  if (hasTargets && Math.abs(targetSum - 100) > 0.5) {
    warnings.push(`目标权重合计 ${targetSum}%，不等于 100%，偏离参考值仅按当前目标计算。`)
  }
  const actionable = drift
    .filter((entry) => Math.abs(entry.drift) >= 0.5 && entry.amount !== 0)
    .sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift))

  // Snapshot-derived history.
  const snapshots = [...(doc.snapshots ?? [])].sort((a, b) => a.date.localeCompare(b.date))
  const latest = snapshots[snapshots.length - 1]
  const peak = snapshots.reduce(
    (best, entry) => (entry.value > (best?.value ?? -Infinity) ? entry : best),
    undefined,
  )
  const first = snapshots[0]
  const history = {
    count: snapshots.length,
    latest: latest ? { date: latest.date, value: round(latest.value) } : null,
    peak: peak ? { date: peak.date, value: round(peak.value) } : null,
    drawdownPct:
      peak && peak.value > 0 && latest ? round(((latest.value - peak.value) / peak.value) * 100) : null,
    returnSinceFirstPct:
      first && first.value > 0 && latest ? round(((latest.value - first.value) / first.value) * 100) : null,
  }

  // Freshness: a bookkeeping deck is only as good as its prices.
  const stale = []
  for (const holding of doc.holdings) {
    const stamp = Date.parse(holding.updatedAt ?? '')
    if (!Number.isFinite(stamp)) continue
    const days = Math.floor((now.getTime() - stamp) / 86_400_000)
    if (days >= staleAfterDays) stale.push({ code: holding.code, name: holding.name, days })
  }
  if (stale.length > 0) {
    warnings.push(
      `${stale.length} 条持仓超过 ${staleAfterDays} 天未更新价格（${stale
        .slice(0, 5)
        .map((entry) => entry.code)
        .join('、')}${stale.length > 5 ? ' 等' : ''}）。`,
    )
  }

  return {
    generatedAt: now.toISOString(),
    currency: doc.currency ?? 'CNY',
    totals: {
      value,
      cost,
      pnl,
      pnlPct,
      count: rows.length,
      previousValue,
      dayChange,
      dayChangePct: previousValue > 0 ? round((dayChange / previousValue) * 100) : null,
      pricedCount: withPrevious.length,
    },
    rows,
    sorted: sorted.map((row) => ({ code: row.code, name: row.name, weight: row.weight })),
    byKind,
    concentration,
    targets: { byCode: byCodeTargets, byKind: byKindTargets, drift, actionable, sum: targetSum },
    history,
    stale,
    warnings,
  }
}

const money = (value) =>
  Number.isFinite(value)
    ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
    : '—'
const pct = (value) => (Number.isFinite(value) ? `${value.toFixed(2)}%` : '—')

/** Markdown report for the model to relay to the user. */
export function formatReport(report) {
  const lines = []
  const { totals } = report
  lines.push(`## 组合概览（${report.currency}）`)
  lines.push('')
  lines.push(
    `- 总市值：**${money(totals.value)}**；成本：${money(totals.cost)}；浮动盈亏：${money(
      totals.pnl,
    )}（${pct(totals.pnlPct)}）`,
  )
  lines.push(
    `- 当日盈亏：**${money(totals.dayChange)}**（${pct(totals.dayChangePct)}，基于 ${totals.pricedCount} 个有前日净值的品种）`,
  )
  lines.push(`- 持仓数量：${totals.count}`)
  if (report.byKind.length > 0) {
    lines.push(`- 资产类别：${report.byKind.map((b) => `${b.label} ${pct(b.weight)}`).join(' / ')}`)
  }
  lines.push(
    `- 集中度：第一大 ${pct(report.concentration.top1)}，前三大 ${pct(
      report.concentration.top3,
    )}，HHI ${report.concentration.hhi}`,
  )
  lines.push('')

  if (report.rows.length > 0) {
    lines.push('### 持仓明细')
    lines.push('')
    lines.push(
      '| 代码 | 名称 | 类别 | 份额 | 今日净值 | 前日净值 | 当日涨跌 | 成本价 | 市值 | 盈亏 | 盈亏率 | 权重 |',
    )
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const row of [...report.rows].sort((a, b) => b.value - a.value)) {
      const dayMove =
        row.dayChange === null
          ? '—'
          : `${row.dayChange > 0 ? '+' : ''}${row.dayChange}（${row.dayChangePct > 0 ? '+' : ''}${row.dayChangePct}%）`
      lines.push(
        `| ${row.code} | ${row.name} | ${row.kindLabel} | ${row.units} | ${
          row.price === null ? '—' : row.price
        }${row.priceDate ? `（${row.priceDate.slice(5)}）` : ''} | ${
          row.prevPrice === null ? '—' : row.prevPrice
        }${row.prevPriceDate ? `（${row.prevPriceDate.slice(5)}）` : ''} | ${dayMove} | ${
          row.costPrice === null ? '—' : row.costPrice
        } | ${money(row.value)} | ${money(row.pnl)} | ${pct(row.pnlPct)} | ${pct(row.weight)} |`,
      )
    }
    lines.push('')
  }

  const { drift, actionable } = report.targets
  if (drift.length === 0) {
    lines.push('### 目标配置')
    lines.push('')
    lines.push('尚未设置目标权重。设置后这里会给出每个持仓的偏离与再平衡金额。')
    lines.push('')
  } else {
    lines.push('### 偏离与再平衡')
    lines.push('')
    lines.push('| 范围 | 标的 | 当前 | 目标 | 偏离 | 建议金额 |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    for (const entry of drift) {
      lines.push(
        `| ${entry.scope === 'holding' ? '持仓' : '类别'} | ${entry.label} | ${pct(
          entry.current,
        )} | ${pct(entry.target)} | ${entry.drift > 0 ? '+' : ''}${entry.drift} 个百分点 | ${
          entry.side === 'hold' ? '—' : `${entry.side === 'buy' ? '买入' : '卖出'} ${money(Math.abs(entry.amount))}`
        } |`,
      )
    }
    lines.push('')
    if (actionable.length === 0) {
      lines.push('当前配置与目标的偏离都在 0.5 个百分点以内，无需再平衡。')
      lines.push('')
    }
  }

  if (report.history.count > 0) {
    lines.push('### 净值轨迹')
    lines.push('')
    lines.push(
      `- 快照数：${report.history.count}；最近一次：${report.history.latest?.date} ${money(
        report.history.latest?.value,
      )}`,
    )
    lines.push(
      `- 历史峰值：${report.history.peak?.date} ${money(report.history.peak?.value)}；当前回撤：${pct(
        report.history.drawdownPct,
      )}`,
    )
    lines.push(`- 自首个快照以来：${pct(report.history.returnSinceFirstPct)}`)
    lines.push('')
  }

  if (report.warnings.length > 0) {
    lines.push('### 需要留意')
    lines.push('')
    for (const warning of report.warnings) lines.push(`- ${warning}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
