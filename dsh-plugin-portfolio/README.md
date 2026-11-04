# 投资组合 · dsh-plugin-portfolio

给 DeepSeek Harness（桌面版 0.2.x）用的本地插件：把投资持仓、目标配置和市值快照记下来，并算出**总市值 / 浮动盈亏 / 权重 / 资产类别分布 / 集中度 / 目标偏离 / 再平衡金额**，供智能体在对话里做投资决策。

行情**直接复用这个 profile 里已配置好的盈米（qieman）MCP**：插件不另开连接、不重复存 API key，而是在调用时按名字解析 MCP 客户端注册的
`mcp__qieman__BatchGetFundNavHistory` 工具并调用它，把最新净值回写进持仓。所以只要 profile 里挂过 `@deepseek-ai/dsh-mcp-client`（你这台机器已经在 `~/.dsh/cordis.patch.yml` 里配了 qieman），`refresh` 就能用；没配则给出可读报错，不会用旧价格冒充新数据。

## 它给智能体的能力

一个工具 `portfolio`，六个动作：

| 动作 | 作用 |
| --- | --- |
| `report`（默认） | 组合概览、持仓明细表、类别分布、集中度、目标偏离与再平衡建议、数据新鲜度提醒 |
| `upsert` | 按代码新增或覆盖持仓（代码 / 名称 / 类别 / 份额 / 成本价 / 现价 / 目标权重 / 备注） |
| `remove` | 按代码删除持仓 |
| `targets` | 设置目标权重：按持仓代码，或按资产类别（fund / stock / bond / cash / other） |
| `snapshot` | 记录当天（或指定日期）的组合市值快照，用于回撤与累计收益 |
| `history` | 列出历史快照与当前回撤 |
| `check` | **估值体检（时机）**：拉 A股温度计 + 各标的 1 年净值，算「1 年高点回撤 / 200 日均线偏离」，按估值档位告诉你现在该不该买；`intraday: true` 时用场内实时价估算当日净值（温度计仍为 T-1） |
| `rebalance` | **新钱到账后调比例（自动两模式）**：钱袋子里有新钱 → 按固定目标缺口把新钱投放；没有新钱 → 在已买入品种间按归一化目标占比轮动（卖高配买低配、现金中性）。建仓期只买不卖 |
| `refresh` | **向盈米 MCP 拉最新净值并回写现价**，同时写入**前一交易日净值**（`codes` 可只刷指定持仓；股票等无行情源的标的手动维护） |

## 界面（浏览器端）

插件同时带一个只读面板：左侧边栏的全局面板列表里多一个「投资组合」图标，点开是一整页的组合看板——总市值 / 成本 / 浮动盈亏 / 持仓数四张卡片、类别占比条、持仓明细表、目标偏离与再平衡金额、数据新鲜度提醒，右上角「刷新」。

- 数据由 Host 半的 `GET /portfolio/api/summary` 提供（只读、无写接口），面板用相对地址 `fetch` 取数；这条通道是 `dsh-client-ui-schedule`（DSH 自己的计划页）和 better-sidebar 同一个模式。
- 「模型」页展示买/卖规则（A 股温度、海外位置、黄金、债券、现金），以及**组合目标（v7.1）**与**回测 / 压力测试**：近 5 年目标权重静态持有（不含现金）的年化收益、最大回撤、波动、夏普，和 S1–S5 压力情景估算；数据为 2026-11-04 快照。
- 浏览器半 `client.js` 是**手写的不需要构建**：宿主把它当作经典脚本，在 `/plugins/<包名>/client.js` 原样返回，执行时只注册一个懒加载工厂；React 由宿主提供。
- 只读接口：`GET /portfolio/api/summary`、`GET /portfolio/api/check`（时机 + 钱袋子/买入信号；`?intraday=1` 用盘中实时价估算）、`GET /portfolio/api/rebalance`（新钱投放或轮动清单，`mode` 字段标明是 `deploy` 还是 `rotate`）、`GET /portfolio/api/quotes`（全品种场内代理实时价）；写操作：`POST /portfolio/api/execute`（提交勾选的买入订单，需 `x-dsh-portfolio: 1` 头）、`GET /portfolio/api/orders`（待确认/已成交订单）、`POST /portfolio/api/transfer`（记录平台"钱袋子→品种"调仓，按净值折算份额，需 `x-dsh-portfolio: 1` 头）、`GET /portfolio/api/executions`（执行历史，带建仓轮次）、`GET /portfolio/api/weekly`（周度市场分析：提高/维持/降低节奏 + 目标 pace）；写操作只走 `refresh`（POST + 请求头）。
- 写操作（录入/改价/设目标）仍然走对话里的 `portfolio` 工具；面板上只有一个**「刷新净值」**按钮，它会 POST `/portfolio/api/refresh`（要求 `x-dsh-portfolio: 1` 头，跨站表单拿不到），由 Host 去问盈米 MCP 拿净值。

