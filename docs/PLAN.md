# 给你的 DSH 建一个「投资持仓 + 决策」插件：从 0 到 1

这份文档是这次落地的完整说明：**DSH 的插件是什么 → 怎么开始 → 已经建好的骨架 → 下一步怎么长**。
配套资料在 `research/`（host 侧 API、client 侧 UI、安装与热更新），可直接当参考手册查。

---

## 1. 先搞清楚：DSH 的「插件」到底是什么

你用的桌面版 DSH 版本是 **0.2.1-rc.3**（Electron 应用，`/Applications/DeepSeek Harness.app`）。
它的插件模型可以一句话概括：

> **一个普通的 npm 包 + 一个 YAML patch 行 + 可选的一个浏览器端文件。**

具体是：

| 组成 | 作用 | 必须吗 |
| --- | --- | --- |
| `package.json` 的 `dsh.bundle.patch` | 指向 `cordis.patch.yml`，安装时被识别为「bundle」 | 必须 |
| `cordis.patch.yml` | `- insert: [{ id, name, config }]`，把插件行插进 profile 的插件树 | 必须 |
| `index.js`（Host 半） | 在应用主进程里运行：注册工具、路由、定时任务、存储 | 至少一半 |
| `lib/client.js`（Client 半） | 浏览器里运行：往 UI 的插槽（slot）里塞 React 组件 | 想要界面才需要 |
| `locale/*.json` + `icon.svg` | Plugins 页面里的标题/描述/图标 | 强烈建议 |

关键点，全都实测过：

- **两半都不需要构建工具**。Client 半不是 ESM，而是 `window.__ModuleLoader__.load({ id, factory })` 这种 6 行包装的经典脚本，React 由宿主提供；Host 半就是普通 ESM。
- **安装不需要发布到 npm**。Plugins 页面 → Add plugin → 箭头 → **Install a third-party plugin**，填**本地绝对路径**就行（也接受包名/Git/tarball）。安装会写 profile 的 `package.json` + `pnpm-lock.yaml` + `node_modules`，并把 bundle 追加到 `dsh.profile.bundles`。
- **`desktop` 这个 profile 归 Electron 独占**：命令行 `dsh plugin --profile desktop ...` 会被拒绝（`profile "desktop" is managed exclusively by the Electron application`），而且你 PATH 里的 `dsh` 是 0.1.5，和桌面版 0.2.1-rc.3 不是同一套 API。**别用 CLI 装，走 GUI。**
- **官方作者文档就在应用里**：`dsh-agent-preset/skills/cordis-plugin-development/`（SKILL.md + references + 可直接抄的 templates）。在 Creator 模式（新建任务时选 Creator）里，智能体自带这套 skill，会自己写 bundle 再用 `plugin_manager` 的 `install_bundle` 装上——想「让 AI 帮我写插件」就走这条路。
- **改代码的生效规则**：Client 半改了文件会被 `dsh-client-hmr` 500ms 内热替换；Host 半改了要重启应用 / 重载 bundle；本地目录是 `link:` 语义，重装一次最稳。
- 失败兜底：应用启动时如果有插件把 profile 弄坏，窗口会提供「**Disable third-party plugins, back up profile patch, and restart**」按钮（把 profile 的 `cordis.patch.yml` 改名备份并重置 bundles）。

---

## 2. 该怎么开始（推荐顺序）

**第 0 步 · 先想清楚「谁在用」**
DSH 的强项是对话。所以第一版应该是「**智能体会用的工具**」，而不是「一个网页」：你说「看看我的持仓」，智能体调工具、算指标、给结论。界面在第二版再加。

**第 1 步 · 从模板起步，不要从空白起步**
把应用里的 `templates/decoration/`（UI 版）或 `references/host-plugin.md` 的 Host-only manifest 抄到工作区，改个名字就是能装的 bundle。本次已经按这个规范把骨架建好了（见第 3 节）。

**第 2 步 · 装进正在跑的桌面版**
Plugins → Add plugin → 箭头 → Install a third-party plugin → 填 `/Users/lanlan/freedom/dsh-plugin-portfolio` → Install。
装完在 Plugins 列表里能看到「投资组合」，可以随时 Off/Remove。

**第 3 步 · 在对话里用起来，按真实需求迭代**
先只做「记账 + 算术」，价格从已装好的 `qieman` MCP（`BatchGetFundNavHistory`、`GetFundDiagnosis`…）取，再写进组合。跑几天会发现真正的痛点是「不想手抄价格」，于是 v0.2 做自动刷新；再往后才需要面板。

---

## 3. 已经建好的东西：`dsh-plugin-portfolio`

