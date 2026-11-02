# 两个源扩展的处理逻辑与功能清单

本文记录 WordFind 关键词雷达 v1.1.0 的两个来源扩展：TrendsBar 与 Trends Radar，以及它们的处理逻辑、功能全集、重叠项和合并规则。

## 0. 结论摘要

- 你最初给出的链接是 **TrendsBar**（第二个扩展）。
- 第一个扩展根据本机 Chrome 已安装列表判定为 **Trends Radar**（同为 Google Trends 关键词分析工具，且功能与 TrendsBar 大量重叠）。
- 两者都保留其独有能力：TrendsBar 的翻译、相关词、页面状态标记、右键菜单；Trends Radar 的自动挖词、词根列表、批量打开上限、外部查询。
- 合并版以统一的关键词组、统一词库、单一注入管线和单一 URL 生成函数重构，不复用原扩展代码。

## 1. 选中依据与获取方式

| 项目 | TrendsBar | Trends Radar |
| --- | --- | --- |
| Chrome 扩展 ID | `djimlibchepimambphhbhhjegmanioch` | `jcbophednbmljagjnjakebggflbfialp` |
| 版本 | 0.5.1 | 1.0.9 |
| 形态 | Plasmo + React 打包，侧边栏 + 内容脚本 | webpack + React 18 + Radix，侧边栏 + 内容脚本 + 后台爬虫 |
| 主要权限 | `storage`、`sidePanel`、`contextMenus`；主机权限 `https://*/*` | `storage`、`sidePanel`、`webRequest`、`activeTab`；主机权限 `trends.google.com` |
| 目标页面 | `trends.google.com` | `trends.google.com` |
| 获取方式 | Chrome Web Store CRX 下载，剥掉 CRX3 头后解包 | 从本机 Chrome 已安装目录复制；发布包内嵌 sourcemap，仅用于理解行为 |

选中逻辑：

1. 两者都做 Google Trends 关键词分析与对比，属于同一赛道。
2. 两者都有侧边栏、关键词列表、收藏/历史、页面注入，重复度高，适合合并。
3. 两者的独有能力互补：TrendsBar 偏“人工分析与辅助”，Trends Radar 偏“自动扩展与批量执行”。
4. 合并目标不是简单拼代码，而是把同一件事收敛成一套数据模型和一套执行链路。

## 2. TrendsBar

### 2.1 架构

- MV3，Plasmo 打包，侧边栏为 React 单页，内容脚本注入 `trends.google.com`。
- 存储键：`options`（关键词组、时间、地区、链接组）、`helper`（分析助手配置）、`history`、`favorite`、`listen-keyword`。
- 后台负责：右键菜单、打开侧边栏、翻译请求代理、外部关键词评分请求代理。
- 没有自动爬虫，没有 `webRequest` 拦截。

### 2.2 处理逻辑

1. **输入与保存**：侧边栏维护多个关键词组（每行一组，最多 5 个，逗号分隔），以及一组“链接组”用于批量查看。
2. **URL 生成**：`genTrendsUrl(keywords, geo, dateRange)` 拼出 `trends.google.com/trends/explore?date=...&q=...&geo=...`。
3. **批量打开**：按 `size` / `index` 分页打开链接组；支持“打开从第 N 条开始的 M 条”。
4. **对比**：把收藏/词根关键词与当前关键词拼接后打开 Trends。
5. **分析助手**：内置 Google、Time、Geo、Bing、Domains、Ahrefs 等外部分析入口，用 `{keyword}` 模板替换。
6. **翻译**：后台代理 `translate.googleapis.com`，在页面注入的标签与侧边栏翻译中使用。
7. **关键词评分**：请求外部 `s.trendsbar.net/?k=...&v=...`，属于第三方服务。
8. **页面注入**：
   - `/trends/explore`：关键词行加复制/对比/分析；搜索框加 X/G/Q/引号；相关查询加“分析”按钮。
   - `/trending`、`/explore`：表格行加复制/对比/分析。
   - 状态标记：历史、收藏、词根。
