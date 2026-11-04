/**
 * Durable, plugin-owned storage for the portfolio document.
 *
 * The document is plain JSON so the user can read, back up or hand-edit it.
 * Writes are atomic (temp file + rename) and serialized per store instance, so
 * a tool call and another tool call cannot interleave partial writes.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const HOLDING_KINDS = ['fund', 'stock', 'bond', 'cash', 'other']

export const KIND_LABELS = {
  fund: '基金',
  stock: '股票',
  bond: '债券',
  cash: '现金',
  other: '其他',
}

export const DOC_VERSION = 1

/** A portfolio with no holdings yet. */
export function emptyPortfolio() {
  return {
    version: DOC_VERSION,
    currency: 'CNY',
    updatedAt: null,
    holdings: [],
    targets: { byCode: {}, byKind: {} },
    snapshots: [],
    orders: [],
    deployment: { rounds: [] },
  }
}

function expandHome(input, home = homedir()) {
  if (input === '~') return home
  if (input.startsWith('~/')) return join(home, input.slice(2))
  return input
}

/** Resolve the data file: explicit config wins, else <DSH_HOME>/storages/portfolio. */
export function resolveDataFile(configured, env = process.env, home = homedir()) {
  if (configured) return resolve(expandHome(configured, home))
  const dshHome = env.DSH_HOME ? resolve(expandHome(env.DSH_HOME, home)) : join(home, '.dsh')
  return join(dshHome, 'storages', 'portfolio', 'portfolio.json')
}

/** Coerce a stored value into the current document shape. */
export function normalizePortfolio(raw) {
  const doc = raw && typeof raw === 'object' ? raw : {}
  const targets = doc.targets && typeof doc.targets === 'object' ? doc.targets : {}
  return {
    version: DOC_VERSION,
    currency: typeof doc.currency === 'string' ? doc.currency : 'CNY',
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : null,
    holdings: Array.isArray(doc.holdings) ? doc.holdings.map(normalizeHolding) : [],
    targets: {
      byCode: plainNumberRecord(targets.byCode),
      byKind: plainNumberRecord(targets.byKind),
    },
    orders: Array.isArray(doc.orders) ? doc.orders : [],
    deployment: doc.deployment && Array.isArray(doc.deployment.rounds) ? doc.deployment : { rounds: [] },
    snapshots: Array.isArray(doc.snapshots)
      ? doc.snapshots
          .filter((s) => s && typeof s === 'object' && typeof s.date === 'string')
          .map((s) => ({ date: s.date, value: Number(s.value) || 0, cost: Number(s.cost) || 0 }))
      : [],
  }
}

function plainNumberRecord(value) {
  const out = {}
  if (!value || typeof value !== 'object') return out
  for (const [key, entry] of Object.entries(value)) {
    const number = Number(entry)
    if (Number.isFinite(number)) out[key] = number
  }
  return out
}

/** Normalize one holding record; throws on input a caller must fix. */
export function normalizeHolding(input, index = 0) {
  if (!input || typeof input !== 'object') {
    throw new Error(`holdings[${index}] must be an object`)
  }
  const code = String(input.code ?? '').trim().toUpperCase()
  if (!code) throw new Error(`holdings[${index}].code is required`)
  const units = Number(input.units)
  if (!Number.isFinite(units) || units < 0) {
    throw new Error(`holdings[${index}].units must be a non-negative number`)
  }
  const kind = HOLDING_KINDS.includes(input.kind) ? input.kind : 'other'
  const costPrice = numberOrUndefined(input.costPrice)
  const price = numberOrUndefined(input.price) ?? (kind === 'cash' ? 1 : undefined)
  const targetWeight = numberOrUndefined(input.targetWeight)
  return {
    code,
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : code,
    kind,
    units,
    ...(costPrice === undefined ? {} : { costPrice }),
    ...(price === undefined ? {} : { price }),
    ...(typeof input.priceDate === 'string' && input.priceDate ? { priceDate: input.priceDate } : {}),
    ...(typeof input.priceSource === 'string' && input.priceSource ? { priceSource: input.priceSource } : {}),
    ...(Number.isFinite(input.prevPrice) ? { prevPrice: input.prevPrice } : {}),
    ...(typeof input.prevPriceDate === 'string' && input.prevPriceDate ? { prevPriceDate: input.prevPriceDate } : {}),
    ...(targetWeight === undefined ? {} : { targetWeight }),
    ...(typeof input.note === 'string' && input.note.trim() ? { note: input.note.trim() } : {}),
    updatedAt: new Date().toISOString(),
  }
}

function numberOrUndefined(value) {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

export class PortfolioStore {
  /** @param {string} file absolute path of the JSON document */
  constructor(file) {
    this.file = file
    /** @type {Promise<unknown>} */
    this.tail = Promise.resolve()
  }

  /** Read the document; a missing file is an empty portfolio. */
  async read() {
    let text
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return emptyPortfolio()
      throw new Error(`cannot read portfolio file ${this.file}: ${error?.message ?? error}`)
    }
    try {
      return normalizePortfolio(JSON.parse(text))
    } catch (error) {
      throw new Error(
        `portfolio file ${this.file} is not valid JSON (${error?.message ?? error}); fix or move it, then retry`,
      )
    }
  }

  /** Write the document atomically. */
  async write(doc) {
    const next = { ...normalizePortfolio(doc), updatedAt: new Date().toISOString() }
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp-${process.pid}-${Date.now()}`
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    try {
      await rename(temp, this.file)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
    return next
  }

  /**
   * Read-modify-write under a serialized queue.
   * @template T
   * @param {(doc: ReturnType<typeof emptyPortfolio>) => T | Promise<T>} mutate
   * @returns {Promise<{ doc: ReturnType<typeof emptyPortfolio>, result: T }>}
   */
  update(mutate) {
    const run = async () => {
      const doc = await this.read()
      const result = await mutate(doc)
      const written = await this.write(doc)
      return { doc: written, result }
    }
    const next = this.tail.then(run, run)
    this.tail = next.catch(() => undefined)
    return next
  }
}
