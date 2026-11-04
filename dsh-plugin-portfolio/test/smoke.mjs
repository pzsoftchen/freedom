/**
 * Smoke test for the Portfolio bundle, runnable without the Harness app.
 *
 *   node test/smoke.mjs
 *
 * The Host half imports no @deepseek-ai/* package, so this runs with no
 * dependencies installed. It drives the registered tool the way the Harness
 * loop does: validate args, execute, render.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Keep the test from overwriting the live app's activation breadcrumb.
process.env.DSH_PLUGIN_PORTFOLIO_QUIET = '1'

const dir = await mkdtemp(join(tmpdir(), 'portfolio-smoke-'))
const dataFile = join(dir, 'portfolio.json')

let plugin
try {
  plugin = await import('../index.js')
} catch (error) {
  console.error('Cannot import ../index.js:', error.message)
  console.error('Run this test where @deepseek-ai/schemastery and @deepseek-ai/dsh-tools resolve,')
  console.error('for example a directory whose node_modules links the DSH runtime.')
  process.exit(1)
}

assert.equal(plugin.name, 'portfolio')
assert.deepEqual(plugin.inject, ['tools'])
assert.equal(typeof plugin.apply, 'function')
assert.equal(typeof plugin.inject.join(','), 'string', 'the plugin declares its Cordis services')
assert.equal(plugin.Config, undefined, 'the host half stays dependency-free: no schemastery Config')

/** Stand-in for the profile's mcp-client tools. */
function mcpToolStub(name) {
  if (name === 'mcp__qieman__GetLatestQuotations') {
    return {
      name,
      async execute() {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                temperatureList: [
                  { temperatureIndexCode: '000985', indexName: '中证全A', temperature: 12.83, ratingText: '低估' },
                ],
              }),
            },
          ],
        }
      },
    }
  }
  if (name !== 'mcp__qieman__BatchGetFundNavHistory') return undefined
  return {
    name,
    async execute(args) {
      const codes = args?.fundCodes ?? []
      if (args?.dimensionType === 'oneYear') {
        // Table rendering, 40 unique trading days per fund, newest first.
        const lines = []
        const base = Date.UTC(2026, 9, 27)
        for (const code of codes) {
          lines.push(`  - fundCode: "${code}"`, '    data:', `      code: "${code}"`, '      data[40]{navDate,nav,dailyReturn}:')
          for (let day = 0; day < 40; day += 1) {
            const date = new Date(base - day * 86_400_000)
            const stamp = `${date.getUTCFullYear()}年${String(date.getUTCMonth() + 1).padStart(2, '0')}月${String(
              date.getUTCDate(),
            ).padStart(2, '0')}日`
            lines.push(`        ${stamp},${(3.95 + day * 0.002).toFixed(4)},0.10%`)
          }
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }
      return codes.map((code) => ({
        fundCode: code,
        data: {
          code,
          data: [
            { navDate: '2026年10月27日', nav: 3.9349, dailyReturn: '-0.16%' },
            { navDate: '2026年10月26日', nav: 3.9411, dailyReturn: '0.81%' },
          ],
        },
      }))
    },
  }
}

/** Minimal stand-ins for the services the plugin expects. */
const registrations = []
const routes = []
const noopDisposer = () => {}
const ctx = {
  tools: {
    register(definition) {
      registrations.push(definition)
      return noopDisposer
    },
    // Stand-in for the profile's mcp-client: the plugin resolves the NAV tool
    // by its public name and calls it directly.
    get: mcpToolStub,
  },
  effect(fn) {
    fn()
    return noopDisposer
  },
  inject(_deps, callback) {
    callback({
      effect(fn) {
        fn()
        return noopDisposer
      },
      timeout() {
        return noopDisposer
      },
      webServer: {
        register(route) {
          routes.push(route)
          return noopDisposer
        },
      },
    })
  },
}
plugin.apply(ctx, { dataFile, staleAfterDays: 30, equityCapPct: 200, tacticalBandPp: { 'A股': 200, '海外': 200, '黄金': 200 }, dynamicCashTarget: false, defxCodes: [] })
assert.equal(registrations.length, 1, 'apply must register exactly one tool')
assert.equal(routes.length, 12, 'apply must register summary, refresh, check, rebalance, quotes, execute, transfer, orders, executions, weekly, activity and history routes')
const summaryRoute = routes.find((route) => route.path === '/portfolio/api/summary')
const refreshRoute = routes.find((route) => route.path === '/portfolio/api/refresh')
const checkRoute = routes.find((route) => route.path === '/portfolio/api/check')
const rebalanceRoute = routes.find((route) => route.path === '/portfolio/api/rebalance')
assert.ok(summaryRoute, 'summary route registered')
assert.ok(refreshRoute, 'refresh route registered')
assert.ok(checkRoute, 'valuation check route registered')
assert.ok(rebalanceRoute, 'rebalance route registered')
const quotesRoute = routes.find((route) => route.path === '/portfolio/api/quotes')
assert.ok(quotesRoute, 'quotes route registered')
assert.ok(routes.find((route) => route.path === '/portfolio/api/execute'), 'execute route registered')
assert.ok(routes.find((route) => route.path === '/portfolio/api/orders'), 'orders route registered')
assert.ok(routes.find((route) => route.path === '/portfolio/api/executions'), 'executions route registered')
assert.ok(routes.find((route) => route.path === '/portfolio/api/weekly'), 'weekly route registered')
assert.ok(routes.find((route) => route.path === '/portfolio/api/activity'), 'activity route registered')
assert.ok(routes.find((route) => route.path === '/portfolio/api/history'), 'history route registered')
assert.ok(routes.find((route) => route.path === '/portfolio/api/transfer'), 'transfer route registered')
assert.equal(summaryRoute.kind, 'exact')
assert.equal(refreshRoute.kind, 'exact')

