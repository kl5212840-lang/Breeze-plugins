# 独立社区适配首个实现

## 实施范围

新建 `plugins/bika-classic`，使用独立包名、UUID、清单、首页和生命周期。没有把现有插件整体拷贝后改名。共享漫画与账号适配在构建时编入独立 CJS：`NormalModuleReplacementPlugin` 仅对原 Bika 的 `src` 上下文替换 `./info`、`./bika-identity`。源码直接引用便于后续一起维护，成品没有跨安装调用。

原 Bika 仅将同一个 UUID 常量抽至 `bika-identity.ts`，`info.ts` 保留同名导出，视频也引用该常量。保留原 Bika UUID、功能和更新渠道；避免视频硬编码身份，以及直接 `info → video → info` 引入的模块初始化循环。

首页两个真实请求并行执行：既有 `comics/advanced-search` 最新排序与 `comics/leaderboard?tt=H24&ct=VC`。只显示各前 12 条，完整分区仍有可用跳转；不声称站点新增推荐算法。没有新增接口、域名、官方素材或轮询。搜索热词仍交给宿主搜索页，不在首页重复加入热搜条。

## 数据和生命周期边界

身份是新 UUID `97b8ebb1-9f1f-423c-9847-acd7b0ccd31f`，不加入任何别名或 `legacySources`。宿主的 `plugin_config_bridge.dart` 按真实 runtime 对应 source 分仓，Rust cache 使用 runtime-scoped key；保留标准配置键，兼容既有配置及备份协议。测试桥模拟这个隔离边界，不能替代真实数据库、移除或恢复测试。

新 `init` 只读取自身 `network.apiBase` 并设置自身缓存；不读取别的安装、登录、签到或设置定时器。重建 runtime 保留自己的线路和凭据；退出只清本插件会话，不清本插件其他偏好，也不动另一份安装。

一次性导入未实现，元信息明确 `recordImport: unavailable`。没有自动记录复制、账号复制、实时共用或下载文件重新关联。后续导入必须先预览、主动选择、明确冲突，取消不写，失败不改源插件，独立处理文件引用和删除保护。

## 宿主可选声明

以下都在 `breezeExperience` 中；没有声明的旧插件保持原行为，不通过 UUID 别名获得新能力。

| 字段 | 本插件值 | 消费位置和语义 |
| --- | --- | --- |
| `profileKind` | `bika` | `SourceShellSection.fromPluginInfo` 已传入；`source_profile_content.dart` 的 `_brandHero` 应按可选声明使用 Bika 资料布局，数据仍按真实 source 查询 |
| `videoBrowseOnly` | `true` | `source_shell_page.dart` 读取并传给 `SourceVideoContent`，最终传 `ApiVideoLibraryPage.browseOnly`；避免把本机视频记录重复放在浏览页 |
| `profileVideoRecords` | `true` | `source_shell_page.dart` 按声明把本插件视频模块传给个人页，收藏/历史/下载归属本插件 source |
| `profileCloudFavoriteFunction` | `getCloudFavoriteSceneBundle` | 已有协议，让个人页打开本插件实际账号的站点收藏 |
| `communityAdaptation` | 版本 1 声明 | 描述社区维护、独立记录/会话、导入不可用与官方基准待核验；旧宿主忽略，不新增失效按钮 |

修改前宿主仍有三处只认原 Bika UUID：`source_profile_content.dart` 的 `_brandHero`、`source_shell_page.dart` 的个人页视频模块传递、`source_video_content.dart` 的 `browseOnly`。本子任务未改这些宿主文件，由主任务统一接入；本文不是宿主修改已完成的证据。

排行场景额外声明 `scene.body.params.layout: bikaRanking`，且实际请求仍为 `getRankingData`。首页两处排行入口和 `getComicListSceneBundle` 使用同一份场景；主任务宿主按真实请求加可选布局声明选择专用排行，不以新旧插件共用身份获得布局。

其余身份消费者也已扫描：`comic_list_page.dart` 原本的专用排行布局只认原 Bika，由主任务按上述场景声明接入；`video_page_route.dart` 的原 Bika 详情 route 名属于有界合成试验，不自动向新插件推广。静态分流起始集仍只登记原 Bika，新插件可走现有已安装 CJS 扫描，不新增域名或静态源别名。商城 managed UUID 集合用于同身份覆盖，新独立 UUID 会正常作为独立项合并，无需加入覆盖名单。旧主页和数据库迁移的旧 ID 保留，不映射到新插件。

## 本轮验证

1. 新插件 TypeScript 检查通过；独立 CJS 构建通过，清单与实际 `getInfo()` 一致，成品不包含两种旧 Bika UUID。
2. 9 项真实 CJS 离线测试通过：元信息/无隐式导入；启动不读旧会话/不请求/不重试；新旧成品共存；登录/退出/设置隔离；runtime 重建；首页/分类任务结构与数量界限；视频目录/详情/播放身份及无漫画授权；详情/推荐/阅读/评论嵌套身份；未授权跳转身份与失败无后台重试。
3. 原 Bika 70 项 TypeScript 测试及 TypeScript 检查通过；重新构建原 CJS 后，对照原 UUID、显示名和视频详情回调仍属于「哔咔漫画+」。

网络和持久化使用合成 fixture，无用户账号、用户存储或真实请求。未运行 Flutter、Dart、Rust/原生构建、模拟器安装、iPad、云操作、发布上传。未验证整页视觉、手势、数据备份恢复或真实账号回读。

## 待办

- 主任务接入上述三项宿主声明，并验证独立记录筛选与真实入口。
- 固定可核对的官方版本基准，逐页记录实际差异；社区、消息、官方专属推荐和原版动画未移植。
- 头像和资料写入沿用现有适配，需要按真实账号完成回读验收。
- 主动一次性导入、下载引用/删除保护、卸载重装和备份恢复验证。
- 同一现有 iPhone 增量验证，两个界面风格、浅深主题与大字；通过后再决定交付渠道。

## 共享启动风险与后续同批修复

首次调查时，原 Bika `bika-settings.ts` 的 `init` 无条件启动 `runBikaAuthAndCheckInLoop`。旧循环仅在本插件有账号和密码时登录再签到；无凭据、账号代际变化、签到未确认或成功均返回。其他异常（含登录拒绝、普通网络错）会在 20–300 秒后继续，次数没有上限。`saveSettings` 不触发循环。

宿主 `qjs_download_runtime.dart` 用 `_runtimeInitDone` 与 `_runtimeInitialization` 按 runtime 去重，所以不能说每次打开页面都会再开循环；runtime 重建可能重新启动。JM 已有 running gate、revision、有限 transient retry 与 init gate，不能仅因函数名带 Loop 就认定同风险。其他视频源扫描中的循环是有界分页/缓存整理或 OmoFun 带超时取消的 pending 等待，未据此认定其后台无限重试。

主任务确认后，同批已将原 Bika 更新为 0.1.17：保留原自动登录/签到政策，只修复无界重试及旧会话写入穿越。共享无源标识 retry helper 沿用 JM 的三次总尝试与 1s/2s 退避，JM 保留等价包装/导出；Bika 的 HTTP 错误只保留脱敏消息及安全分类。单运行者、固定代际与等待全部并发写完成的会话队列保护登录、退出及密码更新。独立插件仍不在启动时自动认证，版本保持 0.1.0。详见原 Bika 的 [生命周期修复说明](../../bika/docs/auth_lifecycle_0.1.17_2026-11-03.md)。
