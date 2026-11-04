# Freedom · 投资组合插件 + 投资文档

本仓库（**private**）维护两部分内容：

1. **dsh-plugin-portfolio**：给 DeepSeek Harness（DSH）桌面版用的投资组合插件——Host 半注册 `portfolio`
   工具与只读 HTTP 路由，Client 半提供浏览器看板（配置 / 持仓 / 执行 / 任务 / 模型）；
2. **投资文档与研究笔记**：建仓计划、估值模型确认书、组合 Review、决策纪要、宏观分析、DSH 插件开发笔记。

> 持仓数据本身（`$DSH_HOME/storages/portfolio/portfolio.json`）与 qieman 凭据仍只在本机，不提交。

## 目录

```
dsh-plugin-portfolio/     # 插件本体（bundle）
  index.js                # Host 半：portfolio 工具 + GET/POST 路由
  client.js               # Client 半：手写浏览器 bundle（无需构建）
  lib/                    # store / analysis / valuation / quotes
  locale/ icon.svg        # Plugins 页面的标题与图标
  cordis.patch.yml        # bundle patch（一行 insert）
  test/                   # smoke / valuation / quotes / client 冒烟测试
  README.md               # 安装、用法、配置、开发、验证

# 投资文档
PLAN.md                           # 插件开发总说明（从 0 到 1）
估值模型确认书.md                  # 估值口径、阈值、缺陷与验证计划
建仓计划-方案D.md                  # 建仓规则 v3 → v5/v6 → v7 → v7.1（当前）
操作手册-估值驱动.md               # 钱袋子 + 估值信号的执行流程
组合Review-2026-10-29-第二轮.md
组合Review-2026-10-29-第三轮.md
组合模型Review-2026-10-29.md
组合Review-2026-11-03.md
决策纪要-2026-11-04.md             # 已定事项 / 待拍板 / 参数速查 / 时间表
宏观周期分析-2026-11-03.md          # 全球与中国经济周期定位

# 研究笔记
research/china-macro.md           # 国内宏观底稿（69 条来源）
research/global-macro.md          # 海外宏观底稿（60+ 条来源）
research/market-cycle.md          # 大类资产与周期指标底稿（41 条来源）
research/host-api.md              # DSH 插件 Host 半 API 笔记
research/client-ui.md             # DSH 插件 Client 半与 slot 目录
research/dev-loop.md              # 插件安装与迭代开发流程
```

## 功能概览（插件）

- **工具**：`portfolio`（`report / check / rebalance / transfer / refresh / upsert / remove / targets / snapshot / history`）；
- **看板**：总市值、成本、浮盈亏、类别占比、持仓明细、目标偏离与再平衡金额、数据新鲜度；
  自动任务（每日估值体检、每周节奏分析）、执行记录；
- **模型页**：估值规则（温度 / 位置 / 黄金 / 债券 / 现金）+ **组合目标（v7.1）** + **回测与压力测试**；
- **行情**：复用 profile 已配置的 `qieman` MCP（`BatchGetFundNavHistory`），不另开数据源。

## 快速开始

见 [dsh-plugin-portfolio/README.md](dsh-plugin-portfolio/README.md)。一句话版本：

1. DSH 桌面版 → Plugins → Add plugin → Install a third-party plugin → 填本仓库 `dsh-plugin-portfolio/` 的本地绝对路径；
2. 或在 profile 的 `cordis.patch.yml` 里加一行 `- insert: [{ id: portfolio, name: '@local/dsh-plugin-portfolio' }]` 热挂载。

## 版本

- **v7.1（2026-11-04）**：目标权重（红利 28 / A股其他 13 / 海外 10 / 黄金 5 / 债券 39 / 现金 5，红利随温度 24–30% 调节）、
  模型页新增组合目标与回测/压力测试、C 类换 A 类（162412）、"重新读取"反馈与数据时间戳。
- **v7（2026-11-04）**：回撤预算放宽到 −20%，提高权益与红利、压降债券。
- **v6（2026-10-29）**：红利按温度在区间内自动调节。

## 许可

暂无 LICENSE 文件；如需开源请补充。