const tool = registrations[0]
assert.equal(tool.name, 'portfolio')
assert.equal(tool.parameters.type, 'object')
assert.ok(tool.parameters.properties.action.enum.includes('upsert'))
assert.equal(tool.output.schema.type, 'object')
assert.equal(typeof tool.execute, 'function')
assert.equal(typeof tool.output.render, 'function')

/** Call the tool as the loop does, and assert the rendered content shape. */
const call = async (args) => {
  const value = await tool.execute(args, { signal: AbortSignal.timeout(5000) })
  const content = tool.output.render(args, value)
  assert.ok(Array.isArray(content) && content[0]?.type === 'text', 'render must return text content')
  return value
}

// 1. Empty portfolio answers with guidance, not an error.
const empty = await call({ action: 'report' })
assert.equal(empty.ok, true)
assert.equal(empty.data.empty, true)

// 2. Upsert four holdings, including cash.
const upserted = await call({
  action: 'upsert',
  holdings: [
    { code: '110011', name: '易方达中小盘', kind: 'fund', units: 1000, costPrice: 7.2, price: 8.0 },
    { code: '161725', name: '招商中证白酒', kind: 'fund', units: 2000, costPrice: 1.1, price: 0.95 },
    { code: '600519', name: '贵州茅台', kind: 'stock', units: 100, costPrice: 1500, price: 1680 },
    { code: 'CASH', name: '现金', kind: 'cash', units: 50000, costPrice: 1 },
  ],
})
const totals = upserted.data.report.totals
assert.equal(totals.value, 8000 + 1900 + 168000 + 50000)
assert.equal(totals.cost, 7200 + 2200 + 150000 + 50000)
assert.equal(upserted.data.report.rows.length, 4)
assert.equal(upserted.data.report.rows.find((row) => row.code === 'CASH').price, 1)
assert.match(upserted.text, /组合概览/)

// 3. Upsert is idempotent by code: same code replaces, does not duplicate.
const updated = await call({
  action: 'upsert',
  holdings: [{ code: '110011', units: 1500, price: 8.5, costPrice: 7.2 }],
})
assert.equal(updated.data.report.rows.filter((row) => row.code === '110011').length, 1)
assert.equal(updated.data.report.rows.find((row) => row.code === '110011').units, 1500)
// name falls back to the code when omitted, because the record is replaced.
assert.equal(updated.data.report.rows.find((row) => row.code === '110011').name, '110011')

// 4. Weights sum to 100% and concentration reflects the cash-heavy book.
const report = updated.data.report
const weightSum = report.rows.reduce((sum, row) => sum + row.weight, 0)
assert.ok(Math.abs(weightSum - 100) < 0.5, `weights should sum to 100, got ${weightSum}`)
assert.equal(report.sorted[0].code, '600519')
assert.ok(report.concentration.top1 > 40, 'a single holding dominates the book')
assert.ok(report.warnings.some((warning) => warning.includes('集中度')))

// 5. Targets produce drift and rebalance amounts against total value.
const targeted = await call({
  action: 'targets',
  targets: [
    { key: '110011', weight: 30 },
    { key: '600519', weight: 10 },
    { key: 'fund', weight: 40, scope: 'kind' },
    { key: 'cash', weight: 20, scope: 'kind' },
  ],
})
assert.ok(targeted.data.report.targets.drift.length >= 4)
const cashDrift = targeted.data.report.targets.drift.find((entry) => entry.key === 'cash')
assert.equal(cashDrift.scope, 'kind')
assert.equal(cashDrift.side, 'sell', 'cash is overweight, so the suggestion sells')
assert.ok(cashDrift.amount < 0)

// 6. A zero target clears the entry instead of writing 0.
await call({ action: 'targets', targets: [{ key: '600519', weight: 0 }] })
const afterClear = JSON.parse(await readFile(dataFile, 'utf8'))
assert.equal(afterClear.targets.byCode['600519'], undefined)

// 7. Snapshot records value and is deduplicated by date.
const snapshot = await call({ action: 'snapshot', snapshotDate: '2026-01-31' })
assert.equal(snapshot.data.snapshot.date, '2026-01-31')
await call({ action: 'snapshot', snapshotDate: '2026-01-31' })
const history = await call({ action: 'history' })
assert.equal(history.data.snapshots.length, 1)
assert.match(history.text, /历史快照/)

