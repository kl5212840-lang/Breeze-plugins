# 魔都原生插件（本地接入中）

统一仓库的独立 CJS，不依赖同目录其他文件。使用 `node script/build-video.cjs` 重建；源配置在 source.json，公共读取层在 plugins/video-common/cms-core.cjs。

要求支持视频协议 2 的配套 Breeze，旧公开客户端尚不支持。当前仅完成真实源列表/详情/分集地址读取、父类聚合与两页去重；新插件的 iPhone 播放、切集、收藏与续播仍待验收，未发布。

接口字典、字段决定与受限状态位于 Breeze/docs/video_source_api。源站不支持的筛选不能放到界面；API 地址别名不等于媒体备用线路。