9. **右键菜单**：分析选中词（送入侧边栏）、与当前关键词一起对比。
10. **存储模型**：历史、收藏、词根是三套独立列表，彼此不共享记录。

### 2.3 功能清单

- 关键词输入：多行、每组最多 5 个、逗号分隔。
- 时间范围：过去 24 小时 / 7 天 / 30 天 / 90 天 / 12 个月 / 自定义。
- 地理范围：全球、美国、英国、德国、日本、韩国。
- 批量查看与分页打开链接。
- 对比关键词与固定分析助手链接。
- 关键词翻译、目标语言设置、页面自动翻译。
- 相关查询分析入口。
- 关键词评分（外部服务，beta）与高分阈值。
- 历史 / 收藏 / 词根三套列表。
- 去重、排序、整理（链接组）。
- 页面注入：复制、对比、分析、加/去引号、删除、Google 搜索、词库状态图标。
- 右键菜单：分析选中词、与当前词对比。
- 中英双语（en / zh_CN）。

## 3. Trends Radar

### 3.1 架构

- MV3，webpack + React 18 + Radix UI + Tailwind，侧边栏为单页应用。
- 后台 Service Worker 持有挖词状态；侧边栏通过 `chrome.runtime.connect({name:'analysis-connection'})` 建立长连接，5 秒一次 ping/pong 心跳。
- 存储键：`customKeywords`、`commonKeywords`、`historyKeywords`、`roots`、`lastUsed`、`rootLastUsed`、`autoRootKeywords`、`lastSettings`、`languageSettings`、`analysisState`。
- 内容脚本只做页面悬浮按钮，不参与挖词数据采集。

### 3.2 自动挖词主链路

1. 侧边栏收集种子关键词、对比基准词、地区、时间范围、最大词数、阈值。
2. 通过 Port 发送 `START_CAPTURE`，后台重置计数、队列与根词列表。
3. 后台从种子队列取最多 4 个，加上 1 个基准词，组成最多 5 个词的 Trends URL。
4. `chrome.tabs.update` 把当前活动标签页导航到该 URL（原版会占用当前标签页）。
5. `chrome.webRequest.onCompleted` 监听 `trends.google.com/trends/api/*`。
6. 命中两类接口：
   - `widgetdata/relatedsearches`：相关搜索；只接受 `keywordType=QUERY`，并排除基准词的 `BROAD` 请求。
   - `widgetdata/multiline`：时间线数据。
7. 后台再次 `fetch` 同一 URL，读取响应文本，去掉 `)]}'` 前缀后 `JSON.parse`。
8. 当“相关搜索响应数 = 本批关键词数”且“时间线已到”时处理本批：
   - 从时间线判断有效新词：前两个点为 0、最后三个点不下降、末点相对基准词末点达到阈值百分比。
   - 从相关搜索提取新词：优先 `rankedList[1]`（rising），为空则 `rankedList[0]`（top）。
   - 过滤：长度 >100、含英文逗号、超过 6 个单词、已在根词/相关词中的词。
   - 新词加入种子队列，最多到“最大词数”。
9. 每批之间随机等待 4–6 秒；失败按指数退避重试，最多 10 次。
10. 达到最大词数或队列耗尽后结束；支持暂停（保存 `analysisState`）、继续、停止。

### 3.3 其他页签逻辑

- **Batch Analysis**：自定义 / 收藏 / 历史三套列表；每开一批标签页，从列表取 `5 - 对比词数` 个关键词；记录“上次使用”并从收藏列表继续向后翻页。
- **Root Analysis**：内置 50 个英文后缀词根（Translator、Processor、Designer…），可编辑；按 `maxTabs` 批量打开，并记录已用位置，支持重置位置。
- **Settings**：仅语言切换（English / 中文）。

### 3.4 功能清单