// 8. Remove drops holdings and rejects unknown codes loudly.
const removed = await call({ action: 'remove', codes: ['CASH'] })
assert.deepEqual(removed.data.removed, ['CASH'])
await assert.rejects(call({ action: 'remove', codes: ['NOPE'] }), /没有匹配的持仓/)

// 9. Argument validation comes from the generated JSON Schema.
await assert.rejects(call({ action: 'upsert' }), /holdings/)
await assert.rejects(call({ action: 'nope' }), /must be one of|未知动作/)
await assert.rejects(call({ action: 'upsert', holdings: [{ code: 'X', units: -1 }] }), /units/)

// 10. The persisted document is plain, versioned JSON.
const doc = JSON.parse(await readFile(dataFile, 'utf8'))
assert.equal(doc.version, 1)
assert.equal(doc.currency, 'CNY')
assert.ok(doc.updatedAt)
assert.equal(doc.holdings.length, 3)

// 11. The browser half's route answers with the same analysis, and rejects non-GET.
const callRoute = async (method = 'GET') => {
  let status
  let body
  const res = {
    writeHead(code) {
      status = code
    },
    end(payload) {
      body = payload
    },
  }
  await summaryRoute.handler({ method }, res)
  return { status, json: JSON.parse(body) }
}
await rm(dataFile, { force: true }) // start the route test from an empty book
const routeEmpty = await callRoute()
assert.equal(routeEmpty.status, 200, 'summary route: ' + JSON.stringify(routeEmpty.json).slice(0,300))
assert.equal(routeEmpty.json.ok, true)
assert.equal(routeEmpty.json.value.empty, true)

await call({ action: 'upsert', holdings: [{ code: '110011', name: '易方达中小盘', kind: 'fund', units: 100, costPrice: 7, price: 8 }] })
const routeReady = await callRoute()
assert.equal(routeReady.status, 200)
assert.equal(routeReady.json.ok, true)
assert.equal(routeReady.json.value.totals.value, 800)
assert.equal(routeReady.json.value.rows.length, 1)

const routeMethod = await callRoute('POST')
assert.equal(routeMethod.status, 405)
assert.equal(routeMethod.json.ok, false)

// 12. refresh pulls NAVs through the profile's MCP tool and writes them back.
await call({ action: 'upsert', holdings: [{ code: '110011', name: '易方达中小盘', kind: 'fund', units: 100, costPrice: 7 }] })
const refreshed = await call({ action: 'refresh' })
assert.equal(refreshed.data.tool, 'mcp__qieman__BatchGetFundNavHistory')
const navRow = refreshed.data.updated.find((row) => row.code === '110011')
assert.ok(navRow, 'the fund NAV was refreshed')
assert.equal(navRow.to, 3.9349)
assert.equal(navRow.date, '2026-10-27')
assert.equal(navRow.prev, 3.9411, 'the previous trading day NAV is carried too')
assert.equal(navRow.prevDate, '2026-10-26')
const afterNav = await call({ action: 'report' })
const fund = afterNav.data.report.rows.find((row) => row.code === '110011')
assert.equal(fund.price, 3.9349)
assert.equal(fund.prevPrice, 3.9411)
assert.equal(fund.prevPriceDate, '2026-10-26')
assert.ok(Math.abs(fund.dayChange - -0.0062) < 1e-9, 'same-day move is price minus previous NAV')
assert.ok(afterNav.text.includes('当日盈亏'), 'the report shows the same-day P&L line')
assert.ok(afterNav.text.includes('前日净值'), 'the report table has a previous-NAV column')

// 13. A profile without the MCP server fails with a readable error.
const untouched = ctx.tools.get
ctx.tools.get = () => undefined
await assert.rejects(call({ action: 'refresh' }), /找不到行情工具 mcp__qieman__/)
ctx.tools.get = untouched

// 14. The refresh route is POST-only and requires the panel header.
let status
let body
const postRefresh = async (headers, method = 'POST') => {
  status = undefined
  body = undefined
  await refreshRoute.handler({ method, headers }, {
    writeHead(code) {
      status = code
    },
    end(payload) {
      body = payload
    },
  })
  return { status, json: body ? JSON.parse(body) : undefined }
}
const forbidden = await postRefresh({})
assert.equal(forbidden.status, 403)
const wrongMethod = await postRefresh({ 'x-dsh-portfolio': '1' }, 'GET')
assert.equal(wrongMethod.status, 405)
const allowed = await postRefresh({ 'x-dsh-portfolio': '1' })
assert.equal(allowed.status, 200)
assert.equal(allowed.json.ok, true)
assert.equal(allowed.json.refreshed.updated.length, 1)

