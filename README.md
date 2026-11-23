# Breeze 插件

在 [Breeze](https://github.com/kl5212840-lang/Breeze/releases) 的插件商店安装或更新，也可以从 [Releases](https://github.com/kl5212840-lang/Breeze-plugins/releases) 下载 CJS。OmoFun 动漫和魔都资源需要 Breeze 3.0.38 或支持这两个片库的版本。

| 插件 | 版本 |
| --- | --- |
| 哔咔漫画+ | 0.2.1 |
| 禁漫天堂+ | 0.2.1 |
| 拷贝漫画 | 0.2.1 |
| Hanime1 | 0.2.1 |
| OmoFun 动漫 | 0.1.1 |
| iKun 资源 | 0.1.3 |
| 魔都资源 | 0.1.2 |

本项目独立维护。哔咔、禁漫和拷贝插件分别基于 [Breeze-plugin-bikaComic](https://github.com/deretame/Breeze-plugin-bikaComic)、[Breeze-plugin-JmComic-change](https://github.com/mumushu0501-boop/Breeze-plugin-JmComic-change) 和 [Breeze-plugin-copyComic](https://github.com/deretame/Breeze-plugin-copyComic)。许可见各插件目录。

## 维护发布

公开版本按各插件在 `catalog/v1` 和 `updates/v1` 的已发布版本递增。构建后用 `script/prepare-next-release.cjs` 核对上一次线上附件、版本和 UUID，再生成新附件及索引。附件上传并回读校验后更新商城。