`/Users/lanlan/freedom/dsh-plugin-portfolio/`

```
package.json          # dsh.bundle.patch + dsh.client + exports（./client、./locale、./icon）
cordis.patch.yml      # 一行 insert：id=portfolio, config={dataFile?, staleAfterDays}（同时挂 Host 与 Client 两半）
index.js              # Host 半：portfolio 工具（6 个动作）+ GET /portfolio/api/summary 只读路由
client.js             # Client 半：手写浏览器 bundle（无构建），main 整页面板 + sidebar.panellist 图标
lib/store.js          # 组合文档的原子读写（临时文件 + rename，写操作串行）
lib/analysis.js       # 纯算术：市值/成本/盈亏/权重/类别/集中度/目标偏离/再平衡/快照回撤
locale/{en,zh}.json   # Plugins 页面的标题与描述
icon.svg              # 自绘图标（原创，无版权问题）
test/smoke.mjs        # Host 半冒烟测试（真实 dsh-tools + schemastery + 路由）
test/client.mjs       # Client 半冒烟测试（模拟 __ModuleLoader__ / React / ctx.slots）
README.md             # 安装、用法、界面、数据结构、开发、路线图
```

**设计取舍（为什么这么做）**

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 要不要抓行情 | 不抓 | 行情/诊断走 `qieman` MCP；插件只做记账与确定性计算，结果可复现、可核对 |
| 数据存哪 | `$DSH_HOME/storages/portfolio/portfolio.json` | 纯 JSON、可读可备份；比 storage-domain 简单，升级路径清晰（见 host-api.md §4） |
| 工具粒度 | 一个 `portfolio` 工具 + `action` 参数 | 6 个强相关动作共用一套参数，模型不易选错；符合 DSH「一个操作两种调用者」的实践 |
| 要不要 Client 半 | v0.1 只做**只读**看板 | 面板走 `main` 槽 + `sidebar.panellist` 图标（DSH 自己的计划页就是这么注册的），数据走 Host 的 `GET /portfolio/api/summary` + 相对 `fetch`；只读所以不加写接口，避免在 Electron 的取数通道/信任围栏还没完全实证时暴露写操作 |

**已验证**（用应用内真实的 0.2.1-rc.3 运行时，不是模拟）

1. `node --check` 全过；`package.json`/locale JSON/`icon.svg`/`cordis.patch.yml` 解析全过。
2. `test/smoke.mjs` 通过：在真实 `@deepseek-ai/dsh-tools` 的 `defineTool` 下注册工具并驱动 10 组用例（权重合计 100%、集中度告警、目标偏离方向与金额、快照按日期去重、参数校验、文件结构）。过程中真的抓到一个 schema 错误（嵌套对象必须显式写 `additionalProperties: false`），已修。
3. 用从 app.asar 解出来的 0.2.1-rc.3 CLI，在隔离的 `DSH_HOME=/tmp` 里建了一个 web profile 并挂载本 bundle：`--dump-config` 输出第 1232–1236 行出现
   `- id: portfolio / name: '@local/dsh-plugin-portfolio' / config: { staleAfterDays: 7 }`，说明 bundle patch 与 profile 组合正确。
4. `test/client.mjs` 通过：在模拟的 `window.__ModuleLoader__` + React + `ctx.slots` 下，产物契约（`id` = 包名、懒加载工厂、只 require `react`）、`main` 与 `sidebar.panellist` 两个注册（key 与 id 一致）、两个组件可渲染。**外观未验证**——那需要装进应用里看一眼。

**已装在这台机器上（2026-10-28 15:09）**：`~/.dsh/profiles/desktop` 里已通过 `link:` 依赖 + profile patch 行热挂载，
Host 半已在运行中的 Electron 进程里激活（插件自写的 breadcrumb `${TMPDIR}/dsh-plugin-portfolio-activated.json`
记录 pid 28513 / electron-44.7.0 为证），改源码后推一次 patch 会热重载（实测 breadcrumb 时间随之更新）。
浏览器半随页面刷新加载（Client 模块图来自运行中的 Loader 条目，不依赖 bundles 列表）。

**两个实测教训**（已写进插件 README 与代码注释）：
1. 手改 `dsh.profile.bundles` 运行时**不会**生效（只被 Plugin Manager 或启动时读取）；而 patch 层被 HMR 监视，所以本地开发用 patch 行挂载。两种通道**只能选一种**，否则同一 row id 挂两次会让加载器报重复。
2. `link:` 进来的包，其裸 import 从**自己目录**解析，profile 的 `node_modules` 帮不上忙——所以 Host 半最终改成了**零依赖**（直接注册 registry 的原始 tool 定义，不用 `defineTool`/`schemastery`），这样不需要在 checkout 里装依赖，也不会被宿主版本漂移影响。

