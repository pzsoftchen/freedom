/**
 * Portfolio — Host half.
 *
 * One agent tool does the bookkeeping and the deterministic math for the user's
 * investment portfolio; it never fetches market data. The agent supplies prices
 * or fund NAVs it read from a market-data source (the qieman MCP tools in this
 * profile), and this plugin persists holdings, target weights and snapshots and
 * returns value / P&L / weights / drift / rebalance amounts.
 *
 * Data lives in <DSH_HOME>/storages/portfolio/portfolio.json unless the row
 * config sets `dataFile`.
 *
 * Prices come from the profile's qieman MCP server (already configured for the
 * agent) rather than from a second data connection: `refresh` resolves the
 * `mcp__<server>__BatchGetFundNavHistory` tool on ctx.tools and calls it.
 *
 * The host half deliberately imports no `@deepseek-ai/*` package: a locally
 * linked bundle resolves its bare imports against its own directory, which has
 * no node_modules, so a dependency-free module loads everywhere. The tool
 * definition is therefore the registry's own plain shape (JSON Schema +
 * execute + render) instead of `defineTool`.
 */
import { analyze, formatReport } from './lib/analysis.js'
import { DEFAULT_MCP_SERVER, DEFAULT_NAV_TOOL, fetchChina10yYield, fetchEtfQuotes, fetchKlineSeries, fetchNavSeriesMap, fetchNavs, fetchTemperature, mcpToolName, percentileRank } from './lib/quotes.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { TEMPERATURE_BANDS, capGold, classifyPosition, classifyTemperature, classifyTrend, pct, seriesMetrics, tiltDividend } from './lib/valuation.js'
import {
  HOLDING_KINDS,
  KIND_LABELS,
  PortfolioStore,
  normalizeHolding,
  resolveDataFile,
} from './lib/store.js'

export const name = 'portfolio'

export const inject = ['tools']

const ACTIONS = ['report', 'check', 'rebalance', 'transfer', 'refresh', 'history', 'snapshot', 'upsert', 'remove', 'targets']

/** Default display names for the planned sleeves (used when a code has no holding yet). */
const PLAN_LABELS = {
  '000509': '广发钱袋子A（现金）',
  '007169': '易方达中债1-3年国开债A',
  '003376': '广发中债7-10年国开债A',
  '001257': '兴业收益增强债券A',
  '100032': '富国中证红利指数增强A',
  '008163': '南方标普红利低波50ETF联接A',
  '009051': '易方达中证红利ETF联接A',
  '020602': '易方达中证红利低波动联接A',
  '022424': '广发中证A500ETF联接A',
  '000248': '汇添富主要消费ETF联接A',
  '001180': '广发医药卫生联接A',
  '012323': '华宝医疗ETF联接C',
  '162412': '华宝医疗ETF联接A',
  '050025': '博时标普500ETF联接A',
  '000071': '华夏恒生ETF联接A',
  '006327': '易方达中证海外中国互联网A',
  '000369': '广发全球医疗保健(QDII)A',
  '000216': '华安黄金ETF联接A',
}

const ACTION_HELP = [
  'report: 读取组合并给出概览、持仓明细、类别分布、集中度、目标偏离与再平衡建议（默认动作）',
  'check: 估值体检——拉 A股温度计 + 各标的 1 年净值，算 1 年高点回撤与 200 日均线偏离，按估值档位给出“现在该不该买”（时机）',
  'transfer: 记录平台调仓（钱袋子 → 品种，按份额/金额），成交后按目标净值折算份额入账',
  'rebalance: 投入新钱后做一次——自动判断：钱袋子里有新钱时，按各品种与固定目标比例的缺口把新钱投放下去；没有新钱时，在已买入品种之间按归一化目标占比做轮动（卖高配买低配、现金中性）。之后由 check 按估值给买卖建议继续收敛',
  'refresh: 通过已配置的 qieman MCP 拉取基金最新净值并回写现价（传入 codes 可只刷新指定持仓，默认刷新全部非现金持仓）',
  'upsert: 新增或覆盖持仓（按 code 匹配），传入 holdings',
  'remove: 按代码删除持仓，传入 codes',
  'targets: 设置目标权重，传入 targets（scope 为 holding 时按代码，kind 时按资产类别）',
  'snapshot: 记录今天的组合市值快照，用于回撤与收益跟踪',
  'history: 列出已记录的快照',
].join('；')

const DESCRIPTION =
  '管理用户的投资组合：记录/更新/删除持仓与目标权重、记录市值快照，并计算总市值、浮动盈亏、权重、' +
  '资产类别分布、集中度、目标偏离与再平衡金额。可以用 refresh 直接向已配置的 qieman MCP 拉取基金最新净值并回写现价；' +
  `股票等没有接入行情源的标的仍需手动 upsert。动作说明：${ACTION_HELP}。`

const HOLDING_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', description: '基金/股票代码，例如 110011；现金可用 CASH' },
    name: { type: 'string', description: '名称' },
    kind: {
      type: 'string',
      enum: HOLDING_KINDS,
      description: `资产类别：${HOLDING_KINDS.map((kind) => `${kind}=${KIND_LABELS[kind]}`).join('，')}`,
    },
    units: { type: 'number', description: '持有份额/股数；现金填金额' },
    costPrice: { type: 'number', description: '单位成本价（现金填 1）' },
    price: { type: 'number', description: '最新单价/净值；现金默认 1' },
    targetWeight: { type: 'number', description: '该持仓的目标权重（百分数，例如 20 表示 20%）' },
    note: { type: 'string', description: '备注，例如买入理由或计划' },
  },
  required: ['code', 'units'],
}

const TARGET_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    key: { type: 'string', description: '持仓代码，或资产类别（scope=kind 时）' },
    weight: { type: 'number', description: '目标权重（百分数）' },
    scope: {
      type: 'string',
      enum: ['holding', 'kind'],
      description: 'holding=按持仓代码（默认），kind=按资产类别',
    },
  },
  required: ['key', 'weight'],
}

const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ACTIONS,
      description: `动作，默认 report。${ACTION_HELP}`,
    },
    holdings: {
      type: 'array',
      items: HOLDING_ITEM_SCHEMA,
      description: 'upsert 使用：一个或多个持仓记录，按 code 新增或覆盖。',
    },
    codes: {
      type: 'array',
      items: { type: 'string' },
      description: 'remove 使用：要删除的持仓代码列表；refresh / check 使用：只处理这些代码。',
    },
    targets: {
      type: 'array',
      items: TARGET_ITEM_SCHEMA,
      description: 'targets 使用：目标权重列表；weight 为 0 表示清除该目标。',
    },
    snapshotDate: {
      type: 'string',
      description: 'snapshot 使用：快照日期 YYYY-MM-DD，缺省为今天。',
    },
  },
  required: ['action'],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: '是否成功' },
    action: { type: 'string', description: '执行的动作' },
    text: { type: 'string', description: '给人看的 Markdown 结果' },
    data: { type: 'object', additionalProperties: true, description: '结构化结果，便于程序化复用' },
  },
  required: ['ok', 'action', 'text', 'data'],
}

