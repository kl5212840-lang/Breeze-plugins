# 哔咔漫画+ v0.1.8

本插件在[独立仓库](https://github.com/kl5212840-lang/Breeze-plugin-bika-personal)发布，不覆盖上游哔咔插件。建议与本分支 Breeze v3.0.36 配套使用。

## 本次更新

- 登录、签到与搜索不再向调试日志输出表单、请求或响应原始数据。
- 网络异常不再把包含请求头和请求体的原始错误对象传给应用。
- 保持既有分类、搜索、排行和「我的」功能；本次没有接入注册。

## Release 附件

- `breeze-plugin-bika-comic.bundle.cjs.br`：插件商城下载的压缩包。
- `breeze-plugin-bika-comic.bundle.cjs`：未压缩插件包。
- `manifest.json`：插件元数据，版本为 0.1.8。

本版本 Release 可下载后，`catalog/plugins_data.json` 将同步指向 `v0.1.8`。
