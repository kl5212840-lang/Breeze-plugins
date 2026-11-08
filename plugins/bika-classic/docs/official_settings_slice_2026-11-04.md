# 官方设置有界接入：Q&A 与联系

版本仍为 0.1.4。仅基于用户指定 PicACG 2.5.85 unsigned IPA，保留五栏与既定粉色/跟随全局样式。此记录不是完整原版功能验收。

## 本批已实现

- `src/official-help.ts` 导出纯本地 `getOfficialHelpBundle`，元数据以 `bikaExperience.officialHelpFunction` 可选声明。函数无 HTTP、配置读取或写入。
- 原生宿主 `bika_official_help.dart` 显示有界 Q&A 子集及官方联系；设置入口仅在精确 BK UUID、声明 version 1 与函数名一致时显示。没有嵌网页替代原生帮助。
- 官方公告 `https://t.me/PicACG`、官网 `https://picacomic.com`，仅在点按后外部打开；邮箱 `picapicacomic@gmail.com` 可显式写邮件或复制。邮件只传地址，无正文/账号/设备信息；打开失败保留地址与复制操作。
- 宿主拒绝未知数据版本、错误 source、重复身份、超长/过量内容、不安全协议、含凭据/查询参数的链接和邮件换行。失败可重试；未发布任何新通用插件动作。

## 原包证据

本机 `Breeze/build/bika-official-reference-20261103/aot-call-analysis/settings-contract-followup-20261104.md` 及相邻注释反汇编：

- `showQADialog` VM `0x34bbf0..0x34c7b8` 构造本地帮助 Map/list。
- pool `0x22518..0x22540` 对应官方信息、公告、官网、邮箱。
- `0x22548..0x22550` 邮件联系与 Telegram 公告；`0x22568..0x22580` 免费与假冒付费提醒；`0x22588..0x22590` 加载问题；`0x225b8..0x225f0` 交流规则。
- 接入的是这些已确认内容的精简转述与原始联系地址，不声称完整复刻所有 FAQ。地址来源确证不等于当前网络可用性实测。

## 本批明确未完成

反馈提交：`HttpPicaV2Utils.report` VM `0x395b2c` 是 `getHost('recommend') + '/report/'`，以 queryParameters 发送 GET；额外诊断 map、环境主机及隐私/提交 UI 合同尚不完整。邮箱联系不冒充该反馈接口。

图片渲染已继续接入宿主：原版 `filterQuality` 四档 none/low/medium/high、默认 medium，写本地 SharedPreferences；Breeze 以该独立插件的 `ui.imageFilterQuality` 保存，只作用已声明的 BK。独立设置页保存后回读，再反馈成功；CoverWidget 的 DecorationImage 与 ReadImageWidget → ImageDisplay 的 Image.file 已使用真实采样值。粉色/跟随全局均生效；源壳外封面及阅读器按自身 source 使用共享、按需释放的只读 watcher，不借用其他来源的 scope。非 BK 保持当前锁定 Flutter 的原缺省 medium。该选项不改 URL、原图字节、缓存身份或服务器 `image.quality`。本轮未运行 SDK，新增真实组件值与源隔离 fixture 待主代理执行；不据此宣称设备画质或性能已验。

注册：`_registerPageState._register` VM `0x33644c` 的 11 字段构造及 `auth/register` POST 已恢复，但全部校验、gender 允许值和条款链尚未完成。BK 没有暴露 `register` 或 `registerUrl`，不以外部网页替代。

找回：原版登录回调 VM `0x3585cc` → builder `0x358630` → `featureUnavailable`，并非找回 HTTP 合同。BK 没有暴露 `forgotPassword`；已登录改密不作为找回替代。

## 验证

- `node --experimental-transform-types --test plugins/bika-classic/tests/source-slice.test.cjs`：29/29。
- `node ../bika/node_modules/typescript/bin/tsc --project tsconfig.json --noEmit`：exit 0。
- Fixture 断言帮助函数可在全部 bridge/config 调用被禁止时返回；不读取账号、不网络请求；原版三个联系地址完全匹配。
- 新宿主测试覆盖原生内容、显式打开/复制、失败恢复、无正文邮件、错误声明不调用插件；本轮按限制未运行 SDK。
- 图片渲染新增 `test/source_shell/bika_image_rendering_test.dart`，检查真实 DecorationImage/Image.file、源壳内外及另源隔离、两种样式、provider/状态身份保持和保存回读；同样未运行 SDK。阅读器主路由当前不带 SourceExperienceBoundary，采样消费者自身按 PictureInfo.from 解析，不依赖根路由继承。
- 无设备、真实账号/反馈写入、清理、CJS 构建或版本增加。宿主 locale 与统一 codegen 由主代理集成。
