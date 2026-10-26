# Breeze 插件合集

本账号维护的五个插件统一在这里管理源码、商店目录、安装文件与更新入口。配套客户端：[Breeze v3.0.37](https://github.com/kl5212840-lang/Breeze/releases/latest)。

| 插件 | 当前版本 | 源码 |
| --- | --- | --- |
| 哔咔漫画+ | 0.1.11 | [plugins/bika](plugins/bika) |
| 禁漫天堂+ | 0.3.4 | [plugins/jm](plugins/jm) |
| 拷贝漫画 | 0.0.18 | [plugins/copy](plugins/copy) |
| Hanime1 | 0.11.4 | [plugins/hanime](plugins/hanime) |
| iKun 资源 | 0.1.2 | [plugins/ikun](plugins/ikun) |

在 Breeze「插件商店」中安装或更新；也可以从[下载页](https://github.com/kl5212840-lang/Breeze-plugins/releases)获取对应 `.cjs`，通过本地安装导入。已有插件的 UUID、配置键、收藏与记录身份保持不变。更新客户端和更新插件是两项独立操作。

`plugins_data.json` 是统一商店目录，`updates/` 为每个插件提供独立更新索引，版本号和下载附件不会串用。安装文件统一放在本仓库 Release，客户端 IPA 留在 Breeze 仓库。

构建漫画插件时，在各子目录安装依赖并运行 `pnpm build`；Hanime1 和 iKun 直接使用其 CJS。全部构建后在根目录运行 `node script/prepare-release.cjs`，校验实际 `getInfo()`、生成目录和更新索引，并准备 `dist/` 中的发布附件及 SHA-256。先上传并验证附件，再发布对应目录及索引。

## 来源与使用说明

本项目独立维护，非各源站或上游官方发布。漫画插件分别基于 [deretame/Breeze-plugin-bikaComic](https://github.com/deretame/Breeze-plugin-bikaComic)、[mumushu0501-boop/Breeze-plugin-JmComic-change](https://github.com/mumushu0501-boop/Breeze-plugin-JmComic-change)、[deretame/Breeze-plugin-copyComic](https://github.com/deretame/Breeze-plugin-copyComic)；原始许可和说明保留在相应子目录。原开发仓库保留历史记录，新版本统一在本仓库维护。

插件通过第三方公开服务提供目录或账号操作，不托管影视、漫画内容；内容、线路、账号权限以原站为准。iKun 收藏与记录由 Breeze 本机管理，可使用 Breeze 同步，不是源站账号功能。图标由内置图像生成工具制作，原图与提示词保留在相应 assets 目录。