## 数据存在哪里

默认 `$DSH_HOME/storages/portfolio/portfolio.json`（macOS 上是 `~/.dsh/storages/portfolio/portfolio.json`），纯 JSON、可读可备份：

```json
{
  "version": 1,
  "currency": "CNY",
  "holdings": [{
    "code": "110011", "name": "易方达中小盘", "kind": "fund",
    "units": 1000, "costPrice": 7.2,
    "price": 8.0,       "priceDate": "2026-10-27",      // 今日（最新）净值
    "prevPrice": 7.94,  "prevPriceDate": "2026-10-26",  // 前一交易日净值
    "priceSource": "qieman"
  }],
  "targets": { "byCode": { "110011": 30 }, "byKind": { "cash": 20 } },
  "snapshots": [{ "date": "2026-10-28", "value": 227900, "cost": 209400 }]
}
```

写入是原子的（临时文件 + rename），同一个文件上的并发调用会排队，不会写出半个文件。

## 安装（桌面版）

### 这台机器上已经装好了（热挂载方式）

已完成的动作，可复查：

1. 目录通过 `link:` 进入 profile 的依赖：`~/.dsh/profiles/desktop/package.json` 里
   `"@local/dsh-plugin-portfolio": "link:/<path-to>/dsh-plugin-portfolio"`，
   `node_modules/@local/dsh-plugin-portfolio` 是指向本目录的符号链接（`pnpm add link:...` 生成）。
2. 挂载行写在 profile 的用户 patch 层 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾：
   `- insert: [{ id: portfolio, name: '@local/dsh-plugin-portfolio' }]`。
   这层被 HMR 监视，改完即热重组，**不用重启应用**。
3. 生效证据：插件被激活时会在系统临时目录写一条 breadcrumb
   `${TMPDIR}/dsh-plugin-portfolio-activated.json`（记录 pid、Electron 版本、数据文件路径）。
   本机上它已由运行中的 Electron 进程写入，说明 Host 半已经在跑。

**看界面**：硬刷新一次页面（Cmd+Shift+R），左侧边栏的全局面板列表里会出现「投资组合」图标；点开是看板。

### 为什么用 patch 行而不是「bundle 列表」

`dsh.profile.bundles`（也在 `package.json` 里）只被 Plugin Manager 写入、或在应用启动时读取；手改这个列表运行时不会生效。
而 patch 层是 HMR 直接监视的。所以本地开发用 patch 行挂载，**这也意味着：别再在 Plugins 页面里选中/启用这个包**，否则同一 id 挂两次，加载器会报重复。

### 想要「由插件管理器管理」的正式安装

下次重启应用前，先删掉 `cordis.patch.yml` 末尾那三行（`- insert: ...`），然后走 GUI：