export function apply(ctx, config = {}) {
  const file = resolveDataFile(config?.dataFile)
  const staleAfterDays = Number.isFinite(config?.staleAfterDays) ? config.staleAfterDays : 7
  const mcpServer = typeof config?.mcpServer === 'string' && config.mcpServer ? config.mcpServer : DEFAULT_MCP_SERVER
  const navTool = typeof config?.navTool === 'string' && config.navTool ? config.navTool : DEFAULT_NAV_TOOL
  const autoRefreshHours = Number.isFinite(config?.autoRefreshHours) && config.autoRefreshHours > 0 ? config.autoRefreshHours : 0
  const autoSnapshot = config?.autoSnapshot === true
  const watchlist = Array.isArray(config?.watchlist) ? config.watchlist.map((code) => String(code).trim().toUpperCase()) : []
  const overseasCodes = Array.isArray(config?.overseasCodes)
    ? config.overseasCodes.map((code) => String(code).trim().toUpperCase())
    : ['050025', '000071', '006327', '000369']
  const longBondCodes = Array.isArray(config?.longBondCodes)
    ? config.longBondCodes.map((code) => String(code).trim().toUpperCase())
    : ['003376']
  const bondCodes = Array.isArray(config?.bondCodes)
    ? config.bondCodes.map((code) => String(code).trim().toUpperCase())
    : ['007169', '003376', '001257']
  const goldCode = typeof config?.goldCode === 'string' ? config.goldCode.trim().toUpperCase() : '000216'
  const cashCode = typeof config?.cashCode === 'string' ? config.cashCode.trim().toUpperCase() : '000509'
  // Intraday estimation map: fund code → exchange code with a live quote.
  const defaultEtfMap = {
    '022424': 'sh512050', // A500ETF
    '100032': 'sh510880', // 红利ETF（指数增强的代理）
    '009051': 'sh510880', // 红利ETF
    '008163': 'sh515450', // 红利低波50ETF
    '020602': 'sh515450', // 红利低波（代理）
    '000248': 'sz159928', // 消费ETF
    '001180': 'sz159938', // 医药ETF
    '012323': 'sh512170', // 医疗ETF
    '162412': 'sh512170', // 医疗ETF（A 类）
    '050025': 'sh513500', // 标普500ETF
    '000071': 'sz159920', // 恒生ETF
    '006327': 'sh513050', // 中概互联网ETF
    '000216': 'sh518880', // 黄金ETF
    '007169': 'sh511360', // 短融ETF（1-3年国开代理）
    '003376': 'sh511260', // 十年国债ETF（7-10年国开代理）
  }
  const etfMap = { ...defaultEtfMap, ...(config?.etfMap && typeof config.etfMap === 'object' ? config.etfMap : {}) }
  // Index funds: estimate from the tracked index (no ETF premium/discount noise).
  const defaultIndexMap = {
    '100032': 'sh000922', // 中证红利
    '009051': 'sh000922',
    '022424': 'sh000510', // 中证A500
    '000248': 'sh000932', // 中证消费
    '001180': 'sh000991', // 全指医药
    '012323': 'sz399989', // 中证医疗
    '162412': 'sz399989', // 中证医疗（A 类）
  }
  const indexMap = { ...defaultIndexMap, ...(config?.indexMap && typeof config.indexMap === 'object' ? config.indexMap : {}) }
  const quoteCodeFor = (code) => indexMap[code] ?? etfMap[code] ?? null
  const scheduleCheckAt = typeof config?.scheduleCheckAt === 'string' ? config.scheduleCheckAt.trim() : '14:40'
  const scheduleWeeklyAt = typeof config?.scheduleWeeklyAt === 'string' ? config.scheduleWeeklyAt.trim() : '15:30'
  const weeklyEnabled = config?.weeklyEnabled !== false
  const activityLimit = Number.isFinite(config?.activityLimit) ? Math.max(1, Math.floor(config.activityLimit)) : 7
  const scheduleWeekdaysOnly = config?.scheduleWeekdaysOnly !== false
  // Review fixes: one-shot caps, joint overseas+gold cap, cash reserve isolation,
  // per-index A-share temperature, strategic overweight sells.
  const maxRunPct = Number.isFinite(config?.maxRunPct) ? config.maxRunPct : 0.1
  const maxSleeveStepPct = Number.isFinite(config?.maxSleeveStepPct) ? config.maxSleeveStepPct : 0.5
  const overseasGoldCapPct = Number.isFinite(config?.overseasGoldCapPct) ? config.overseasGoldCapPct : 30
  const reserveAmount = Number.isFinite(config?.reserveAmount) ? Math.max(0, config.reserveAmount) : 0
  const strategicOverPct = Number.isFinite(config?.strategicOverPct) ? config.strategicOverPct : 10
  const ashareIndexMap = { '022424': '000300', ...(config?.ashareIndexMap && typeof config.ashareIndexMap === 'object' ? config.ashareIndexMap : {}) }
  const dividendCodes = Array.isArray(config?.dividendCodes) ? config.dividendCodes : ['100032', '008163', '009051', '020602']
  const dividendBandMin = Number.isFinite(config?.dividendBandMin) ? config.dividendBandMin : 20
  const dividendBandMax = Number.isFinite(config?.dividendBandMax) ? config.dividendBandMax : 25
  const dividendCheapBelow = Number.isFinite(config?.dividendCheapBelow) ? config.dividendCheapBelow : 10
  const dividendExpensiveAbove = Number.isFinite(config?.dividendExpensiveAbove) ? config.dividendExpensiveAbove : 50
  const dividendFundingCode = typeof config?.dividendFundingCode === 'string' ? config.dividendFundingCode : '007169'
  // Cheap sleeves may be bought beyond their target (a measured overweight).
  const cheapOverBuyPct = Number.isFinite(config?.cheapOverBuyPct) ? config.cheapOverBuyPct : 115
  const cheapOverBuyBands = ['极低估', '便宜']
  const equityCapPct = Number.isFinite(config?.equityCapPct) ? config.equityCapPct : 65
  // Tactical overlay: how many pp a category may sit above its strategic anchor
  // while its sleeves are cheap. Strategic weights remain the anchor (never 0/ignored).
  const tacticalBandPp = {
    A股: 1.5,
    海外: 0.75,
    黄金: 0.5,
    债券: 0,
    现金: 0,
    ...(config?.tacticalBandPp && typeof config.tacticalBandPp === 'object' ? config.tacticalBandPp : {}),
  }
  const tacticalCheapBands = ['极低估', '便宜']
  // Build-out tracker: how many monthly deployment rounds the plan assumes.
  // Dynamic deployment: no fixed number of rounds. Each run deploys a share of
  // the *remaining gap*, scaled by valuation, with a floor/ceiling so it neither
  // stalls (permanent cash drag) nor rushes (all-in on one signal).
  const deployPacePct = Number.isFinite(config?.deployPacePct) ? config.deployPacePct : 0.3
  const deployMinRunPct = Number.isFinite(config?.deployMinRunPct) ? config.deployMinRunPct : 0.05
  const deployMaxRunPct = Number.isFinite(config?.deployMaxRunPct) ? config.deployMaxRunPct : 0.5
  const deployStopGapPct = Number.isFinite(config?.deployStopGapPct) ? config.deployStopGapPct : 1
  const deployMultiplierMin = Number.isFinite(config?.deployMultiplierMin) ? config.deployMultiplierMin : 0.5
  const deployMultiplierMax = Number.isFinite(config?.deployMultiplierMax) ? config.deployMultiplierMax : 1.2
  const jointCodes = [...new Set([...overseasCodes, goldCode])]
  const sellOverTargetPct = Number.isFinite(config?.sellOverTargetPct) ? config.sellOverTargetPct : 5
  const sellBands = Array.isArray(config?.sellBands) ? config.sellBands : ['贵']
  const store = new PortfolioStore(file)

  /** Refresh NAVs for the given holdings through the profile's MCP server. */
  const refreshPrices = async (requestedCodes) => {
    const current = await store.read()
    const wanted = (requestedCodes ?? []).map((code) => String(code).trim().toUpperCase()).filter(Boolean)
    const targets = current.holdings.filter((holding) =>
      wanted.length > 0 ? wanted.includes(holding.code) : holding.kind !== 'cash',
    )
    const targetCodes = Object.keys(current.targets.byCode ?? {}).filter((code) => code !== cashCode)
    if (targets.length === 0 && (wanted.length > 0 || targetCodes.length === 0)) {
      throw new Error('没有可刷新的持仓：现金不需要行情，先录入基金/股票等持仓再刷新。')
    }
    const fetchCodes = [...new Set([...targets.map((holding) => holding.code), ...targetCodes])]
    const quotes = await fetchNavs(ctx, fetchCodes, {
      server: mcpServer,
      tool: navTool,
    })
    const updated = []
    const missing = []
    const { doc } = await store.update((draft) => {
      for (const holding of draft.holdings) {
        const quote = quotes.get(holding.code)
        if (!quote) continue
        updated.push({
          code: holding.code,
          from: holding.price ?? null,
          to: quote.price,
          date: quote.date,
          prev: quote.prevPrice ?? null,
          prevDate: quote.prevDate ?? null,
        })
        holding.price = quote.price
        holding.priceDate = quote.date
        holding.prevPrice = quote.prevPrice ?? undefined
        holding.prevPriceDate = quote.prevDate ?? undefined
        holding.priceSource = mcpServer
        holding.updatedAt = new Date().toISOString()
      }
    })
    for (const target of targets) if (!quotes.has(target.code)) missing.push(target.code)
    // Cache the latest two NAVs for every target sleeve (also the not-yet-held
    // ones) so the quotes endpoint can show 前日/今日净值 next to the realtime price.
    try {
      const cache = {}
      for (const [code, quote] of quotes) {
        cache[code] = {
          nav: quote.price ?? null,
          navDate: quote.date ?? null,
          prevNav: quote.prevPrice ?? null,
          prevNavDate: quote.prevDate ?? null,
        }
      }
      await writeFile(navCacheFile(), `${JSON.stringify(cache, null, 2)}\n`)
    } catch (error) {
      ctx.logger?.warn?.(`portfolio: cannot cache NAVs (${String(error?.message ?? error)})`)
    }
    const filledOrders = await fillPendingOrders(quotes)
    return { doc, updated, missing, filledOrders, tool: mcpToolName(mcpServer, navTool) }
  }

  /** Record (or replace) one valuation snapshot for `date`. */
  const takeSnapshot = async (date) => {
    const { doc, result } = await store.update((draft) => {
      const report = analyze(draft, { staleAfterDays })
      const entry = { date, value: report.totals.value, cost: report.totals.cost }
      draft.snapshots = [...draft.snapshots.filter((existing) => existing.date !== date), entry].sort((a, b) =>
        a.date.localeCompare(b.date),
      )
      return entry
    })
    return { doc, snapshot: result }
  }

  // Activation breadcrumb: written once per load into the OS temp directory so
  // "did the host half actually mount?" is answerable without app logs. Tests
  // set DSH_PLUGIN_PORTFOLIO_QUIET so they cannot overwrite the live record.
  if (process.env.DSH_PLUGIN_PORTFOLIO_QUIET !== '1') void recordActivation(file).catch(() => {})



  /**
   * Rotation rebalance: renormalise the *already-held* sleeves to their target
   * proportions inside the held basket, then trade the difference. Sells fund
   * buys, so it is cash-neutral and can widen the deviation from the absolute
   * targets — that is intended; later deploy/sell steps converge again.
   */
  const runRotate = async () => {
    const doc = await store.read()
    const last = await readLastCheck()
    const value = round2(
      doc.holdings.reduce((sum, holding) => sum + (Number(holding.units) || 0) * (Number(holding.price) || 0), 0),
    )
    const tilt = effectiveTargets(doc, last?.temperature?.temperature ?? null)
    const targetsByCode = tilt.byCode
    const cashHolding =
      doc.holdings.find((holding) => holding.code === cashCode) ?? doc.holdings.find((holding) => holding.kind === 'cash') ?? null
    const invested = doc.holdings.filter(
      (holding) => holding.kind !== 'cash' && Number.isFinite(Number(targetsByCode[holding.code])),
    )
    if (invested.length === 0) throw new Error('还没有已买入且有目标比例的品种：先用 upsert 买入，或先设定 targets')

    const heldValue = round2(invested.reduce((sum, holding) => sum + (Number(holding.units) || 0) * (Number(holding.price) || 0), 0))
    const targetSum = round2(invested.reduce((sum, holding) => sum + Number(targetsByCode[holding.code]), 0))

    const rows = invested.map((holding) => {
      const current = round2((Number(holding.units) || 0) * (Number(holding.price) || 0))
      const relativeTarget = round2((Number(targetsByCode[holding.code]) / targetSum) * 100)
      const relativeCurrent = heldValue > 0 ? round2((current / heldValue) * 100) : 0
      const deltaPct = round2(relativeTarget - relativeCurrent)
      return {
        code: holding.code,
        name: holding.name || PLAN_LABELS[holding.code] || holding.code,
        absoluteTarget: Number(targetsByCode[holding.code]),
        relativeTarget,
        relativeCurrent,
        deltaPct,
        currentValue: current,
        amount: round2((deltaPct / 100) * heldValue),
      }
    })

    const buys = rows.filter((row) => row.amount > 0).sort((a, b) => b.amount - a.amount)
    const sells = rows.filter((row) => row.amount < 0).map((row) => ({ ...row, amount: round2(-row.amount) })).sort((a, b) => b.amount - a.amount)
    const totalBuy = round2(buys.reduce((sum, row) => sum + row.amount, 0))
    const totalSell = round2(sells.reduce((sum, row) => sum + row.amount, 0))

    const lines = ['## 再平衡（已买入品种轮动）', '']
    lines.push(`已买入篮子 **${money(heldValue)}**（组合总值 ${money(value)}），按各品种在篮子内的目标占比重新分配。`)
    lines.push(`本次目的标占比合计 ${pct(targetSum)}；卖出与买入现金中性，不依赖新钱。`)
    lines.push('')
    lines.push('| 代码 | 名称 | 目标(相对)% | 当前(相对)% | 调整 | 金额 |')
    lines.push('| --- | --- | ---: | ---: | ---: | ---: |')
    for (const row of [...rows].sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct))) {
      lines.push(
        `| ${row.code} | ${row.name} | ${pct(row.relativeTarget)} | ${pct(row.relativeCurrent)} | ${
          row.deltaPct > 0 ? '+' : ''
        }${row.deltaPct}pp | ${row.amount > 0 ? `+${money(row.amount)}` : row.amount < 0 ? `-${money(-row.amount)}` : '—'} |`,
      )
    }
    lines.push('')
    lines.push(`**卖出 ${money(totalSell)} → 买入 ${money(totalBuy)}**（差额 ${money(round2(totalBuy - totalSell))} 留/取自钱袋子）`)
    lines.push('')

    // show the absolute deviation this rotation creates
    lines.push('### 轮动后与绝对目标的偏离（设计内，后续靠 deploy 收敛）')
    lines.push('')
    lines.push('| 代码 | 绝对目标% | 轮动后权重% | 偏离 |')
    lines.push('| --- | ---: | ---: | ---: |')
    const projected = []
    for (const row of rows) {
      const targetValue = (row.absoluteTarget / 100) * value
      const newValue = row.currentValue + (row.deltaPct / 100) * heldValue
      const newWeight = value > 0 ? round2((newValue / value) * 100) : 0
      const deviation = round2(newWeight - row.absoluteTarget)
      projected.push({ code: row.code, targetPct: row.absoluteTarget, newWeight, deviation })
      lines.push(`| ${row.code} | ${pct(row.absoluteTarget)} | ${pct(newWeight)} | ${deviation > 0 ? '+' : ''}${deviation}pp |`)
    }
    lines.push('')
    lines.push('这些偏离是轮动的必然结果：未买入的品种（目标占比仍在）没有动，等 `deploy`（新钱）或价格变化后继续收敛。')

    return {
      text: lines.join('\n'),
      data: {
        value,
        heldValue,
        targetSum,
        rows,
        buys,
        sells,
        totalBuy,
        totalSell,
        projected,
        cash: cashHolding
          ? { value: round2((Number(cashHolding.units) || 0) * (Number(cashHolding.price) || 1)) }
          : null,
      },
    }
  }

  /** New money: allocate the dry powder by absolute-target gaps. */
  const runDeploy = async () => {
      const doc = await store.read()
      const lastCheck = await readLastCheck()
      const deployTilt = effectiveTargets(
        doc,
        lastCheck?.temperature?.temperature ?? null,
        dividendBandsFromRows(lastCheck?.rows),
      )
      const deployTargets = deployTilt.byCode
      const value = round2(
        doc.holdings.reduce((sum, holding) => sum + (Number(holding.units) || 0) * (Number(holding.price) || 0), 0),
      )
      const basis = planningValue > 0 ? planningValue : value
      const buckets = cashBuckets(doc)
      const cashHolding = buckets.planCash ?? buckets.wallet
      const cashValue = buckets.total
      const targetsByCode = deployTargets
      const codes = [...new Set([...Object.keys(targetsByCode), ...doc.holdings.map((h) => h.code)])]
      if (codes.length === 0) throw new Error('还没有目标比例：先用 targets 设定')

      const dynamicCashPct = cashTargetPctFor(lastCheck?.temperature?.temperature)
      const cashTargetPct = Number.isFinite(dynamicCashPct)
        ? dynamicCashPct
        : [targetsByCode[cashHolding?.code ?? ''], targetsByCode[cashCode], doc.targets.byKind?.cash, 5]
            .map(Number)
            .find((number) => Number.isFinite(number))
      const cashTargetValue = round2((cashTargetPct / 100) * basis)
      const available =
        fundingMode !== 'external' && buckets.wallet
          ? Math.max(0, round2(buckets.spendable - reserveAmount - Math.max(0, cashTargetValue - buckets.other)))
          : null

      const rows = []
      for (const code of codes) {
        const holding = doc.holdings.find((entry) => entry.code === code)
        const currentValue = holding ? round2((Number(holding.units) || 0) * (Number(holding.price) || (holding.kind === 'cash' ? 1 : 0))) : 0
        const targetPct = Number(targetsByCode[code])
        const targetValue = Number.isFinite(targetPct) ? round2((targetPct / 100) * value) : null
        rows.push({
          code,
          name: holding?.name || PLAN_LABELS[code] || code,
          targetPct: Number.isFinite(targetPct) ? targetPct : null,
          currentPct: basis > 0 ? round2((currentValue / basis) * 100) : 0,
          deltaPct: Number.isFinite(targetPct) ? round2((basis > 0 ? (currentValue / basis) * 100 : 0) - targetPct) : null,
          targetValue,
          currentValue,
          deltaValue: targetValue === null ? null : round2(targetValue - currentValue),
        })
      }

      // Build-out progress: how much of the target non-cash book is already in place.
      const nonCashValue = rows.filter((row) => categoryOfCode(row.code) !== '现金').reduce((sum, row) => sum + row.currentValue, 0)
      const targetNonCash = Math.max(0, round2(basis - cashTargetValue))
      const progress = targetNonCash > 0 ? Math.min(100, round2((nonCashValue / targetNonCash) * 100)) : 100
      const cashPct = basis > 0 ? round2((cashValue / basis) * 100) : 0
      const building = progress < 95 || cashPct - cashTargetPct > 2

      const gaps = rows.filter((row) => row.deltaValue !== null && row.deltaValue > 0)
      const totalGap = round2(gaps.reduce((sum, row) => sum + row.deltaValue, 0))
      const over = rows.filter((row) => row.deltaValue !== null && row.deltaValue < 0)

      // 定期不定额: monthly base = ammo / remaining rounds, scaled by the
      // valuation multiplier (weighted band fractions from the last check).
      const checkRows = Array.isArray(lastCheck?.rows) ? lastCheck.rows : []
      const bandByCode = new Map(checkRows.map((row) => [row.code, row]))
      const weighted = gaps.map((row) => {
        const bandRow = bandByCode.get(row.code)
        const fraction = Number(bandRow?.fraction)
        const bandPriority = BAND_PRIORITY[bandRow?.band] ?? 1
        const weight = row.deltaValue * (Number.isFinite(fraction) ? fraction : 1) * bandPriority
        return { row, weight }
      })
      const weightSum = round2(weighted.reduce((sum, item) => sum + item.weight, 0))
      const rawMultiplier = totalGap > 0 ? weightSum / totalGap : 1
      const multiplier = round2(Math.min(deployMultiplierMax, Math.max(deployMultiplierMin, rawMultiplier)))
      const gapPct = value > 0 ? round2((totalGap / value) * 100) : 0
      const floor = Number.isFinite(available) ? round2(available * deployMinRunPct) : round2(value * 0.01)
      const ceiling = Number.isFinite(available) ? round2(available * deployMaxRunPct) : round2(basis * maxRunPct)
      const paceBudget = round2(totalGap * deployPacePct * multiplier)
      const dynamicBudget = round2(
        Math.min(Math.max(paceBudget, floor), ceiling, Number.isFinite(available) ? available : Infinity, basis * maxRunPct),
      )
      const trackedRounds = Array.isArray(doc.deployment?.rounds) ? doc.deployment.rounds.length : 0
      const budget = dynamicBudget
      const rawBuys = weighted
        .map(({ row, weight }) => ({
          ...row,
          gap: row.deltaValue,
          amount: weightSum > 0 && Number.isFinite(budget) ? round2((weight / weightSum) * budget) : round2(row.deltaValue * (weightSum > 0 ? weight / weightSum : 0)),
        }))
        .filter((row) => row.amount > 0)
      const currentJointPct = round2(
        rows.filter((row) => jointCodes.includes(row.code)).reduce((sum, row) => sum + (row.currentPct ?? 0), 0),
      )
      let buys = capBuys(rawBuys, { value: basis, available: Number.isFinite(budget) ? budget : available, currentJointPct })
      if (fundingMode === 'auto' && Number.isFinite(available)) {
        const unheld = buys.filter((item) => !isHeldCode(doc, item.code))
        const unheldTotal = round2(unheld.reduce((sum, item) => sum + item.amount, 0))
        if (unheldTotal > available && unheldTotal > 0) {
          const scale = available / unheldTotal
          buys = buys.map((item) =>
            isHeldCode(doc, item.code) ? item : { ...item, amount: round2(item.amount * scale) },
          )
          buys = buys.filter((item) => item.amount > 0)
        }
      }
      // Equity-ish cap: A-share + overseas + gold may not exceed equityCapPct of the book.
      const bondLike = new Set([...bondCodes, '007169', '003376', '001257'])
      const cashLike = new Set([
        cashHolding?.code ?? cashCode,
        spendCashCode,
        ...doc.holdings.filter((holding) => holding.kind === 'cash').map((holding) => holding.code),
      ])
      const equityCurrent = round2(
        rows
          .filter((row) => !bondLike.has(row.code) && !cashLike.has(row.code))
          .reduce((sum, row) => sum + row.currentValue, 0),
      )
      const equityBuys = buys.filter((item) => !bondLike.has(item.code) && !cashLike.has(item.code))
      const equityLimit = round2(basis * (equityCapPct / 100) - equityCurrent)
      const equityBuyTotal = round2(equityBuys.reduce((sum, item) => sum + item.amount, 0))
      if (equityBuyTotal > 0 && equityBuyTotal > equityLimit) {
        const scale = Math.max(0, equityLimit) / equityBuyTotal
        buys = buys.map((item) =>
          bondLike.has(item.code) || cashLike.has(item.code) ? item : { ...item, amount: round2(item.amount * scale) },
        )
        buys = buys.filter((item) => item.amount > 0)
      }
      // Tactical band: each category may only overshoot its strategic anchor by
      // tacticalBandPp (e.g. A股 +4pp). Buys beyond the band are trimmed.
      const byCategoryNow = new Map()
      for (const row of rows) {
        const category = categoryOfCode(row.code)
        const bucket = byCategoryNow.get(category) ?? { strategicPct: 0, currentPct: 0 }
        bucket.strategicPct = round2(bucket.strategicPct + (row.targetPct ?? 0))
        bucket.currentPct = round2(bucket.currentPct + row.currentPct)
        byCategoryNow.set(category, bucket)
      }
      const categoryScale = new Map()
      for (const item of buys) {
        const category = categoryOfCode(item.code)
        const bucket = byCategoryNow.get(category) ?? { strategicPct: 0, currentPct: 0 }
        const capPct = bucket.strategicPct + (Number(tacticalBandPp[category]) || 0)
        const buyPct = (item.amount / basis) * 100
        const roomPct = Math.max(0, capPct - bucket.currentPct)
        const usedPct = categoryScale.get(category) ?? 0
        const availablePct = Math.max(0, roomPct - usedPct)
        if (buyPct > availablePct) {
          item.amount = round2((availablePct / 100) * value)
          categoryScale.set(category, round2(usedPct + availablePct))
        } else {
          categoryScale.set(category, round2(usedPct + buyPct))
        }
      }
      buys = buys.filter((item) => item.amount > 0)
      const sells = []
      if (!building) {
        for (const row of over) {
          const amount = round2(-row.deltaValue)
          if (amount > 0) sells.push({ ...row, amount, reason: `超配 ${Math.abs(row.deltaPct)}pp，卖出到目标比例` })
        }
      }
      const totalBuy = round2(buys.reduce((sum, row) => sum + row.amount, 0))
      const totalSell = round2(sells.reduce((sum, row) => sum + row.amount, 0))

      const lines = ['## 再平衡：新钱投放（按固定目标比例收敛）', '']
      lines.push(
        `组合总值 **${money(value)}**；钱袋子 **${money(cashValue)}**（目标 ${pct(cashTargetPct)}）；可动用弹药 **${
          Number.isFinite(available) ? money(available) : '未跟踪现金'
        }**`,
      )
      lines.push(
        `建仓进度 **${progress}%**；当前状态：**${building ? '建仓期（只买不卖，偏离仅评价）' : '已建仓（可双向收敛）'}**`,
      )
      lines.push('')
      lines.push('| 代码 | 名称 | 目标% | 当前% | 偏离 | 目标金额 | 当前金额 | 调整金额 | 评价 |')
      lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |')
      const buyMap = new Map(buys.map((row) => [row.code, row.amount]))
      const sellMap = new Map(sells.map((row) => [row.code, row.amount]))
      for (const row of [...rows].sort((a, b) => Math.abs(b.deltaPct ?? 0) - Math.abs(a.deltaPct ?? 0))) {
        const buy = buyMap.get(row.code) ?? 0
        const sell = sellMap.get(row.code) ?? 0
        const adjust = buy > 0 ? `+${money(buy)}` : sell > 0 ? `-${money(sell)}` : '—'
        let comment = '达标'
        if (row.deltaValue === null) comment = '未设目标'
        else if (row.deltaValue > 0) comment = building ? `低配 ${Math.abs(row.deltaPct)}pp，建仓期买入` : `低配 ${Math.abs(row.deltaPct)}pp`
        else if (row.deltaValue < 0) comment = building ? `超配 ${Math.abs(row.deltaPct)}pp，建仓期仅评价` : `超配 ${Math.abs(row.deltaPct)}pp，卖出收敛`
        lines.push(
          `| ${row.code} | ${row.name} | ${row.targetPct ?? '—'} | ${row.currentPct} | ${
            row.deltaPct === null ? '—' : `${row.deltaPct > 0 ? '+' : ''}${row.deltaPct}pp`
          } | ${row.targetValue === null ? '—' : money(row.targetValue)} | ${money(row.currentValue)} | ${adjust} | ${comment} |`,
        )
      }
      lines.push('')
      lines.push(
        `动态节奏：剩余缺口 ${money(totalGap)}（占组合 ${gapPct}%）× 节奏 ${round2(deployPacePct * 100)}% × 估值乘数 ${multiplier} = 本轮预算 ${
          Number.isFinite(budget) ? money(budget) : '—'
        }（不设固定轮数；缺口小于 ${deployStopGapPct}% 时视为建仓完成）`,
      )
      lines.push('')
      lines.push(`**买入合计 ${money(totalBuy)}**`)
      if (!building) lines.push(`**卖出合计 ${money(totalSell)}**（只调整比例，卖出的钱回钱袋子）`)
      else lines.push('建仓期不卖出：上表「超配」只作评价，等建仓完成（进度 ≥95% 且现金回到目标附近）再收敛。')
      if (totalGap > 0 && Number.isFinite(available) && available >= totalGap) {
        lines.push('弹药足够补满所有缺口：按上表全额买入即达到目标比例。')
      }
    return { text: lines.join('\n'), data: { value,
          plan: { pacePct: round2(deployPacePct * 100), gapPct, multiplier, budget, fundingMode, trackedRounds, stopGapPct: deployStopGapPct, phase: gapPct <= deployStopGapPct ? 'near-target' : 'building' },
          cash: {
            value: cashValue,
            spendable: buckets.spendable,
            targetPct: cashTargetPct,
            targetValue: cashTargetValue,
            available: Number.isFinite(available) ? available : null,
          },
          progress,
          building,
          rows,
          buys,
          sells,
          totalBuy,
          totalSell,
          totalGap,
 } }
  }

  /** Valuation check shared by the tool action and the HTTP route. */
  const runCheck = async (requestedCodes = [], options = {}) => {
    const intraday = options.intraday === true
      const doc = await store.read()
      const value = round2(
        doc.holdings.reduce((sum, holding) => sum + (Number(holding.units) || 0) * (Number(holding.price) || 0), 0),
      )
      const basis = planningValue > 0 ? planningValue : value
      const wanted = (requestedCodes ?? []).map((code) => String(code).trim().toUpperCase()).filter(Boolean)
      const codes = (wanted.length > 0
        ? wanted
        : [...new Set([...doc.holdings.map((h) => h.code), ...watchlist, ...Object.keys(doc.targets.byCode)])]
      ).filter((code) => code !== spendCashCode)
      if (codes.length === 0) throw new Error('没有可检查的标的：先录入持仓或配置 watchlist')

      const series = await fetchNavSeriesMap(ctx, codes, { server: mcpServer })
      let yieldHistory = null
      if (bondYieldSignal && longBondCodes.some((code) => codes.includes(code))) {
        if (yieldCache && Date.now() - yieldCache.at < 6 * 60 * 60 * 1000) {
          yieldHistory = yieldCache.list
        } else {
          try {
            yieldHistory = await fetchChina10yYield({ pages: bondYieldPages })
            yieldCache = { at: Date.now(), list: yieldHistory }
          } catch (error) {
            ctx.logger?.warn?.(`portfolio: cannot fetch 10Y yield (${String(error?.message ?? error)})`)
          }
        }
      }
      let goldPoints = null
      if (goldTrendGate && codes.includes(goldCode)) {
        if (goldCache && Date.now() - goldCache.at < 6 * 60 * 60 * 1000) {
          goldPoints = goldCache.points
        } else {
          try {
            goldPoints = await fetchKlineSeries(goldIndexSecid, { limit: goldLookbackLimit })
            goldCache = { at: Date.now(), points: goldPoints }
          } catch (error) {
            ctx.logger?.warn?.(`portfolio: cannot fetch gold index (${String(error?.message ?? error)})`)
          }
        }
      }
      let fxHistory = null
      if (defxCodes.some((code) => codes.includes(code))) {
        if (fxCache && Date.now() - fxCache.at < 6 * 60 * 60 * 1000) {
          fxHistory = fxCache.map
        } else {
          try {
            const points = await fetchKlineSeries(usdcnhSecid, { limit: 260 })
            fxHistory = new Map(points.map((point) => [point.date, point.close]))
            fxCache = { at: Date.now(), map: fxHistory }
          } catch (error) {
            ctx.logger?.warn?.(`portfolio: cannot fetch FX history (${String(error?.message ?? error)})`)
          }
        }
      }
      let intradayQuotes = null
      let intradayNote = ''
      if (intraday) {
        try {
          const exchangeCodes = codes.map((code) => quoteCodeFor(code)).filter(Boolean)
          intradayQuotes = await fetchEtfQuotes(exchangeCodes)
          if (intradayQuotes.size === 0) intradayNote = '盘中行情未取到，回退为日频净值'
        } catch (error) {
          intradayNote = `盘中行情不可用（${String(error?.message ?? error)}），回退为日频净值`
        }
      }
      let temperatures = null
      let temperatureNote = ''
      try {
        temperatures = await fetchTemperature(ctx, { server: mcpServer })
      } catch (error) {
        temperatureNote = `温度计不可用（${String(error?.message ?? error)}），A 股按“未知”处理`
      }
      const allA = temperatures?.find((row) => row.code === '000985') ?? temperatures?.[0] ?? null
      const ashare = classifyTemperature(allA?.temperature)
      const checkDividendBands = {}
      for (const code of dividendCodes) {
        const metrics = seriesMetrics(series.get(code))
        if (metrics) checkDividendBands[code] = classifyPosition(metrics).band
      }
      const checkTilt = effectiveTargets(doc, allA?.temperature ?? null, checkDividendBands)
      const checkTargets = checkTilt.byCode

      const rows = []
      for (const code of codes) {
        const rawMetrics = seriesMetrics(series.get(code))
        if (!rawMetrics) continue
        let metrics = rawMetrics
        let estimated = false
        let quotePct = null
        const quote = intradayQuotes?.get(quoteCodeFor(code))
        if (quote && Number.isFinite(quote.changePct)) {
          const estimate = rawMetrics.latest.nav * (1 + quote.changePct / 100)
          const high = Math.max(rawMetrics.high.nav, estimate)
          metrics = {
            ...rawMetrics,
            latest: { nav: estimate, date: `${rawMetrics.latest.date} 盘中` },
            high: { nav: high, date: rawMetrics.high.date },
            drawdownPct: high > 0 ? (estimate / high - 1) * 100 : null,
            deviationPct: rawMetrics.ma200 ? (estimate / rawMetrics.ma200 - 1) * 100 : null,
          }
          estimated = true
          quotePct = round2(quote.changePct)
        }
        let defxNote = ''
        let adjustedSeries = null
        if (fxHistory && defxCodes.includes(code)) {
          const adjusted = (series.get(code) ?? [])
            .map((point) => {
              const fx = fxHistory.get(String(point.date).slice(0, 10))
              return fx > 0 ? { date: point.date, nav: point.nav / fx } : null
            })
            .filter(Boolean)
          if (adjusted.length > 25) {
            adjustedSeries = adjusted
            metrics = seriesMetrics(adjusted)
            defxNote = '；已按 USDCNH 汇率还原（剔除汇率影响）'
          }
        }
        const stats = seriesStats(series.get(code))
        const holding = doc.holdings.find((entry) => entry.code === code)
        const isGold = code === goldCode
        const isOverseas = overseasCodes.includes(code)
        const isLongBond = longBondCodes.includes(code)
        const isCash = holding?.kind === 'cash'
        const isBond = (holding?.kind === 'bond') || bondCodes.includes(code)
        let band
        if (isCash) {
          band = { band: '现金', fraction: 1, note: '现金不参与估值，保持目标比例' }
        } else if (isBond && !isLongBond) {
          if (secondaryBondCodes.includes(code)) {
            const eqBand = classifyTemperature(allA?.temperature)
            const bondShare = 1 - secondaryBondEquityPct
            band = {
              band: '二级债',
              fraction: round2(bondShare + secondaryBondEquityPct * (eqBand.fraction ?? 0)),
              note: `${Math.round(bondShare * 100)}%债不择时 + ${Math.round(secondaryBondEquityPct * 100)}%权益按温度（${eqBand.band}）缩放`,
            }
          } else {
            band = { band: '不择时', fraction: 1, note: '短债直接补齐' }
          }
        } else if (isGold) {
          let base = classifyPosition(metrics)
          let goldNote = base.note
          if (goldTrendGate && Array.isArray(goldPoints) && goldPoints.length > 220) {
            const closes = goldPoints.map((point) => point.close)
            const latest = closes[closes.length - 1]
            const high3y = Math.max(...closes)
            const ma = (n) => (n <= closes.length ? closes.slice(-n).reduce((sum, v) => sum + v, 0) / n : null)
            const ma20 = ma(20), ma60 = ma(60), ma200 = ma(200)
            const ma20SlopePct = ma20 && closes.length > 25 ? ((ma20 / (closes.slice(-25, -5).reduce((a, b) => a + b, 0) / 20) - 1) * 100) : null
            const ma200SlopePct = ma200 && closes.length > 220 ? ((ma200 / (closes.slice(-220, -20).reduce((a, b) => a + b, 0) / 200) - 1) * 100) : null
            const trend = classifyTrend({ price: latest, ma20, ma60, ma200, ma20SlopePct, ma200SlopePct })
            const drawdown3y = high3y > 0 ? (latest / high3y - 1) * 100 : null
            base = classifyPosition({ drawdownPct: drawdown3y, deviationPct: ma200 ? (latest / ma200 - 1) * 100 : null })
            goldNote = `3 年区间：距高 ${round2(drawdown3y)}%、距 200 日线 ${round2((latest / ma200 - 1) * 100)}%；趋势${trend.state}（${trend.note}）`
            if (goldTrendGate) base = { ...base, fraction: Math.min(base.fraction, trend.cap), note: goldNote }
          }
          band = { ...base, fraction: capGold(base.fraction), note: `${base.note}；黄金封顶 1/2${defxNote}` }
        } else if (isLongBond) {
          const below = Number.isFinite(metrics.deviationPct) && metrics.deviationPct <= -2
          const dmaScore = below ? 1 : 1 / 3
          let yieldScore = null
          let yieldNote = ''
          if (bondYieldSignal && Array.isArray(yieldHistory) && yieldHistory.length > 200) {
            const values = yieldHistory.map((point) => point.yield)
            const current = values[0]
            const pct = percentileRank(values, current)
            yieldScore = pct >= 70 ? 1 : pct >= 30 ? 2 / 3 : 1 / 3
            yieldNote = `；10Y 国债 ${current.toFixed(2)}%（${round2(pct)} 分位）→ 收益率${pct >= 70 ? '偏高' : pct >= 30 ? '中性' : '偏低'}`
          }
          const fraction = round2(yieldScore === null ? dmaScore : Math.min(dmaScore, yieldScore))
          const bandName = fraction >= 1 ? '收益率回升' : fraction >= 0.5 ? '收益率中性' : '收益率低位'
          band = {
            band: bandName,
            fraction,
            note: `${below ? '净值低于 200 日线 2%' : '净值未低于 200 日线 2%'}${yieldNote}`,
          }
        } else if (isOverseas) {
          let base = classifyPosition(metrics)
          if (overseasTrendGate && Array.isArray(adjustedSeries) && adjustedSeries.length > 220) {
            const closes = adjustedSeries.map((point) => point.nav)
            const avg = (n) => closes.slice(-n).reduce((sum, value) => sum + value, 0) / n
            const latest = closes[closes.length - 1]
            const ma20 = avg(20)
            const ma60 = avg(60)
            const ma200 = avg(200)
            const prev20 = closes.slice(-25, -5).reduce((sum, value) => sum + value, 0) / 20
            const prev200 = closes.slice(-220, -20).reduce((sum, value) => sum + value, 0) / 200
            const trend = classifyTrend({
              price: latest,
              ma20,
              ma60,
              ma200,
              ma20SlopePct: (ma20 / prev20 - 1) * 100,
              ma200SlopePct: (ma200 / prev200 - 1) * 100,
            })
            const multiplier = overseasTrendLevels[trend.state] ?? 1
            base = {
              band: base.band,
              fraction: round2(base.fraction * multiplier),
              note: `${base.note}；趋势${trend.state} → 比例 ×${multiplier}`,
            }
          }
          band = { ...base, note: `${base.note}${defxNote}` }
        } else {
          const indexCode = ashareIndexMap[code] ?? '000985'
          const localA = temperatures?.find((row) => row.code === indexCode) ?? allA
          const tempBand = classifyTemperature(localA?.temperature)
          const tempNote = `A股温度 ${localA?.temperature ?? '—'}°（${localA?.name ?? '未知'}）`
          if (combineStyleValuation) {
            const posBand = classifyPosition(metrics)
            const usePosition = posBand.fraction < tempBand.fraction
            band = usePosition
              ? { ...posBand, note: `温度 ${tempBand.band}（${localA?.temperature ?? '—'}°）/ 自身位置 ${posBand.band} → 取更保守` }
              : { ...tempBand, note: `${tempNote} / 自身位置 ${posBand.band}` }
          } else {
            band = { ...tempBand, note: tempNote }
          }
        }
        const targetPct = Number(checkTargets[code])
        const currentValue = holding ? (Number(holding.units) || 0) * (Number(holding.price) || 0) : 0
        const targetValue = Number.isFinite(targetPct) ? (targetPct / 100) * basis : null
        const plainGap = targetValue === null ? null : Math.max(0, round2(targetValue - currentValue))
        // 两层结构：战略锚 = 目标金额；战术超配带 = 锚 + 该类别的 pp 带（且不超过锚×cheapOverBuyPct）；
        // 只有"便宜/极低估"才启用战术带，其余档位只补战略缺口。
        const categoryBand = Number(tacticalBandPp[categoryOfCode(code)])
        const bandPp = Number.isFinite(categoryBand) ? categoryBand : 0
        const tacticalCapValue =
          targetValue === null
            ? null
            : round2((targetValue * cheapOverBuyPct) / 100)
        const tacticalCapWithBand =
          targetValue === null || !Number.isFinite(bandPp) || bandPp <= 0
            ? tacticalCapValue
            : round2(Math.min(tacticalCapValue ?? Infinity, (targetPct + bandPp) * (value / 100)))
        const overBuyRoom =
          targetValue !== null && cheapOverBuyBands.includes(band.band) && cheapOverBuyPct > 100
            ? Math.max(0, round2((tacticalCapWithBand ?? targetValue) - currentValue))
            : plainGap
        const gap = overBuyRoom
        const suggest = gap === null ? null : round2(gap * (band.fraction ?? 0))
        rows.push({
          code,
          name: holding?.name || PLAN_LABELS[code] || code,
          latest: metrics.latest.nav,
          latestDate: metrics.latest.date,
          high: metrics.high.nav,
          highDate: metrics.high.date,
          drawdownPct: round2(metrics.drawdownPct),
          ma200: metrics.ma200 === null ? null : round2(metrics.ma200),
          deviationPct: round2(metrics.deviationPct),
          band: band.band,
          fraction: band.fraction,
          note: band.note,
          targetPct: Number.isFinite(targetPct) ? targetPct : null,
          tacticalCapPct:
            Number.isFinite(targetPct) && Number.isFinite(bandPp) && bandPp > 0 ? round2(targetPct + bandPp) : null,
          currentPct: basis > 0 ? round2((currentValue / basis) * 100) : 0,
          layer:
            targetPct === null
              ? null
              : currentValue > targetValue && cheapOverBuyBands.includes(band.band)
                ? '战术超配（估值驱动）'
                : currentValue > targetValue
                  ? '超战略锚，待回归'
                  : '战略补缺口',
          ret20: stats.ret20,
          vol20: stats.vol20,
          tranches: [],
          currentValue: round2(currentValue),
          estimated,
          quotePct,
          gap,
          suggest,
        })
      }
      // --- cash basket: the dry powder that funds every buy ---------------
      const buckets = cashBuckets(doc)
      const cashHolding = buckets.planCash ?? buckets.wallet
      const cashValue = buckets.total
      const dynamicCashPct = cashTargetPctFor(allA?.temperature)
      const cashTargetPct = Number.isFinite(dynamicCashPct)
        ? dynamicCashPct
        : [doc.targets.byCode?.[cashHolding?.code ?? ''], doc.targets.byCode?.[cashCode], doc.targets.byKind?.cash, 5]
            .map(Number)
            .find((value) => Number.isFinite(value))
      const cashTargetValue = round2((cashTargetPct / 100) * basis)
      const available =
        fundingMode !== 'external' && buckets.wallet
          ? Math.max(0, round2(buckets.spendable - reserveAmount - Math.max(0, cashTargetValue - buckets.other)))
          : null

      // --- sell signals: expensive and overweight, or clearly over target --
      const sells = []
      const overCheap = []
      for (const row of rows) {
        if (row.code === cashHolding?.code || row.band === '现金') continue
        if (row.targetPct === null) continue
        const weight = basis > 0 ? (row.currentValue / basis) * 100 : 0
        const overPct = round2(weight - row.targetPct)
        if (overPct <= 0.5) continue
        const amount = round2(Math.max(0, row.currentValue - (row.targetPct / 100) * basis))
        if (sellBands.includes(row.band)) {
          sells.push({ ...row, weight: round2(weight), overPct, reason: `${row.band}且超配 ${overPct}pp`, amount })
        } else {
          // 非贵的档位即使超配，也先不卖（用户原则），只记录
          overCheap.push({ ...row, weight: round2(weight), overPct, amount })
        }
      }

      // --- buy signals, capped by the dry powder in the cash basket --------
      const priority = {
        便宜: 5,
        偏低: 4,
        '合理偏低': 3,
        不择时: 3,
        二级债: 3,
        合理: 2,
        偏高: 1,
        贵: 0,
        现金: 0,
        收益率回升: 3,
        收益率低位: 2,
        未知: 0,
      }
      rows.sort((a, b) => (priority[b.band] ?? 0) - (priority[a.band] ?? 0) || (b.suggest ?? 0) - (a.suggest ?? 0))
      const rawBuys = rows
        .filter((row) => row.suggest !== null && row.suggest > 0)
        .map((row) => ({
          ...row,
          gap: row.gap ?? row.suggest,
          amount: row.suggest,
          priority: BAND_PRIORITY[row.band] ?? 1,
        }))
      const currentJointPct = round2(
        rows.filter((row) => jointCodes.includes(row.code)).reduce((sum, row) => sum + row.currentPct, 0),
      )
      let buys = capBuys(rawBuys, { value: basis, available, currentJointPct, priorityAllocation: true })
      // Equity-ish cap: A-share + overseas + gold may not exceed equityCapPct of the book.
      const bondLike = new Set([...bondCodes, '007169', '003376', '001257'])
      const cashLike = new Set([
        cashHolding?.code ?? cashCode,
        spendCashCode,
        ...doc.holdings.filter((holding) => holding.kind === 'cash').map((holding) => holding.code),
      ])
      const equityCurrent = round2(
        rows
          .filter((row) => !bondLike.has(row.code) && !cashLike.has(row.code))
          .reduce((sum, row) => sum + row.currentValue, 0),
      )
      const equityBuys = buys.filter((item) => !bondLike.has(item.code) && !cashLike.has(item.code))
      const equityLimit = round2(basis * (equityCapPct / 100) - equityCurrent)
      const equityBuyTotal = round2(equityBuys.reduce((sum, item) => sum + item.amount, 0))
      if (equityBuyTotal > 0 && equityBuyTotal > equityLimit) {
        const scale = Math.max(0, equityLimit) / equityBuyTotal
        buys = buys.map((item) =>
          bondLike.has(item.code) || cashLike.has(item.code) ? item : { ...item, amount: round2(item.amount * scale) },
        )
        buys = buys.filter((item) => item.amount > 0)
      }
      // Tactical band: each category may only overshoot its strategic anchor by
      // tacticalBandPp (e.g. A股 +4pp). Buys beyond the band are trimmed.
      const byCategoryNow = new Map()
      for (const row of rows) {
        const category = categoryOfCode(row.code)
        const bucket = byCategoryNow.get(category) ?? { strategicPct: 0, currentPct: 0 }
        bucket.strategicPct = round2(bucket.strategicPct + (row.targetPct ?? 0))
        bucket.currentPct = round2(bucket.currentPct + row.currentPct)
        byCategoryNow.set(category, bucket)
      }
      const categoryScale = new Map()
      for (const item of buys) {
        const category = categoryOfCode(item.code)
        const bucket = byCategoryNow.get(category) ?? { strategicPct: 0, currentPct: 0 }
        const capPct = bucket.strategicPct + (Number(tacticalBandPp[category]) || 0)
        const buyPct = (item.amount / basis) * 100
        const roomPct = Math.max(0, capPct - bucket.currentPct)
        const usedPct = categoryScale.get(category) ?? 0
        const availablePct = Math.max(0, roomPct - usedPct)
        if (buyPct > availablePct) {
          item.amount = round2((availablePct / 100) * value)
          categoryScale.set(category, round2(usedPct + availablePct))
        } else {
          categoryScale.set(category, round2(usedPct + buyPct))
        }
      }
      if (fundingMode === 'auto' && Number.isFinite(available)) {
        const unheld = buys.filter((item) => !isHeldCode(doc, item.code))
        const unheldTotal = round2(unheld.reduce((sum, item) => sum + item.amount, 0))
        if (unheldTotal > available && unheldTotal > 0) {
          const scale = available / unheldTotal
          buys = buys.map((item) =>
            isHeldCode(doc, item.code) ? item : { ...item, amount: round2(item.amount * scale) },
          )
        }
      }
      buys = buys.filter((item) => item.amount > 0)
      const requested = round2(rows.reduce((sum, row) => sum + (row.suggest ?? 0), 0))
      const buyByCode = new Map(buys.map((item) => [item.code, item.amount]))
      for (const row of rows) {
        row.suggest = round2(buyByCode.get(row.code) ?? 0)
        row.tranches = tranchePlan(row.suggest, { ret20: row.ret20, vol20: row.vol20 }, row.deviationPct)
      }
      const tranchesByCode = new Map(rows.map((row) => [row.code, row.tranches]))
      for (const item of buys) item.tranches = tranchesByCode.get(item.code) ?? []
      const totalBuy = round2(buys.reduce((sum, row) => sum + row.amount, 0))
      const capped = requested > totalBuy

      const lines = ['## 估值检查', '']
      lines.push(
        `A股温度：${allA ? `${allA.name} ${allA.temperature}°（${allA.rating || ashare.band}）` : '不可用'} → 档位 **${ashare.band}**，${ashare.note}`,
      )
      if (Number.isFinite(ashare.stopAbove)) lines.push(`（停止加仓阈值：温度 > ${ashare.stopAbove}°；建议每月只执行一次，避免边界反复）`)
      if (temperatureNote) lines.push(`注意：${temperatureNote}`)
      if (intraday) {
        lines.push(
          `盘中模式：已用场内实时价估算 ${[...(intradayQuotes?.keys() ?? [])].length} 个映射标的的当日净值；温度计仍为 T-1（盘中不更新）${intradayNote ? `；${intradayNote}` : ''}`,
        )
      }
      lines.push('')

      // cash basket first: that is the account the user actually funds
      lines.push('### 钱袋子')
      lines.push('')
      lines.push(
        `余额 **${money(cashValue)}**，占比 ${pct(value > 0 ? (cashValue / value) * 100 : 0)}，目标 ${pct(cashTargetPct)}（${money(cashTargetValue)}）`,
      )
      lines.push(
        fundingMode === 'external'
          ? `资金来源：**外部直接申购**（不占用钱袋子；单次预算上限 ${money(basis * maxRunPct)}）`
          : fundingMode === 'auto'
            ? `资金来源：**自动**（未持有品种用钱袋子 ${Number.isFinite(available) ? money(available) : '—'}，已持有品种直接申购）`
            : `可动用弹药 **${Number.isFinite(available) ? money(available) : '未跟踪现金'}**`,
      )
      lines.push('')

      lines.push('### 买入信号')
      lines.push('')
      if (buys.length === 0) {
        lines.push('暂无买入信号：要么目标已满，要么打折不够。')
      } else {
        lines.push('| 代码 | 名称 | 档位 | 缺口 | 建议买入 |')
        lines.push('| --- | --- | --- | ---: | ---: |')
        for (const row of buys) lines.push(`| ${row.code} | ${row.name} | ${row.band} | ${money(row.gap ?? 0)} | ${money(row.amount)} |`)
        lines.push('')
        lines.push(
          `**合计买入 ${money(totalBuy)}**${capped ? `（受钱袋子余额约束，未满足的额度留待下期）` : ''}`,
        )
        lines.push('')
        lines.push('### 分批计划（不是一次性买）')
        lines.push('')
        lines.push('| 代码 | 名称 | 建议合计 | 第1批（现在） | 第2批（再跌3%） | 第3批（再跌6%） | 本周行情 |')
        lines.push('| --- | --- | ---: | ---: | ---: | ---: | --- |')
        for (const row of buys) {
          const [t1, t2, t3] = row.tranches ?? []
          const mood =
            row.ret20 === null || row.ret20 === undefined
              ? '—'
              : `近20日 ${row.ret20 > 0 ? '+' : ''}${row.ret20}%${
                  row.vol20 === null || row.vol20 === undefined ? '' : `，波动 ${row.vol20}%`
                }`
          lines.push(
            `| ${row.code} | ${row.name} | ${money(row.amount)} | ${t1 ? money(t1.amount) : '—'} | ${
              t2 ? money(t2.amount) : '—'
            } | ${t3 ? money(t3.amount) : '—'} | ${mood} |`,
          )
        }
        lines.push('')
        lines.push(
          '分批规则：近20日涨超 5% → 30/35/35 更慢；已低于趋势且近20日跌超 3% → 60/20/20 前置；其余 40/30/30。后两批以"较当前再跌 3%/6%"为触发条件，不设时间强制。',
        )
      }
      lines.push('')

      lines.push('### 卖出信号')
      lines.push('')
      if (sells.length === 0) {
        lines.push('暂无卖出信号。')
      } else {
        lines.push('| 代码 | 名称 | 档位 | 当前权重 | 目标% | 卖出金额 | 原因 |')
        lines.push('| --- | --- | --- | ---: | ---: | ---: | --- |')
        for (const row of sells) {
          lines.push(
            `| ${row.code} | ${row.name} | ${row.band} | ${pct(row.weight)} | ${row.targetPct ?? '—'} | ${money(
              row.amount,
            )} | ${row.reason} |`,
          )
        }
        lines.push('')
        lines.push(`卖出所得回到钱袋子，作为下一期弹药。`)
      }
      lines.push('')

      if (overCheap.length > 0) {
        lines.push('### 超配但便宜（不卖）')
        lines.push('')
        lines.push('| 代码 | 名称 | 档位 | 当前权重 | 目标% | 超配 |')
        lines.push('| --- | --- | --- | ---: | ---: | ---: |')
        for (const row of overCheap) {
          lines.push(`| ${row.code} | ${row.name} | ${row.band} | ${pct(row.weight)} | ${row.targetPct ?? '—'} | +${row.overPct}pp |`)
        }
        lines.push('')
        lines.push('便宜的东西不卖，用新钱或等它变贵再平衡。')
        lines.push('')
      }

      lines.push('### 全部标的')
      lines.push('')
      lines.push('| 代码 | 名称 | 净值 | 1年高点 | 回撤 | 200日线 | 偏离 | 档位 | 战略% | 战术上限% | 缺口 |')
      lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |')
      for (const row of rows) {
        lines.push(
          `| ${row.code} | ${row.name} | ${row.latest} | ${row.high} | ${pct(row.drawdownPct)} | ${
            row.ma200 ?? '—'
          } | ${pct(row.deviationPct)} | ${row.band} | ${row.targetPct ?? '—'} | ${row.tacticalCapPct ?? '—'} | ${
            row.gap === null ? '—' : money(row.gap)
          } |`,
        )
      }
    const payload = {
      at: new Date().toISOString(),
      intraday,
      temperature: allA,
      ashare,
      buys: buys.map((row) => ({ code: row.code, name: row.name, band: row.band, amount: row.amount })),
      sells: sells.map((row) => ({ code: row.code, name: row.name, band: row.band, amount: row.amount, reason: row.reason })),
      totalBuy,
      totalSell: round2(sells.reduce((sum, row) => sum + row.amount, 0)),
      cash: { value: cashValue, targetPct: cashTargetPct, available: Number.isFinite(available) ? available : null },
      rows: rows.map((row) => ({
        code: row.code,
        name: row.name,
        band: row.band,
        fraction: row.fraction,
        targetPct: row.targetPct,
        currentPct: row.currentPct,
        drawdownPct: row.drawdownPct,
        deviationPct: row.deviationPct,
        gap: row.gap,
        suggest: row.suggest,
        estimated: row.estimated,
      })),
      text: lines.join('\n'),
    }
    await persistLastCheck(payload)
    await appendActivity({
      type: 'check',
      title: '每日估值体检',
      summary: `A股 ${Number.isFinite(allA?.temperature) ? `${allA.temperature}°` : '—'} / ${ashare.band}；买入合计 ${money(totalBuy)}${intraday ? '（盘中估算）' : ''}`,
      detail: {
        temperature: allA?.temperature ?? null,
        band: ashare.band,
        totalBuy,
        buyCount: buys.length,
        buys: buys.map((row) => ({ code: row.code, name: row.name, band: row.band, amount: row.amount })),
      },
    })
    return {
      text: lines.join('\n'),
      data: {
        temperature: allA,
        ashare,
        dividend: checkTilt.meta,
        layers: {
          strategicPct: round2(rows.reduce((sum, row) => sum + (row.targetPct ?? 0), 0)),
          tacticalOverlayPp: round2(rows.reduce((sum, row) => sum + (tacticalBandPp[categoryOfCode(row.code)] || 0), 0)),
          note: '战略配置是锚；估值只在战术带内超配，超带且不便宜则回归',
        },
        intraday: {
          requested: intraday,
          mapped: codes.filter((code) => Boolean(etfMap[code])).length,
          quotes: intradayQuotes?.size ?? 0,
          note: intradayNote,
        },
        rows,
        buys,
        sells,
        overCheap,
        cash: { value: cashValue, targetPct: cashTargetPct, targetValue: cashTargetValue, available: Number.isFinite(available) ? available : null },
        totalBuy,
        capped,
        value,
      },
    }
  }

  ctx.tools.register({
    name: 'portfolio',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 20000,
    async execute(args) {
      const action = args?.action ?? 'report'
      if (!ACTIONS.includes(action)) {
        throw new Error(`未知动作 ${action}；可选：${ACTIONS.join('、')}`)
      }

      if (action === 'upsert') {
        const incoming = args.holdings ?? []
        if (!Array.isArray(incoming) || incoming.length === 0) {
          throw new Error('upsert 需要至少一条 holdings 记录')
        }
        const parsed = incoming.map((holding, index) => normalizeHolding(holding, index))
        const { doc } = await store.update((draft) => {
          for (const holding of parsed) {
            const at = draft.holdings.findIndex((entry) => entry.code === holding.code)
            if (at >= 0) draft.holdings[at] = holding
            else draft.holdings.push(holding)
          }
        })
        const report = analyze(doc, { staleAfterDays })
        return result(
          'upsert',
          `已保存 ${parsed.length} 条持仓（${parsed.map((h) => h.code).join('、')}）。\n\n` +
            formatReport(report),
          { file, holdings: parsed, report },
        )
      }

      if (action === 'remove') {
        const codes = (args.codes ?? []).map((code) => String(code).trim().toUpperCase()).filter(Boolean)
        if (codes.length === 0) throw new Error('remove 需要 codes 列表')
        const removed = []
        const { doc } = await store.update((draft) => {
          draft.holdings = draft.holdings.filter((holding) => {
            if (codes.includes(holding.code)) {
              removed.push(holding.code)
              return false
            }
            return true
          })
        })
        if (removed.length === 0) {
          throw new Error(`没有匹配的持仓：${codes.join('、')}`)
        }
        return result('remove', `已删除 ${removed.length} 条持仓：${removed.join('、')}。`, {
          file,
          removed,
          holdings: doc.holdings.map((holding) => holding.code),
        })
      }

      if (action === 'targets') {
        const entries = args.targets ?? []
        if (!Array.isArray(entries) || entries.length === 0) {
          throw new Error('targets 需要至少一条目标权重')
        }
        const { doc } = await store.update((draft) => {
          for (const entry of entries) {
            const raw = String(entry?.key ?? '').trim()
            if (!raw) throw new Error('目标权重的 key 不能为空')
            const key = entry.scope === 'kind' ? raw : raw.toUpperCase()
            const bucket = entry.scope === 'kind' ? draft.targets.byKind : draft.targets.byCode
            const weight = Number(entry.weight)
            if (!Number.isFinite(weight)) throw new Error(`目标权重必须是数字：${entry.key}`)
            if (weight <= 0) delete bucket[key]
            else bucket[key] = weight
          }
        })
        const report = analyze(doc, { staleAfterDays })
        return result('targets', `已更新目标权重。\n\n${formatReport(report)}`, {
          file,
          targets: doc.targets,
          report,
        })
      }

      if (action === 'refresh') {
        const { doc, updated, missing, tool } = await refreshPrices(args.codes)
        const lines = ['## 净值刷新', '']
        lines.push(`行情源：\`${tool}\``)
        lines.push('')
        if (updated.length === 0) {
          lines.push('没有拿到任何报价，持仓现价未变。')
        } else {
          lines.push('| 代码 | 原现价 | 前日净值 | 最新净值 | 当日涨跌 | 净值日期 |')
          lines.push('| --- | --- | --- | --- | --- | --- |')
          for (const row of updated) {
            const move =
              row.prev === null || row.prev === undefined ? '—' : `${round2(row.to - row.prev)}`
            lines.push(
              `| ${row.code} | ${row.from ?? '—'} | ${row.prev ?? '—'} | ${row.to} | ${move} | ${row.date || '—'} |`,
            )
          }
        }
        if (missing.length > 0) {
          lines.push('')
          lines.push(`未取到报价：${missing.join('、')}（代码是否正确？是否为场外基金？）`)
        }
        lines.push('')
        const report = analyze(doc, { staleAfterDays })
        return result('refresh', `${lines.join('\n')}\n${formatReport(report)}`, {
          file,
          tool,
          updated,
          missing,
          report,
        })
      }

      if (action === 'snapshot') {
        const date = normalizeDate(args.snapshotDate)
        const { doc, snapshot: taken } = await takeSnapshot(date)
        const report = analyze(doc, { staleAfterDays })
        return result(
          'snapshot',
          `已记录 ${taken.date} 快照：市值 ${taken.value}，成本 ${taken.cost}。\n\n${formatReport(report)}`,
          { file, snapshot: taken, report },
        )
      }

      if (action === 'rebalance') {
        // New money in the cash basket → deploy by fixed target gaps;
        // otherwise re-rotate the already-held basket. One action, two modes.
        const doc0 = await store.read()
        const plan0 = buildPlan(doc0)
        const freshCash = fundingMode !== 'cash' || (plan0.cash.available !== null && plan0.cash.available > Math.max(100, plan0.value * 0.005))
        const planned = freshCash ? await runDeploy() : await runRotate()
        return result('rebalance', planned.text, { ...planned.data, mode: freshCash ? 'deploy' : 'rotate' })
      }

      if (action === 'check') {
        const checked = await runCheck(args.codes ?? [], { intraday: args.intraday === true })
        return result('check', checked.text, checked.data)
      }

      if (action === 'history') {
        const doc = await store.read()
        const report = analyze(doc, { staleAfterDays })
        const lines = ['## 历史快照', '']
        if (doc.snapshots.length === 0) {
          lines.push('还没有快照。用 action=snapshot 记录当前市值后即可跟踪回撤与收益。')
        } else {
          lines.push('| 日期 | 市值 | 成本 |')
          lines.push('| --- | --- | --- |')
          for (const entry of doc.snapshots) lines.push(`| ${entry.date} | ${entry.value} | ${entry.cost} |`)
          lines.push('')
          lines.push(
            `当前回撤：${report.history.drawdownPct ?? '—'}%；自首个快照以来：${
              report.history.returnSinceFirstPct ?? '—'
            }%`,
          )
        }
        return result('history', lines.join('\n'), { file, history: report.history, snapshots: doc.snapshots })
      }

      // report
      const doc = await store.read()
      if (doc.holdings.length === 0) {
        return result(
          'report',
          '组合还是空的。先用 action=upsert 录入持仓（代码、份额、成本价、最新价），再调用 report。',
          { file, empty: true, totals: { value: 0, cost: 0, count: 0 } },
        )
      }
      const report = analyze(doc, { staleAfterDays })
      return result('report', formatReport(report), { file, report })
    },
  })

  // Opt-in daily refresh: off unless the row config sets autoRefreshHours.
  // `timer` is injected optionally so a profile without the timer row still
  // loads the plugin (the tool and panel keep working).
  if (autoRefreshHours > 0) {
    ctx.inject(['timer'], (scope) => {
      scope.effect(
        () =>
          scope.interval(async () => {
            try {
              const { updated } = await refreshPrices([])
              if (updated.length > 0 && autoSnapshot) {
                await takeSnapshot(new Date().toISOString().slice(0, 10))
              }
              ctx.logger?.info?.(`portfolio: auto refresh updated ${updated.length} holding(s)`)
            } catch (error) {
              ctx.logger?.warn?.(`portfolio: auto refresh failed: ${String(error?.message ?? error)}`)
            }
          }, autoRefreshHours * 3_600_000),
        'portfolio: auto refresh interval',
      )
    })
  }

  // Daily 14:40 check (weekdays by default): compute and persist the signals so
  // the panel and the session reminder can read them.
  const parseClock = (value) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ''))
    if (!match) return null
    const hour = Number(match[1])
    const minute = Number(match[2])
    if (hour > 23 || minute > 59) return null
    return { hour, minute }
  }
  const clock = parseClock(scheduleCheckAt)
  if (clock) {
    ctx.inject(['timer'], (scope) => {
      scope.effect(() => {
        let disposed = false
        let handle = null
        const msUntilNext = () => {
          const now = new Date()
          const next = new Date(now)
          next.setHours(clock.hour, clock.minute, 0, 0)
          if (scheduleWeekdaysOnly) {
            while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1)
          }
          if (next.getTime() <= now.getTime()) {
            next.setDate(next.getDate() + 1)
            if (scheduleWeekdaysOnly) {
              while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1)
            }
          }
          return Math.max(1000, next.getTime() - now.getTime())
        }
        const run = async () => {
          if (disposed) return
          try {
            await runCheck([], { intraday: true })
            ctx.logger?.info?.(`portfolio: ${scheduleCheckAt} scheduled check done`)
          } catch (error) {
            ctx.logger?.warn?.(`portfolio: scheduled check failed (${String(error?.message ?? error)})`)
          }
          scheduleNext()
        }
        const scheduleNext = () => {
          if (disposed) return
          handle = scope.timeout(run, msUntilNext())
        }
        scheduleNext()
        return () => {
          disposed = true
          if (typeof handle === 'function') handle()
        }
      }, 'portfolio: scheduled check')
    })
  }

  const weeklyClock = parseClock(scheduleWeeklyAt)
  if (weeklyEnabled && weeklyClock) {
    ctx.inject(['timer'], (scope) => {
      scope.effect(() => {
        let disposed = false
        let handle = null
        const msUntilNext = () => {
          const now = new Date()
          const next = new Date(now)
          next.setHours(weeklyClock.hour, weeklyClock.minute, 0, 0)
          const friday = 5
          const delta = (friday - next.getDay() + 7) % 7
          next.setDate(next.getDate() + delta)
          if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 7)
          return Math.max(1000, next.getTime() - now.getTime())
        }
        const run = async () => {
          if (disposed) return
          try {
            await runWeekly()
            ctx.logger?.info?.(`portfolio: ${scheduleWeeklyAt} weekly analysis done`)
          } catch (error) {
            ctx.logger?.warn?.(`portfolio: weekly analysis failed (${String(error?.message ?? error)})`)
          }
          scheduleNext()
        }
        const scheduleNext = () => {
          if (disposed) return
          handle = scope.timeout(run, msUntilNext())
        }
        scheduleNext()
        return () => {
          disposed = true
          if (typeof handle === 'function') handle()
        }
      }, 'portfolio: weekly market analysis')
    })
  }

  // The browser half reads these routes with relative fetches. Optional
  // injection keeps the tool working in profiles without a web server
  // (headless, ACP): only the panel is absent there.
  /** The buy/sell decision rules themselves, so the panel can show the model. */
  const buildModel = () => ({
    temperature: {
      source: '盈米市场温度计：指数成立以来的 PE + PB + 风险溢价加权，0–100°',
      bands: [
        { range: '<10°', band: '极低估', action: '买满剩余额度' },
        { range: '10–30°', band: '低估', action: '买 2/3' },
        { range: '30–50°', band: '合理', action: '买 1/3（慢）' },
        { range: '50–70°', band: '偏高', action: '买 1/4 或等' },
        { range: '>70°', band: '高估', action: '不买' },
      ],
      hysteresis: '档位按整数边界切换，同一档位内不因日频波动改动作；每月只执行一次',
      styleNote:
        '风格/行业指数（红利、消费、医药、医疗）没有独立温度：用宽基温度与自身 200 日线/回撤位置取更保守者，避免"宽基低估但行业已涨高"的误判',
    },
    position: {
      source: '1 年高点回撤 + 200 日均线偏离（位置信号，不是绝对估值）',
      bands: [
        { band: '便宜', action: '买满剩余额度', rule: '回撤深且低于 200 日线' },
        { band: '偏低', action: '买 1/2', rule: '回撤 10–20% 或低于均线' },
        { band: '合理偏低', action: '买 1/3', rule: '仅一个条件成立' },
        { band: '合理', action: '买 1/4', rule: '两个条件都不明显' },
        { band: '偏高', action: '买 1/10 或等', rule: '接近高点或高于均线 3%+' },
        { band: '贵', action: '不买', rule: '创新高且高于均线 10%+' },
      ],
      note: '未接入美股 CAPE / 实际利率 / 中债收益率，只作位置判断，置信度较低',
    },
    gold: {
      source: 'COMEX 美元金价（101.GC00Y）的 3 年区间 + 20/60/200 日均线排列',
      rules: [
        { state: '下跌（空头排列+均线走低）', cap: '单次上限 1/4' },
        { state: '震荡（均线纠缠）', cap: '单次上限 3/8' },
        { state: '上涨（多头排列+均线走高）', cap: '恢复 1/2' },
      ],
      note: '位置=距 3 年高点回撤 + 距 200 日线偏离；最终 = min(位置档位, 趋势上限) 再封顶 1/2',
    },
    overseas: {
      source: 'QDII 净值除以 USDCNH 汇率后的位置信号',
      rules: [
        { trend: '下跌', multiplier: 0.6 },
        { trend: '震荡', multiplier: 0.8 },
        { trend: '上涨', multiplier: 1.0 },
      ],
      note: '位置（回撤 + 200 日线）再乘趋势系数；标普/恒生/中概/全球医疗适用',
    },
    bonds: {
      short: '短债/现金：不择时，买满缺口',
      secondary: '二级债（001257）：80% 债不择时 + 20% 权益按 A股温度缩放',
      long: '长债（003376）：200 日线偏离 + 中国 10 年期国债收益率分位，取更保守',
      longBands: [
        { percentile: '≥70%', fraction: 1, note: '收益率高=债便宜，可加久期' },
        { percentile: '30–70%', fraction: 2 / 3, note: '中性' },
        { percentile: '<30%', fraction: 1 / 3, note: '收益率低=债贵，只买底盘' },
      ],
    },
    cash: {
      source: '随 A股温度升降的动态现金目标（借鉴长赢）',
      bands: [
        { temperature: '<10°', targetPct: 5 },
        { temperature: '10–30°', targetPct: 10 },
        { temperature: '30–50°', targetPct: 20 },
        { temperature: '>50°', targetPct: 35 },
      ],
      buckets: '盈米宝=可直接申购的自由现金；组合钱袋子=平台组合内现金（不参与直接申购）',
    },
    special: [
      { label: `黄金（${goldCode}）`, rule: '信号再便宜也最多买 1/2；再跌 8–10% 才补满' },
      { label: `长债（${longBondCodes.join('、')}）`, rule: '净值低于 200 日线 2% 视为收益率回升，可加满；否则只买 1/3' },
      { label: '短债 / 二级债 / 现金', rule: '不择时，直接补齐（压舱石）' },
    ],
    sell: {
      bands: sellBands,
      overPct: sellOverTargetPct,
      rule: `只在「${sellBands.join(' / ')}」且超配 >0.5pp 时卖出到目标比例；便宜资产即使超配也不卖`,
    },
    timing: '每月固定一天跑一次；买卖金额由与固定目标比例的缺口 × 档位比例决定',
    // 组合目标 + 回测（2026-11-04 v7.1，与 建仓计划-方案D.md §13 同步）
    portfolio: {
      capital: 300000,
      expectedReturnPct: 4.9,
      drawdownBudgetPct: 20,
      effectiveNote:
        '当前温度 8.34°：红利 tilt 被"自身位置偏高"阻断（008163/020602 高于 200 日线约 4%），实际 红利 28% / 债券 39%；若两只红利回到 200 日线下方，自动顶到 红利 30% / 债券 37%',
      layers: [
        { name: '红利', weight: 28, codes: '100032 9 ｜ 008163 7 ｜ 009051 6 ｜ 020602 6（温度<10° 可到 30）' },
        { name: 'A股其他', weight: 13, codes: '022424 6 ｜ 000248 3 ｜ 001180 2 ｜ 162412 2' },
        { name: '海外', weight: 10, codes: '050025 4 ｜ 000071 2 ｜ 006327 2.5 ｜ 000369 1.5（优先场内 513500/513050）' },
        { name: '黄金', weight: 5, codes: '000216 5（单次封顶 1/2）' },
        { name: '债券', weight: 39, codes: '007169 28 ｜ 003376 6 ｜ 001257 5' },
        { name: '现金', weight: 5, codes: '000509 5' },
      ],
      note:
        'v7.1 动态规则：权益随温度在 56%（<10°）→24%（>70°）之间调整；现金 5%–25%；黄金固定 5%；只卖"贵"的、便宜多买；权重锁定 12 个月，只允许红利 24–30% 随温度调节',
    },
    backtest: {
      window: '2021-11-02 ~ 2026-11-03（近 5 年，目标权重静态持有、未再平衡，不含现金）',
      annualizedPct: 3.56,
      maxDrawdownPct: -8.14,
      volatilityPct: 7.26,
      sharpe: 0.1,
      compare: 'v7（债券 41 / 黄金 6 / 海外 12）同期：年化 4.01%、最大回撤 −7.55%。回测奖励过去 5 年的债券/黄金赢家，v7.1 是前瞻调整——不要用回测选权重。',
      stress: [
        { scenario: 'S1 全球 risk-off（股 −25~−35%、金 −20%、债 −4.5%）', value: -18.2 },
        { scenario: 'S2 利率 +200bp', value: -1.7 },
        { scenario: 'S3 A股 −30%', value: -12.9 },
        { scenario: 'S5 股债双杀（A −25 / 海 −20 / 债 −4）', value: -15.0 },
      ],
      note:
        '4 只基金用表征指数代理（050025/006327/000369→885065；020602/022424 早期→H11021）；压力测试为估算，历史回撤不代表未来。',
    },
  })

  /** Effective targets: base weights with the dividend band tilt applied. */
  const effectiveTargets = (doc, temperature, dividendBands = null) =>
    tiltDividend(
      doc.targets.byCode ?? {},
      {
        dividendCodes,
        bandMin: dividendBandMin,
        bandMax: dividendBandMax,
        cheapBelow: dividendCheapBelow,
        expensiveAbove: dividendExpensiveAbove,
        fundingCode: dividendFundingCode,
        dividendBands: dividendBands ?? {},
        blockUpTiltBands: ['偏高', '贵'],
      },
      temperature,
    )

  /** Apply the one-shot caps: per-sleeve step, overseas+gold joint cap, run cap. */
  const capBuys = (items, context) => {
    const { value, available, currentJointPct } = context
    const cap = items.map((item) => ({
      ...item,
      amount: round2(Math.min(item.amount, Math.max(0, (item.gap ?? item.amount) * maxSleeveStepPct))),
    }))
    let jointTotal = 0
    for (const item of cap) if (jointCodes.includes(item.code)) jointTotal = round2(jointTotal + item.amount)
    const jointAllowed = round2(Math.max(0, ((overseasGoldCapPct - currentJointPct) / 100) * value))
    if (jointTotal > 0 && jointTotal > jointAllowed) {
      const scale = jointAllowed / jointTotal
      for (const item of cap) if (jointCodes.includes(item.code)) item.amount = round2(item.amount * scale)
    }
    const maxRun = Number.isFinite(available) ? Math.min(available, value * maxRunPct) : value * maxRunPct
    let total = round2(cap.reduce((sum, item) => sum + item.amount, 0))
    if (total > 0 && total > maxRun) {
      if (context.priorityAllocation) {
        // cheapest band first, then biggest gap
        const ranked = [...cap].sort(
          (a, b) => (b.priority ?? 1) - (a.priority ?? 1) || (b.gap ?? b.amount) - (a.gap ?? a.amount),
        )
        let remaining = maxRun
        for (const item of ranked) {
          const take = round2(Math.min(item.amount, remaining))
          item.amount = take
          remaining = round2(remaining - take)
        }
        for (const item of cap) if (!ranked.includes(item)) item.amount = 0
      } else {
        const scale = maxRun / total
        for (const item of cap) item.amount = round2(item.amount * scale)
      }
      total = round2(cap.reduce((sum, item) => sum + item.amount, 0))
    }
    return cap.filter((item) => item.amount > 0)
  }

  const lastCheckFile = () => join(dirname(file), 'last-check.json')
  const navCacheFile = () => join(dirname(file), 'nav-cache.json')
  const weeklyFile = () => join(dirname(file), 'weekly.json')
  const activityFile = () => join(dirname(file), 'activity.json')
  const readActivity = async () => {
    try {
      const parsed = JSON.parse(await readFile(activityFile(), 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  /** Append one automation result, keeping only the last N entries. */
  const appendActivity = async (entry) => {
    try {
      const existing = await readActivity()
      const next = [...existing, { at: new Date().toISOString(), ...entry }].slice(-activityLimit)
      await writeFile(activityFile(), `${JSON.stringify(next, null, 2)}\n`)
      return next
    } catch (error) {
      ctx.logger?.warn?.(`portfolio: cannot append activity (${String(error?.message ?? error)})`)
      return null
    }
  }
  const readWeekly = async () => {
    try {
      return JSON.parse(await readFile(weeklyFile(), 'utf8'))
    } catch {
      return null
    }
  }
  const readNavCache = async () => {
    try {
      return JSON.parse(await readFile(navCacheFile(), 'utf8'))
    } catch {
      return {}
    }
  }
  const persistLastCheck = async (payload) => {
    try {
      await mkdir(dirname(lastCheckFile()), { recursive: true })
      await writeFile(lastCheckFile(), `${JSON.stringify(payload, null, 2)}\n`)
    } catch (error) {
      ctx.logger?.warn?.(`portfolio: cannot persist last check (${String(error?.message ?? error)})`)
    }
  }
  const dividendBandsFromRows = (rows) => {
    const map = {}
    for (const row of Array.isArray(rows) ? rows : []) {
      if (dividendCodes.includes(row.code) && row.band) map[row.code] = row.band
    }
    return map
  }

  const readLastCheck = async () => {
    try {
      return JSON.parse(await readFile(lastCheckFile(), 'utf8'))
    } catch {
      return null
    }
  }

  /** Cash buckets: inside the plan basket vs the free wallet (盈米宝). */
  const cashBuckets = (doc) => {
    const holdings = doc.holdings ?? []
    const planCash =
      holdings.find((h) => h.code === cashCode) ??
      holdings.find((h) => h.kind === 'cash' && h.code !== spendCashCode) ??
      null
    // Without a dedicated wallet sleeve, the plan's own cash is the spendable pool.
    const wallet = holdings.find((h) => h.code === spendCashCode) ?? planCash
    const total = round2(holdings.filter((h) => h.kind === 'cash').reduce((sum, h) => sum + (Number(h.units) || 0) * (Number(h.price) || 1), 0))
    const spendable = wallet ? round2((Number(wallet.units) || 0) * (Number(wallet.price) || 1)) : 0
    return { wallet, planCash, total, spendable, other: round2(total - spendable) }
  }

  const categoryOfCode = (code) =>
    code === cashCode || code === spendCashCode
      ? '现金'
      : code === goldCode
        ? '黄金'
        : bondCodes.includes(code)
          ? '债券'
          : overseasCodes.includes(code)
            ? '海外'
            : 'A股'

  const tacticalOverPct = (row) => {
    const band = Number(tacticalBandPp[row.category])
    return Number.isFinite(band) ? band : 0
  }

  /** Full target book (held + not-yet-held) for the panel's plan table. */
  const buildPlan = (doc, temperature = null, dividendBands = null) => {
    const value = round2(
      doc.holdings.reduce((sum, holding) => sum + (Number(holding.units) || 0) * (Number(holding.price) || 0), 0),
    )
    const basis = planningValue > 0 ? planningValue : value
    const tilt = effectiveTargets(doc, temperature, dividendBands)
    const targetsByCode = tilt.byCode
    const buckets = cashBuckets(doc)
    const cashHolding = buckets.planCash ?? buckets.wallet
    const cashValue = buckets.total
    const dynamicCashPct = cashTargetPctFor(temperature)
    const cashTargetPct = Number.isFinite(dynamicCashPct)
      ? dynamicCashPct
      : [targetsByCode[cashHolding?.code ?? ''], targetsByCode[cashCode], doc.targets.byKind?.cash, 5]
          .map(Number)
          .find((number) => Number.isFinite(number))
    const cashTargetValue = round2((cashTargetPct / 100) * basis)
    const available =
      fundingMode !== 'external' && buckets.wallet
        ? Math.max(0, round2(buckets.spendable - reserveAmount - Math.max(0, cashTargetValue - buckets.other)))
        : null
    const categoryOf = (code) =>
      code === (cashHolding?.code ?? cashCode) || code === spendCashCode
        ? '现金'
        : code === goldCode
          ? '黄金'
          : bondCodes.includes(code)
            ? '债券'
            : overseasCodes.includes(code)
              ? '海外'
              : 'A股'
    const codes = [...new Set([...Object.keys(targetsByCode), ...doc.holdings.map((holding) => holding.code)])]
    const rows = codes.map((code) => {
      const holding = doc.holdings.find((entry) => entry.code === code)
      const currentValue = holding
        ? round2((Number(holding.units) || 0) * (Number(holding.price) || (holding.kind === 'cash' ? 1 : 0)))
        : 0
      const targetPct = Number(targetsByCode[code])
      const targetValue = Number.isFinite(targetPct) ? round2((targetPct / 100) * basis) : null
      const currentPct = basis > 0 ? round2((currentValue / basis) * 100) : 0
      return {
        code,
        name: holding?.name || PLAN_LABELS[code] || code,
        category: categoryOf(code),
        kind: holding?.kind ?? null,
        held: Boolean(holding),
        targetPct: Number.isFinite(targetPct) ? targetPct : null,
        currentPct,
        deltaPct: Number.isFinite(targetPct) ? round2(currentPct - targetPct) : null,
        targetValue,
        currentValue,
        deltaValue: targetValue === null ? null : round2(targetValue - currentValue),
      }
    })
    const nonCashValue = rows
      .filter((row) => row.category !== '现金')
      .reduce((sum, row) => sum + row.currentValue, 0)
    const targetNonCash = Math.max(0, round2(basis - cashTargetValue))
    const progress = targetNonCash > 0 ? Math.min(100, round2((nonCashValue / targetNonCash) * 100)) : 100
    const cashPct = basis > 0 ? round2((cashValue / basis) * 100) : 0
    const byCategory = new Map()
    for (const row of rows) {
      const bucket = byCategory.get(row.category) ?? {
        category: row.category,
        targetPct: 0,
        currentPct: 0,
        gapValue: 0,
        count: 0,
        heldCount: 0,
      }
      bucket.targetPct = round2(bucket.targetPct + (row.targetPct ?? 0))
      bucket.currentPct = round2(bucket.currentPct + row.currentPct)
      bucket.gapValue = round2(bucket.gapValue + (row.deltaValue ?? 0))
      bucket.count += 1
      if (row.held) bucket.heldCount += 1
      byCategory.set(row.category, bucket)
    }
    const strategicTotal = round2(rows.reduce((sum, row) => sum + (row.targetPct ?? 0), 0))
    const overlayTotal = round2(rows.reduce((sum, row) => sum + tacticalOverPct(row), 0))
    return {
      value,
      basis,
      targetCapital,
      layers: {
        strategicPct: strategicTotal,
        tacticalOverlayPct: overlayTotal,
        note: '战略配置是锚；估值只允许在战术带内超配（逐类上限见下），超带需回归',
      },
      categorySummary: ['现金', '债券', 'A股', '海外', '黄金']
        .map((category) => byCategory.get(category))
        .filter(Boolean)
        .map((bucket) => ({
          ...bucket,
          tacticalBandPp: Number.isFinite(Number(tacticalBandPp[bucket.category])) ? Number(tacticalBandPp[bucket.category]) : 0,
          tacticalCapPct: round2(bucket.targetPct + (Number(tacticalBandPp[bucket.category]) || 0)),
        })),
      rows: rows.sort((a, b) => (b.targetPct ?? 0) - (a.targetPct ?? 0)),
      cash: {
        value: cashValue,
        spendable: buckets.spendable,
        walletCode: spendCashCode,
        targetPct: cashTargetPct,
        targetValue: cashTargetValue,
        available,
        reserve: reserveAmount,
      },
      fundingMode,
      progress,
      cashPct,
      building: progress < 95 || cashPct - cashTargetPct > 2,
      heldCount: rows.filter((row) => row.held).length,
      targetCount: rows.filter((row) => row.targetPct !== null).length,
      dividend: tilt.meta,
    }
  }

  const orderId = () => `ord-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const tradeDateOf = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) ? String(value) : new Date().toISOString().slice(0, 10))

  /** Record a platform rebalance transfer (cash basket → fund), share-based. */
  const transferOrders = async (items, options = {}) => {
    const list = (Array.isArray(items) ? items : [])
      .map((item) => ({
        from: String(item?.from ?? item?.fromCode ?? cashCode).trim().toUpperCase(),
        to: String(item?.to ?? item?.code ?? '').trim().toUpperCase(),
        name: typeof item?.name === 'string' ? item.name : '',
        amount: round2(Number(item?.amount) || 0),
      }))
      .filter((item) => item.to && item.amount > 0)
    if (list.length === 0) throw new Error('没有可记录的调仓（需要 to 代码与金额）')
    const tradeDate = tradeDateOf(options.tradeDate)
    const immediate = options.immediate === true
    const navCache = immediate ? await readNavCache() : {}
    const created = []
    await store.update((draft) => {
      if (!Array.isArray(draft.orders)) draft.orders = []
      for (const item of list) {
        const order = {
          id: orderId(),
          side: 'transfer',
          fromCode: item.from,
          code: item.to,
          name: item.name || PLAN_LABELS[item.to] || item.to,
          amount: item.amount,
          source: 'cash',
          tradeDate,
          status: 'pending',
          createdAt: new Date().toISOString(),
        }
        draft.orders.push(order)
        created.push(order)
      }
    })
    const total = round2(created.reduce((sum, order) => sum + order.amount, 0))
    await appendActivity({
      type: 'transfer',
      title: '钱袋子调仓',
      summary: `转出 ${created.length} 笔，合计 ${money(total)}（待净值确认）`,
      detail: { count: created.length, total, items: created.map((order) => ({ code: order.code, amount: order.amount })) },
    })
    return { orders: created, total, tradeDate }
  }

  /** Queue buy orders for the sleeves the user ticked in the check result. */
  const executeOrders = async (items, options = {}) => {
    const currentDoc = await store.read()
    const list = (Array.isArray(items) ? items : [])
      .map((item) => ({
        code: String(item?.code ?? '').trim().toUpperCase(),
        name: typeof item?.name === 'string' ? item.name : '',
        source:
          item?.source === 'cash' || item?.source === 'external'
            ? item.source
            : resolveSource(currentDoc, String(item?.code ?? '').trim().toUpperCase()),
        amount: round2(Number(item?.amount) || 0),
      }))
      .filter((item) => item.code && item.amount > 0)
    if (list.length === 0) throw new Error('没有选中任何品种，或金额为 0')
    const tradeDate = tradeDateOf(options.tradeDate)
    const immediate = options.immediate === true
    const navCache = immediate ? await readNavCache() : {}
    const created = []
    await store.update((draft) => {
      if (!Array.isArray(draft.orders)) draft.orders = []
      for (const item of list) {
        const order = {
          id: orderId(),
          code: item.code,
          name: item.name || PLAN_LABELS[item.code] || item.code,
          side: 'buy',
          amount: item.amount,
          source: item.source ?? fundingMode,
          tradeDate,
          status: 'pending',
          createdAt: new Date().toISOString(),
        }
        if (immediate) {
          let holding = draft.holdings.find((entry) => entry.code === order.code)
          const cachedNav = navCache[order.code] ?? null
          const price = holding ? Number(holding.price) : Number(cachedNav?.nav)
          const navDate = holding ? holding.priceDate : cachedNav?.navDate
          if (!Number.isFinite(price) || price <= 0) {
            throw new Error(`缺少 ${order.code} 的最新净值，无法即时入账；请先刷新净值`)
          }
          const units = round2(order.amount / price)
          if (!holding) {
            holding = {
              code: order.code,
              name: order.name,
              kind: ['007169', '003376', '001257'].includes(order.code) ? 'bond' : 'fund',
              units: 0,
              costPrice: price,
              price,
              priceDate: navDate,
            }
            draft.holdings.push(holding)
          }
          holding.units = round2((Number(holding.units) || 0) + units)
          holding.price = price
          holding.priceDate = navDate
          holding.costPrice = holding.costPrice || price
          holding.updatedAt = new Date().toISOString()
          if ((order.source ?? fundingMode) !== 'external' && order.cashDeducted !== true) {
            const cash =
              draft.holdings.find((entry) => entry.code === cashCode) ??
              draft.holdings.find((entry) => entry.kind === 'cash')
            if (cash) cash.units = round2((Number(cash.units) || 0) - order.amount)
          }
          order.status = 'filled'
          order.filledAt = new Date().toISOString()
          order.filledNav = price
          order.filledNavDate = navDate
          order.filledUnits = units
        }
        draft.orders.push(order)
        created.push(order)
      }
      if (!draft.deployment || !Array.isArray(draft.deployment.rounds)) draft.deployment = { rounds: [] }
      draft.deployment.rounds.push({
        at: new Date().toISOString(),
        tradeDate,
        amount: round2(created.reduce((sum, order) => sum + order.amount, 0)),
        orders: created.map((order) => order.id),
      })
    })
    const total = round2(created.reduce((sum, order) => sum + order.amount, 0))
    await appendActivity({
      type: 'execute',
      title: '提交买入订单',
      summary: `提交 ${created.length} 笔，合计 ${money(total)}（待确认）`,
      detail: { count: created.length, total, orders: created.map((order) => ({ code: order.code, name: order.name, amount: order.amount })) },
    })
    return { orders: created, total, tradeDate }
  }

  /** Fill pending buys once a NAV on/after the order date is available. */
  const fillPendingOrders = async (navQuotes) => {
    const filled = []
    if (!navQuotes || navQuotes.size === 0) return filled
    await store.update((draft) => {
      if (!Array.isArray(draft.orders) || draft.orders.length === 0) return
      for (const order of draft.orders) {
        if (order.status !== 'pending') continue
        if (order.side === 'transfer') continue // handled below once the target NAV is known
        const quote = navQuotes.get(order.code)
        if (!quote || !Number.isFinite(quote.price) || !quote.date) continue
        if (String(quote.date) < String(order.tradeDate)) continue
        const units = round2(order.amount / quote.price * 100) / 100
        if (!Number.isFinite(units) || units <= 0) continue
        let holding = draft.holdings.find((entry) => entry.code === order.code)
        if (!holding) {
          holding = {
            code: order.code,
            name: order.name,
            kind: 'fund',
            units: 0,
            costPrice: quote.price,
            price: quote.price,
            priceDate: quote.date,
          }
          draft.holdings.push(holding)
        }
        holding.units = round2((Number(holding.units) || 0) + units)
        holding.price = quote.price
        holding.priceDate = quote.date
        holding.costPrice = holding.costPrice || quote.price
        if (quote.prevPrice) {
          holding.prevPrice = quote.prevPrice
          holding.prevPriceDate = quote.prevDate ?? undefined
        }
        holding.priceSource = mcpServer
        holding.updatedAt = new Date().toISOString()
        const source = order.source ?? fundingMode
        if (source !== 'external' && order.cashDeducted !== true) {
          const cash = draft.holdings.find((entry) => entry.code === cashCode) ?? draft.holdings.find((entry) => entry.kind === 'cash')
          if (cash) cash.units = round2((Number(cash.units) || 0) - order.amount)
        }
        order.status = 'filled'
        order.filledAt = new Date().toISOString()
        order.filledNav = quote.price
        order.filledNavDate = quote.date
        order.filledUnits = units
        filled.push({ ...order })
      }
      // Platform rebalances: cash basket → fund, converted at the fund's NAV.
      for (const order of draft.orders) {
        if (order.status !== 'pending' || order.side !== 'transfer') continue
        const quote = navQuotes.get(order.code)
        if (!quote || !Number.isFinite(quote.price) || !quote.date) continue
        if (String(quote.date) < String(order.tradeDate)) continue
        const units = round2(order.amount / quote.price)
        if (!Number.isFinite(units) || units <= 0) continue
        let holding = draft.holdings.find((entry) => entry.code === order.code)
        if (!holding) {
          holding = {
            code: order.code,
            name: order.name,
            kind: 'fund',
            units: 0,
            costPrice: quote.price,
            price: quote.price,
            priceDate: quote.date,
          }
          draft.holdings.push(holding)
        }
        holding.units = round2((Number(holding.units) || 0) + units)
        holding.price = quote.price
        holding.priceDate = quote.date
        holding.costPrice = holding.costPrice || quote.price
        holding.priceSource = mcpServer
        holding.updatedAt = new Date().toISOString()
        const cash =
          draft.holdings.find((entry) => entry.code === (order.fromCode ?? spendCashCode)) ??
          draft.holdings.find((entry) => entry.code === cashCode) ??
          draft.holdings.find((entry) => entry.kind === 'cash')
        if (cash) cash.units = round2((Number(cash.units) || 0) - order.amount)
        order.status = 'filled'
        order.filledAt = new Date().toISOString()
        order.filledNav = quote.price
        order.filledNavDate = quote.date
        order.filledUnits = units
        filled.push({ ...order })
      }
    })
    return filled
  }

  /** Short-term stats used for the tranche schedule (20-day return / volatility). */
  const seriesStats = (navs) => {
    if (!Array.isArray(navs) || navs.length < 25) return { ret20: null, vol20: null }
    const sorted = navs.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)))
    const latest = sorted[sorted.length - 1].nav
    const before20 = sorted[sorted.length - 21].nav
    const ret20 = before20 > 0 ? round2(((latest / before20) - 1) * 100) : null
    const rets = []
    for (let i = sorted.length - 20; i < sorted.length; i += 1) {
      const prev = sorted[i - 1]?.nav
      const cur = sorted[i]?.nav
      if (prev > 0 && cur > 0) rets.push(cur / prev - 1)
    }
    let vol20 = null
    if (rets.length > 1) {
      const mean = rets.reduce((sum, value) => sum + value, 0) / rets.length
      const variance = rets.reduce((sum, value) => sum + (value - mean) ** 2, 0) / rets.length
      vol20 = round2(Math.sqrt(variance) * Math.sqrt(252) * 100)
    }
    return { ret20, vol20 }
  }

  /**
   * Split one run's suggestion into tranches. Front-load when the sleeve is
   * already below trend and falling; fade in slower after a strong short-term
   * run-up. Later tranches are conditional on further weakness.
   */
  const tranchePlan = (suggest, stats, deviationPct) => {
    if (!Number.isFinite(suggest) || suggest <= 0) return []
    const ret20 = stats?.ret20 ?? null
    let split = [0.4, 0.3, 0.3]
    if (ret20 !== null && ret20 > 5) split = [0.3, 0.35, 0.35]
    else if (ret20 !== null && ret20 < -3 && Number.isFinite(deviationPct) && deviationPct < 0) split = [0.6, 0.2, 0.2]
    const triggers = [null, 3, 6]
    const rows = split.map((share, index) => ({
      seq: index + 1,
      share,
      amount: round2(suggest * share),
      triggerPct: triggers[index],
      trigger: index === 0 ? '现在（本轮）' : `较当前再跌 ${triggers[index]}%`,
    }))
    // fix rounding drift on the last tranche
    const sum = round2(rows.reduce((total, row) => total + row.amount, 0))
    rows[rows.length - 1].amount = round2(rows[rows.length - 1].amount + (suggest - sum))
    return rows
  }

  /**
   * Weekly market read-out → should the deployment pace go up or down?
   * Uses the A-share temperature (valuation), the 20-day trend/volatility of the
   * largest A-share sleeve, and the 200-day deviation.
   */
  const weeklySuggestion = (checkData) => {
    const rows = Array.isArray(checkData?.rows) ? checkData.rows : []
    const anchor = rows.find((row) => row.code === '022424') ?? rows.find((row) => row.code === '100032') ?? null
    const fraction = Number(checkData?.ashare?.fraction)
    const temp = Number(checkData?.temperature?.temperature)
    const ret20 = Number(anchor?.ret20)
    const dev200 = Number(anchor?.deviationPct)
    const vol20 = Number(anchor?.vol20)
    const reasons = []
    let suggestion = '维持'
    let targetPace = deployPacePct
    const bandName = checkData?.ashare?.band ?? ''
    const valuationCheap = bandName === '极低估' || bandName === '低估' || (Number.isFinite(fraction) && fraction >= 0.6)
    const valuationRich = bandName === '高估' || bandName === '偏高' || (Number.isFinite(fraction) && fraction <= 0.25)
    const weakTrend = Number.isFinite(ret20) && ret20 <= -8
    const hotTrend = Number.isFinite(ret20) && ret20 >= 8
    const farAbove = Number.isFinite(dev200) && dev200 >= 8
    const highVol = Number.isFinite(vol20) && vol20 >= 25
    if (valuationRich || farAbove) {
      suggestion = '降低'
      targetPace = Math.max(0.15, round2(deployPacePct * 0.6))
      reasons.push(`估值偏贵（${checkData?.ashare?.band ?? '—'}，温度 ${Number.isFinite(temp) ? temp : '—'}°）`)
      if (farAbove) reasons.push(`价格高于 200 日线 ${dev200}%`)
    } else if (valuationCheap && (weakTrend || farAbove === false)) {
      suggestion = '提高'
      targetPace = Math.min(0.5, round2(deployPacePct * 1.33))
      reasons.push(`估值便宜（${checkData?.ashare?.band ?? '—'}，温度 ${Number.isFinite(temp) ? temp : '—'}°）`)
      if (weakTrend) reasons.push(`近 20 日已跌 ${Math.abs(ret20)}%，可按节奏加快`)
    } else {
      reasons.push(`估值居中（${checkData?.ashare?.band ?? '—'}），趋势不明显`)
    }
    if (highVol) reasons.push(`20 日波动 ${vol20}%，建议分批更细、不要单笔重仓`)
    if (hotTrend && suggestion !== '降低') reasons.push(`近 20 日涨 ${ret20}%，不追高`)
    return {
      at: new Date().toISOString(),
      suggestion,
      targetPacePct: round2(targetPace * 100),
      metrics: { temperature: Number.isFinite(temp) ? temp : null, band: checkData?.ashare?.band ?? null, fraction: Number.isFinite(fraction) ? fraction : null, ret20: Number.isFinite(ret20) ? ret20 : null, dev200: Number.isFinite(dev200) ? dev200 : null, vol20: Number.isFinite(vol20) ? vol20 : null },
      reasons,
      note: '每周五收盘后生成；提高=本轮节奏加快，降低=放慢，仍需 10% 单次硬顶保护',
    }
  }

  const runWeekly = async () => {
    const checked = await runCheck([])
    const weekly = weeklySuggestion(checked.data)
    await writeFile(weeklyFile(), `${JSON.stringify(weekly, null, 2)}\n`)
    await appendActivity({
      type: 'weekly',
      title: '每周市场分析',
      summary: `${weekly.suggestion}节奏 → 目标 pace ${weekly.targetPacePct}%（${weekly.reasons[0] ?? ''}）`,
      detail: weekly,
    })
    return weekly
  }

  /** Execution history: every queued order with its deployment round. */
  const executionRows = (doc) => {
    const rounds = Array.isArray(doc.deployment?.rounds) ? doc.deployment.rounds : []
    const roundOf = new Map()
    rounds.forEach((round, index) => {
      for (const id of round.orders ?? []) roundOf.set(id, index + 1)
    })
    return (Array.isArray(doc.orders) ? doc.orders : [])
      .slice()
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
      .map((order) => ({
        id: order.id,
        round: roundOf.get(order.id) ?? null,
        code: order.code,
        name: order.name,
        side: order.side,
        amount: order.amount,
        source: order.source ?? fundingMode,
        tradeDate: order.tradeDate,
        status: order.status,
        createdAt: order.createdAt,
        filledAt: order.filledAt ?? null,
        filledNav: order.filledNav ?? null,
        filledNavDate: order.filledNavDate ?? null,
        filledUnits: order.filledUnits ?? null,
      }))
  }

  // Real-world operations: purchases are made directly (external money), not by
  // topping up the cash basket inside the portfolio.
  const fundingMode = ['cash', 'external', 'auto'].includes(config?.fundingMode) ? config.fundingMode : 'auto'
  // Plan on a fixed capital base (e.g. 300k) even when only part of the money has
  // been deployed yet. 0 = use the live market value as the base.
  const planningValue = Number.isFinite(config?.planningValue) && config.planningValue > 0 ? config.planningValue : 0
  const targetCapital = Number.isFinite(config?.targetCapital) && config.targetCapital > 0 ? config.targetCapital : 0
  // Real orders are placed instantly (no T+1 confirmation wait) → fill at the
  // latest known NAV right away instead of leaving a pending order.
  const executeImmediate = config?.executeImmediate !== false
  // 组合外的自由现金（盈米宝）：组合里的钱袋子不用于直接申购。
  const spendCashCode = typeof config?.spendCashCode === 'string' ? config.spendCashCode.trim().toUpperCase() : 'YMB'
  // 长赢式：现金是随估值升降的战略资产（借自长赢150的做法）。
  const dynamicCashTarget = config?.dynamicCashTarget !== false
  const cashTargetPctFor = (temperature) => {
    if (!dynamicCashTarget || !Number.isFinite(temperature)) return null
    if (temperature < 10) return 5
    if (temperature < 30) return 10
    if (temperature < 50) return 20
    return 35
  }
  // 风格/行业指数没有独立温度：用"宽基温度"和"自身位置信号"取更保守者。
  const combineStyleValuation = config?.combineStyleValuation !== false
  // 二级债含权益仓位：其"不择时"只对债券部分成立，权益部分要跟权益估值走。
  const secondaryBondCodes = Array.isArray(config?.secondaryBondCodes) ? config.secondaryBondCodes : ['001257']
  const secondaryBondEquityPct = Number.isFinite(config?.secondaryBondEquityPct) ? config.secondaryBondEquityPct : 0.2
  // QDII/黄金的 CNY 净值含汇率：用离岸人民币历史把净值还原为外币口径再判断位置。
  const defxCodes = Array.isArray(config?.defxCodes)
    ? config.defxCodes
    : ['050025', '000071', '006327', '000369', '000216']
  const usdcnhSecid = typeof config?.usdcnhSecid === 'string' ? config.usdcnhSecid : '133.USDCNH'
  let fxCache = null
  // 黄金：用 COMEX 美元金价（剔除汇率）做多年区间位置 + 均线趋势闸门。
  const goldTrendGate = config?.goldTrendGate !== false
  const goldIndexSecid = typeof config?.goldIndexSecid === 'string' ? config.goldIndexSecid : '101.GC00Y'
  const goldLookbackLimit = Number.isFinite(config?.goldLookbackLimit) ? config.goldLookbackLimit : 760
  let goldCache = null
  // 债券：中国10年期国债收益率的多年分位（收益率高=债便宜，可加久期）。
  const bondYieldSignal = config?.bondYieldSignal !== false
  const bondYieldPages = Number.isFinite(config?.bondYieldPages) ? config.bondYieldPages : 6
  let yieldCache = null
  // 海外权益：位置信号 × 趋势乘数（下跌 0.6 / 震荡 0.8 / 上涨 1.0）。
  const overseasTrendLevels = {
    下跌: 0.6,
    震荡: 0.8,
    上涨: 1.0,
    ...(config?.overseasTrendLevels && typeof config.overseasTrendLevels === 'object'
      ? config.overseasTrendLevels
      : {}),
  }
  const overseasTrendGate = config?.overseasTrendGate !== false
  // 横截面优先买：越便宜的档位，分到的预算越多（借自长赢"挑最便宜的买"）。
  const BAND_PRIORITY = {
    极低估: 1.6,
    便宜: 1.6,
    低估: 1.2,
    偏低: 1.15,
    '合理偏低': 1.0,
    合理: 0.8,
    偏高: 0.25,
    贵: 0,
    '收益率回升': 1.1,
    收益率低位: 0.8,
    不择时: 1.0,
    二级债: 0.9,
    现金: 0,
    未知: 0.6,
  }
  const isHeldCode = (doc, code) => {
    const holding = (doc.holdings ?? []).find((entry) => entry.code === code)
    return Boolean(holding && holding.kind !== 'cash' && (Number(holding.units) || 0) > 0)
  }
  const resolveSource = (doc, code) => {
    if (fundingMode !== 'auto') return fundingMode
    if (isHeldCode(doc, code)) return 'external'
    const hasWallet = (doc.holdings ?? []).some((holding) => holding.code === spendCashCode)
    return hasWallet ? 'wallet' : 'plan'
  }
  const historyCache = new Map()
  const HISTORY_RANGES = {
    '1m': 'oneMonth',
    '3m': 'quarter',
    '6m': 'halfYear',
    '1y': 'oneYear',
    '3y': 'threeYear',
    all: 'setupDay',
  }

  /** NAV history for one sleeve, with the stats the chart needs. */
  const historyFor = async (code, range) => {
    const key = `${code}:${range}`
    const cached = historyCache.get(key)
    if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.value
    const series = await fetchNavSeriesMap(ctx, [code], {
      server: mcpServer,
      tool: navTool,
      dimensionType: HISTORY_RANGES[range] ?? 'oneYear',
    })
    const raw = (series.get(code) ?? [])
      .slice()
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    const navs = raw.map((point) => point.nav)
    const ma200 = []
    for (let i = 0; i < navs.length; i += 1) {
      if (i < 199) {
        ma200.push(null)
        continue
      }
      const window = navs.slice(i - 199, i + 1)
      ma200.push(round2((window.reduce((sum, value) => sum + value, 0) / window.length) * 10000) / 10000)
    }
    const points = raw.map((point, index) => ({ date: point.date, nav: point.nav, ma200: ma200[index] }))
    if (points.length === 0) throw new Error('没有取到该品种的历史净值')
    const first = points[0]
    const last = points[points.length - 1]
    let peak = -Infinity
    let maxDrawdown = 0
    for (const point of points) {
      peak = Math.max(peak, point.nav)
      maxDrawdown = Math.min(maxDrawdown, point.nav / peak - 1)
    }
    const value = {
      code,
      range,
      points,
      stats: {
        startDate: first.date,
        endDate: last.date,
        startNav: round2(first.nav * 10000) / 10000,
        endNav: round2(last.nav * 10000) / 10000,
        totalReturnPct: first.nav > 0 ? round2((last.nav / first.nav - 1) * 100) : null,
        maxDrawdownPct: round2(maxDrawdown * 100),
        currentDrawdownPct: peak > 0 ? round2((last.nav / peak - 1) * 100) : null,
        highNav: round2(peak * 10000) / 10000,
        ma200: ma200[ma200.length - 1] ?? null,
        deviationFromMa200Pct:
          ma200[ma200.length - 1] ? round2((last.nav / ma200[ma200.length - 1] - 1) * 100) : null,
      },
    }
    historyCache.set(key, { at: Date.now(), value })
    return value
  }

  /** Realtime proxy quotes for every mapped sleeve (held or not). */
  const quoteSnapshot = async () => {
    const doc = await store.read()
    const codes = [...new Set([...Object.keys(doc.targets.byCode ?? {}), ...doc.holdings.map((holding) => holding.code)])]
    const exchangeCodes = [...new Set(codes.map((code) => quoteCodeFor(code)).filter(Boolean))]
    const quotes = await fetchEtfQuotes(exchangeCodes)
    const navCache = await readNavCache()
    const rows = codes.map((code) => {
      const holding = doc.holdings.find((entry) => entry.code === code)
      const indexCode = indexMap[code] ?? null
      const proxy = etfMap[code] ?? null
      const quoteCode = quoteCodeFor(code)
      const quote = quoteCode ? quotes.get(quoteCode) : null
      const cached = navCache[code] ?? null
      const nav = holding ? Number(holding.price) || null : cached?.nav ?? null
      const navDate = holding ? holding.priceDate ?? null : cached?.navDate ?? null
      const prevNav = holding ? (Number.isFinite(Number(holding.prevPrice)) ? Number(holding.prevPrice) : null) : cached?.prevNav ?? null
      const prevNavDate = holding ? holding.prevPriceDate ?? null : cached?.prevNavDate ?? null
      const changePct = quote ? round2(quote.changePct) : null
      const estimate = nav !== null && changePct !== null ? round2(nav * (1 + changePct / 100) * 10000) / 10000 : null
      return {
        code,
        name: holding?.name || PLAN_LABELS[code] || code,
        proxy,
        indexCode,
        source: quote ? (indexCode ? 'index' : 'etf') : null,
        price: indexCode ? null : quote ? round2(quote.price) : null,
        changePct,
        estimate,
        nav,
        navDate,
        prevNav,
        prevNavDate,
        held: Boolean(holding),
      }
    })
    return { at: new Date().toISOString(), rows, missing: codes.filter((code) => !etfMap[code]) }
  }

  const summaryPayload = async () => {
    const doc = await store.read()
    if (doc.holdings.length > 0) {
      const report = analyze(doc, { staleAfterDays })
      const last = await readLastCheck()
      report.plan = buildPlan(doc, last?.temperature?.temperature ?? null, dividendBandsFromRows(last?.rows))
      report.model = buildModel()
      report.lastCheck = await readLastCheck()
      report.weekly = await readWeekly()
      report.activity = (await readActivity()).slice(-activityLimit)
      const pending = (doc.orders ?? []).filter((order) => order.status === 'pending')
      report.orders = { pending: pending.slice(-20), pendingTotal: round2(pending.reduce((sum, order) => sum + (Number(order.amount) || 0), 0)) }
      const rounds = Array.isArray(doc.deployment?.rounds) ? doc.deployment.rounds : []
      const submittedAmount = round2(rounds.reduce((sum, round) => sum + (Number(round.amount) || 0), 0))
      const executions = executionRows(doc)
      report.executions = {
        items: executions.slice(0, 50),
        count: executions.length,
        pendingCount: executions.filter((row) => row.status === 'pending').length,
        filledCount: executions.filter((row) => row.status === 'filled').length,
        filledAmount: round2(
          executions.filter((row) => row.status === 'filled').reduce((sum, row) => sum + (Number(row.amount) || 0), 0),
        ),
      }
      report.deployment = {
        totalRounds: null,
        doneRounds: rounds.length,
        submittedAmount,
        lastRoundAt: rounds.length > 0 ? rounds[rounds.length - 1].at : null,
      }
      return report
    }
    return {
      empty: true,
      plan: buildPlan(doc, null),
      model: buildModel(),
      lastCheck: await readLastCheck(),
      currency: doc.currency,
      generatedAt: new Date().toISOString(),
      totals: { value: 0, cost: 0, pnl: 0, pnlPct: null, count: 0 },
      rows: [],
      byKind: [],
      targets: { byCode: {}, byKind: {}, drift: [], actionable: [] },
      history: { count: doc.snapshots.length },
      warnings: [],
    }
  }
  const readJsonBody = (req) =>
    new Promise((resolve) => {
      if (typeof req?.on !== 'function') return resolve({})
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
        if (raw.length > 1_000_000) resolve({})
      })
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : {})
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  ctx.inject(['webServer'], (scope) => {
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: '/portfolio/api/summary',
          handler: async (req, res) => {
            if ((req.method ?? 'GET').toUpperCase() !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
            try {
              return json(res, 200, { ok: true, value: await summaryPayload() })
            } catch (error) {
              return json(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
      'portfolio: /portfolio/api/summary route',
    )

    // A write-ish action, so it requires a header a cross-origin form cannot
    // set. The panel sends it; anything else gets 403.
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: '/portfolio/api/refresh',
          handler: async (req, res) => {
            if ((req.method ?? 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
            if (req.headers?.['x-dsh-portfolio'] !== '1') return json(res, 403, { ok: false, error: 'forbidden' })
            try {
              const { updated, missing, tool } = await refreshPrices([])
              return json(res, 200, { ok: true, value: await summaryPayload(), refreshed: { updated, missing, tool } })
            } catch (error) {
              return json(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
      'portfolio: /portfolio/api/refresh route',
    )

    // Read-only valuation check for the panel / curl. It calls the profile's
    // MCP server, so it is a GET on purpose and never mutates holdings.
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: '/portfolio/api/check',
          handler: async (req, res) => {
            if ((req.method ?? 'GET').toUpperCase() !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
            try {
              const intraday = /[?&]intraday=(1|true)/.test(req.url ?? '')
              const checked = await runCheck([], { intraday })
              return json(res, 200, { ok: true, value: checked.data })
            } catch (error) {
              return json(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
      'portfolio: /portfolio/api/check route',
    )

    // Rebalance plan: deploy fresh cash by target gaps, or rotate the held
    // basket. Pure bookkeeping — no MCP call.
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: '/portfolio/api/rebalance',
          handler: async (req, res) => {
            if ((req.method ?? 'GET').toUpperCase() !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
            try {
              const doc0 = await store.read()
              const plan0 = buildPlan(doc0)
              const freshCash = fundingMode !== 'cash' || (plan0.cash.available !== null && plan0.cash.available > Math.max(100, plan0.value * 0.005))
              const planned = freshCash ? await runDeploy() : await runRotate()
              return json(res, 200, { ok: true, value: { ...planned.data, mode: freshCash ? 'deploy' : 'rotate' } })
            } catch (error) {
              return json(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
      'portfolio: /portfolio/api/rebalance route',
    )

    // Realtime proxy quotes (ETF prices) for held and not-yet-held sleeves.
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: '/portfolio/api/quotes',
          handler: async (req, res) => {
            if ((req.method ?? 'GET').toUpperCase() !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
            try {
              return json(res, 200, { ok: true, value: await quoteSnapshot() })
            } catch (error) {
              return json(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
      'portfolio: /portfolio/api/quotes route',
    )

    // Queue buy orders for the ticked check-result rows.
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: '/portfolio/api/execute',
          handler: async (req, res) => {
            if ((req.method ?? 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
            if (req.headers?.['x-dsh-portfolio'] !== '1') return json(res, 403, { ok: false, error: 'forbidden' })
            try {
              const body = await readJsonBody(req)
              const executed = await executeOrders(body?.items ?? [], {
                tradeDate: body?.tradeDate,
                immediate: body?.immediate === true || (body?.immediate !== false && executeImmediate),
              })
              return json(res, 200, { ok: true, value: executed })
            } catch (error) {
              return json(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
      'portfolio: /portfolio/api/execute route',
    )

    // Platform rebalance: cash basket → fund, share-based, filled at the fund NAV.
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: '/portfolio/api/transfer',
          handler: async (req, res) => {
            if ((req.method ?? 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
            if (req.headers?.['x-dsh-portfolio'] !== '1') return json(res, 403, { ok: false, error: 'forbidden' })
            try {
              const body = await readJsonBody(req)
              const moved = await transferOrders(body?.items ?? [], { tradeDate: body?.tradeDate })
              return json(res, 200, { ok: true, value: moved })
            } catch (error) {
              return json(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
      'portfolio: /portfolio/api/transfer route',
    )

    // Pending / recent orders.
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: '/portfolio/api/orders',
          handler: async (req, res) => {
            if ((req.method ?? 'GET').toUpperCase() !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
            try {
              const doc = await store.read()
              const orders = Array.isArray(doc.orders) ? doc.orders : []
              return json(res, 200, {
                ok: true,
                value: {
                  pending: orders.filter((order) => order.status === 'pending'),
                  filled: orders.filter((order) => order.status === 'filled').slice(-30),
                },
              })
            } catch (error) {
              return json(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
      'portfolio: /portfolio/api/orders route',
    )

    // Execution history (order ledger with deployment round numbers).
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: '/portfolio/api/executions',
          handler: async (req, res) => {
            if ((req.method ?? 'GET').toUpperCase() !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
            try {
              const doc = await store.read()
              return json(res, 200, { ok: true, value: { items: executionRows(doc) } })
            } catch (error) {
              return json(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
      'portfolio: /portfolio/api/executions route',
    )

    // Weekly market read-out (提高/降低节奏建议).
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: '/portfolio/api/weekly',
          handler: async (req, res) => {
            if ((req.method ?? 'GET').toUpperCase() !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
            try {
              const weekly = (await readWeekly()) ?? (await runWeekly())
              return json(res, 200, { ok: true, value: weekly })
            } catch (error) {
              return json(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
      'portfolio: /portfolio/api/weekly route',
    )

    // Automation activity log (last N runs).
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: '/portfolio/api/activity',
          handler: async (req, res) => {
            if ((req.method ?? 'GET').toUpperCase() !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
            try {
              return json(res, 200, { ok: true, value: { items: await readActivity() } })
            } catch (error) {
              return json(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
      'portfolio: /portfolio/api/activity route',
    )

    // NAV history for the per-instrument chart (1y / 3y / since inception).
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: '/portfolio/api/history',
          handler: async (req, res) => {
            if ((req.method ?? 'GET').toUpperCase() !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
            try {
              const url = new URL(req.url ?? '/', 'http://localhost')
              const code = String(url.searchParams.get('code') ?? '').trim().toUpperCase()
              const range = url.searchParams.get('range') ?? '1y'
              if (!code) return json(res, 400, { ok: false, error: 'missing code' })
              if (!HISTORY_RANGES[range]) {
                return json(res, 400, { ok: false, error: 'range must be 1m / 3m / 6m / 1y / 3y / all' })
              }
              return json(res, 200, { ok: true, value: await historyFor(code, range) })
            } catch (error) {
              return json(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
      'portfolio: /portfolio/api/history route',
    )
  })
}

const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100
const money = (value) =>
  Number.isFinite(value)
    ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
    : '—'

function result(action, text, data) {
  return { ok: true, action, text, data }
}

function normalizeDate(input) {
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.trim())) {
    const parsed = new Date(`${input.trim()}T00:00:00`)
    if (!Number.isNaN(parsed.getTime())) return input.trim()
    throw new Error(`无效日期：${input}`)
  }
  if (input !== undefined && input !== null && input !== '') {
    throw new Error(`日期格式应为 YYYY-MM-DD：${input}`)
  }
  return new Date().toISOString().slice(0, 10)
}

/** Write a tiny breadcrumb so activation is observable outside the app. */
async function recordActivation(dataFile) {
  const { writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const body = {
    at: new Date().toISOString(),
    pid: process.pid,
    version: process.versions.electron ? `electron-${process.versions.electron}` : process.version,
    dataFile,
  }
  await writeFile(join(tmpdir(), 'dsh-plugin-portfolio-activated.json'), `${JSON.stringify(body, null, 2)}\n`)
}