// 15. Opt-in auto refresh registers one interval and can refresh + snapshot.
const dir2 = await mkdtemp(join(tmpdir(), 'portfolio-schedule-'))
const file2 = join(dir2, 'portfolio.json')
await writeFile(
  file2,
  JSON.stringify({
    version: 1,
    currency: 'CNY',
    holdings: [{ code: '110011', name: '易方达', kind: 'fund', units: 100, costPrice: 4, price: 4 }],
    targets: { byCode: {}, byKind: {} },
    snapshots: [],
  }),
)
const intervals = []
const scheduleCtx = {
  tools: { register: () => () => {}, get: mcpToolStub },
  effect: (fn) => fn(),
  inject: (_deps, callback) =>
    callback({
      effect: (fn) => fn(),
      interval: (fn, delay) => {
        intervals.push({ fn, delay })
        return () => {}
      },
      timeout: () => () => {},
      webServer: { register: () => () => {} },
    }),
}
plugin.apply(scheduleCtx, { dataFile: file2, staleAfterDays: 7, autoRefreshHours: 6, autoSnapshot: true })
assert.equal(intervals.length, 1, 'one refresh interval is scheduled')
assert.equal(intervals[0].delay, 6 * 3_600_000)
await intervals[0].fn()
const scheduled = JSON.parse(await readFile(file2, 'utf8'))
assert.equal(scheduled.holdings[0].price, 3.9349, 'the interval refreshed the NAV')
assert.equal(scheduled.holdings[0].priceDate, '2026-10-27')
assert.equal(scheduled.snapshots.length, 1, 'a snapshot was recorded with the refresh')
assert.equal(scheduled.snapshots[0].value, 393.49)
await rm(dir2, { recursive: true, force: true })

// 15b. The read-only check route returns the same valuation table.
let checkStatus
let checkBody
await checkRoute.handler({ method: 'GET' }, {
  writeHead(code) {
    checkStatus = code
  },
  end(payload) {
    checkBody = payload
  },
})
assert.equal(checkStatus, 200, 'check route status, body=' + String(checkBody).slice(0, 400))
assert.equal(JSON.parse(checkBody).ok, true)
assert.ok(Array.isArray(JSON.parse(checkBody).value.rows))

// 16. Valuation check: official temperature bands + 200DMA position, with targets.
await call({ action: 'targets', targets: [{ key: '161725', weight: 20 }] })
const checked = await call({ action: 'check' })
assert.ok(checked.text.includes('估值检查'), 'check returns a report')
assert.ok(checked.text.includes('中证全A'), 'temperature is reported')
assert.equal(checked.data.ashare.band, '低估', '12.83° falls in the official undervalued band')
assert.ok(checked.data.rows.length > 0, 'at least one instrument was evaluated')
const namedRow = checked.data.rows.find((row) => row.code === '161725')
assert.ok(namedRow && namedRow.name && namedRow.name.length > 0, 'not-yet-held sleeves get a label even without a stored name')
const row110011 = checked.data.rows.find((row) => row.code === '110011')
assert.ok(row110011, 'the held fund is in the table')
assert.equal(row110011.fraction, 0.1, 'style sleeves take the more conservative of temperature and own position')
assert.ok(row110011.ma200 > 0, 'the 200-day average was computed from the series')
assert.ok(row110011.drawdownPct < 0, 'drawdown from the 1-year high is negative')
assert.ok(checked.data.totalBuy > 0, 'a positive buy suggestion is produced')
assert.ok(checked.data.layers && checked.data.layers.strategicPct > 0, 'the strategic layer is reported')
const layeredCheckRow = checked.data.rows.find((row) => row.code === '161725')
assert.ok(layeredCheckRow.tacticalCapPct > layeredCheckRow.targetPct, 'tactical ceiling sits above the strategic anchor')
assert.ok(typeof layeredCheckRow.layer === 'string', 'each row is labelled strategic/tactical')
assert.equal(layeredCheckRow.tranches.length, 3, 'each buy suggestion is split into three tranches')
const trancheSum = layeredCheckRow.tranches.reduce((sum, t) => sum + t.amount, 0)
assert.ok(Math.abs(trancheSum - layeredCheckRow.suggest) < 0.02, 'the tranches add up to the suggestion')
assert.equal(checked.text.includes('分批计划'), true, 'the report includes a tranche schedule')
const row161725 = checked.data.rows.find((row) => row.code === '161725')
assert.ok(row161725 && row161725.suggest > 0, 'a target without holdings produces a gap to buy')
assert.ok(checked.data.buys.some((row) => row.code === '161725'), 'the gap appears as a buy signal')

