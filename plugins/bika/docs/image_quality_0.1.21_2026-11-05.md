# 哔咔＋0.1.21 图片质量请求接入

本批仅处理整合 Plus，不启用或迁回独立哔咔插件。版本输入 `src/info.ts` 与 `package.json` 同步为 0.1.21；manifest/dist 由主任务统一构建生成，本批不生成交付资源。

## 官方静态证据

基准为用户指定的 PicACG iOS 2.5.85 IPA；原记录位于 Breeze 的 `docs/bika_ios_2_5_85_reference_2026-11-03.md`，AOT 解析材料位于 `build/bika-official-reference-20261103/aot-call-analysis/`。本次使用既有只读解析器在内存核对以下方法及常量，未执行 IPA、SDK、设备或账号请求。

- `showSettingsDialog`（0x3801d8）读取 `imageQuality`，官方缺省 `medium`。
- 画质菜单闭包（0x380b84）映射 `low`→极限压缩、`medium`→推荐设置、`high`→高清、`original`→原始图片。
- `_onSelect`（0x381314）调用 `PicaLocalStorage.saveData` 保存 `imageQuality`。
- `PicaAuthentication.generateHeaders`（0x2358e0）读取同一值并写 `image-quality`。
- `PicaComic.getComicOrder`（0x234d84）读取画质并参与章节请求/缓存流程；`ComicDataLoader.getImageUrl`（0x390d54）拼接返回的 `fileServer` 与 `path`。
- 官方 `filterQuality` 是另一套本地采样设置；原包明确提示修改渲染精度不会改变漫画画质。不能把其 `none` 改名为原图。

## Plus 本批合同

- 设置字段 `image.quality` 复用现有每源 pluginConfig 存储，新增原图/高清/推荐/极度压缩四个合法值。升级保持既有 `original` 缺省，不借接入官方默认值降低现有用户画质。
- 非法新提交在任何设置写入前拒绝；未知恢复值按 original 使用但不覆盖其存储。合法云恢复值通过相同读取路径参与下一次请求，无独立 UI 影子值。
- 同一请求画质快照同时进入实际 `image-quality` 头及请求缓存键，质量不同的章节 JSON 不复用。章节分页和图片地址生成共用同一画质；读请求期间改档，旧响应不得作为当前结果或进入请求缓存。
- 成功的 PUT/POST 等写入不因画质途中变化而报成失败，避免误导用户重复提交已经完成的操作。
- 非原图章节使用当前服务端返回的 `fileServer/path`，不编造分档 CDN 域名、查询参数或压缩尺寸。既有原图镜像、图片分流、封面/分类图兼容路径保留。
- 本地采样原存储、账号、API 节点与分流保持独立；保存图片质量不修改下载记录或已下载文件。已打开阅读页的即时刷新由宿主处理，本批不宣称其已完成。

## 隔离验证与待验

2026-11-05：Plus 全量 127 项 Node 检查通过，TypeScript `tsc --noEmit` 通过。Breeze 本机日志为：

- `build/ui-b2304-bika-image-quality-node-tests.log`
- `build/ui-b2304-bika-image-quality-typecheck.log`
- `build/ui-b2304-bika-image-quality-red-green.log`

新增 `tests/image-quality.test.ts` 覆盖实际 Axios adapter 收到的四档请求头、设置回读/恢复、缓存分区、在途改档与缓存回读竞争、已完成写入、服务端图片地址和章节全链。定向反证将请求头恢复为旧固定 original 时，high 用例按预期失败；恢复实现后通过，源码逐字节恢复。

这些是静态客户端合同与隔离协议证据。尚未验证当前真实服务端是否接受并产生四档不同图片、图片尺寸/字节/视觉差异、真实云端恢复、宿主阅读页即时刷新、两样式实际菜单与设备图片展示。没有新的 dist、IPA、模拟器安装或云交付，不宣称真实服务端压缩档已生效。
