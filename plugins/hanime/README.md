# Hanime1 · Breeze 视频插件

为 [Breeze](https://github.com/kl5212840-lang/Breeze) 提供 Hanime1 原生浏览、网页浏览与视频播放入口。推荐配合本分支 Breeze v3.0.41 或更新版本使用。

## 安装与更新

在 Breeze 的**插件商店**中找到「Hanime1」，选择安装或更新。已经本地安装过旧版的用户可以直接从商店更新：插件 UUID 保持不变，沿用原有配置与账号数据，无需卸载。

插件独立发布在[本仓库 Releases](https://github.com/kl5212840-lang/Breeze-plugin-Hanime1-native/releases)，不放入 Breeze 应用的 Release 附件。商店暂时不可用时，也可从本仓库下载 `.cjs` 文件并在插件管理中本地安装。

## 主要功能

- 推荐、排行、搜索与筛选、订阅、作者主页以及「我的」资料和视频列表。
- 原生／网页模式显式切换，常用账号和站点操作由配套 Breeze 宿主呈现。
- 原位、竖屏及横屏播放，倍速、线路、手动选集与本次播放排序由宿主管理。
- 独立的插件设置与更新通道；使用自定义像素头像，不依赖外部图床。

站点内容、账号权限和可用操作以原站为准。登录、人机验证或暂不支持的表单会交给站点网页；发布评论可能受原站邮箱验证限制。本插件不托管视频，也不绕过站点访问控制。

## v0.11.3

首次通过插件商店独立分发，补齐 GitHub 更新地址。与已验收的 0.11.2 相比，仅调整版本与发布元数据，浏览、解析、播放和账号逻辑保持一致。

## 开发与检查

运行资源为 `hanime1-native.cjs`；`manifest.json` 必须与其 `getInfo()` 一致。更新前保留 UUID，并同步版本、manifest、Release 与商店目录。

```sh
npm ci --ignore-scripts
node --test hanime1-native.test.cjs
```

完整宿主 DOM 测试还需要 Flutter/Dart，以及同级目录的 `Breeze` 源码：

```sh
npm test
```

DOM 测试使用合成样例，不等于真实站点写入或真机验收。插件商店目录沿用本分支现有的[共享目录](https://github.com/kl5212840-lang/Breeze-plugin-bika-personal/blob/main/catalog/plugins_data.json)，应先发布可下载的插件，再更新目录。

自定义图标由用户提供的参考图融合生成，来源说明见 [assets/README.md](assets/README.md)。
