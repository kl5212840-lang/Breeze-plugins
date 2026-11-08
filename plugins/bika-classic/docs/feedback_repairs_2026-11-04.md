# 哔咔漫画：本轮实际反馈的因果与修复边界

2026-11-04。只改独立BK源码及对应宿主/测试，不构建、安装、SDK、设备、账号读取或云写。交付仍待主代理统一版本、构建与验收；本记录不能把源码/fixture提升成实际账号或视觉验收。

## 已定位的问题与最小修法

| 反馈 | 已取得的真实因果 | 本轮源码变化 |
| --- | --- | --- |
| 游戏接入感不足/看不到新标签 | 本机0.1.3成品getInfo确有gameListFunction/gameDetailFunction，两个导出存在；CJS SHA256为 `2404956110b88d0491d4eac0905e35abff7bed56ca0c884fab5b2d5331f8ec1b`。宿主却把导航时传入的sections当永久快照；registry变化只刷名字/登录能力，且同版本同bundle的getInfo变化被早退 | 仅对exact独立BK能力声明，在getInfo/bundle变化时重建sections。按稳定id保留当前tab、已访问子树、滚动及返回历史；新增游戏不会把正在看的设置切回首页。预览函数绑定改变时才重建“我的”。**未用设备证明这就是用户本次所见的唯一原因** |
| 有站点收藏，预览却空 | metadata指向getCloudFavoriteSceneBundle。该函数只返回data.scene，不发收藏GET；预览解析只读data.items，把缺失items当成空数组。改前两个定向断言均失败，且失败位置正是items缺失与匿名未拒绝 | 新增getProfileCloudFavoriteBundle，声明给“我的”预览；真实请求为成熟合同 `GET users/favourite?s=dd&page=1`，完整列表原scene保留。会话钉住、无缓存/轮询/写账号；坏结构报失败，不冒充0；total缺失为null，不从第一页长度猜总数 |
| 个人资料不符 | 当前核心getUserInfoBundle本就直接读取fresh users/profile的name/level/exp/title/slogan，不从其它安装取账号，也不补经验分母。已确认粉色个人头部漏显返回的experience；尚未取得用户本次具体错误字段的实际只读回读证据 | 独立BK头部增加真实experience显示，不加经验进度或推算门槛；没有凭空替换等级/称号。**其它具体数值是否仍不符需主代理通过正常账号API回读核对，不能宣称全部修复** |
| 电影/里番重复 | 底部已有视频分组，但BikaSettingsContent又逐项渲染videoActions | 去掉设置中的两个重复视频入口；保留底部视频与既有收藏/历史/播放器 |
| Breeze设置与哔咔设置混层 | 原源内设置直接平铺Breeze缓存、语言/主题和应用锁，即使带“Breeze”后缀仍在同一任务层 | 源内只保留一个“Breeze设置”入口，进入独立下一层GlobalSettingPage，并恢复全局外观边界；不把这些全局值冒充BK独立值 |
| 服务器设置在哪里/是否真接 | API服务器、分流通道在核心schema确有network.apiBase/network.proxy，成熟saveSettings会保存并影响client，但此前只藏在笼统插件偏好里 | 增加独立“服务器与分流”页，只读取schema这两项；选择只提交相应field，保存后回读才反馈成功。不增线路猜测或探测。离线断言已证实切base/channel后下一请求确使用所选origin/app-channel |
| 首页热词太满 | BikaHomeContent无上限地Wrap全部keywords | 默认4项，用户可本地展开/收起，不重发请求、不换ScrollController；分类与成熟真实动作保持 |
| 人物大小/位置、错误卡缺原版特色 | 加载人物固定85逻辑尺寸，放进小宿主仍可能溢出；失败/空态为通用图形 | 加载默认72并受宿主宽高约束，保留原GIF/静态帧与减少动态判断；错误/空状态接入已核原IPA人物PNG，按宿主限尺寸、按显示尺寸解码。错误内容可滚动，不把鉴权锁状态当网络失败人物 |
| 游戏下载通道不明确 | 指定IPA的getPicGameDownloadUrl只从游戏对象androidLinks/iosLinks按平台取链接，不是另一个换链API；前批只读详情未输出这些字段 | 详情仅输出这两组中实际存在的HTTP(S)链接，去重并排除带用户名/密码的URL。原生页显示平台与目标域名，明确“在浏览器中打开”，用户点击才启动外部应用；不创建漫画章节任务、不自动下载/安装、不显示假完成 |

本轮“真实账号API”指生产数据链确实调用本插件独立会话下的站点接口。开发验证只使用离线会话样本；没有读取或打印用户凭证，也没有越过子任务禁设备边界进行账号调用。真实账号成功、列表权限和具体资料值仍应由主代理通过已有运行态的正常只读操作核对，不能拿fixture替代。

## 原版能力仍然明确保留的缺口

唯一主基准仍为用户指定的PicACG iOS 2.5.85及同目录截图，调用证据见[恢复合同](recovered_game_contract_2026-11-04.md)。原截图中的站点反馈、Q&A、图片渲染、原应用更新服务尚无完整可接合同；本轮没有用无关Breeze页面或空按钮伪装支持。已证实的原包“忘记密码”动作仅显示featureUnavailable对话框；注册JSON已恢复，但校验/条款与完整提交反馈未收口，不擅自开放。启动密码/语言/缓存的现有Breeze能力继续在Breeze独立下一层，不能宣称等同原站设置。

## 验证与主代理收口清单

- Node定向25/25通过；TypeScript noEmit退出0。包含收藏缺结构/真实空/账号变化迟到、服务器及通道影响实际transport配置、游戏链接来源/安全协议与原有首页/游戏/身份隔离。manifest/CJS字节未变断言通过。本子任务没有构建新资源。
- 宿主新增网络页保存/回读/防重入、人物24px与减少动态、热词展开不请求，以及同版本metadata更新保留设置选择的断言。已有设置宿主测试按新层级更新；**本子任务未跑SDK**，主代理需定向测试、format、分析并核对普通Navigator/AutoRoute返回。
- 已在pubspec列入 `asset/image/bika_experience/icon_exclamation_error.png` 与 `icon_empty.png`，各一次。两项均已目视确认是穿着完整的原版错误/空状态人物和小兽，不是作品封面；从指定IPA资源复制，分别394470/374437字节，SHA256为 `92e0747e8d16e467e5f35f6115de4d2bb01df139d73be916adb23fa8819a7bdf` / `952cc40949967c9ec7de0aba9ac8259642fa00cf9e2163225dfe090bf545ea5e`。
- 新的源内设置、网络反馈、经验、外部链接文案已加入en_US/zh_CN的sourceShell下13个bika前缀key，参数一致性校验通过；主代理最后统一codegen。实际浅深/窄屏大字、人物位置、转场和游戏/收藏账号数据仍待操作验收，不以测试存在或源码可编译代替。