- 关键词管理：自定义、收藏、历史三套列表，支持添加、删除、收藏、复制、搜索、打开 Trends。
- 关键词预处理：连字符/下划线转空格、去掉 `.html`、换行转分号。
- 地区、时间范围、最大标签页数、对比基准词。
- 对比词预设：empty、good morning images（130k）、happy birthday image（50k）、baby shower（25k）等 11 个。
- 批量打开 Trends，支持从上次位置继续。
- 英文词根列表与批量打开、位置重置。
- 自动挖词：种子导入、最大词数、阈值、暂停/继续/停止、进度、有效新词列表。
- 逐词外部动作：复制、Google 搜索、Twitter、Reddit、Ahrefs 难度、namebeta 域名、打开 Trends、收藏。
- 页面注入：搜索框悬浮按钮（复制/收藏/Google/难度/域名）、趋势关键词悬浮按钮（复制/对比）。
- 中英双语。

## 4. 重叠与差异矩阵

| 能力 | TrendsBar | Trends Radar | 合并后 |
| --- | --- | --- | --- |
| 侧边栏 | 有 | 有 | 一个四页签侧边栏 |
| 关键词列表 | 关键词组 + 链接组 | 自定义/收藏/历史/词根多套 | 统一关键词组 + 统一词库 |
| 时间/地区 | 有 | 有 | 共享设置 |
| 批量打开 | 分页打开链接 | 按最大标签数分批 | 分析全部 + 最大打开组数 |
| 对比词 | 收藏/词根拼接 | 固定基准词 + 预设 | 手动组拼接 + 挖词基准词 |
| 收藏/历史/词根 | 三套独立存储 | 多套独立存储 | 一条词库记录 + 三个标记 |
| 页面注入 | 复制/对比/分析/引号/删除/搜索/状态 | 复制/收藏/搜索/难度/域名/对比 | 一套注入管线 + 收藏按钮 |
| 翻译 | 有 | 无 | 保留 |
| 相关词 | 页面按钮 + 外部分析入口 | Trends 相关搜索 | Suggest 面板 + 挖词 |
| 关键词评分 | 外部服务 | 无 | 移除，改为可验证统计 |
| 自动挖词 | 无 | 有 | 新增「挖词」页签 |
| 英文词根列表 | 无 | 有 | 可一键导入词库 |
| 外部查询 | 分析助手链接 | 五个逐词图标 | 词库「查」面板 |
| 最大标签数 | 无 | 有 | 设置项 |
| 右键菜单 | 有 | 无 | 保留 |
| 导入/导出 | 无 | 无 | 新增 JSON/CSV |

## 5. 合并处理逻辑

### 5.1 六条规则

1. **先归一再合并**：所有关键词都归一到“词组（group）”和“词库记录（library record）”两层。历史、收藏、词根不再各自维护列表。
2. **一个动作只有一个实现**：打开 Trends、复制链接、拼接参数全部走同一个 `buildTrendsUrl`；页面注入只走 `ensureTools` / `ensureBadges`。
3. **重复的 UI 收敛**：多套关键词列表、多个批量打开入口、多组逐词图标，分别收敛为词库、批量分析、查面板。
4. **独有能力不丢**：挖词、词根、外部查询、最大标签数、翻译、右键菜单都保留，但放到统一模型下的对应位置。
5. **移除不可验证能力**：TrendsBar 的第三方评分服务不进入合并版；相关词改为 Google Suggest + Trends 相关搜索两条可解释路径。
6. **独立重写**：只用原扩展的可见行为与接口格式作为需求，不复制打包代码；所有实现为本项目原生 JS。

### 5.2 功能落位