---

## 4. 接下来怎么长（建议路线）

- **v0.2 行情自动化（已完成）**：不再另起数据连接，而是在插件里按名字解析 profile 已配置的盈米 MCP 工具
  `mcp__qieman__BatchGetFundNavHistory` 并调用，把最新净值回写 `price`/`priceDate`。实测：隔离 web 运行时里
  `POST /portfolio/api/refresh` → 110011 从 4.0 更新到 3.9349、161725 从 0.6 到 0.5406（净值日 2026-10-27），
  且「未取到报价」为空。面板上多了「刷新净值」按钮；对话里是 `portfolio` 的 `refresh` 动作。
  每次刷新同时保留**今日净值与该品种前一交易日净值**，报告和面板都能看到「今日 / 前日 / 当日涨跌」；
  用截图里 7 只基金回验，重算出的当日盈亏与持仓页「日收益」列逐项一致（+53.36 / −198.76 / +41.51 / +49.94 / +34.33 / −33.25 / 0）。
  定时刷新与自动快照也已实现但**默认关闭**（`autoRefreshHours: 0` / `autoSnapshot: false`），
  打开后按小时刷新并在成功后记当天快照；调度用 `timer` 服务的可选注入，缺 timer 时插件照常加载。
- **v0.3 面板增强**：v0.1 已经有只读面板（`main` 整页 + 侧栏图标 + 只读路由 + 相对 fetch，和 `dsh-client-ui-schedule`、better-sidebar 同一模式）。下一步是把类别占比做成条形图/环形图（注意：图表库不在宿主的 baseline 模块表里，要么自己写 SVG，要么走构建打成 require.async chunk），并给面板加编辑能力（加写路由 + 同源/信任围栏）。
- **v0.4 决策层**：把「偏离 → 建议」从纯算术升级成规则引擎（再平衡阈值、单标的/单类别上限、最大回撤警戒），并让智能体把 `qieman` 的诊断/基金经理观点作为证据一起给结论。
- **v1.0 账本**：从「快照」升级为「交易流水 + 持仓推导」，支持多账户/多组合、真实成本（含分红/费用）。

---

## 5. 避坑清单（本次实测踩到的）

1. **别用 `dsh` 命令装/改 desktop profile**：版本不对（0.1.5 vs 0.2.1-rc.3）且被显式拒绝。
2. **别手写 profile 的 `package.json` / `cordis.patch.yml` 来装插件**：GUI 安装会替你处理依赖、锁文件、bundles 顺序与版本预检。
3. **版本预检会静默禁用**：只写 `engines.dsh`（或每个 `@deepseek-ai/dsh*` peer 都对得上），否则整行会被 detach 成 disabled，界面上不报错。
4. **profile 的 `cordis.patch.yml` 是一个 YAML 文档数组**：模板里已有 `[]` 时必须先把 `[]` 删掉再追加行，否则 `end of the stream or a document separator is expected`。
5. **`patchReload: live` 在 0.2.1 是死字段**：现在的重载是 `hmr` 行（+ `dsh-client-hmr` 管浏览器半）。
6. **Client 半的 `id` 必须等于包名**，组件里不要 `require('@deepseek-ai/dsh-client-ui-primitives')` 之类的宿主包（会崩 slot 且白屏），要抄样式就抄 CSS/主题变量 `--dsw-alias-*`。
7. **回滚**：Plugins 页 Off / Remove 即可；应用起不来时用启动窗口的禁用第三方插件按钮。

---

## 6. 参考资料索引

| 文件 | 内容 |
| --- | --- |
| `research/host-api.md` | Host 半：Cordis 插件形状、`defineTool` 完整契约、`ctx.webServer` 路由与信任围栏、storage-domain 持久化、批量清单与 patch 机制（837 行，全部带 file:line 证据） |
| `research/client-ui.md` | Client 半：`dsh.client` 契约、模块加载器、103 个 slot 目录、`main`+`panellist` 整页模式、无构建手写 client.js、样式与热更新（782 行） |
| `research/dev-loop.md` | 安装与迭代：GUI 安装链路、profile 改动面、HMR 规则、回滚/救援、版本预检（197 行，含跑批步骤） |
| `dsh-plugin-portfolio/README.md` | 插件本体的安装、用法、数据结构、开发与验证 |

排错时优先看 `~/.dsh/profiles/desktop/.plugin-manager/logs/<op>/pnpm.log`，以及应用日志里的 `[loader]` 行。
