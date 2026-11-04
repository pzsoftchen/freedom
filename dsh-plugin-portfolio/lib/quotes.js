/**
 * Market data through the already-configured Yingmi (qieman) MCP server.
 *
 * The plugin does not open its own MCP connection. The profile's mcp-client
 * registers the server's tools on `ctx.tools` (names are
 * `mcp__<serverName>__<toolName>`), so this module resolves one of those
 * definitions and calls it. One connection, one API key, no duplicated
 * configuration — and if the profile has no MCP server mounted, the refresh
 * action fails with a readable message instead of silently using stale prices.
 */

export const DEFAULT_MCP_SERVER = 'qieman'
export const DEFAULT_NAV_TOOL = 'BatchGetFundNavHistory'

/** Public tool name the MCP client registers for a server tool. */
export function mcpToolName(server = DEFAULT_MCP_SERVER, tool = DEFAULT_NAV_TOOL) {
  return `mcp__${server}__${tool}`
}

const pad = (value) => String(value).padStart(2, '0')

/** "2026年10月27日" | "2026-10-27T..." | Date → "YYYY-MM-DD" (or ''). */
export function normalizeDate(value) {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  }
  if (typeof value !== 'string') return ''
  const cn = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(value)
  if (cn) return `${cn[1]}-${pad(cn[2])}-${pad(cn[3])}`
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value.trim())
  if (iso) return `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}`
  return ''
}

/** Fields an MCP result can carry as plain text blocks. */
function textOf(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value.content)) {
    const parts = value.content
      .filter((block) => block && typeof block.text === 'string')
      .map((block) => block.text)
    return parts.length > 0 ? parts.join('\n') : null
  }
  if (Array.isArray(value.data) || Array.isArray(value.result)) return JSON.stringify(value)
  return null
}

/** Split one CSV line, honouring double-quoted fields. */
function splitCsv(line) {
  const out = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        current += char
      }
      continue
    }
    if (char === '"') quoted = true
    else if (char === ',') {
      out.push(current)
      current = ''
    } else current += char
  }
  out.push(current)
  return out.map((field) => field.trim())
}

/**
 * Parse the server's token-efficient text rendering, e.g.
 *
 *   [1]:
 *     - fundCode: "110011"
 *       data[18]{navDate,nav,dailyReturn}:
 *         2026年10月27日,3.9349,"-0.16%"
 *
 * qieman answers MCP tool calls as formatted text rather than JSON, so the
 * table header names the columns. The call asks for `isDesc`, so the first row
 * is the newest NAV and the second row is the previous trading day — both are
 * kept, which is what the panel and the report show as 当日/前一交易日.
 * A regex fallback covers servers that omit the header.
 */
function parseNavText(text) {
  const quotes = new Map()
  const lines = text.split(/\r?\n/)
  let code = null
  let columns = null

  const commit = (row) => {
    if (!code || !row) return
    const dateIndex = columns ? columns.findIndex((name) => /navDate|date/i.test(name)) : 0
    const navIndex = columns ? columns.findIndex((name) => /^nav$/i.test(name)) : 1
    const date = normalizeDate(row[dateIndex] ?? '')
    const price = Number(row[navIndex])
    if (!date || !Number.isFinite(price)) return
    const existing = quotes.get(code)
    if (!existing) {
      quotes.set(code, { price, date, prevPrice: null, prevDate: null, dailyReturn: row[2] ?? null })
    } else if (existing.prevPrice === null && existing.date !== date) {
      existing.prevPrice = price
      existing.prevDate = date
    }
  }

  for (const line of lines) {
    const block = /^\s*-\s*fundCode:\s*"?([A-Za-z0-9_.-]+)"?\s*$/.exec(line)
    if (block) {
      code = block[1].toUpperCase()
      columns = null
      continue
    }
    if (!code) continue
    const header = /^\s*data\[\d+\]\{([^}]+)\}\s*:?\s*$/.exec(line)
    if (header) {
      columns = header[1].split(',').map((name) => name.trim())
      continue
    }
    if (!columns) continue
    const cells = /^\s+\S/.test(line) ? splitCsv(line.trim()) : []
    if (cells.length < 2) continue
    commit(cells)
    const quote = quotes.get(code)
    columns = quote?.prevPrice === null ? columns : null // stop after two rows
  }

  if (quotes.size === 0) {
    // Fallback: any "date,number" pair inside a fundCode block.
    for (const match of text.matchAll(/([0-9]{4}(?:年[0-9]{1,2}月[0-9]{1,2}日|-[0-9]{1,2}-[0-9]{1,2})),\s*"?([0-9]+(?:\.[0-9]+)?)"?/g)) {
      const date = normalizeDate(match[1])
      const price = Number(match[2])
      if (date && Number.isFinite(price)) {
        const before = text.slice(0, match.index)
        const blocks = [...before.matchAll(/-\s*fundCode:\s*"?([A-Za-z0-9_.-]+)"?/g)]
        const owner = blocks.at(-1)
        if (!owner) continue
        const key = owner[1].toUpperCase()
        const existing = quotes.get(key)
        if (!existing) quotes.set(key, { price, date, prevPrice: null, prevDate: null, dailyReturn: null })
        else if (existing.prevPrice === null && existing.date !== date) {
          existing.prevPrice = price
          existing.prevDate = date
        }
      }
    }
  }
  return quotes
}

