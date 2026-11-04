# Freedom · DeepSeek Harness 投资组合插件

本仓库维护 **dsh-plugin-portfolio**：一个给 DeepSeek Harness（DSH）桌面版用的投资组合插件——
Host 半注册 `portfolio` 工具与只读 HTTP 路由，Client 半提供浏览器看板（配置 / 持仓 / 执行 / 任务 / 模型）。

> 本仓库只包含插件代码与文档。**个人财务数据（持仓、建仓计划、组合 Review、研究笔记）不在本仓库**，
> 数据保存在本机 `$DSH_HOME/storages/portfolio/portfolio.json`，不随代码提交。

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
```

## 功能概览

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

## 许可

暂无 LICENSE 文件；如需开源请补充。
