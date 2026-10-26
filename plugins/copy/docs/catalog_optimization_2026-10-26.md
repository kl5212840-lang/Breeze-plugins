# 拷贝 0.0.16：检索与目录保真

本轮不发布、不推送，不操作账号。保持原插件 UUID 和旧版 IPA 兼容的数据合同。

- 全新上架同时识别 `/update/newest` 的 `row.comic` 和 `/comics` 的扁平记录，防止兜底后显示空列表。
- 作者、作品别名、题材、更新时间和热度保留；热度用 `metadata.popularity`，不再伪装成点赞或浏览次数。缺失信息保持缺失，真实热度 0 与未知区分。列表和搜索不逐卡请求详情。
- 作者动作使用 `extern.authorActions = [{label, action}]`，由服务器返回的作者 slug 构造已有 `openComicList` 动作，无附加网络请求。
- 搜索仍使用源站支持的全部/标题/作者/汉化组范围；未知或跨源遗留的 `q_type` 回到默认范围。
- 完整题材由 `/theme/comic/count?limit=500&offset=0` 获取，按 API host 缓存 24 小时；网络/存储故障时用最后成功缓存或内置 72 项快照。请求有 3.5 秒超时且不自动重试。修复 C 系列、TL、AA 等旧题材 value，包含 C106/C107/C108 的真实 slug。
- 实证 mobile `/comics` 忽略独立 `region/status` 参数，因此没有呈现无效的地区/状态组合。仅暴露已验证的 `theme + top + ordering`；`top` 作为“范围”单选，可选日本/韩漫/美漫/完结，不伪装成两个可叠加维度。
- 章节按实际 total/limit/offset 取全，保留每组服务器顺序；所需后续页失败、重复、位置不匹配或总数变化均明确失败，不缓存残缺目录。目录缓存升级 v2，避免沿用旧版截断于 500 话的缓存；图片和阅读进度标识不变。

公开 GET 验证证据位于宿主工程 `build/comic_plugin_audit_20261026/copy-filter-capability-evidence.json`；字段存在证据见同目录 `copy-public-field-inventory.json`。只记录分类元数据与字段/状态，不保存账号内容。

观察到搜索结果缺少状态、最新章、更新时间和题材，这些不从详情逐卡补齐。发现列表有题材/更新时间；详情单页才有简介、状态、地区、最新章等。API 抽样不是对所有镜像线路的全面验收。

验证：`pnpm test`、`pnpm typecheck`、定向 `oxlint` 与 `pnpm build`。构建输出 `dist/breeze-plugin-copy-comic.bundle.cjs` 和同名 `.br`。