// 16b. The summary feed carries the full target book (held + not yet held).
let summaryStatus
let summaryBody
await summaryRoute.handler({ method: 'GET' }, {
  writeHead(code) {
    summaryStatus = code
  },
  end(payload) {
    summaryBody = payload
  },
})
assert.equal(summaryStatus, 200)
const summaryValue = JSON.parse(summaryBody).value
assert.ok(summaryValue.plan, 'summary payload includes the plan')
const plan161725 = summaryValue.plan.rows.find((row) => row.code === '161725')
assert.ok(plan161725, 'a not-yet-held sleeve is listed')
assert.equal(plan161725.held, false)
assert.equal(plan161725.currentPct, 0)
assert.equal(plan161725.targetPct, 20)
assert.equal(summaryValue.plan.targetCount, 1, 'only configured sleeves count as targets')
const heldNoTarget = summaryValue.plan.rows.find((row) => row.code === '110011')
assert.ok(heldNoTarget && heldNoTarget.held === true && heldNoTarget.targetPct === null, 'held sleeves without a target are still listed')
assert.ok(typeof summaryValue.plan.progress === 'number', 'build progress is reported')
assert.ok(summaryValue.lastCheck && summaryValue.lastCheck.at, 'the last check is persisted for the panel/reminder')
assert.ok(Array.isArray(summaryValue.lastCheck.rows), 'the sidecar carries the valuation rows')
assert.ok(summaryValue.plan.layers && summaryValue.plan.layers.strategicPct > 0, 'plan reports the strategic/tactical layers')
assert.ok(summaryValue.weekly === null || typeof summaryValue.weekly === 'object', 'weekly read-out is exposed when present')
assert.ok(Array.isArray(summaryValue.activity), 'the activity log is exposed on the summary')
assert.ok(summaryValue.activity.some((entry) => entry.type === 'check'), 'the manual check was logged')
assert.ok(summaryValue.plan.categorySummary.every((group) => group.tacticalCapPct >= group.targetPct), 'category tactical caps are above the anchor')
assert.ok(summaryValue.model, 'summary payload carries the valuation rules')
assert.equal(summaryValue.model.temperature.bands.length, 5, 'five A-share temperature bands')
assert.ok(summaryValue.model.temperature.hysteresis.includes('整数边界'), 'band switching rule is exposed without a conflicting stop threshold')
assert.equal(summaryValue.model.position.bands.length, 6, 'six position bands')
assert.ok(summaryValue.model.sell.bands.includes('贵'), 'sell rule lists expensive bands only')
assert.ok(summaryValue.model.special.length >= 3, 'special rules (gold/long bond/short bond) are exposed')
assert.ok(summaryValue.model.gold && summaryValue.model.gold.rules.length === 3, 'gold trend rules are exposed')
assert.ok(summaryValue.model.overseas && summaryValue.model.overseas.rules.length === 3, 'overseas trend multipliers are exposed')
assert.ok(summaryValue.model.bonds && summaryValue.model.bonds.longBands.length === 3, 'bond yield bands are exposed')
assert.ok(summaryValue.model.cash && summaryValue.model.cash.bands.length === 4, 'dynamic cash targets are exposed')
assert.ok(summaryValue.model.backtest.stress.length >= 7, 'stress scenarios include historical paths')
assert.ok(summaryValue.model.backtest.stress.some((row) => row.kind === 'history'), 'at least one historical path exists')
const forecast = summaryValue.model.backtest.forecast
assert.ok(forecast && forecast.layers.length === 6, 'forward return forecast is exposed')
assert.equal(forecast.layers.reduce((sum, row) => sum + row.weight, 0), 100, 'forecast layers sum to 100%')
assert.ok(forecast.lowPct <= forecast.expectedPct && forecast.expectedPct <= forecast.highPct, 'forecast range is ordered')
assert.equal(forecast.capital, 300000, 'forecast is based on the 30万 capital base')
assert.ok(forecast.annualAmount > 0 && forecast.cumulative5yAmount.base > 0, 'forecast carries yuan amounts')
assert.ok(summaryValue.rows.every((row) => 'dayPnl' in row), 'each holding carries a day P&L amount')
assert.ok(plan161725.category, 'plan rows carry a category for the grouped panel')
assert.equal(plan161725.category, 'A股', 'a domestic equity sleeve is grouped under A股')
const heldRow = summaryValue.plan.rows.find((row) => row.code === '110011')
assert.equal(heldRow.category, 'A股', 'held sleeves are categorised too')

// 17. Cash basket: buys are capped by the dry powder above the cash target.
await call({ action: 'upsert', holdings: [{ code: 'CASH', name: '钱袋子', kind: 'cash', units: 1000 }] })
await call({ action: 'targets', targets: [{ key: 'CASH', weight: 100 }] })
const capped = await call({ action: 'check' })
assert.equal(capped.data.cash.available, 0, 'cash target eats the whole balance')
assert.equal(capped.data.buys.length, 0, 'no buy signal without dry powder')
assert.ok(capped.text.includes('钱袋子'), 'the report exposes the cash basket')

// 18. Sell signal: expensive sleeve that is over its target.
await call({ action: 'upsert', holdings: [{ code: '050025', name: '标普500', kind: 'fund', units: 100, price: 5.58 }] })
await call({ action: 'targets', targets: [{ key: '050025', weight: 1 }, { key: 'CASH', weight: 0 }] })
const withSell = await call({ action: 'check' })
assert.equal(withSell.data.sells.length, 0, '偏高 overweight is not sold: only 贵 triggers a sale')
const overCheapRow = withSell.data.overCheap.find((row) => row.code === '050025')
assert.ok(overCheapRow, 'non-expensive overweight is reported in the 超配但便宜 list instead')
assert.ok(withSell.text.includes('卖出信号'), 'the report has a sell section')

// 19. Deploy: new money is allocated by absolute-target gaps, never sells.
async function applyTo(file, config) {
  const seen = []
  const localRoutes = []
  const localCtx = {
    tools: {
      register(definition) {
        seen.push(definition)
        return () => {}
      },
      get: mcpToolStub,
    },
    effect: (fn) => fn(),
    inject: (_deps, callback) =>
      callback({
        effect: (fn) => fn(),
        timeout: () => () => {},
        webServer: {
          register(route) {
            localRoutes.push(route)
            return () => {}
          },
        },
      }),
  }
  plugin.apply(localCtx, { dataFile: file, staleAfterDays: 7, dynamicCashTarget: false, defxCodes: [], ...config })
  return { tool: seen[0], routes: localRoutes }
}

