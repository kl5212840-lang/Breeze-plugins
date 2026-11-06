# Breeze 插件合集

本账号维护的五个插件统一在这里管理源码、商店目录、安装文件与更新入口。配套客户端：[Breeze v3.0.38](https://github.com/kl5212840-lang/Breeze/releases/latest)。

| 插件 | 当前版本 | 源码 |
| --- | --- | --- |
| 哔咔漫画+ | 0.1.1 | [plugins/bika](plugins/bika) |
| 禁漫天堂+ | 0.1.1 | [plugins/jm](plugins/jm) |
| 拷贝漫画 | 0.1.1 | [plugins/copy](plugins/copy) |
| Hanime1 | 0.1.0 | [plugins/hanime](plugins/hanime) |
| iKun 资源 | 0.1.1 | [plugins/ikun](plugins/ikun) |

在 Breeze「插件商店」中安装或更新；也可以从[下载页](https://github.com/kl5212840-lang/Breeze-plugins/releases)获取对应 `.cjs`，通过本地安装导入。已有插件的 UUID、配置键、收藏与记录身份保持不变。更新客户端和更新插件是两项独立操作。

`catalog/v1/plugins_data.json` 是当前商店目录，`updates/v1/` 为每个插件提供独立更新入口。版本号分别维护，更新一个插件不要求其他插件同步升级。插件安装包放在本仓库 Release，客户端 IPA/APK 放在 Breeze 仓库。

旧客户端继续使用原来的目录和更新入口。升级到 Breeze 3.0.38 后，已识别的旧发布包可迁移至 0.1.0，UUID、配置、收藏与记录保留；未发布或自行修改的本地包不会被自动替换。后续版本按 0.1.1、0.2.0 等正常递增。

## 构建与发布

首次 0.1.0 仅调整已发布安装包的版本和更新入口，不重新打包业务代码：运行 `node script/prepare-release.cjs --published-baseline`。输入固定在 `compat/published/`，脚本核验原包摘要，并验证撤销元数据改动后与原包逐字节一致。

后续更新在相应子目录修改并递增公开版本。漫画插件安装依赖后运行 `pnpm build`；Hanime1 和 iKun 使用其 CJS。运行 `node script/prepare-release.cjs`，校验包信息、生成 `dist/formal-v1/` 附件、目录与更新索引。先上传并验证附件，再发布对应目录及索引。根目录旧 `plugins_data.json` 与 `updates/*.json` 保留原版本号和下载坐标，供旧客户端兼容使用；旧目录仅同步图标和仓库链接。

## 来源与使用说明

本项目独立维护，非各源站或上游官方发布。漫画插件分别基于 [deretame/Breeze-plugin-bikaComic](https://github.com/deretame/Breeze-plugin-bikaComic)、[mumushu0501-boop/Breeze-plugin-JmComic-change](https://github.com/mumushu0501-boop/Breeze-plugin-JmComic-change)、[deretame/Breeze-plugin-copyComic](https://github.com/deretame/Breeze-plugin-copyComic)；原始许可和说明保留在相应子目录。源码、图标与安装文件统一在本仓库维护；原始许可和上游来源保留在各插件目录。

插件通过第三方公开服务提供目录或账号操作，不托管影视、漫画内容；内容、线路、账号权限以原站为准。iKun 收藏与记录由 Breeze 本机管理，可使用 Breeze 同步，不是源站账号功能。图标由内置图像生成工具制作，原图与提示词保留在相应 assets 目录。
