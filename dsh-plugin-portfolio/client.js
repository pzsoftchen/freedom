// Browser half — hand-written bundle, no build step.
//
// The host serves this file byte-for-byte at /plugins/@local/dsh-plugin-portfolio/client.js
// and the web shell executes it as a classic script. Running it only REGISTERS a
// lazy factory: `id` must equal the package name, and everything below runs when
// the plugin is materialized.
//
// Layout: status strip → four stat cards → three tabs (配置 / 持仓 / 模型).
// Check and rebalance results open as dismissible cards above the tabs so they
// never pile up with the permanent tables.
window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-portfolio',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'portfolio'
    const API = {
      summary: '/portfolio/api/summary',
      refresh: '/portfolio/api/refresh',
      check: '/portfolio/api/check',
      rebalance: '/portfolio/api/rebalance',
    }
    const inject = ['slots']

    const color = {
      text: 'var(--dsw-alias-label-primary, #1a1a1a)',
      secondary: 'var(--dsw-alias-label-secondary, #6b7280)',
      faint: 'var(--dsw-alias-label-tertiary, #9ca3af)',
      border: 'var(--dsw-alias-border-l1, rgba(0,0,0,0.10))',
      surface: 'var(--dsw-alias-bg-l1, transparent)',
      subtle: 'var(--dsw-alias-fill-l2, rgba(0,0,0,0.04))',
      brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      accent: '#4d6bfe',
      up: 'var(--dsw-alias-label-danger, #d03050)',
      down: 'var(--dsw-alias-label-success, #18a058)',
    }

    const styles = {
      page: {
        padding: '16px 20px 28px',
        color: color.text,
        fontSize: 12.5,
        lineHeight: 1.55,
        height: '100%',
        overflow: 'auto',
        boxSizing: 'border-box',
      },
      header: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 },
      title: { margin: 0, fontSize: 16, fontWeight: 600 },
      caption: { color: color.secondary, fontSize: 11.5 },
      faint: { color: color.faint, fontSize: 11 },
      spacer: { flex: 1 },
      actions: { display: 'flex', gap: 6, alignItems: 'center' },
      button: {
        padding: '3px 10px',
        borderRadius: 6,
        border: `1px solid ${color.border}`,
        background: 'transparent',
        color: color.text,
        cursor: 'pointer',
        fontSize: 11.5,
        whiteSpace: 'nowrap',
      },
      primaryButton: {
        padding: '3px 12px',
        borderRadius: 6,
        border: 'none',
        background: color.accent,
        color: '#fff',
        cursor: 'pointer',
        fontSize: 11.5,
        whiteSpace: 'nowrap',
      },
      dashGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: 8,
        marginBottom: 8,
      },
      dashCard: {
        border: `1px solid ${color.border}`,
        borderRadius: 10,
        padding: '8px 10px',
        background: color.surface,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      },
      dashHead: { display: 'flex', alignItems: 'center', gap: 6, color: color.secondary, fontSize: 11 },
      dashValue: { fontSize: 16, fontWeight: 600, lineHeight: 1.2 },
      dashSub: { fontSize: 10.5, color: color.faint },
      ringWrap: { display: 'flex', alignItems: 'center', gap: 8 },
      gaugeTrack: {
        height: 6,
        borderRadius: 3,
        background: `linear-gradient(90deg, #5b8def 0%, #4fb477 35%, #e5b94e 65%, #e06c5a 100%)`,
        position: 'relative',
        margin: '6px 0 2px',
      },
      gaugeMarker: { position: 'absolute', top: -3, width: 2, height: 12, background: color.text, borderRadius: 1 },
      bulletTrack: { height: 6, borderRadius: 3, background: color.subtle, position: 'relative', overflow: 'hidden' },
      bulletFill: { height: '100%', background: color.brand, borderRadius: 3 },
      bulletTick: { position: 'absolute', top: -2, width: 2, height: 10, background: color.text, opacity: 0.6 },
      chips: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
      chip: {
        fontSize: 10.5,
        color: color.secondary,
        border: `1px solid ${color.border}`,
        borderRadius: 999,
        padding: '2px 8px',
        background: color.surface,
      },
      statusStrip: {
        display: 'flex',
        gap: 12,
        flexWrap: 'wrap',
        alignItems: 'center',
        padding: '6px 10px',
        borderRadius: 8,
        background: color.subtle,
        marginBottom: 10,
        fontSize: 11.5,
        color: color.secondary,
      },
      cards: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
        gap: 8,
        marginBottom: 12,
      },
      card: {
        padding: '9px 11px',
        border: `1px solid ${color.border}`,
        borderRadius: 10,
        background: color.surface,
      },
      cardLabel: { color: color.secondary, fontSize: 11, marginBottom: 2 },
      cardValue: { fontSize: 17, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
      tabs: { display: 'flex', gap: 4, marginBottom: 10, borderBottom: `1px solid ${color.border}`, paddingBottom: 6 },
      tab: {
        padding: '3px 12px',
        borderRadius: 999,
        border: 'none',
        background: 'transparent',
        color: color.secondary,
        cursor: 'pointer',
        fontSize: 12,
      },
      tabActive: {
        padding: '3px 12px',
        borderRadius: 999,
        border: 'none',
        background: color.accent,
        color: '#fff',
        cursor: 'pointer',
        fontSize: 12,
      },
      section: { marginBottom: 14 },
      sectionTitle: { fontSize: 12.5, fontWeight: 600, margin: '10px 0 6px' },
      table: { width: '100%', borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' },
      th: {
        textAlign: 'left',
        fontWeight: 500,
        color: color.secondary,
        fontSize: 11,
        padding: '4px 6px',
        borderBottom: `1px solid ${color.border}`,
        whiteSpace: 'nowrap',
      },
      td: { padding: '4px 6px', borderBottom: `1px solid ${color.border}`, whiteSpace: 'nowrap', fontSize: 11.5 },
      categoryRow: {
        display: 'grid',
        gridTemplateColumns: '68px 1fr 78px 78px 78px 96px',
        gap: 8,
        alignItems: 'center',
        padding: '7px 8px',
        borderBottom: `1px solid ${color.border}`,
        cursor: 'pointer',
      },
      categoryName: { fontWeight: 600, fontSize: 12 },
      barTrack: { height: 5, borderRadius: 3, background: color.subtle, overflow: 'hidden', display: 'flex' },
      barFill: { height: '100%', background: color.brand, borderRadius: 3 },
      barFillMuted: { height: '100%', background: color.faint, opacity: 0.35 },
      notice: {
        padding: '6px 9px',
        border: `1px solid ${color.border}`,
        borderRadius: 8,
        color: color.secondary,
        fontSize: 11.5,
      },
      result: {
        border: `1px solid ${color.border}`,
        borderRadius: 10,
        padding: '10px 12px',
        marginBottom: 12,
        background: color.surface,
      },
      resultHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
    }

    const money = (value) =>
      Number.isFinite(value)
        ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
        : '—'
    const pct = (value) => (Number.isFinite(value) ? `${value.toFixed(2)}%` : '—')
    const signedColor = (value) => (value > 0 ? color.up : value < 0 ? color.down : color.text)
    const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100
    const ComponentBase = React.Component ?? class {}
    class PanelErrorBoundary extends ComponentBase {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      render() {
        if (this.state.error) {
          return h(
            'div',
            { style: { padding: 16, color: color.up } },
            `看板渲染出错：${String(this.state.error?.message ?? this.state.error)}；请刷新页面，或告诉我报错内容。`,
          )
        }
        return this.props.children
      }
    }

    function useSummary() {
      const [state, setState] = React.useState({ status: 'loading' })
      const load = React.useCallback(() => {
        setState((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }))
        return fetch(`${API.summary}?_=${Date.now()}`, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.json()
          })
          .then((payload) => {
            if (!payload || payload.ok !== true) throw new Error(payload?.error ?? 'bad payload')
            setState({ status: 'ready', value: payload.value })
            return payload.value
          })
          .catch((error) => {
            setState({ status: 'error', error: String(error?.message ?? error) })
            throw error
          })
      }, [])
      React.useEffect(() => {
        load().catch(() => {})
      }, [load])
      return [state, load]
    }

    const jsonFetch = (url, options) =>
      fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' }, ...options }).then((response) =>
        response.json().then((payload) => {
          if (!response.ok || payload.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          return payload
        }),
      )

    function StatCard({ label, value, tone }) {
      return h(
        'div',
        { style: styles.card },
        h('div', { style: styles.cardLabel }, label),
        h('div', { style: { ...styles.cardValue, color: tone ?? color.text } }, value),
      )
    }

    function SummaryCards({ value }) {
      const totals = value?.totals
      if (!totals) return null
      const plan = value.plan
      return h(
        'div',
        { style: styles.cards },
        h(StatCard, { label: '总市值', value: money(totals.value) }),
        h(StatCard, { label: '投入成本', value: money(totals.cost) }),
        h(StatCard, {
          label: `浮动盈亏（${pct(totals.pnlPct)}）`,
          value: money(totals.pnl),
          tone: signedColor(totals.pnl),
        }),
      )
    }

    function CategoryList({ plan, quoteByCode, onHistory }) {
      // Categories start open (`undefined !== false`); clicking one collapses it.
      const [collapsed, setCollapsed] = React.useState({})
      const summary = plan?.categorySummary ?? []
      const rowsOf = (category) => (plan?.rows ?? []).filter((row) => row.category === category)
      const anyCollapsed = summary.some((group) => collapsed[group.category] === true)
      return h(
        'div',
        null,
        summary.length > 0
          ? h(
              'div',
              { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: 4 } },
              h(
                'button',
                {
                  type: 'button',
                  style: styles.button,
                  onClick: () => setCollapsed(anyCollapsed ? {} : Object.fromEntries(summary.map((group) => [group.category, true]))),
                },
                anyCollapsed ? '全部展开' : '全部收起',
              ),
            )
          : null,
        summary.map((group) => {
          const open = collapsed[group.category] !== true
          const rows = rowsOf(group.category)
          const fill = group.targetPct > 0 ? Math.min(100, (group.currentPct / group.targetPct) * 100) : 0
          return h(
            'div',
            { key: group.category },
            h(
              'div',
              {
                style: styles.categoryRow,
                role: 'button',
                onClick: () =>
                  setCollapsed((previous) => ({ ...previous, [group.category]: previous[group.category] !== true })),
              },
              h('div', { style: styles.categoryName }, `${open ? '▾' : '▸'} ${group.category}`),
              h(
                'div',
                { style: styles.barTrack },
                h('div', { style: { ...styles.barFill, width: `${fill}%` } }),
                h('div', { style: { ...styles.barFillMuted, width: `${Math.max(0, 100 - fill)}%` } }),
              ),
              h('div', { style: styles.caption }, `战略 ${pct(group.targetPct)}`),
              h('div', { style: styles.caption }, `战术≤ ${pct(group.tacticalCapPct ?? group.targetPct)}`),
              h('div', { style: styles.caption }, `当前 ${pct(group.currentPct)}`),
              h(
                'div',
                { style: { ...styles.caption, color: (group.gapValue ?? 0) > 0 ? color.up : color.text } },
                `缺口 ${money(group.gapValue)}`,
              ),
            ),
            open
              ? h(
                  'table',
                  { style: styles.table },
                  h(
                    'thead',
                    null,
                    h(
                      'tr',
                      null,
                      ['代码', '名称', '前日→今日净值', '实时', '目标%', '当前%', '偏离', '缺口'].map((label) =>
                        h('th', { key: label, style: styles.th }, label),
                      ),
                    ),
                  ),
                  h(
                    'tbody',
                    null,
                    rows.map((row) =>
                      h(
                        'tr',
                        { key: row.code, style: row.held ? null : { opacity: 0.55 } },
                        h('td', { style: styles.td }, row.code),
                        h(
                          'td',
                          {
                            style: { ...styles.td, cursor: 'pointer', color: color.brand },
                            title: '点击查看走势',
                            onClick: () => onHistory({ code: row.code, name: row.name }),
                          },
                          row.name + (row.held ? '' : '（未买）') + ' 📈',
                        ),
                        h(
                          'td',
                          { style: styles.td },
                          quoteByCode?.[row.code]?.prevNav === null || quoteByCode?.[row.code]?.prevNav === undefined
                            ? '—'
                            : `${quoteByCode[row.code].prevNav} → ${quoteByCode[row.code].nav}（${
                                quoteByCode[row.code].navDate?.slice(5) ?? '—'
                              }）`,
                        ),
                        h(
                          'td',
                          { style: { ...styles.td, color: signedColor(quoteByCode?.[row.code]?.changePct) } },
                          quoteByCode?.[row.code]?.changePct === null || quoteByCode?.[row.code]?.changePct === undefined
                            ? '—'
                            : `${quoteByCode[row.code].changePct > 0 ? '+' : ''}${quoteByCode[row.code].changePct}%`,
                        ),
                        h('td', { style: styles.td }, pct(row.targetPct)),
                        h('td', { style: styles.td }, pct(row.currentPct)),
                        h(
                          'td',
                          { style: { ...styles.td, color: signedColor(row.deltaPct) } },
                          row.deltaPct === null ? '—' : `${row.deltaPct > 0 ? '+' : ''}${row.deltaPct}pp`,
                        ),
                        h('td', { style: styles.td }, money(row.deltaValue)),
                      ),
                    ),
                  ),
                )
              : null,
          )
        }),
      )
    }

    function HoldingsTable({ value, quoteByCode, onHistory }) {
      const rows = [...(value?.rows ?? [])].sort((a, b) => b.value - a.value)
      return h(
        'table',
        { style: styles.table },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            ['代码', '名称', '前日净值', '今日净值', '涨跌(净值)', '当日盈亏(元)', '实时参考', '市值', '盈亏', '权重'].map((label) =>
              h('th', { key: label, style: styles.th }, label),
            ),
          ),
        ),
        h(
          'tbody',
          null,
          rows.map((row) =>
            h(
              'tr',
              { key: row.code },
              h('td', { style: styles.td }, row.code),
              h(
                'td',
                { style: { ...styles.td, cursor: 'pointer', color: color.brand }, title: '点击查看走势', onClick: () => onHistory({ code: row.code, name: row.name }) },
                `${row.name} 📈`,
              ),
              h(
                'td',
                { style: styles.td },
                row.prevPrice === null || row.prevPrice === undefined
                  ? '—'
                  : `${row.prevPrice}（${row.prevPriceDate ? row.prevPriceDate.slice(5) : '—'}）`,
              ),
              h(
                'td',
                { style: styles.td },
                row.price === null ? '—' : `${row.price}（${row.priceDate ? row.priceDate.slice(5) : '—'}）`,
              ),
              h(
                'td',
                { style: { ...styles.td, color: signedColor(row.dayChange) } },
                row.dayChange === null || row.dayChange === undefined
                  ? '—'
                  : `${row.dayChange > 0 ? '+' : ''}${row.dayChange}（${row.dayChangePct > 0 ? '+' : ''}${row.dayChangePct}%）`,
              ),
              h(
                'td',
                { style: { ...styles.td, color: signedColor(row.dayPnl) } },
                row.dayPnl === null || row.dayPnl === undefined ? '—' : `${row.dayPnl > 0 ? '+' : ''}${money(row.dayPnl)}`,
              ),
              h(
                'td',
                { style: styles.td },
                quoteByCode?.[row.code]?.estimate === null || quoteByCode?.[row.code]?.estimate === undefined
                  ? quoteByCode?.[row.code]?.price === null || quoteByCode?.[row.code]?.price === undefined
                    ? '无估算源'
                    : h(
                        'span',
                        { style: { color: signedColor(quoteByCode[row.code].changePct) } },
                        `${quoteByCode[row.code].price}（${quoteByCode[row.code].changePct > 0 ? '+' : ''}${quoteByCode[row.code].changePct}%）`,
                      )
                  : h(
                      'span',
                      { style: { color: signedColor(quoteByCode[row.code].changePct) } },
                      `${Number(quoteByCode[row.code].estimate).toFixed(4)}（${quoteByCode[row.code].changePct > 0 ? '+' : ''}${
                        quoteByCode[row.code].changePct
                      }%，${quoteByCode[row.code].source === 'index' ? '指数估' : 'ETF代理'}）`,
                    ),
              ),
              h('td', { style: styles.td }, money(row.value)),
              h('td', { style: { ...styles.td, color: signedColor(row.pnl) } }, `${money(row.pnl)}（${pct(row.pnlPct)}）`),
              h('td', { style: styles.td }, pct(row.weight)),
            ),
          ),
        ),
      )
    }

    function ModelPanel({ model }) {
      if (!model) return null
      const table = (bands) =>
        h(
          'table',
          { style: styles.table },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              ['档位', '动作', '条件'].map((label) => h('th', { key: label, style: styles.th }, label)),
            ),
          ),
          h(
            'tbody',
            null,
            bands.map((row, index) =>
              h(
                'tr',
                { key: index },
                h('td', { style: styles.td }, row.band),
                h('td', { style: styles.td }, row.action),
                h('td', { style: styles.td }, row.range ?? row.rule ?? ''),
              ),
            ),
          ),
        )
      return h(
        'div',
        null,
        model.portfolio
          ? h(
              'div',
              null,
              h('div', { style: styles.sectionTitle }, '组合目标（v7.1）'),
              h(
                'div',
                { style: styles.notice },
                `目标规模 ${money(model.portfolio.capital)} ｜ 期望年化 ≈${model.portfolio.expectedReturnPct}% ｜ 回撤预算 −${model.portfolio.drawdownBudgetPct}%`,
              ),
              h(
                'table',
                { style: styles.table },
                h('thead', null, h('tr', null,
                  ['层', '权重', '品种'].map((label) => h('th', { key: label, style: styles.th }, label)),
                )),
                h('tbody', null,
                  model.portfolio.layers.map((row) =>
                    h('tr', { key: row.name },
                      h('td', { style: styles.td }, row.name),
                      h('td', { style: styles.td }, `${row.weight}%`),
                      h('td', { style: styles.td }, row.codes),
                    ),
                  ),
                ),
              ),
              h('div', { style: { ...styles.notice, margin: '6px 0 6px' } }, model.portfolio.effectiveNote),
              h('div', { style: { ...styles.notice, marginBottom: 12 } }, model.portfolio.note),
            )
          : null,
        model.backtest
          ? h(
              'div',
              null,
              h('div', { style: styles.sectionTitle }, '回测与压力测试'),
              h(
                'div',
                { style: styles.notice },
                `${model.backtest.window}：年化 ${model.backtest.annualizedPct}% ｜ 最大回撤 ${model.backtest.maxDrawdownPct}% ｜ 波动 ${model.backtest.volatilityPct}% ｜ 夏普 ${model.backtest.sharpe}`,
              ),
              model.backtest.forecast
                ? h(
                    'div',
                    { style: { marginTop: 10 } },
                    h('div', { style: styles.sectionTitle }, '收益预测（分层加权，非回测外推）'),
                    h(
                      'div',
                      { style: styles.notice },
                      `本金 ${money(model.backtest.forecast.capital)}｜期望年化 ${model.backtest.forecast.expectedPct}% ≈ **${money(
                        model.backtest.forecast.annualAmount,
                      )}/年**（区间 ${model.backtest.forecast.lowPct}%~${model.backtest.forecast.highPct}% ≈ ${money(
                        model.backtest.forecast.annualLowAmount,
                      )}~${money(model.backtest.forecast.annualHighAmount)}/年）｜5 年累计 ≈ ${money(
                        model.backtest.forecast.cumulative5yAmount.low,
                      )} / ${money(model.backtest.forecast.cumulative5yAmount.base)} / ${money(
                        model.backtest.forecast.cumulative5yAmount.high,
                      )}（低/中/高）`,
                    ),
                    h(
                      'table',
                      { style: styles.table },
                      h('thead', null, h('tr', null,
                        ['层', '权重', '金额', '期望年化', '年收益', '区间', '依据'].map((label) => h('th', { key: label, style: styles.th }, label)),
                      )),
                      h('tbody', null,
                        model.backtest.forecast.layers.map((row) =>
                          h('tr', { key: row.name },
                            h('td', { style: styles.td }, row.name),
                            h('td', { style: styles.td }, `${row.weight}%`),
                            h('td', { style: styles.td }, money(row.amount)),
                            h('td', { style: styles.td }, `${row.expectedPct}%`),
                            h('td', { style: styles.td }, `${money(row.annualAmount)}/年`),
                            h('td', { style: styles.td }, `${row.low}% ~ ${row.high}%`),
                            h('td', { style: styles.td }, row.basis),
                          ),
                        ),
                      ),
                    ),
                    h('div', { style: { ...styles.notice, margin: '6px 0 12px' } }, model.backtest.forecast.compare),
                    h('div', { style: { ...styles.notice, margin: '0 0 12px', color: color.faint } }, model.backtest.forecast.note),
                  )
                : null,
              h(
                'table',
                { style: styles.table },
                h('thead', null, h('tr', null,
                  ['情景', '组合回撤', '30 万浮亏', '50 万浮亏'].map((label) => h('th', { key: label, style: styles.th }, label)),
                )),
                h('tbody', null,
                  model.backtest.stress.map((row) => {
                    const absolute30 = Math.round((row.value / 100) * 300000)
                    const absolute50 = Math.round((row.value / 100) * 500000)
                    return h('tr', { key: row.scenario },
                      h('td', { style: styles.td }, row.scenario),
                      h('td', { style: styles.td }, `${row.value}%`),
                      h('td', { style: styles.td }, `${absolute30 < 0 ? '-' : ''}${Math.abs(absolute30).toLocaleString('zh-CN')}`),
                      h('td', { style: styles.td }, `${absolute50 < 0 ? '-' : ''}${Math.abs(absolute50).toLocaleString('zh-CN')}`),
                    )
                  }),
                ),
              ),
              h('div', { style: { ...styles.notice, margin: '6px 0 12px' } }, model.backtest.note),
            )
          : null,
        h('div', { style: styles.sectionTitle }, 'A 股：按市场温度'),
        table(model.temperature.bands),
        h('div', { style: { ...styles.notice, margin: '6px 0 12px' } }, model.temperature.hysteresis),
        model.temperature.styleNote
          ? h('div', { style: { ...styles.notice, margin: '0 0 12px' } }, model.temperature.styleNote)
          : null,
        h('div', { style: styles.sectionTitle }, '海外 / 港股 / 黄金：回撤 + 200 日线'),
        table(model.position.bands),
        h('div', { style: { ...styles.notice, margin: '6px 0 12px' } }, model.position.note),
        model.overseas
          ? h(
              'div',
              null,
              h('div', { style: styles.sectionTitle }, '海外权益：位置 × 趋势乘数'),
              h(
                'table',
                { style: styles.table },
                h('thead', null, h('tr', null,
                  ['趋势', '比例系数'].map((label) => h('th', { key: label, style: styles.th }, label)),
                )),
                h('tbody', null,
                  model.overseas.rules.map((row) =>
                    h('tr', { key: row.trend },
                      h('td', { style: styles.td }, row.trend),
                      h('td', { style: styles.td }, `×${row.multiplier}`),
                    ),
                  ),
                ),
              ),
              h('div', { style: { ...styles.notice, margin: '6px 0 12px' } }, `${model.overseas.source}｜${model.overseas.note}`),
            )
          : null,
        model.gold
          ? h(
              'div',
              null,
              h('div', { style: styles.sectionTitle }, '黄金：3 年位置 + 均线趋势'),
              h(
                'table',
                { style: styles.table },
                h('thead', null, h('tr', null,
                  ['趋势状态', '单次上限'].map((label) => h('th', { key: label, style: styles.th }, label)),
                )),
                h('tbody', null,
                  model.gold.rules.map((row) =>
                    h('tr', { key: row.state },
                      h('td', { style: styles.td }, row.state),
                      h('td', { style: styles.td }, row.cap),
                    ),
                  ),
                ),
              ),
              h('div', { style: { ...styles.notice, margin: '6px 0 12px' } }, `${model.gold.source}｜${model.gold.note}`),
            )
          : null,
        model.bonds
          ? h(
              'div',
              null,
              h('div', { style: styles.sectionTitle }, '债券：按久期分别判断'),
              h('div', { style: { ...styles.notice, marginBottom: 6 } }, `短债/现金：${model.bonds.short}`),
              h('div', { style: { ...styles.notice, marginBottom: 6 } }, `二级债：${model.bonds.secondary}`),
              h('div', { style: { ...styles.notice, marginBottom: 6 } }, `长债：${model.bonds.long}`),
              h(
                'table',
                { style: styles.table },
                h('thead', null, h('tr', null,
                  ['10Y 收益率分位', '比例', '说明'].map((label) => h('th', { key: label, style: styles.th }, label)),
                )),
                h('tbody', null,
                  (model.bonds.longBands ?? []).map((row) =>
                    h('tr', { key: row.percentile },
                      h('td', { style: styles.td }, row.percentile),
                      h('td', { style: styles.td }, row.fraction === 1 ? '买满' : row.fraction === 2 / 3 ? '2/3' : '1/3'),
                      h('td', { style: styles.td }, row.note),
                    ),
                  ),
                ),
              ),
              h('div', { style: { height: 8 } }),
            )
          : null,
        model.cash
          ? h(
              'div',
              null,
              h('div', { style: styles.sectionTitle }, '现金：动态目标（随温度）'),
              h(
                'table',
                { style: styles.table },
                h('thead', null, h('tr', null,
                  ['温度', '现金目标'].map((label) => h('th', { key: label, style: styles.th }, label)),
                )),
                h('tbody', null,
                  model.cash.bands.map((row) =>
                    h('tr', { key: row.temperature },
                      h('td', { style: styles.td }, row.temperature),
                      h('td', { style: styles.td }, `${row.targetPct}%`),
                    ),
                  ),
                ),
              ),
              h('div', { style: { ...styles.notice, margin: '6px 0 12px' } }, `资金分桶：${model.cash.buckets}`),
            )
          : null,
        h('div', { style: styles.sectionTitle }, '特殊规则'),
        ...(model.special ?? []).map((entry) =>
          h('div', { key: entry.label, style: { ...styles.notice, marginBottom: 6 } }, `${entry.label}：${entry.rule}`),
        ),
        h('div', { style: { ...styles.notice, marginTop: 8 } }, `卖出：${model.sell.rule}`),
        h('div', { style: { ...styles.notice, marginTop: 6 } }, `节奏：${model.timing}`),
      )
    }

    function ResultCard({ title, onClose, children }) {
      return h(
        'div',
        { style: styles.result },
        h(
          'div',
          { style: styles.resultHead },
          h('strong', null, title),
          h('span', { style: styles.spacer }),
          h('button', { type: 'button', style: styles.button, onClick: onClose }, '关闭'),
        ),
        children,
      )
    }

    function CheckResult({ data, onClose, onExecuted }) {
      const rows = [...(data?.rows ?? [])].sort((a, b) => (b.suggest ?? 0) - (a.suggest ?? 0))
      const sugg = rows.filter((row) => (row.suggest ?? 0) > 0)
      const [picked, setPicked] = React.useState(() => Object.fromEntries(sugg.map((row) => [row.code, true])))
      const [edits, setEdits] = React.useState(() =>
        Object.fromEntries(sugg.map((row) => [row.code, { amount: row.suggest, source: '' }])),
      )
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')
      const amountOf = (code) => Number(edits[code]?.amount ?? 0)
      const sourceOf = (code) => edits[code]?.source ?? ''
      const pickedRows = sugg.filter((row) => picked[row.code])
      const pickedTotal = pickedRows.reduce((sum, row) => sum + amountOf(row.code), 0)
      const allPicked = sugg.length > 0 && pickedRows.length === sugg.length
      const toggle = (code) => setPicked((previous) => ({ ...previous, [code]: !previous[code] }))
      const execute = () => {
        if (pickedRows.length === 0) return
        setBusy(true)
        setNote('')
        jsonFetch('/portfolio/api/execute', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-portfolio': '1' },
          body: JSON.stringify({
            items: pickedRows
              .filter((row) => amountOf(row.code) > 0)
              .map((row) => ({
                code: row.code,
                name: row.name,
                amount: amountOf(row.code),
                ...(sourceOf(row.code) ? { source: sourceOf(row.code) } : {}),
              })),
          }),
        })
          .then((payload) => {
            setNote(`已提交 ${payload.value.orders.length} 笔待确认订单，合计 ${money(payload.value.total)}；净值公布后点「刷新净值」自动入账。`)
            if (onExecuted) onExecuted()
          })
          .catch((error) => setNote(`执行失败：${String(error?.message ?? error)}`))
          .then(() => setBusy(false))
      }
      return h(
        ResultCard,
        { title: '估值体检结果', onClose },
        h(
          'div',
          { style: { ...styles.notice, marginBottom: 8 } },
          `A股 ${data?.temperature?.name ?? '—'} ${data?.temperature?.temperature ?? '—'}° → ${
            data?.ashare?.band ?? '—'
          }；建议买入合计 ${money(data?.totalBuy)}${data?.capped ? '（受钱袋子/上限约束）' : ''}`,
        ),
        Array.isArray(data?.dataWarnings) && data.dataWarnings.length > 0
          ? h(
              'div',
              { style: { ...styles.notice, marginBottom: 8, color: '#b45309' } },
              `数据提示：${data.dataWarnings.join('；')}`,
            )
          : null,
        note ? h('div', { style: { ...styles.notice, marginBottom: 8 } }, note) : null,
        h(
          'table',
          { style: styles.table },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h(
                'th',
                { style: styles.th },
                h('input', {
                  type: 'checkbox',
                  checked: allPicked,
                  onChange: () => setPicked(allPicked ? {} : Object.fromEntries(sugg.map((row) => [row.code, true]))),
                }),
              ),
              ['代码', '名称', '档位', '战略·上限', '当前%', '建议买入', '资金来源', '分批', '层级'].map((label) =>
                h('th', { key: label, style: styles.th }, label),
              ),
            ),
          ),
          h(
            'tbody',
            null,
            rows.map((row) =>
              h(
                'tr',
                { key: row.code, style: row.suggest > 0 ? null : { opacity: 0.55 } },
                h(
                  'td',
                  { style: styles.td },
                  h('input', {
                    type: 'checkbox',
                    disabled: row.suggest <= 0,
                    checked: row.suggest > 0 && picked[row.code] === true,
                    title:
                      row.suggest > 0
                        ? `建议买入 ${money(row.suggest)}`
                        : row.gap > 0
                          ? `档位「${row.band}」不买入，建议 0`
                          : '已达/超目标，无需买入',
                    onChange: () => toggle(row.code),
                  }),
                ),
                h('td', { style: styles.td }, row.code),
                h('td', { style: styles.td }, row.name),
                h(
                  'td',
                  {
                    style: { ...styles.td, maxWidth: 300, verticalAlign: 'top' },
                    title: row.note ?? `1年回撤 ${pct(row.drawdownPct)}｜200日线偏离 ${pct(row.deviationPct)}`,
                  },
                  h('div', null, row.band),
                  row.note
                    ? h(
                        'div',
                        {
                          style: {
                            color: color.faint,
                            fontSize: 10,
                            lineHeight: 1.4,
                            maxWidth: 300,
                            whiteSpace: 'normal',
                            wordBreak: 'break-word',
                            marginTop: 2,
                          },
                        },
                        row.note,
                      )
                    : null,
                ),
                h(
                  'td',
                  { style: styles.td },
                  `${pct(row.targetPct)}${row.tacticalCapPct === null || row.tacticalCapPct === undefined ? '' : ` / ${pct(row.tacticalCapPct)}`}`,
                ),
                h('td', { style: styles.td }, pct(row.currentPct)),
                h(
                  'td',
                  { style: styles.td },
                  row.suggest > 0
                    ? h('input', {
                        type: 'number',
                        min: 0,
                        step: '100',
                        value: amountOf(row.code),
                        style: {
                          width: 86,
                          padding: '2px 4px',
                          border: `1px solid ${color.border}`,
                          borderRadius: 4,
                          background: 'transparent',
                          color: color.text,
                          fontSize: 11.5,
                        },
                        onChange: (event) =>
                          setEdits((previous) => ({
                            ...previous,
                            [row.code]: { ...previous[row.code], amount: Number(event.target.value) || 0 },
                          })),
                      })
                    : '—',
                ),
                h(
                  'td',
                  { style: styles.td },
                  row.suggest > 0
                    ? h(
                        'select',
                        {
                          value: sourceOf(row.code),
                          style: {
                            padding: '2px 4px',
                            border: `1px solid ${color.border}`,
                            borderRadius: 4,
                            background: 'transparent',
                            color: color.text,
                            fontSize: 11,
                          },
                          onChange: (event) =>
                            setEdits((previous) => ({
                              ...previous,
                              [row.code]: { ...previous[row.code], source: event.target.value },
                            })),
                        },
                        h('option', { value: '' }, '自动'),
                        h('option', { value: 'cash' }, '钱袋子'),
                        h('option', { value: 'external' }, '直接申购'),
                      )
                    : '—',
                ),
                h(
                  'td',
                  {
                    style: styles.td,
                    title: (row.tranches ?? [])
                      .map((t) => `第${t.seq}批 ${money(t.amount)}（${t.trigger}）`)
                      .join('｜'),
                  },
                  (row.tranches ?? []).length > 0
                    ? row.tranches.map((t) => `${Math.round(t.share * 100)}%`).join('/')
                    : '—',
                ),
                h(
                  'td',
                  { style: { ...styles.td, color: row.layer && row.layer.startsWith('战术') ? color.brand : color.secondary } },
                  row.layer ?? '—',
                ),
              ),
            ),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 } },
          h(
            'span',
            { style: styles.caption },
            `已选 ${pickedRows.length}/${sugg.length} 笔可执行，合计 ${money(pickedTotal)}`,
          ),
          h('span', { style: styles.spacer }),
          h(
            'button',
            {
              type: 'button',
              style: { ...styles.primaryButton, opacity: busy || pickedRows.length === 0 ? 0.5 : 1 },
              disabled: busy || pickedRows.length === 0,
              onClick: execute,
            },
            busy ? '提交中…' : `执行选中（${pickedRows.length} 笔）`,
          ),
        ),
      )
    }

    function RebalanceResult({ data, onClose }) {
      const buys = data?.buys ?? []
      const sells = data?.sells ?? []
      const line = (row, sign) =>
        h(
          'tr',
          { key: `${sign}-${row.code}` },
          h('td', { style: styles.td }, row.code),
          h('td', { style: styles.td }, row.name),
          h('td', { style: styles.td }, sign),
          h('td', { style: styles.td }, money(row.amount)),
          h('td', { style: styles.td }, row.targetPct === null || row.targetPct === undefined ? '—' : pct(row.targetPct)),
          h('td', { style: styles.td }, row.currentPct === null || row.currentPct === undefined ? '—' : pct(row.currentPct)),
        )
      return h(
        ResultCard,
        { title: `再平衡结果（${data?.mode === 'rotate' ? '轮动' : '新钱投放'}）`, onClose },
        h(
          'div',
          { style: { ...styles.notice, marginBottom: 8 } },
          `买 ${money(data?.totalBuy)} ｜ 卖 ${money(data?.totalSell)} ｜ ${data?.building ? '建仓期：只买不卖' : '已建仓：双向收敛'}${
            data?.plan
              ? ` ｜ 动态节奏：剩余缺口 ${data.plan.gapPct}% × ${data.plan.pacePct}% × 乘数 ${data.plan.multiplier} = 预算 ${money(data.plan.budget)}`
              : ''
          }`,
        ),
        buys.length + sells.length === 0
          ? h('div', { style: styles.notice }, '本次无需调整。')
          : h(
              'table',
              { style: styles.table },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  ['代码', '名称', '方向', '金额', '目标%', '当前%'].map((label) =>
                    h('th', { key: label, style: styles.th }, label),
                  ),
                ),
              ),
              h('tbody', null, [...sells.map((row) => line(row, '卖出')), ...buys.map((row) => line(row, '买入'))]),
            ),
      )
    }

    function useQuotes() {
      const [quotes, setQuotes] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        const pull = () =>
          fetch('/portfolio/api/quotes', { credentials: 'same-origin', headers: { accept: 'application/json' } })
            .then((response) => response.json())
            .then((payload) => {
              if (alive && payload?.ok === true) setQuotes(payload.value)
            })
            .catch(() => {})
        pull()
        const timer = setInterval(pull, 60_000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])
      const byCode = {}
      for (const row of quotes?.rows ?? []) byCode[row.code] = row
      return { at: quotes?.at ?? null, byCode }
    }

    /** Execution ledger: every queued/confirmed buy with its deployment round. */
    function ExecutionsTable({ value }) {
      const exec = value?.executions
      const rows = exec?.items ?? []
      if (!rows || rows.length === 0) {
        return h('div', { style: styles.notice }, '还没有执行记录：在「估值体检」结果里勾选品种并点「执行选中」后，这里会留下历史。')
      }
      return h(
        'div',
        null,
        h(
          'div',
          { style: { ...styles.notice, marginBottom: 8 } },
          `共 ${exec.count} 笔：已成交 ${exec.filledCount} 笔（${money(exec.filledAmount)}）｜待确认 ${exec.pendingCount} 笔`,
        ),
        h(
          'table',
          { style: styles.table },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              ['提交时间', '轮次', '代码', '名称', '金额', '资金', '状态', '成交净值', '份额', '成交时间'].map((label) =>
                h('th', { key: label, style: styles.th }, label),
              ),
            ),
          ),
          h(
            'tbody',
            null,
            rows.map((row) =>
              h(
                'tr',
                { key: row.id },
                h('td', { style: styles.td }, row.createdAt ? new Date(row.createdAt).toLocaleString('zh-CN', { hour12: false }) : '—'),
                h('td', { style: styles.td }, row.round === null ? '—' : `第 ${row.round} 轮`),
                h('td', { style: styles.td }, row.code),
                h('td', { style: styles.td }, row.name),
                h('td', { style: styles.td }, money(row.amount)),
                h(
                  'td',
                  { style: styles.td },
                  row.source === 'wallet'
                    ? '盈米宝'
                    : row.source === 'plan' || row.source === 'cash'
                      ? '钱袋子'
                      : row.source === 'external'
                        ? '直接申购'
                        : '—',
                ),
                h(
                  'td',
                  { style: { ...styles.td, color: row.status === 'filled' ? color.down : color.secondary } },
                  row.status === 'filled' ? '已成交' : '待确认',
                ),
                h('td', { style: styles.td }, row.filledNav === null ? '—' : row.filledNav),
                h('td', { style: styles.td }, row.filledUnits === null ? '—' : row.filledUnits),
                h(
                  'td',
                  { style: styles.td },
                  row.filledAt ? new Date(row.filledAt).toLocaleString('zh-CN', { hour12: false }) : '—',
                ),
              ),
            ),
          ),
        ),
      )
    }

    /** Simple SVG line chart for one instrument (1y / 3y / since inception). */
    function HistoryCard({ code, name, onClose }) {
      const [range, setRange] = React.useState('1y')
      const [history, setHistory] = React.useState(null)
      const [error, setError] = React.useState('')
      React.useEffect(() => {
        let alive = true
        setHistory(null)
        setError('')
        fetch(`/portfolio/api/history?code=${encodeURIComponent(code)}&range=${range}`, {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        })
          .then((response) => response.json())
          .then((payload) => {
            if (!alive) return
            if (payload?.ok !== true) throw new Error(payload?.error ?? '加载失败')
            setHistory(payload.value)
          })
          .catch((err) => alive && setError(String(err?.message ?? err)))
        return () => {
          alive = false
        }
      }, [code, range])
      const points = history?.points ?? []
      const navs = points.map((point) => point.nav)
      const maSeries = points.map((point) => point.ma200)
      const min = navs.length > 0 ? Math.min(...navs) : 0
      const max = navs.length > 0 ? Math.max(...navs) : 1
      const width = 640
      const height = 160
      const pad = 6
      const span = max - min || 1
      const path =
        points.length > 1
          ? points
              .map((point, index) => {
                const x = pad + (index / (points.length - 1)) * (width - pad * 2)
                const y = height - pad - ((point.nav - min) / span) * (height - pad * 2)
                return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
              })
              .join(' ')
          : ''
      const maValues = maSeries.filter((value) => value !== null && value !== undefined)
      const allValues = [...navs, ...maValues]
      const axisMin = allValues.length > 0 ? Math.min(...allValues) : 0
      const axisMax = allValues.length > 0 ? Math.max(...allValues) : 1
      const axisSpan = axisMax - axisMin || 1
      const toPath = (series) => {
        if (points.length < 2) return ''
        const valid = series.map((value, index) => ({ value, index })).filter((item) => item.value !== null && item.value !== undefined)
        if (valid.length < 2) return ''
        return valid
          .map((item, order) => {
            const x = pad + (item.index / (points.length - 1)) * (width - pad * 2)
            const y = height - pad - ((item.value - axisMin) / axisSpan) * (height - pad * 2)
            return `${order === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
          })
          .join(' ')
      }
      const navPath = toPath(navs)
      const maPath = toPath(maSeries)
      const stats = history?.stats
      return h(
        ResultCard,
        { title: `${name}（${code}）走势`, onClose },
        h(
          'div',
          { style: { display: 'flex', gap: 6, marginBottom: 8 } },
          ...[
            ['1m', '近1月'],
            ['3m', '近3月'],
            ['6m', '近6月'],
            ['1y', '近1年'],
            ['3y', '近3年'],
            ['all', '成立以来'],
          ].map(([key, label]) =>
            h(
              'button',
              { key, type: 'button', style: range === key ? styles.tabActive : styles.tab, onClick: () => setRange(key) },
              label,
            ),
          ),
          h('span', { style: styles.spacer }),
          stats
            ? h(
                'span',
                { style: styles.caption },
                `${stats.startDate} → ${stats.endDate}｜区间收益 ${stats.totalReturnPct > 0 ? '+' : ''}${stats.totalReturnPct}%｜最大回撤 ${stats.maxDrawdownPct}%｜当前回撤 ${stats.currentDrawdownPct}%`,
              )
            : null,
        ),
        error
          ? h('div', { style: styles.notice }, `读取失败：${error}`)
          : !history
            ? h('div', { style: styles.notice }, '加载走势中…')
            : h(
                'div',
                null,
                h(
                  'svg',
                  { viewBox: `0 0 ${width} ${height}`, style: { width: '100%', height: 170, display: 'block' } },
                  h('path', { d: navPath, fill: 'none', stroke: color.brand, strokeWidth: 1.6 }),
                  maPath
                    ? h('path', {
                        d: maPath,
                        fill: 'none',
                        stroke: color.secondary,
                        strokeWidth: 1.2,
                        strokeDasharray: '5 3',
                      })
                    : null,
                  h('text', { x: pad, y: 12, fontSize: 10, fill: color.secondary }, `高点 ${max.toFixed(4)}`),
                  h('text', { x: pad, y: height - 4, fontSize: 10, fill: color.secondary }, `低点 ${min.toFixed(4)}`),
                ),
                h(
                  'div',
                  { style: { ...styles.notice, marginTop: 6 } },
                  stats
                    ? `当前位置：距区间高点 ${stats.currentDrawdownPct}% ｜ 距 200 日线 ${
                        stats.deviationFromMa200Pct > 0 ? '+' : ''
                      }${stats.deviationFromMa200Pct}%（MA200 ${stats.ma200 ?? '—'}，当前 ${stats.endNav}）`
                    : '',
                ),
              ),
      )
    }

    /** Automation activity: the last N runs (check / weekly / execute). */
    function TasksTable({ value }) {
      const items = [...(value?.activity ?? [])].reverse()
      if (items.length === 0) {
        return h('div', { style: styles.notice }, '还没有任务记录：每天 14:40 体检、每周五 15:30 分析、每次执行都会记录在这里（保留最近 7 条）。')
      }
      const [open, setOpen] = React.useState({})
      return h(
        'div',
        null,
        items.map((entry, index) => {
          const key = `${entry.at}-${index}`
          const expanded = open[key] === true
          const detail = entry.detail ?? {}
          return h(
            'div',
            { key, style: { ...styles.result, padding: '8px 10px', marginBottom: 6 } },
            h(
              'div',
              { style: { display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }, onClick: () => setOpen((previous) => ({ ...previous, [key]: !previous[key] })) },
              h('span', { style: { ...styles.caption, minWidth: 120 } }, new Date(entry.at).toLocaleString('zh-CN', { hour12: false })),
              h(
                'span',
                { style: { ...styles.td, border: 'none', color: color.brand, fontSize: 11 } },
                entry.type === 'check' ? '体检' : entry.type === 'weekly' ? '周分析' : '执行',
              ),
              h('span', { style: { ...styles.td, border: 'none' } }, entry.summary ?? ''),
              h('span', { style: styles.spacer }),
              h('span', { style: styles.faint }, expanded ? '收起' : '详情'),
            ),
            expanded
              ? h(
                  'div',
                  { style: { ...styles.notice, marginTop: 6 } },
                  entry.type === 'check'
                    ? `温度 ${detail.temperature ?? '—'}° / ${detail.band ?? '—'}；买入 ${detail.buyCount ?? 0} 笔，合计 ${money(detail.totalBuy)}`
                    : entry.type === 'weekly'
                      ? `建议 ${detail.suggestion ?? '—'}，目标 pace ${detail.targetPacePct ?? '—'}%；${(detail.reasons ?? []).join('；')}`
                      : `共 ${detail.count ?? 0} 笔，合计 ${money(detail.total)}；${(detail.orders ?? [])
                          .map((order) => `${order.code} ${money(order.amount)}`)
                          .join('，')}`,
                )
              : null,
          )
        }),
      )
    }

    function TopDashboard({ plan, value, quotesAt }) {
      if (!plan) return null
      const lastCheck = value?.lastCheck ?? null
      const temperature = Number.isFinite(lastCheck?.temperature?.temperature) ? lastCheck.temperature.temperature : null
      const temperatureBand = lastCheck?.ashare?.band ?? '—'
      const progress = Number.isFinite(plan.progress) ? plan.progress : 0
      const targetCapital = Number.isFinite(plan.targetCapital) ? plan.targetCapital : null
      const wallet = Number.isFinite(plan.cash?.spendable) ? plan.cash.spendable : 0
      const planCash = Number.isFinite(plan.cash?.value) ? plan.cash.value - wallet : 0
      const spendable = Number.isFinite(plan.cash?.value) ? plan.cash.value : wallet
      const totalValue = Number.isFinite(plan.value) ? plan.value : 0
      const cashPct = totalValue > 0 ? (spendable / totalValue) * 100 : 0
      const dayPnl = Number.isFinite(value?.totals?.dayChange) ? value.totals.dayChange : null
      const dayPnlPct = Number.isFinite(value?.totals?.dayChangePct) ? value.totals.dayChangePct : null
      const pending = value?.orders?.pending?.length ?? 0
      const rounds = value?.deployment?.doneRounds ?? null
      const ringRadius = 22
      const circumference = 2 * Math.PI * ringRadius
      const ring = h(
        'svg',
        { width: 58, height: 58, viewBox: '0 0 58 58', role: 'img', 'aria-label': `建仓进度 ${pct(progress)}` },
        h('circle', { cx: 29, cy: 29, r: ringRadius, fill: 'none', stroke: color.subtle, strokeWidth: 6 }),
        h('circle', {
          cx: 29,
          cy: 29,
          r: ringRadius,
          fill: 'none',
          stroke: color.brand,
          strokeWidth: 6,
          strokeLinecap: 'round',
          strokeDasharray: `${(circumference * Math.min(100, Math.max(0, progress))) / 100} ${circumference}`,
          transform: 'rotate(-90 29 29)',
        }),
      )
      const gauge =
        temperature === null
          ? h('div', { style: styles.dashSub }, '温度未知（先跑一次估值体检）')
          : h(
              'div',
              null,
              h(
                'div',
                { style: styles.gaugeTrack },
                h('div', { style: { ...styles.gaugeMarker, left: `calc(${Math.min(100, Math.max(0, temperature))}% - 1px)` } }),
              ),
              h('div', { style: styles.dashSub }, `${temperature.toFixed(2)}° · ${temperatureBand}`),
            )
      return h(
        'div',
        null,
        h(
          'div',
          { style: styles.dashGrid },
          h(
            'div',
            { style: styles.dashCard },
            h('div', { style: styles.dashHead }, '建仓进度'),
            h(
              'div',
              { style: styles.ringWrap },
              ring,
              h(
                'div',
                null,
                h('div', { style: styles.dashValue }, pct(progress)),
                h('div', { style: styles.dashSub }, targetCapital ? `目标 ${money(targetCapital)}` : '目标未设'),
              ),
            ),
          ),
          h(
            'div',
            { style: styles.dashCard },
            h('div', { style: styles.dashHead }, 'A股温度（中证全A）'),
            gauge,
          ),
          h(
            'div',
            { style: { ...styles.dashCard }, title: `现金合计 ${money(spendable)}：盈米宝可直接申购，组合钱袋子在组合内等平台调仓` },
            h('div', { style: styles.dashHead }, '可投弹药（盈米宝）'),
            h('div', { style: styles.dashValue }, money(spendable)),
            h('div', { style: styles.dashSub }, `盈米宝 ${money(wallet)} + 钱袋子 ${money(planCash)}`),
            h(
              'div',
              { style: styles.bulletTrack },
              h('div', { style: { ...styles.bulletFill, width: `${Math.min(100, cashPct)}%` } }),
              h('div', { style: { ...styles.bulletTick, left: `calc(${Math.min(100, plan.cash?.targetPct ?? 5)}% - 1px)` } }),
            ),
            h('div', { style: styles.dashSub }, `可动用 ${money(plan.cash?.available ?? wallet)}（盈米宝）｜现金占比 ${pct(cashPct)}（目标 ${pct(plan.cash?.targetPct ?? 5)}）`),
          ),
          h(
            'div',
            { style: { ...styles.dashCard, title: `前日净值口径：${money(dayPnl)}` } },
            h('div', { style: styles.dashHead }, '当日盈亏'),
            h(
              'div',
              { style: { ...styles.dashValue, color: signedColor(dayPnl) } },
              dayPnl === null ? '—' : `${dayPnl > 0 ? '+' : ''}${money(dayPnl)}`,
            ),
            h('div', { style: { ...styles.dashSub, color: signedColor(dayPnl) } }, dayPnlPct === null ? '' : `${pct(dayPnlPct)}（净值口径）`),
          ),
        ),
        h(
          'div',
          { style: styles.chips },
          h('span', { style: styles.chip }, plan.building ? '建仓期：只买不卖' : '已建仓：可双向收敛'),
          pending > 0 ? h('span', { style: { ...styles.chip, color: color.up } }, `待确认 ${pending} 笔`) : null,
          rounds !== null ? h('span', { style: styles.chip }, `已执行 ${rounds} 批`) : null,
          value?.generatedAt
            ? h('span', { style: styles.chip }, `数据 ${new Date(value.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`)
            : null,
          quotesAt
            ? h('span', { style: styles.chip }, `实时参考 ${new Date(quotesAt).toLocaleTimeString('zh-CN', { hour12: false })}（ETF 代理）`)
            : null,
          Number.isFinite(plan.basis) && plan.basis !== plan.value
            ? h('span', { style: styles.chip }, `规划基数 ${money(plan.basis)}`)
            : null,
          plan.fundingMode === 'auto'
            ? h('span', { style: styles.chip }, '资金来源：未持有→盈米宝，已持有→直接申购')
            : null,
        ),
      )
    }

    function PortfolioPanel() {
      const [state, load] = useSummary()
      const { at: quotesAt, byCode: quoteByCode } = useQuotes()
      const [tab, setTab] = React.useState('plan')
      const [note, setNote] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [intraday, setIntraday] = React.useState(false)
      const [checkView, setCheckView] = React.useState(null)
      const [historyCode, setHistoryCode] = React.useState(null)
      const [rebalanceView, setRebalanceView] = React.useState(null)

      const value = state.status === 'ready' ? state.value : null
      const plan = value?.plan

      const runCheck = React.useCallback(() => {
        setBusy('check')
        setNote('估值体检中（拉温度计 + 一年净值，约 10–20 秒）…')
        jsonFetch(API.check + (intraday ? '?intraday=1' : ''))
          .then((payload) => {
            setCheckView(payload.value)
            setRebalanceView(null)
            setNote(`估值体检完成：A股 ${payload.value?.ashare?.band ?? '—'}`)
          })
          .catch((error) => setNote(`估值体检失败：${String(error?.message ?? error)}`))
          .then(() => setBusy(''))
      }, [intraday])

      const runRebalance = React.useCallback(() => {
        setBusy('rebalance')
        setNote('计算再平衡…')
        jsonFetch(API.rebalance)
          .then((payload) => {
            setRebalanceView(payload.value)
            setCheckView(null)
            setNote(payload.value?.mode === 'deploy' ? '再平衡：新钱投放' : '再平衡：已买入品种轮动')
          })
          .catch((error) => setNote(`再平衡失败：${String(error?.message ?? error)}`))
          .then(() => setBusy(''))
      }, [])

      const runRefresh = React.useCallback(() => {
        setBusy('refresh')
        setNote('刷新净值中…')
        jsonFetch(API.refresh, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-portfolio': '1' },
          body: '{}',
        })
          .then((payload) => {
            const count = payload.refreshed?.updated?.length ?? 0
            setNote(count > 0 ? `已刷新 ${count} 条净值` : '没有取到新净值')
            load()
          })
          .catch((error) => setNote(`刷新失败：${String(error?.message ?? error)}`))
          .then(() => setBusy(''))
      }, [load])

      const reload = React.useCallback(() => {
        setNote('重新读取中…')
        load()
          .then(() => setNote(`已重新读取 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`))
          .catch((error) => setNote(`重新读取失败：${String(error?.message ?? error)}`))
      }, [load])

      const body =
        state.status === 'loading'
          ? h('div', { style: styles.notice }, '正在读取持仓…')
          : state.status === 'error'
            ? h('div', { style: styles.notice }, `读取失败：${state.error}（点「重新读取」重试）`)
            : !value
              ? null
              : h(
                  'div',
                  null,
                  h(SummaryCards, { value }),
                  plan ? h(TopDashboard, { plan, value, quotesAt }) : null,
                  historyCode
                    ? h(HistoryCard, {
                        code: historyCode.code,
                        name: historyCode.name,
                        onClose: () => setHistoryCode(null),
                      })
                    : null,
                  value.generatedAt
                    ? h(
                        'div',
                        { style: { ...styles.faint, marginBottom: 8 } },
                        `数据更新于 ${new Date(value.generatedAt).toLocaleString('zh-CN', { hour12: false })}`,
                      )
                    : null,
                  h(
                    'div',
                    { style: styles.tabs },
                    ...[
                      ['plan', '配置'],
                      ['holdings', '持仓'],
                      ['executions', '执行'],
                      ['tasks', '任务'],
                      ['model', '模型'],
                    ].map(([key, label]) =>
                      h(
                        'button',
                        { key, type: 'button', style: tab === key ? styles.tabActive : styles.tab, onClick: () => setTab(key) },
                        label,
                      ),
                    ),
                  ),
                  tab === 'plan'
                    ? h(CategoryList, { plan, quoteByCode, onHistory: (item) => setHistoryCode(item) })
                    : tab === 'holdings'
                      ? h(HoldingsTable, { value, quoteByCode, onHistory: (item) => setHistoryCode(item) })
                      : tab === 'executions'
                        ? h(ExecutionsTable, { value })
                        : tab === 'tasks'
                          ? h(TasksTable, { value })
                          : h(ModelPanel, { model: value.model }),
                )

      const panel = h(
        'section',
        { style: styles.page },
        h(
          'header',
          { style: styles.header },
          h('h2', { style: styles.title }, '投资组合'),
          note ? h('span', { style: styles.faint }, note) : null,
          h('span', { style: styles.spacer }),
          h(
            'div',
            { style: styles.actions },
            h(
              'label',
              { style: { ...styles.faint, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' } },
              h('input', { type: 'checkbox', checked: intraday, onChange: (event) => setIntraday(event.target.checked) }),
              '盘中',
            ),
            h(
              'button',
              { type: 'button', style: styles.primaryButton, disabled: busy === 'check', onClick: runCheck },
              busy === 'check' ? '体检中…' : '估值体检',
            ),
            h(
              'button',
              { type: 'button', style: styles.button, disabled: busy === 'rebalance', onClick: runRebalance },
              busy === 'rebalance' ? '计算中…' : '再平衡',
            ),
            h(
              'button',
              { type: 'button', style: styles.button, disabled: busy === 'refresh', onClick: runRefresh },
              busy === 'refresh' ? '刷新中…' : '刷新净值',
            ),
            h('button', { type: 'button', style: styles.button, onClick: reload }, '重新读取'),
          ),
        ),
        value?.lastCheck
          ? h(
              'div',
              { style: { ...styles.notice, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 } },
              h(
                'span',
                null,
                `⏰ 上次体检 ${new Date(value.lastCheck.at).toLocaleString('zh-CN', { hour12: false })}：买入合计 ${money(
                  value.lastCheck.totalBuy,
                )}${value.lastCheck.intraday ? '（盘中估算）' : ''}`,
              ),
              h('span', { style: styles.spacer }),
              h(
                'button',
                {
                  type: 'button',
                  style: styles.button,
                  onClick: () => setCheckView({ ...value.lastCheck }),
                },
                '查看建议',
              ),
            )
          : null,
        checkView ? h(CheckResult, { data: checkView, onClose: () => setCheckView(null), onExecuted: load }) : null,
        rebalanceView ? h(RebalanceResult, { data: rebalanceView, onClose: () => setRebalanceView(null) }) : null,
        body,
      )
      return h(PanelErrorBoundary, null, panel)
    }

    function PanelIcon(props) {
      const size = props?.size ?? 20
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          'aria-hidden': true,
          style: { opacity: props?.active ? 1 : 0.7, display: 'block' },
        },
        h('circle', { cx: 12, cy: 12, r: 8, fill: 'none', stroke: 'currentColor', strokeWidth: 2 }),
        h('path', { d: 'M12 4v8h8', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
      )
    }

    function apply(ctx) {
      ctx.effect(
        () => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, PortfolioPanel)),
        'portfolio: main panel',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: '投资组合' }, PanelIcon),
          ),
        'portfolio: sidebar nav icon',
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
