# 哔咔漫画：指定 iOS 2.5.85 的游戏调用恢复与只读接入

2026-11-04。本记录补足[此前协议待办](pending_protocol_contract_2026-11-03.md)中的游戏方法、路径及响应绑定，纠正找回密码的方法名判断。唯一体验基准仍是用户指定的 `PicACG-v2.5.85-unsigned.ipa` 与同目录截图；没有使用已撤回的Android参考，也没有执行IPA。

## 证据取得方式与边界

只从原IPA读取 `Payload/Runner.app/Frameworks/App.framework/App`，临时展开一个App Mach-O供本机反汇编，原iCloud文件不变。App SHA256为 `8b32784a9d8489888582d743cfba16d4cce3b1ad401afd35c00f0b0a13a0cf3a`。文件是单arm64 FAT Mach-O，slice file offset为 `0x4000`，`cryptid=0`；仅有4个Dart快照导出，没有业务方法符号。

根据快照头 `78da37fed6bf1489361a312568249f3f`、`arm64 ios no-compressed-pointers`，参照 [Dart 3.11.5 序列化实现](https://github.com/dart-lang/sdk/blob/3.11.5/runtime/vm/app_snapshot.cc)及 [r2flutter解析器](https://github.com/radareorg/r2flutter)，用Python只读恢复对象分配表、函数/类引用、指令表及对象池。解析检查863个cluster、159364个对象引用、26611条指令记录、33861个对象池项的一致性。函数的名称、owner、code index、指令入口与实际ARM64调用相互核对；不是依靠字符串相邻或把字符串偏移当函数地址。

本机证据在 `Breeze/build/bika-official-reference-20261103/aot-call-analysis/`：`selected-call-evidence.json`记App及有界反汇编文件摘要，`inspect_snapshot.py`/`disassemble_selected.py`记解析方法，`*-annotated.txt`只输出选中方法并对白名单常量注释。任意邻近字符串、认证密钥、账号内容不进入输出；临时App二进制在分析后移除。没有安装工具链、运行SDK、执行AOT、使用设备或读取应用账号。

## 游戏的真实调用合同

下表地址为Mach-O slice的VM地址；对应原文件偏移需加 `0x4000`。

| 能力 | 恢复出的调用链与关键地址 | 可以采用的合同 |
| --- | --- | --- |
| 页码起点 | `_GamePageState`构造 `0x3e2f70..0x3e2f84`将1写入当前页字段；`_fetchGames`在 `0x294d08..0x294d0c`读该字段并调用 `PicaGame.getGameList` | 从第1页开始，按返回的page/pages判断后续页 |
| 列表路径与方法 | `PicaGame.getGameList`入口 `0x294e8c`；`0x294fac`读取对象池 `PP+0x1e650` 的 `games?page=`并拼接传入页码；`0x295098..0x2950a0`以 `GET`调用 `PicaAuthentication.generateHeaders`，随后 `Uri.parse`及HTTP get | `GET games?page=<整数页码>`；不新增limit、sort、搜索或其它猜测参数 |
| 列表结果 | `0x295150`读取code，`0x2951a0`读取message并与success比较；`0x2951f0..0x295260`依次取得data→games→docs；`0x2952d0/0x295324`取得page/pages | 成功结构为 `{code:200,message:"success",data:{games:{docs:[...],page,pages}}`。当前适配要求真实code与结构，不把缺失docs当空数组 |
| 详情路径与方法 | `PicaGame.getGameDetails`入口 `0x2c3fd8`；`0x2c40f4`读取 `games/`并拼接id；`0x2c4110..0x2c411c`传GET给签名；`0x2c4274..0x2c4294`取得data→game | `GET games/<id>`，结果位于 `data.game`；id来自列表 `_id` |
| 列表展示字段 | `GameCardWidget.build`入口 `0x24830c`，依次引用 `_id/title/publisher/version/adult/android/ios/icon`；`0x2486a0..0x2487a0`使用icon.fileServer/path | 本批只映射这些已证明字段。类型不对或缺失的bool保留null，封面缺失用功能图形，不补平台、年龄、版本或假封面 |
| 详情简介 | `_buildDescriptionSection`在 `0x32dc80`、`0x32dd80`读description | 原生详情可显示真实description；宿主只解析文本，不让描述中的HTML触发额外网络请求 |
| 下载链接线索 | `getPicGameDownloadUrl`入口 `0x32f2fc`；`0x32f334/0x32f35c`读取androidLinks/iosLinks，随后按平台选择列表首项 | 这是读取已在游戏对象中的链接的同步帮助函数，**不是换取临时下载链接的网络API**。本批不执行游戏下载、安装或点赞；未把它塞入漫画章节下载模型 |

原包列表方法还有10轮重试/本机快照路径。本批沿Breeze成熟客户端的10秒超时与用户重试，不复制这段循环，不启动后台探测，不保存另一套游戏快照。

## 一次真实匿名GET与明确限制

复用仓库现有 `plugins/bika/src/client.ts` 的签名与HTTP实现，以空的只读bridge提供默认值；没有接触ObjectBox、插件配置文件、账号、令牌或自动登录。实际请求为：

`GET https://picaapi.picacomic.com/games?page=1`，不含authorization。

有一轮直接传输未收到HTTP响应；随后遵从本机现有代理配置完成一次HTTP请求，得到 **HTTP401 / code401 / error1005 / message unauthorized**。没有重试其它未知路径、使用账号或以注册请求探测接口。脱敏结果在 `public-game-read-summary.json`；脚本限制单次执行最多一个GET及唯一origin/path，拒绝authorization和任何写入bridge。

这证明当前匿名访问被拒绝，不证明登录后游戏数据已实测。生产适配在无本插件会话时直接走既有鉴权提示，不发注定失败的匿名列表请求；用户主动登录后才使用本插件既有独立会话。若后续要取得真实成功样本，最小操作是用户在“哔咔漫画”中正常登录后打开游戏一次；只需核对该GET返回的脱敏结构，不需安装/运行参考IPA、另建账号或让用户重新提供密钥。

## 本次源码接入与尚待验证

- classic `src/games.ts`导出 `getGameListBundle/getGameDetailsBundle`，采用上述真实GET与字段，显式区分成功空、坏格式、认证失败与详情身份不符。账号修订、会话、API base及线路在请求前后核对；不写设置/账号/记录，不缓存游戏响应，不发追加逐项详情请求。
- metadata仅在原独立UUID的 `bikaExperience`中新增两个可选函数声明，名称仍为“哔咔漫画”。共享壳由主代理按**首页、视频、游戏、我的、设置**插入专属宿主目的地，不将游戏伪装成漫画scene或站外网页。
- 新宿主 `BikaGamesContent`按页读取、保留列表和位置，分页失败提供局部重试；刷新失败保留原内容，重试仍读第1页。详情走独立原生返回并延用源级外观；不为仅进入列表获取全部详情。人物加载只在真实请求中出现。覆盖缺字段、空态、失败、鉴权、减少动态与离屏现有加载能力。
- 注册/找回仍未启用写入；游戏截图、链接选择/外部下载、点赞与评论尚不在本只读切片内，不能宣称完整游戏体验已验收。

离线fixture的**结构及键来自上述AOT绑定，值均为人工样本**，不是伪装成真实账号的成功抓包。Node定向检查20/20通过，含原有首页/隔离检查与新增游戏请求/分页、未知字段、匿名阻止、401、账号变化迟到及详情身份；TypeScript noEmit退出0，manifest/CJS字节未变检查通过。宿主新增6项定向测试交主代理执行；本子任务不运行SDK/设备，也未重建/安装CJS或更新0.1.2成品。成功账号响应、宿主视觉与动态仍待实际核验。

## 注册已恢复的真实构造；找回是原包明确不可用动作

注册链现可定位到 `_registerPageState._register` `0x33644c` → `jsonEncode` `0x33661c` → `HttpPicaUtils.sendRegData` `0x336648` → `PicaRegisterLogin.register` `0x336820`。`0x3364d8..0x336608`构造共同JSON字段：

`name, email, password, question1, question2, question3, answer1, answer2, answer3, birthday, gender`。

前10项从各控制器text读取，gender从状态字段读取；生日选择回调 `0x3347ec`执行 `DateTime.toLocal()` → `DateTime.toString()` → `split(' ').first`，即日期部分。`0x3368a8..0x336904`明确把 `auth/register`、POST与同一JSON字符串送入签名/HTTP post。返回处理读取HTTP状态、code、message，对邮箱/昵称重复有专门消息路径；表单成功路径保存输入的邮箱/密码后 `GoRouter.pop`。此链未发现注册后调用sign-in或把token写成已登录会话。gender允许值、全部校验、条款和用户提交反馈仍需完整核对，故本批不开放提交，也不照搬原包保存密码策略。

此前 `forgotPassword` 字面不能再登记为“新增网络方法线索”：恢复出来的真实函数是本地化getter **`S.get:forgotPassword` `0x358388`**，调用 `Intl._message`。登录页 `0x357b78`绑定的回调 `0x3585cc`仅调用showDialog；dialog builder `0x358630`在 `0x3586c4`调用 **`S.get:featureUnavailable`**，其默认文案为 **“This feature is unavailable”**。所选原包在此入口表达功能不可用，没有恢复请求链。可以保留原包明确的不可用反馈，不能因此构造安全问题恢复、邮件、验证码或已登录改密替代流程；这也不证明服务端在其它客户端没有恢复能力。