/** Parse a JSON-shaped result (array or { data | result }). */
function parseStructured(value) {
  const quotes = new Map()
  let rows = value
  if (!Array.isArray(rows) && rows && typeof rows === 'object') {
    rows = Array.isArray(rows.data) ? rows.data : Array.isArray(rows.result) ? rows.result : []
  }
  if (!Array.isArray(rows)) return quotes
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue
    const code = String(item.fundCode ?? item.code ?? item.data?.code ?? '').trim().toUpperCase()
    if (!code) continue
    const series = Array.isArray(item.data?.data)
      ? item.data.data
      : Array.isArray(item.data)
        ? item.data
        : []
    const valid = series.filter((row) => row && Number.isFinite(Number(row.nav)))
    const first = valid[0]
    if (!first) continue
    const second = valid[1]
    quotes.set(code, {
      price: Number(first.nav),
      date: normalizeDate(first.navDate ?? first.date),
      prevPrice: second ? Number(second.nav) : null,
      prevDate: second ? normalizeDate(second.navDate ?? second.date) : null,
      dailyReturn: typeof first.dailyReturn === 'string' ? first.dailyReturn : null,
    })
  }
  return quotes
}

/**
 * Parse a `BatchGetFundNavHistory` payload.
 * @returns {Map<string, { price: number, date: string, prevPrice: number | null, prevDate: string | null, dailyReturn: string | null }>}
 */
export function parseNavHistory(value) {
  const text = textOf(value)
  if (text !== null) {
    try {
      const parsed = parseStructured(JSON.parse(text))
      if (parsed.size > 0) return parsed
    } catch {
      // not JSON — the server renders formatted text, handled below
    }
    const fromText = parseNavText(text)
    if (fromText.size > 0) return fromText
  }
  return parseStructured(value)
}

/**
 * Resolve the profile's MCP NAV tool and fetch the latest NAV for `codes`.
 * @param {object} ctx Cordis context with the `tools` service
 * @param {string[]} codes fund codes
 * @param {{ server?: string, tool?: string, timeoutMs?: number }} [options]
 * @returns {Promise<Map<string, { price: number, date: string, dailyReturn: string | null }>>}
 */
export async function fetchNavs(ctx, codes, options = {}) {
  const server = options.server ?? DEFAULT_MCP_SERVER
  const tool = options.tool ?? DEFAULT_NAV_TOOL
  const toolName = mcpToolName(server, tool)
  const definition = ctx.tools?.get?.(toolName)
  if (!definition || typeof definition.execute !== 'function') {
    throw new Error(
      `找不到行情工具 ${toolName}：这个 profile 没有挂载 ${server} MCP（或它尚未就绪）。` +
        '请先在 profile/home patch 里配置 @deepseek-ai/dsh-mcp-client，再重试。',
    )
  }
  const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000)
  const raw = await definition.execute(
    { fundCodes: codes, dimensionType: options.dimensionType ?? 'oneMonth', isDesc: true },
    { signal },
  )
  return parseNavHistory(raw)
}

/* ------------------------------------------------------------------ *
 * Longer series + market temperature (added for the valuation check)
 * ------------------------------------------------------------------ */

/**
 * Parse a multi-fund `BatchGetFundNavHistory` text payload into
 * `Map<code, Array<{ date, nav }>>`, newest first.
 * Handles the tabular rendering, the list-of-records rendering (money funds)
 * and plain JSON.
 */