const dir3 = await mkdtemp(join(tmpdir(), 'portfolio-rebalance-'))
const buildingFile = join(dir3, 'building.json')
await writeFile(
  buildingFile,
  JSON.stringify({
    version: 1,
    currency: 'CNY',
    holdings: [
      { code: '110011', name: '易方达中小盘', kind: 'fund', units: 1000, costPrice: 1, price: 1 },
      { code: 'CASH', name: '钱袋子', kind: 'cash', units: 500, costPrice: 1, price: 1 },
    ],
    targets: { byCode: { '110011': 50, '050025': 30, CASH: 5 }, byKind: {} },
    snapshots: [],
  }),
)
const building = await applyTo(buildingFile, { equityCapPct: 200 })
const planDeploy = await building.tool.execute({ action: 'rebalance' }, {})
assert.equal(planDeploy.data.mode, 'deploy', 'fresh cash in the basket → deploy mode')
assert.equal(planDeploy.data.building, true, 'not fully invested yet → build-out phase')
assert.equal(planDeploy.data.sells.length, 0, 'deploy mode never sells')
assert.ok(planDeploy.data.plan, 'deploy reports the dynamic-pace plan numbers')
assert.ok(planDeploy.data.plan.multiplier >= 0.5 && planDeploy.data.plan.multiplier <= 1.5, 'multiplier stays in its band')
assert.ok(planDeploy.data.plan.budget > 0, 'the run budget is derived from remaining gap × pace × multiplier')
assert.ok(planDeploy.data.plan.pacePct > 0, 'the pace percentage is reported')
assert.equal(planDeploy.data.plan.totalRounds, undefined, 'there is no fixed round count anymore')
assert.ok(planDeploy.data.buys.length > 0, 'underweight sleeves are bought')
const buy050025 = planDeploy.data.buys.find((row) => row.code === '050025')
assert.ok(buy050025, 'a planned-but-unheld sleeve appears in the plan')
assert.ok(planDeploy.data.cash.available !== null, 'auto mode still tracks the cash bucket for unheld sleeves')
assert.ok(planDeploy.data.totalBuy <= planDeploy.data.value * 0.1 + 0.01, 'buys stay inside the 10% run cap')
assert.ok(planDeploy.text.includes('建仓期'), 'the report labels the build-out phase')
const row050025 = planDeploy.data.rows.find((row) => row.code === '050025')
assert.equal(row050025.targetPct, 30, 'unheld sleeves keep their target proportion')

// 20. Rotate: renormalise the already-held basket, cash-neutral, wider absolute deviation.
const rotateFile = join(dir3, 'rotate.json')
await writeFile(
  rotateFile,
  JSON.stringify({
    version: 1,
    currency: 'CNY',
    holdings: [
      { code: '110011', name: '易方达中小盘', kind: 'fund', units: 1000, costPrice: 1, price: 1 },
      { code: '022424', name: '中证A500', kind: 'fund', units: 300, costPrice: 1, price: 1 },
      { code: 'CASH', name: '钱袋子', kind: 'cash', units: 50, costPrice: 1, price: 1 },
    ],
    targets: { byCode: { '110011': 50, '022424': 30, '050025': 12, CASH: 5 }, byKind: {} },
    snapshots: [],
  }),
)
const rotate = await applyTo(rotateFile, { fundingMode: 'cash' })
const planRotate = await rotate.tool.execute({ action: 'rebalance' }, {})
assert.equal(planRotate.data.mode, 'rotate', 'no fresh cash → rotate mode')
assert.equal(planRotate.data.targetSum, 80, 'rotation uses only the held sleeves’ targets')
assert.ok(Math.abs(planRotate.data.totalBuy - planRotate.data.totalSell) < 0.02, 'rotation is cash-neutral')
const sell110011 = planRotate.data.sells.find((row) => row.code === '110011')
const buy022424 = planRotate.data.buys.find((row) => row.code === '022424')
assert.ok(sell110011 && sell110011.amount > 0, 'over-relative sleeve is sold')
assert.ok(buy022424 && buy022424.amount > 0, 'under-relative sleeve is bought')
assert.ok(planRotate.text.includes('轮动'), 'the report explains the rotation')
assert.ok(planRotate.data.projected.length > 0, 'projected absolute deviations are reported')
const projected050025 = planRotate.data.projected.find((row) => row.code === '050025')
assert.equal(projected050025, undefined, 'unheld sleeves are not traded by rotation')

// 21. The rebalance route answers with the plan.
for (const [route, key] of [[rebalanceRoute, 'rows']]) {
  let status
  let body
  await route.handler({ method: 'GET' }, {
    writeHead(code) {
      status = code
    },
    end(payload) {
      body = payload
    },
  })
  assert.equal(status, 200)
  assert.equal(JSON.parse(body).ok, true)
  assert.ok(Array.isArray(JSON.parse(body).value[key]))
}

