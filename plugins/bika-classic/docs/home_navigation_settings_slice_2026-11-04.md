# 哔咔漫画：首页前置与五栏接线清单

2026-11-04。最新用户决定覆盖此前四栏方案：**首页、视频、游戏、我的、设置**。首页合并分类，搜索与热搜在顶部；设置保留完整功能及用户截图的分组图标方向，列表/图标呈现尚待再次确定。外观仍只有原版粉色/跟随全局。0.1.2既有三栏与下方热搜不是已验收目标。

本轮实际查看原目录的分类页、设置页截图，不复制图片或个人资料。下列几何是依据截图结构做的本批候选适配，不是从截图物理像素推导的全局标准。

## 本轮明确实施的首页切片

- 宿主 `BikaHomeContent`：热搜及真实排行榜/最近更新/随机快捷项移至分类之前，与source shell已有顶部搜索相邻，不在首页再加第二个搜索框。
- 分类从大卡改为紧凑的真实封面/薄主题边框/标题卡。常规320/390/440宽约3/4/5列；大字降低列数、标题最多两行。保留CoverWidget图片处理与隐私保护、TouchHoverIntent、真实action、原页重试与同一ScrollController。
- 插件 `src/home.ts` 的scheme同样将热词/快捷项放在分类前，保留现有两个GET、失败区分、健康缓存TTL、账号上下文校验及独立UUID；不新增HTTP、不改认证。
- 不修改个人页、全局theme/controlsStyle或旧Bika。人物素材及源内两项外观仍沿已接入的能力边界。

新增/加强宿主测试断言热搜/榜单先于分类、320/390/440宽及大字列数与真实动作；既有失败重试、scroll保留、浅深两样式和隔离ObjectBox继续保留。本轮仅运行离线源码Node测试及TypeScript检查，宿主SDK未运行。**未重建CJS/manifest、未升版本或更新模拟器；当前成品仍是原0.1.2，源码切片等待主代理统一构建/验收。**

## 五栏实际接线差距及最小改动建议

| 目标 | 当前真实路径 | 有界接线/待办 |
| --- | --- | --- |
| 首页 | metadata唯一home → SourceShellSection.function → IndexedStack → PluginFunctionContent → exact UUID/已声明能力的BikaHomeContent；shell AppBar有SearchQueryField | 本轮已改热搜位置/分类密度。顶部搜索仍走成熟SearchRoute/SearchResultRoute；不能声称安装包已更新 |
| 视频 | 两个breezeVideoModules → SourceShellSection.video → SourceVideoContent，播放器沿已有联动 | 继续使用已存在模块，不挪成游戏；源内外观/播放器边界由主代理负责 |
| 游戏 | 目标明确；当前无已证实的列表/详情完整HTTP调用合同 | 保留为未完成目标，不虚构getGames、endpoint或可用页。具体协议缺口见pending_protocol_contract_2026-11-03.md |
| 我的 | profileTab/profileKind与头像/简介/签到/收藏声明 → SourceProfileContent | 本轮不重排或套用新通用个人模板，不迁移历史/账号 |
| 设置 | 目前只有更多/个人设置动作 → 独立PluginSettingsPage；不存在持久设置section | 需要BK专属section模型/renderer；现PluginSettingsPage有独立SettingPageShell、账户/设置Cubit与执行保护，不能直接塞入IndexedStack造成双AppBar/错误返回。须先协调增加无独立chrome的可嵌入内容或专属设置目录；不能把点击tab后push页面冒充已完成持久tab |

若随后接入共享source_shell_page.dart，应限exact classic UUID与当前bikaExperience声明匹配：保留其它源原sections不变；BK增加专属设置section并渲染已协调的真实设置内容；首页/设置图标只在该分支映射，保留访问过tab的IndexedStack元素、返回与当前source状态。游戏只有真实可用合同后才接function，不能靠补一个空Tab凑五项。当前未修改该共享文件、section模型或PluginSettingsPage。

## 设置完整保留清单（不把未实现写成支持）

截图两组共13个入口。目标方向是保留任务和分组；具体呈现尚未重新确认，不擅自压成当前通用列表。现能力不等于已与该包逐项等价。