1. 侧边栏 → **Plugins** → **Add plugin** 右侧箭头 → **Install a third-party plugin**
2. 填本目录绝对路径：`/<path-to>/dsh-plugin-portfolio`（也接受包名、Git 地址、tarball）
3. Install → 完成后它会进入 `dsh.profile.bundles`，从此可以在 Plugins 页开关、升级、卸载。

另一种方式：让 Creator 模式的智能体装（`plugin_manager` 的 `install_bundle`，`target` 传同一个绝对路径）。

### 卸载

```sh
# 1) 删掉 cordis.patch.yml 末尾的 - insert: ... 三行
# 2) 断开依赖
cd ~/.dsh/profiles/desktop && pnpm remove @local/dsh-plugin-portfolio
# 3) 清掉本机 breadcrumb（可选）
rm -f "$TMPDIR/dsh-plugin-portfolio-activated.json"
```

### 改完代码怎么生效

- **Host 半**（`index.js` / `lib/*`）：保存后 HMR 不会立刻重载（`hmr.root` 为 `[]`，不监视源码），
  在 `cordis.patch.yml` 里加/删一行注释「推一把」就会重新组合并加载新代码；也可以直接重启应用。
- **Client 半**（`client.js`）：`dsh-client-hmr` 会按文件变化热替换，硬刷新页面可确保干净。

## 用法示例（直接对智能体说）

- 「建一个组合：110011 易方达中小盘 1000 份，成本 7.2，现价 8.0；161725 白酒 2000 份，成本 1.1，现价 0.95；再加 5 万现金。」
- 「把 110011 的现价更新成 8.5，然后看看我现在的权重和集中度。」
- 「目标：110011 30%，基金整体 40%，现金 20%。算一下我要买卖多少。」
- 「记一下今天的市值快照。以后每次我让你更新价格时都顺手记一条。」
- 「结合 qieman 的诊断数据和我这份持仓，说说下一步该加仓还是减仓，理由是什么。」

## 配置

需要改路径或新鲜度阈值，在你自己的 profile patch（`~/.dsh/cordis.patch.yml` 或 `~/.dsh/profiles/desktop/cordis.patch.yml`）里按行 id 覆盖：

```yaml
- id: portfolio
  config:
    dataFile: '~/Documents/portfolio/portfolio.json'
    staleAfterDays: 7
    mcpServer: qieman                      # MCP 客户端里的 serverName
    navTool: BatchGetFundNavHistory        # 该 server 上的净值工具名
    watchlist: []                          # check 额外检查、但尚未持有的代码
    bondCodes: ['007169', '003376', '001257']   # 债券类：短债不择时、长债按 200 日线
    longBondCodes: ['003376']              # 长久期：只在净值低于 200 日线 2% 时加
    goldCode: '000216'                     # 黄金：仓位封顶 1/2
    overseasCodes: ['050025', '000071', '006327', '000369']  # 海外：按回撤+200 日线
    cashCode: '000509'                     # 钱袋子：待投资金都放这里
    etfMap: {}                             # 盘中估算映射（基金→场内代码），默认已含 7 只
    scheduleCheckAt: '14:40'                # 每天自动跑一次盘中体检；'' 关闭
    scheduleWeeklyAt: '15:30'               # 每周五收盘后生成市场分析（提高/降低节奏建议）
    weeklyEnabled: true                     # 关闭周度分析
    activityLimit: 7                        # 任务记录保留条数（最近 N 条）
    scheduleWeekdaysOnly: true              # 只在周一到周五跑
    planningValue: 0                        # 规划基数（如 300000）：目标金额/权重/缺口按这个规模算，0=按当前市值
    fundingMode: auto                       # 买入资金来源：auto=未持有走钱袋子/已持有直接申购；external/cash 可强制
    reserveAmount: 0                        # 组合只记投资资金：备用金另行管理，不做隔离
    deployPacePct: 0.3                      # 动态节奏：每轮投剩余缺口的 30%
    deployMinRunPct: 0.05                   # 单轮下限（剩余弹药 5%，防僵死）
    deployMaxRunPct: 0.5                    # 单轮上限（剩余弹药 50%，防冲太猛）
    deployStopGapPct: 1                     # 剩余缺口 <1% 视为建仓完成
    deployMultiplierMin: 0.5                # 估值乘数下限
    deployMultiplierMax: 1.2                # 保守：估值乘数上限
    maxRunPct: 0.1                          # 单次最多买入组合的 10%
    maxSleeveStepPct: 0.5                   # 单只每次最多买缺口的 50%
    overseasGoldCapPct: 30                  # 海外+黄金合并上限
    strategicOverPct: 10                    # 超战略配置多少 pp 强制再平衡卖出
    cheapOverBuyPct: 115                    # 保守：便宜/极低估最多买目标的 115%
    equityCapPct: 65                        # 保守：风险资产（A股+海外+黄金）总仓位硬上限
    ashareIndexMap: { '022424': '000300' }  # A500 用沪深300温度，其余用全A
    sellBands: ['贵', '偏高']               # 只在贵的档位才卖
    sellOverTargetPct: 5                   # 超目标多少个百分点才考虑卖（只对贵的档位生效）
    autoRefreshHours: 0                    # >0：按小时定时刷新（0 = 关闭）
    autoSnapshot: false                    # 定时刷新成功后自动记当天快照
```