// 22. Realtime proxy quotes for held *and* not-yet-held sleeves.
const quotesFile = join(dir3, 'quotes.json')
await writeFile(
  quotesFile,
  JSON.stringify({
    version: 1,
    currency: 'CNY',
    holdings: [{ code: 'CASH', name: '钱袋子', kind: 'cash', units: 100, costPrice: 1, price: 1 }],
    targets: { byCode: { '050025': 12, CASH: 5 }, byKind: {} },
    snapshots: [],
  }),
)
const quotesApp = await applyTo(quotesFile)
const liveQuotesRoute = quotesApp.routes.find((route) => route.path === '/portfolio/api/quotes')
const originalFetch = globalThis.fetch
globalThis.fetch = async () => ({
  ok: true,
  async arrayBuffer() {
    return new TextEncoder().encode('v_sh513500="1~标普500ETF~513500~2.720~2.702~0.000"').buffer
  },
})
let quotesStatus
let quotesBody
await liveQuotesRoute.handler({ method: 'GET' }, {
  writeHead(code) {
    quotesStatus = code
  },
  end(payload) {
    quotesBody = payload
  },
})
globalThis.fetch = originalFetch
assert.equal(quotesStatus, 200)
const quotesValue = JSON.parse(quotesBody).value
const unheldRow = quotesValue.rows.find((row) => row.code === '050025')
assert.ok(unheldRow, 'not-yet-held sleeves get a quote row')
assert.equal(unheldRow.held, false)
assert.equal(unheldRow.price, 2.72)
assert.ok(Math.abs(unheldRow.changePct - 0.666) < 0.01, 'proxy change is derived from price/prevClose')
assert.ok('prevNav' in unheldRow && 'nav' in unheldRow, 'two-day NAV fields are part of every quote row')

// 23. Execution ledger: immediate fill by default, pending path still available.
const dir4 = await mkdtemp(join(tmpdir(), 'portfolio-exec-'))
const execFile = join(dir4, 'exec.json')
await writeFile(
  execFile,
  JSON.stringify({
    version: 1,
    currency: 'CNY',
    holdings: [
      { code: '110011', name: '易方达中小盘', kind: 'fund', units: 100, costPrice: 7, price: 8, prevPrice: 7.9 },
      { code: 'CASH', name: '钱袋子', kind: 'cash', units: 1000, costPrice: 1, price: 1 },
    ],
    targets: { byCode: { '110011': 50, '050025': 10, CASH: 5 }, byKind: {} },
    snapshots: [],
    orders: [],
  }),
)
const execApp = await applyTo(execFile)
const executeRoute = execApp.routes.find((route) => route.path === '/portfolio/api/execute')
const execRefreshRoute = execApp.routes.find((route) => route.path === '/portfolio/api/refresh')
const execSummaryRoute = execApp.routes.find((route) => route.path === '/portfolio/api/summary')
const makeBodyReq = (body) => {
  const handlers = {}
  return {
    method: 'POST',
    headers: { 'x-dsh-portfolio': '1' },
    on(event, callback) {
      handlers[event] = callback
      if (event === 'data') setTimeout(() => callback(JSON.stringify(body)), 0)
      if (event === 'end') setTimeout(() => callback(), 5)
    },
  }
}
let execStatus
let execBody
await executeRoute.handler(makeBodyReq({ items: [{ code: '110011', amount: 200 }] }), {
  writeHead(code) {
    execStatus = code
  },
  end(payload) {
    execBody = payload
  },
})
assert.equal(execStatus, 200)
assert.equal(JSON.parse(execBody).value.orders[0].status, 'filled', 'immediate execution fills at once')
const afterImmediate = JSON.parse(await readFile(execFile, 'utf8'))
const heldAfter = afterImmediate.holdings.find((holding) => holding.code === '110011')
assert.equal(heldAfter.units, 125, 'immediate fill adds units at the holding NAV')
assert.equal(afterImmediate.deployment.rounds.length, 1, 'a submitted batch counts as one deployment round')

// pending path: immediate:false waits for the NAV, then fills on refresh
await executeRoute.handler(makeBodyReq({ items: [{ code: '050025', amount: 150 }], immediate: false, tradeDate: '2026-10-27' }), {
  writeHead() {},
  end() {},
})
const afterPending = JSON.parse(await readFile(execFile, 'utf8'))
assert.equal(afterPending.orders[1].status, 'pending', 'immediate:false leaves the order pending')
assert.equal(afterPending.orders[1].source, 'plan', 'without a wallet sleeve the plan cash funds it')
await execRefreshRoute.handler({ method: 'POST', headers: { 'x-dsh-portfolio': '1' } }, { writeHead() {}, end() {} })
const afterSecondFill = JSON.parse(await readFile(execFile, 'utf8'))
assert.equal(afterSecondFill.orders[1].status, 'filled', 'refresh fills the pending order')
const cashAfterSecond = afterSecondFill.holdings.find((holding) => holding.kind === 'cash')
assert.equal(cashAfterSecond.units, 850, 'cash-funded fill pays from the basket')
let pendingStatus
let pendingBody
await execSummaryRoute.handler({ method: 'GET' }, {
  writeHead(code) {
    pendingStatus = code
  },
  end(payload) {
    pendingBody = payload
  },
})
assert.equal(pendingStatus, 200)
assert.equal(JSON.parse(pendingBody).value.executions.count, 2, 'execution history carries both orders')
assert.ok(JSON.parse(pendingBody).value.activity.some((entry) => entry.type === 'execute'), 'the order batch is logged in activity')
await rm(dir4, { recursive: true, force: true })