export function parseNavSeriesMap(text) {
  const out = new Map()
  if (typeof text !== 'string' || text.trim() === '') return out
  const push = (code, date, nav) => {
    const key = String(code).trim().toUpperCase()
    const value = Number(nav)
    const day = normalizeDate(String(date ?? ''))
    if (!key || !day || !Number.isFinite(value)) return
    const list = out.get(key) ?? []
    list.push({ date: day, nav: value })
    out.set(key, list)
  }

  const lines = text.split(/\r?\n/)
  let code = null
  let columns = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const block = /^\s*-\s*fundCode:\s*"?([A-Za-z0-9_.-]+)"?\s*$/.exec(line)
    if (block) {
      code = block[1]
      columns = null
      continue
    }
    const inlineCode = /^\s*fundCode:\s*"?([A-Za-z0-9_.-]+)"?\s*$/.exec(line)
    if (inlineCode) code = inlineCode[1]
    const header = /^\s*data\[(\d+)\]\{([^}]+)\}\s*:?\s*$/.exec(line)
    if (header && code) {
      columns = header[2].split(',').map((name) => name.trim())
      continue
    }
    const listHeader = /^\s*data\[(\d+)\]\s*:?\s*$/.exec(line)
    if (listHeader) {
      columns = 'records'
      continue
    }
    if (!code || !columns) continue

    if (columns === 'records') {
      const recordDate = /^\s*-?\s*navDate:\s*(.+)$/.exec(line)
      if (recordDate) {
        const next = lines.slice(index + 1, index + 4).join('\n')
        const nav = /^\s*nav:\s*([0-9.]+)\s*$/m.exec(next)
        if (nav) push(code, recordDate[1], nav[1])
      }
      continue
    }

    if (!/^\s+\S/.test(line)) continue
    const cells = splitCsv(line.trim())
    if (cells.length < 2) continue
    const dateIndex = columns.findIndex((name) => /navDate|date/i.test(name))
    const navIndex = columns.findIndex((name) => /^nav$/i.test(name))
    push(code, cells[dateIndex === -1 ? 0 : dateIndex], cells[navIndex === -1 ? 1 : navIndex])
  }
  for (const [key, list] of out) {
    const unique = new Map(list.map((row) => [row.date, row]))
    out.set(
      key,
      [...unique.values()].sort((a, b) => b.date.localeCompare(a.date)),
    )
  }
  return out
}

/** Fetch one-year NAV series for several codes through the profile's MCP. */
export async function fetchNavSeriesMap(ctx, codes, options = {}) {
  const server = options.server ?? DEFAULT_MCP_SERVER
  const tool = options.tool ?? DEFAULT_NAV_TOOL
  const toolName = mcpToolName(server, tool)
  const definition = ctx.tools?.get?.(toolName)
  if (!definition || typeof definition.execute !== 'function') {
    throw new Error(`找不到行情工具 ${toolName}：这个 profile 没有挂载 ${server} MCP（或它尚未就绪）。`)
  }
  const signal = AbortSignal.timeout(options.timeoutMs ?? 60_000)
  const raw = await definition.execute(
    { fundCodes: codes, dimensionType: options.dimensionType ?? 'oneYear', isDesc: true },
    { signal },
  )
  const text = textOf(raw)
  if (text !== null) {
    try {
      const parsed = JSON.parse(text)
      const map = new Map()
      for (const item of Array.isArray(parsed) ? parsed : []) {
        const code = String(item?.fundCode ?? item?.data?.code ?? '').toUpperCase()
        const rows = Array.isArray(item?.data?.data) ? item.data.data : []
        if (!code || rows.length === 0) continue
        map.set(code, rows.map((row) => ({ date: normalizeDate(row.navDate ?? ''), nav: Number(row.nav) })))
      }
      if (map.size > 0) return map
    } catch {
      // formatted text, handled below
    }
    const fromText = parseNavSeriesMap(text)
    if (fromText.size > 0) return fromText
  }
  const fallback = parseNavSeriesMap(typeof raw === 'string' ? raw : '')
  if (fallback.size > 0) return fallback
  throw new Error('行情返回无法解析（既不是 JSON 也不是预期的表格文本）')
}

/**
 * Market temperature (0–100) from the Yingmi quotation tool: PE/PB/risk-premium
 * weighted; official bands are <30 undervalued and >70 overvalued.
 */