定时刷新用 `ctx.interval`（`timer` 服务，基础 bundle 自带），是**可选注入**：即使 profile 没有 timer 行，插件照常加载，只是不排定时任务。

## 开发与验证

Host 半不 import 任何 `@deepseek-ai/*`（本地 link 的包无法从自己的目录解析宿主的共享包；MCP 工具是通过 `ctx.tools.get()` 解析后调用的，同样不需要依赖），
所以这些测试**不需要装依赖**，在插件目录里直接跑：

```sh
# 语法/JSON/SVG 自检
node --check index.js && node --check client.js
# Host 半：用真实的 @deepseek-ai/dsh-tools 与 schemastery 驱动注册出来的工具 + HTTP 路由
node test/smoke.mjs
# Client 半：模拟 window.__ModuleLoader__ / React / ctx.slots，验证产物契约与渲染
node test/client.mjs
# 行情解析：用真实 qieman 返回文本做 fixture
node test/quotes.mjs
# 估值档位与 200 日线指标（纯函数）
node test/valuation.mjs
```

`test/smoke.mjs` 覆盖：空组合提示、upsert 幂等、权重合计 100%、集中度告警、目标偏离与再平衡金额、快照按日期去重、删除校验、JSON Schema 参数校验、持久化文件结构、`/portfolio/api/summary` 的 GET/405 与空组合分支。
`test/client.mjs` 覆盖：loader `id` 等于包名、懒加载工厂、`react` 外部依赖、`main` + `sidebar.panellist` 两个 slot 注册（key 与 id 一致）、两个组件可渲染。它**不**验证外观——那需要装进应用后看页面。

改完代码后：本地目录安装是 `link:` 语义，改动在**重新安装（Remove → Add）或触发一次 bundle 重载**后生效；Host 半更新需要重启应用，浏览器半（如果将来加上）由 `dsh-client-hmr` 热替换。

## 路线图

1. **v0.1（当前）**：Host 侧工具 + JSON 记账 + 确定性分析 + 只读看板（`main` 面板 + 侧栏图标）。
2. **v0.2（已做）**：接入行情源——`refresh` 动作 + 面板「刷新净值」按钮，直接调用 profile 里的盈米 MCP。
3. **v0.3（部分已做）**：可选定时刷新 + 自动快照已实现（`autoRefreshHours`/`autoSnapshot`，默认关闭）；剩余：面板增强——类别占比/权重条形图、编辑持仓（需要加写路由并做同源/信任围栏）、一键「让智能体复盘」（把面板当前状态塞进对话）。
4. **v1.0**：多组合/多账户、交易流水（而非快照）、风险指标（波动、最大回撤、相关性）。