| 原截图任务 | 当前真实消费者/作用域 | 必须保留的差距与安全边界 |
| --- | --- | --- |
| 缓存管理 | StorageSettingPage→CacheSettingPage：Breeze全应用本机缓存 | 原入口是否含离线漫画未确认。不能冒称source独立缓存或把下载文件当临时缓存清掉 |
| 小電影 | 已声明视频模块→SourceVideoContent | 保留真实视频入口；现模块与2.5.85是否同合同仍未核实，不用站外新域名补齐 |
| 小里番 | 同上另一真实视频模块 | 同上；与游戏任务分开 |
| 意见反馈 | Breeze AboutPage有Breeze反馈；包内FeedbackPage仅静态线索 | 不能把Breeze问题渠道冒充站点反馈，未知目标不做假提交 |
| Q&A | 包内showQADialog线索；插件没有问答导出 | 待核真实内容/来源，不编站点规则、不当广告删除 |
| 语言设置 | AppearanceSettingPage语言：当前全局 | 进入时必须明确全应用范围，不偷加源内假开关或改语言策略 |
| 主题设置 | 源内ui.experienceStyle与全局ThemeMode是两维；original/follow已接入 | 源内选择与其他插件一致入口；不写全局seed/controlsStyle。具体布局待确认 |
| 图片渲染 | 有阅读显示/超分；core读image.quality但请求固定original，schema没有该项 | 不将图片渲染改名超分或新增无效画质开关。原包实际选项和生效合同未核实 |
| 启动密码 | AppBehaviorSettingPage应用锁：全应用本机 | 是应用保护而非站点改密；原包锁类型未核实，不读取/复制其密码 |
| 清除缓存 | CacheSettingPage受保护清理：本机全应用 | 继续确认范围、取消/忙碌/失败保护，不新增裸删；不可静默扩大到下载 |
| 检查更新 | 插件updateUrl为空；宿主/插件不同对象 | 不假报最新，不安装参考IPA；未知插件更新通道保持真实缺口 |
| 关于 | 当前有宿主AboutPage，插件metadata含独立版本/社区身份 | 不把宿主版本当插件版本，不声称原发布者发行；具体源内关于页待接 |
| 退出登录 | clearPluginSession及现宿主会话代际/写保护 | 仅当前UUID账号；保留本机历史/下载及其他插件，不能用裸删替代 |

现插件额外可用的账户简介/改密、首页/分类屏蔽、网络线路等设置也不能因恢复截图而丢失；应与上述任务分别归类，不把网络设置塞进图片渲染。表中全局能力只能作为明确标识范围的目的地候选，并非授权本轮改变作用域。未知Q&A/反馈/渲染功能仍须补真实合同，不能以13个同名按钮冒充完整实现。

## 本批后续已落源码：真实设置目的地

在主代理确认范围后，新增 `BikaSettingsContent`，不改共享PluginSettingsPage/content：

- `SourceShellSection.fromPluginInfo`仅对exact哔咔漫画UUID和完整bikaExperience v1声明匹配，追加宿主`settings`目的地；它没有fnPath、scene或虚构插件函数。当前实际为首页/视频/我的/设置，**游戏未接，五栏目标未完成**。
- 主壳负责唯一设置标题栏，保留IndexedStack同一元素和滚动；个人/更多的设置动作选择同一tab。源设置中需要登录的子任务由既有页面处理，不把整个设置tab替换成登录页。
- 设置body直接提供原版粉色/跟随全局的source级选择。只存该UUID `ui.experienceStyle`，默认不写；读取沿SourceExperienceScope，保存沿现PluginConfig bridge，失败可重试、连续选择单飞、不回写全局controlsStyle/Theme。两项选择不改变账号或网络策略。
- 电影/里番直接沿现metadata动作；缓存/清理、语言/全应用浅深主题、应用锁直接打开已有成熟目的地，标题明确标Breeze范围。当前插件关于弹窗显示本插件实际版本/描述，不拿Breeze版本冒充；账号/网络等字段通过明确的“哔咔漫画设置”到原受保护页面，不复制其执行逻辑。
- 对未核Q&A、站点反馈、原包图片渲染、更新合同不制造同名假按钮，也不转到未知网页。清单中的这些能力仍是未完成，不能因现设置tab可用而声明截图设置完整还原。
- 六项专属设置测试覆盖严格能力/源隔离、无嵌套标题/真实action、无默认写/同源偏好、保存失败重试/单飞、普通Navigator和AutoRoute进入真实AppearanceSettingPage后回同一设置实例。测试使用隔离ObjectBox与现registry初始化；SDK由主代理运行，本代理未执行。

这只是任务接线切片，不把当前分组列表提升成最终外观结论；用户截图的图标分组、个人特色、游戏及上述未实现功能仍按最新指示保留为后续目标。新本地化键由主代理统一加入并生成：`sourceShell.bikaOriginalStyle`（原版粉色/Original pink）、`sourceShell.followGlobalStyle`（跟随全局/Follow app style）。本代理不改locale/generated。

游戏本轮复核仍沿同一IPA证据：`PicaGame.getGameList/getGameDetails`、`games`/`games/`及下载/点赞方法名可定位，尚无可验证的HTTP调用、字段/分页/业务结果绑定。没有为导航补猜测请求、静态假列表或禁用游戏产品方案，也没有因此删除五栏目标。