// 24. Platform rebalance transfer: cash basket → fund, share-based fill.
const dir5 = await mkdtemp(join(tmpdir(), 'portfolio-transfer-'))
const transferFile = join(dir5, 'transfer.json')
await writeFile(
  transferFile,
  JSON.stringify({
    version: 1,
    currency: 'CNY',
    holdings: [{ code: 'CASH', name: '钱袋子', kind: 'cash', units: 1000, costPrice: 1, price: 1 }],
    targets: { byCode: { '007169': 50, CASH: 5 }, byKind: {} },
    snapshots: [],
    orders: [],
  }),
)
const transferApp = await applyTo(transferFile)
const transferRoute = transferApp.routes.find((route) => route.path === '/portfolio/api/transfer')
const transferRefresh = transferApp.routes.find((route) => route.path === '/portfolio/api/refresh')
let transferStatus
let transferBody
await transferRoute.handler(makeBodyReq({ items: [{ to: '007169', amount: 200 }], tradeDate: '2026-10-27' }), {
  writeHead(code) {
    transferStatus = code
  },
  end(payload) {
    transferBody = payload
  },
})
assert.equal(transferStatus, 200)
assert.equal(JSON.parse(transferBody).value.orders[0].side, 'transfer')
const beforeTransferFill = JSON.parse(await readFile(transferFile, 'utf8'))
assert.equal(beforeTransferFill.orders[0].status, 'pending', 'transfer waits for the target NAV')
await transferRefresh.handler({ method: 'POST', headers: { 'x-dsh-portfolio': '1' } }, { writeHead() {}, end() {} })
const afterTransferFill = JSON.parse(await readFile(transferFile, 'utf8'))
assert.equal(afterTransferFill.orders[0].status, 'filled', 'transfer fills once the fund NAV is known')
const transferred = afterTransferFill.holdings.find((holding) => holding.code === '007169')
assert.ok(transferred && transferred.units > 0, 'the target sleeve receives shares')
const cashAfterTransfer = afterTransferFill.holdings.find((holding) => holding.kind === 'cash')
assert.equal(cashAfterTransfer.units, 800, 'the cash basket pays for the transfer')
await rm(dir5, { recursive: true, force: true })


// 25. Data-quality fallback: when trend/FX data cannot be fetched, the check
//     must not silently drop the gate — it reports the problem and falls back.
const dirQ = await mkdtemp(join(tmpdir(), 'portfolio-quality-'))
const qualityFile = join(dirQ, 'quality.json')
await writeFile(
  qualityFile,
  JSON.stringify({
    version: 1,
    currency: 'CNY',
    holdings: [
      { code: '110011', name: '易方达中小盘', kind: 'fund', units: 100, costPrice: 7, price: 8, prevPrice: 7.9 },
      { code: '007169', name: '短债', kind: 'bond', units: 1000, costPrice: 1, price: 1.01 },
      { code: 'CASH', name: '钱袋子', kind: 'cash', units: 1000, costPrice: 1, price: 1 },
    ],
    targets: { byCode: { '110011': 40, '007169': 40, CASH: 5 }, byKind: {} },
    snapshots: [],
    orders: [],
  }),
)
const qualityApp = await applyTo(qualityFile, {
  goldTrendGate: true,
  goldCode: '110011',
  overseasTrendGate: true,
  defxCodes: ['110011'],
  bondYieldSignal: true,
})
const qualityCheck = qualityApp.routes.find((route) => route.path === '/portfolio/api/check')
const realFetch = globalThis.fetch
globalThis.fetch = async () => {
  throw new Error('offline')
}
let qualityStatus
let qualityBody
await qualityCheck.handler({ method: 'GET' }, {
  writeHead(code) {
    qualityStatus = code
  },
  end(payload) {
    qualityBody = payload
  },
})
globalThis.fetch = realFetch
assert.equal(qualityStatus, 200, 'check still succeeds when external data is offline')
const qualityValue = JSON.parse(qualityBody).value
assert.ok(Array.isArray(qualityValue.dataWarnings) && qualityValue.dataWarnings.length > 0, 'offline data is reported')
const qualityRow = qualityValue.rows.find((row) => row.code === '110011')
assert.ok((qualityRow?.note ?? '').includes('数据缺失'), 'fallback is explained on the row')
await rm(dirQ, { recursive: true, force: true })

await rm(dir4, { recursive: true, force: true })

await rm(dir3, { recursive: true, force: true })

await rm(dir, { recursive: true, force: true })
console.log('portfolio smoke test OK — totals, weights, drift, snapshots, validation all behave')

