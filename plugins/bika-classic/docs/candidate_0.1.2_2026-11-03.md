# 哔咔漫画 0.1.2 本地候选

基准：用户指定 PicACG iOS 2.5.85 unsigned IPA 与同目录截图；用户后续确认首页合并分类，外观只保留“原版粉色 / 跟随全局”，成熟搜索、筛选与视频体验沿用 Breeze。名称使用“哔咔漫画”，社区适配身份仍在 metadata 中明确，不声称原发布者认证。

## 本批实际变化

- 同一独立 UUID `97b8ebb1-9f1f-423c-9847-acd7b0ccd31f`，版本 0.1.2。没有旧源别名、凭据/记录复制或后台自动登录签到。
- 元数据只公开一个首页 function，撤掉重复分类 tab。首页只请求已有 `GET categories`、`GET keywords`，不为了预览请求最新或排行榜；榜单、最近更新、随机入口继续使用已存在的搜索/榜单合同。
- 分类与热词各自验证业务 envelope，区分成功空数组/失败；一个失败保留另一个。只在同账号、线路、屏蔽条件下保留成功内容；已知401走既有认证失效合同，不等待另一慢请求，但所有在途请求都有 rejection observer。
- 无效业务响应只按捕获的实际缓存键及 CAS 失效。健康缓存保持已有10分钟，不清全站缓存、不自动补偿重试。内部 __bika* 参数不进入 HTTP headers/body。
- 源内 `ui.experienceStyle` select 只有 original/follow；默认只读 original，不写 config 修订。无 fnPath，走现有宿主同 UUID 保存链；读回 data.values。退出保留源内外观，旧Bika不出现该字段。
- 专属宿主首页 `BikaHomeContent` 展示真实分类封面（沿现 CoverWidget 的图片缓存/隐私保护）、热词、快捷入口。失败提示直接调用当前首页 controller，避免叠加新首页路由；刷新期间保留原 ListView/ScrollController 和成功内容。致命错误清除已保留内容；按钮按压/被动hover沿TouchHoverIntent。
- 只在 canonical classic UUID、当前能力 scope.enabled 且 functionId=home 时消费专属展示；无声明、旧Bika和其他插件仍使用原 renderer。人物加载及所有源内主题/播放器边界由主代理接入。

## 已有功能闭环与验收入口

1. 导入本目录 dist CJS，打开“哔咔漫画”：唯一首页展示分类、热词、榜单/最近更新/随机，不另有分类tab。
2. 分类卡/热词进入真实搜索结果，筛选和详情沿现成熟入口；返回保留首页任务位置。排行榜使用 getRankingData 与 bikaRanking 布局。
3. “我的”→登录使用成熟 `auth/sign-in` JSON email/password；账号资料、站点收藏、手动签到、头像/简介/密码沿现已实现的原生协议和入口。对拒绝/认证失效没有新增后台重试。
4. 列表设置→界面→原版粉色/跟随全局：默认不写偏好；切换后返回不丢首页位置；全局/旧Bika/JM不变。更换全局system/breeze时follow实时反映，由宿主scope tests及设备验收确认。
5. 视频tab包含电影/里番现有模块；漫画授权不得进入视频 HTTP 请求。视频详情/播放使用同一classic source；SDK与实际播放由主代理验收。
6. 部分/全部首页加载失败时提示可点，就地重试而不增加路由；成功区域保留；认证失效进入既有登录流程。Node模拟响应仅证明客户端状态行为，不证明真实站点或代理故障。

## 明确未完成

批准目标仍为首页/视频/游戏/我的四标签；**本候选只有可用的首页/视频/我的，四标签未达标**。没有用不可点击或伪返回的游戏页充数，也未将完整规划改成三标签。

- 游戏：现共享Bika全部导出中无 getGames/原生游戏模型。IPA保存的白名单静态证据有 GamePage/GameDetailsPage/PicaGame 和 games、games/；不足以确认列表/详情方法、分页、字段、鉴权与下载合同。既有分类里游戏网页 artwork/link 不是原生API证据，不能将它替代批准的游戏功能。
- 注册：IPA有 auth/register 与表单字段字面，但没有可验证的绑定/必填规则/日期编码/方法及成功反馈。当前核心只原生实现登录，没有注册导出。
- 找回：有忘记密码UI线索，没有本轮已确认的完整公开请求路径/字段。没有伪造接口或把点击自动送未知网页。
- “我的评论”、截图中的细分游戏/屏蔽能力及非必要低频设置仍按参考文档缺口；没有声明完整官方App功能已复刻。一次性资料导入未实现。

上述差距需要真实客户端合同补齐，不应靠猜接口或额外真实账号请求赶验收。本轮没有操作用户账号、云端、设备或SDK。

## 离线验证证据

从插件仓库执行：

```sh
node plugins/bika-classic/build/build.mjs
node --experimental-transform-types --test plugins/bika-classic/tests/*.test.cjs
node plugins/bika/node_modules/typescript/bin/tsc --project plugins/bika-classic/tsconfig.json --noEmit
```

2026-11-03本轮：29/29 Node通过，TypeScript noEmit退出0。15项真实TS模块检查，14项读取真实CJS的合成桥测试，覆盖两成品并存、全部嵌套source、无默认写、手动登录/profile JSON协议、分类/热词→搜索/榜单、失败保留与明确重试、健康TTL、缓存CAS及授权变更迟到。只读当前成品，不访问真实网络/账号/本机用户资料。

宿主新增8项 `test/source_shell/bika_home_content_test.dart`，覆盖真实动作payload、重复重试gate/不导航、保留scroller与位置、致命失败不留旧内容、system/breeze×浅深×320窄屏大字。**本代理未运行SDK，等待主代理串行验证；不能据Node结果声称宿主/实机通过。**

成品：

- CJS SHA256 `61e478fd7f07280fbca7591ba40a0924b936121c2398886f6de82abad89da6c0`
- manifest SHA256 `74cacd94a05dfbe8af76cdb25326b842fb86964c8c9ffb3d2f1e7740bf623e97`

仅本机构建，没有发布、上传或更新旧Bika。
