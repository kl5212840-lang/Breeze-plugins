# Breeze 插件合集

插件安装包、商店目录和更新索引统一在本仓库维护。新视频源需配套最新测试客户端；客户端安装包仍在 Breeze 仓库。

| 插件 | 公开版本 |
| --- | --- |
| 哔咔漫画 | 0.1.0 |
| 哔咔漫画+ | 0.1.2 |
| 禁漫天堂+ | 0.1.2 |
| 拷贝漫画 | 0.1.2 |
| Hanime1 | 0.1.1 |
| OmoFun 动漫 | 0.1.0 |
| iKun 资源 | 0.1.2 |
| 魔都资源 | 0.1.0 |

通过 Breeze 插件商店安装或更新，也可从 Release 下载 CJS。UUID、账号配置、收藏与记录身份保持不变。奥斯卡保留本地，不在本次发布。

当前目录：`catalog/v1/plugins_data.json`，更新索引：`updates/v1/`。旧根目录与旧索引保留兼容；公开版本逐插件连续递增，不采用内部开发号。

运行 `node script/prepare-current-release.cjs` 可从带哈希的 `release-inputs/2026-11-08` 重建本批发布附件。此步骤仅替换对外发布元数据，业务导出函数保持一致；各插件源代码、许可与测试留在 plugins。先上传并核对附件，再更新商店目录。

## 来源与使用说明

本项目独立维护，非各源站或上游官方发布。漫画插件分别基于 [deretame/Breeze-plugin-bikaComic](https://github.com/deretame/Breeze-plugin-bikaComic)、[mumushu0501-boop/Breeze-plugin-JmComic-change](https://github.com/mumushu0501-boop/Breeze-plugin-JmComic-change)、[deretame/Breeze-plugin-copyComic](https://github.com/deretame/Breeze-plugin-copyComic)；原始许可和说明保留在相应子目录。源码、图标与安装文件统一在本仓库维护；原始许可和上游来源保留在各插件目录。

插件通过第三方公开服务提供目录或账号操作，不托管影视、漫画内容；内容、线路、账号权限以原站为准。iKun 收藏与记录由 Breeze 本机管理，可使用 Breeze 同步，不是源站账号功能。图标由内置图像生成工具制作，原图与提示词保留在相应 assets 目录。
