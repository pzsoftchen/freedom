/**
 * Smoke test for the browser half, runnable without the Harness page.
 *
 *   node test/client.mjs
 *
 * It stands in for the web shell: a `window.__ModuleLoader__` that records the
 * lazily-registered factory, a small React shim, and a Cordis-like ctx with
 * `slots`/`effect`. That proves the artifact contract (id, factory shape,
 * exports, slot registrations, a renderable component) without a browser.
 * It does NOT prove what the panel looks like — that needs the running app.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = fileURLToPath(new URL('.', import.meta.url))
const clientFile = new URL('../client.js', import.meta.url)
const packageFile = new URL('../package.json', import.meta.url)

const pkg = JSON.parse(await readFile(packageFile, 'utf8'))

// --- stand-ins for the shell -------------------------------------------------
const loadCalls = []
const context = {
  console,
  setTimeout,
  clearTimeout,
  window: {
    __ModuleLoader__: {
      load(entry) {
        loadCalls.push(entry)
      },
    },
  },
  fetch: () => Promise.reject(new Error('network disabled in this test')),
}
vm.createContext(context)
vm.runInContext(await readFile(clientFile, 'utf8'), context, { filename: 'client.js' })

assert.equal(loadCalls.length, 1, 'the bundle must register exactly one loader entry')
const entry = loadCalls[0]
assert.equal(entry.id, pkg.name, 'loader id must equal the package name')
assert.equal(typeof entry.factory, 'function', 'the loader entry must be lazy')

/** Minimal React: elements are plain objects; hooks keep rendering deterministic. */
const react = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useCallback(fn) {
    return fn
  },
  useEffect() {},
  useMemo(fn) {
    return fn()
  },
}

const required = []
const moduleExports = entry.factory((specifier) => {
  required.push(specifier)
  if (specifier === 'react') return react
  throw new Error(`unexpected require(${specifier})`)
})

assert.equal(required.join(','), 'react')
assert.equal(typeof moduleExports.apply, 'function')
assert.equal(moduleExports.inject.join(','), 'slots', 'inject lists Cordis service names')

// --- stand-ins for Cordis slots ---------------------------------------------
const registrations = []
const disposers = 0
const ctx = {
  effect(fn) {
    const disposer = fn()
    return () => {
      if (typeof disposer === 'function') disposer()
    }
  },
  slots: {
    inject(name, register) {
      assert.equal(typeof register, 'function')
      return register(name)
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}
moduleExports.apply(ctx)

assert.equal(registrations.length, 2, 'one panel and one sidebar icon')
const panel = registrations.find((entry) => entry.options.name === 'main')
const icon = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
assert.ok(panel, 'the panel must register into the keyed main slot')
assert.ok(icon, 'the icon must register into sidebar.panellist')
assert.equal(panel.options.key, icon.options.id, 'panel key and panellist id must match')
assert.equal(panel.options.key, 'portfolio')
assert.equal(typeof icon.options.label, 'string')
assert.ok(Number.isFinite(icon.options.order))

// Both components render a tree without touching the DOM.
const panelTree = panel.component()
const panelRoot = panelTree.type === 'section' ? panelTree : panelTree.props.children
assert.equal(panelRoot.type, 'section', 'the panel renders a section (wrapped by the error boundary)')
assert.equal(panelRoot.props.children[0].type, 'header')

const iconTree = icon.component({ size: 20, active: true })
assert.equal(iconTree.type, 'svg')
assert.equal(iconTree.props.width, 20)

// Static checks for the redesigned panel: tabs, category summary, model view.
const clientSource = await readFile(clientFile, 'utf8')
assert.ok(clientSource.includes('估值体检'), 'the panel has a check button')
assert.ok(clientSource.includes('再平衡'), 'the panel has a rebalance button')
assert.ok(clientSource.includes('const round2'), 'the client bundle defines its own round2 helper')
assert.ok(clientSource.includes('未买'), 'unbought sleeves are labelled')
assert.ok(clientSource.includes('建仓进度'), 'build progress is shown')
assert.ok(clientSource.includes('categorySummary'), 'the plan is grouped by category')
assert.ok(clientSource.includes('按市场温度'), 'the model rules are shown on the page')
assert.ok(clientSource.includes('实时参考'), 'holdings show the realtime proxy quote')
assert.ok(clientSource.includes('前日净值'), 'holdings show the previous-day NAV')
assert.ok(clientSource.includes('collapsed[group.category] !== true'), 'categories are expanded by default')
assert.ok(clientSource.includes('全部收起'), 'the plan tab has an expand/collapse-all control')
assert.ok(clientSource.includes('执行选中'), 'check results can be executed after ticking rows')
assert.ok(clientSource.includes('/portfolio/api/history'), 'instrument names open the NAV history chart')
assert.ok(clientSource.includes('historyCode.code'), 'the history card is actually rendered in the panel tree')
assert.ok(clientSource.includes('ma200'), 'the chart draws the 200-day moving average')
assert.ok(clientSource.includes('距 200 日线'), 'the chart annotates current position vs the 200-day line')
assert.ok(clientSource.includes("type: 'checkbox'"), 'check result rows have checkboxes')
assert.ok(clientSource.includes('涨跌(净值)'), 'NAV change is derived from the two NAVs')
assert.ok(clientSource.includes('/portfolio/api/quotes'), 'the panel polls the quotes route')
assert.ok(clientSource.includes("'plan', '配置'"), 'the panel is tabbed (配置/持仓/模型)')

console.log('portfolio client test OK — loader contract, slot registrations and rendering hold')