| 来源能力 | 合并后位置 |
| --- | --- |
| TrendsBar 关键词组 + 链接组 | 关键词工作台（每行一组，最多 5 个） |
| TrendsBar 时间/地区 | 工作台 + 挖词页共享设置 |
| TrendsBar 翻译 | 每组卡片的“翻译” |
| TrendsBar 页面注入 | `content.js` 统一注入管线 |
| TrendsBar 历史/收藏/词根 | 词库 + 收藏/词根标记 |
| TrendsBar 右键菜单 | `background.js` 右键菜单 |
| Radar 自动挖词 | “挖词”页签 + `radar.js` + 后台爬虫 |
| Radar 自定义/收藏/历史 | 统一词库 |
| Radar 词根列表 | 词库“导入内置词根” + 挖词种子 |
| Radar 最大标签页 | 设置“批量分析最多打开” |
| Radar 对比词预设 | 挖词页“对比基准词” datalist |
| Radar 外部逐词动作 | 词库每行“查”面板 |
| Radar 关键词预处理 | 工作台“整理” |
| Radar 页面收藏按钮 | 注入工具栏“收藏” |

### 5.3 合并后的数据与消息

存储键：

- `settings`：时间、地区、打开方式、最大组数、注入开关、翻译、挖词默认参数。
- `input`：关键词组文本。
- `library`：统一词库记录 `{keyword, favorite, root, count, firstSeen, lastUsed}`。
- `radar`：挖词状态、进度、相关词、有效新词、当前批次、标签页 ID。
- `radarSeeds`：种子关键词文本。
- `pending`：右键/页面送入侧边栏的待处理关键词。

消息：

- `wf:open-panel`、`wf:translate`、`wf:suggest`、`wf:favorite`
- `wf:radar-start`、`wf:radar-pause`、`wf:radar-resume`、`wf:radar-stop`

### 5.4 明确替代/移除

- TrendsBar 的 `s.trendsbar.net` 评分服务：移除。
- Trends Radar “占用当前标签页”的挖词方式：改为独立后台标签页。
- 两边的语言切换：合并版固定中文界面。
- 两边的多套列表与多套页面按钮：合并为单套。

## 6. 合并后 v1.1.0 功能清单

- 关键词工作台：多行分组、去重/排序/整理、时间/地区、分析全部、复制全部链接、逐组打开/复制/引号/翻译/相关词/收藏/删除。
- 词库：统一记录、搜索/筛选/排序、逐条加入输入框/对比/复制/查/收藏/词根/删除、批量加入/批量分析/收藏/取消收藏/词根/删除、JSON/CSV 导入导出、内置词根导入。
- 挖词：种子导入、最大词数、阈值、基准词、暂停/继续/停止、进度与倒计时、有效新词复制/入输入框/入词库。
- 页面注入：复制、对比、分析、收藏、引号、删除、词库标记、相关词分析按钮。
- 右键菜单：分析选中词、与对比组一起打开。
- 设置：打开方式、最大组数、Trends 语言、注入开关、翻译语言与自动复制、挖词默认参数、数据导入导出与恢复默认。

## 7. 验证与边界

已验证：

- 20 项共享逻辑与挖词算法测试。
- 4 项后台编排测试：启动 → 拦截接口 → 有效新词 → 完成；停止；相关响应不齐时的宽限期；收藏写入与大小写去重。
- 侧边栏四个页签在 400px 宽度下渲染检查。
- Trends 注入脚本在模拟 DOM 中验证按钮、收藏消息、状态标记、相关词按钮。

未验证/需真机确认：

- 真实 Google Trends 在线挖词。本机 headless Chrome 无法加载扩展，后台链路是用模拟接口验证的；装到真实 Chrome 后建议先用少量种子试跑。
- Google Trends 页面结构与内部接口变更风险。
- 连续访问触发 Google 限流的风险。

## 8. 相关文件

- `background.js`：菜单、侧边栏、翻译/相关词代理、挖词爬虫、收藏写入。
- `radar.js`：相关词解析、有效新词判定等纯算法。
- `sidepanel.js`：工作台、词库、挖词、设置四页逻辑。
- `content.js`：Trends 页面注入。
- `shared.js`：关键词解析、词根、预设、URL 生成。
- `tools/smoke-test.cjs`、`tools/background-test.cjs`：本地测试。