export async function fetchTemperature(ctx, options = {}) {
  const server = options.server ?? DEFAULT_MCP_SERVER
  const toolName = mcpToolName(server, options.tool ?? 'GetLatestQuotations')
  const definition = ctx.tools?.get?.(toolName)
  if (!definition || typeof definition.execute !== 'function') {
    throw new Error(`找不到温度计工具 ${toolName}：这个 profile 没有挂载 ${server} MCP（或它尚未就绪）。`)
  }
  const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000)
  const raw = await definition.execute({}, { signal })
  const text = textOf(raw) ?? ''
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  const list = parsed?.temperatureList
  if (Array.isArray(list)) {
    return list.map((row) => ({
      code: String(row.temperatureIndexCode ?? ''),
      name: String(row.indexName ?? ''),
      temperature: Number(row.temperature),
      rating: String(row.ratingText ?? row.rating ?? ''),
    }))
  }
  const fallback = [...text.matchAll(/indexName:\s*([^\n]+)[\s\S]{0,200}?temperature:\s*([0-9.]+)/g)].map((match) => ({
    code: '',
    name: match[1].trim(),
    temperature: Number(match[2]),
    rating: '',
  }))
  if (fallback.length > 0) return fallback
  throw new Error('温度计返回无法解析')
}

/* ------------------------------------------------------------------ *
 * Intraday quotes for the panel's "14:40" workflow
 * ------------------------------------------------------------------ */

/**
 * Fetch realtime index/ETF quotes from the public Tencent quote feed.
 * Only used for the intraday check; the valuation anchors stay daily.
 * @param {string[]} codes e.g. ['sh000300', 'sh518880']
 * @returns {Promise<Map<string, { price: number, prevClose: number, changePct: number, name: string }>>}
 */
export async function fetchEtfQuotes(codes) {
  const wanted = (codes ?? []).filter(Boolean)
  const out = new Map()
  if (wanted.length === 0) return out
  const url = `https://qt.gtimg.cn/q=${wanted.join(',')}`
  const response = await fetch(url, { headers: { accept: '*/*' }, signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`行情接口返回 HTTP ${response.status}`)
  const buffer = await response.arrayBuffer()
  const text = new TextDecoder('gbk').decode(buffer)
  for (const match of text.matchAll(/v_([a-z0-9]+)="([^"]+)"/gi)) {
    const code = match[1].toLowerCase()
    const fields = match[2].split('~')
    const price = Number(fields[3])
    const prevClose = Number(fields[4])
    if (!Number.isFinite(price) || !Number.isFinite(prevClose) || prevClose <= 0) continue
    out.set(code, {
      name: fields[1] ?? code,
      price,
      prevClose,
      changePct: ((price - prevClose) / prevClose) * 100,
    })
  }
  return out
}

/**
 * Daily close history from Eastmoney's public kline endpoint.
 * Used to de-FX overseas fund NAVs (USDCNH) and to read index positions.
 * @param {string} secid e.g. '133.USDCNH', '100.SPX'
 * @param {{limit?: number}} options
 * @returns {Promise<Array<{date: string, close: number}>>}
 */
export async function fetchKlineSeries(secid, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 250
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}` +
    `&fields1=f1,f2,f3&fields2=f51,f53&klt=101&fqt=1&end=20500101&lmt=${limit}`
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`kline HTTP ${response.status}`)
  const payload = await response.json()
  const klines = payload?.data?.klines
  if (!Array.isArray(klines)) return []
  return klines
    .map((line) => {
      const [date, close] = String(line).split(',')
      return { date, close: Number(close) }
    })
    .filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(point.close) && point.close > 0)
}

/**
 * China 10Y government bond yield history (Eastmoney datacenter report).
 * Field EMM00166466 = 中国10年期国债收益率.
 * @param {{pages?: number}} options
 * @returns {Promise<Array<{date: string, yield: number}>>} newest first
 */
export async function fetchChina10yYield(options = {}) {
  const pages = Number.isFinite(options.pages) ? options.pages : 4
  const out = []
  for (let page = 1; page <= pages; page += 1) {
    const url =
      'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_TREASURYYIELD' +
      `&columns=SOLAR_DATE%2CEMM00166466&pageNumber=${page}&pageSize=500` +
      '&sortColumns=SOLAR_DATE&sortTypes=-1&source=WEB&client=WEB'
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(12_000),
    })
    if (!response.ok) throw new Error(`yield HTTP ${response.status}`)
    const payload = await response.json()
    const rows = payload?.result?.data
    if (!Array.isArray(rows) || rows.length === 0) break
    for (const row of rows) {
      const date = String(row?.SOLAR_DATE ?? '').slice(0, 10)
      const value = Number(row?.EMM00166466)
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(value) && value > 0) {
        out.push({ date, yield: value })
      }
    }
  }
  return out
}

/** Percentile rank (0–100) of `value` inside `values`. */
export function percentileRank(values, value) {
  const list = (values ?? []).filter((item) => Number.isFinite(item))
  if (list.length === 0 || !Number.isFinite(value)) return null
  const below = list.filter((item) => item < value).length
  return (below / list.length) * 100
}
