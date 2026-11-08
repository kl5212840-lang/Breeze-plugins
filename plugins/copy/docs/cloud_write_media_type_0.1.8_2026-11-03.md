# Copy 0.1.8：云端收藏请求类型修复

实机详情页收藏提示 `Unsupported media type "text/plain;charset=UTF-8" in request.`。本轮没有使用截图账号、真实登录会话或执行任何云端写入；只读取原站公开页面/脚本并运行离线成品测试。

## 根因和最小修改

0.1.7 的 [addCopyFavorite](../src/index.ts) 把 `URLSearchParams` 转成字符串，POST `/api/v3/member/collect/comic?platform=1` 时没有声明表单 Content-Type。实际分发 CJS 经 bundled ky 构造的 Request 因此为 `text/plain;charset=UTF-8`，正文仍为 `comic_id=fixture-comic-uuid&is_collect=1`。模拟服务端拒绝该类型时，现有收藏流程稳定返回相同英文错误。

宿主 `Breeze/rust/rquickjs_playground/js/30_fetch.js` 的 Request 字符串分支（603 行）同样默认 text/plain；651 行仅在未指定 Content-Type 时补默认值，1134 行把 Request headers 直接传至原生网络调用。这是正常的正文类型映射。本轮不改宿主或共享网络。

只在该收藏 POST 补 `application/x-www-form-urlencoded;charset=utf-8`，沿用取消收藏和登录已有写法；不改变接口、字段、线路、身份或其他行为。版本从本轮开始时的 0.1.7 升为 0.1.8，既有 build 流程同步 package、manifest、CJS 与 Brotli。保留本轮之前的未提交修改。

## 原站公开源码核对

- [原站首页](https://2026copy.com/) 引用的 [http_request.js](https://s3.mangafunb.fun/static/websitefree/js20190704/http_request.js) 明确设置 `application/x-www-form-urlencoded;charset=UTF-8`，并拼接 `key=value` 表单正文。本轮匿名 GET：1,410 字节，SHA-256 `87ba9e468f3351a119ac7fee4f1702a3a8e0006d7fcadc7594b2ebb0ea3b90c6`。
- [原站漫画详情页](https://2026copy.com/comic/naoodngxueshenghui) 引用的 [comic_detail20240918.js](https://s3.mangafunb.fun/static/websitefree/js20190704/comic_detail20240918.js) 使用 `comic_id`、`is_collect`，通过上述 helper 提交收藏。匿名 GET：4,194 字节，SHA-256 `d67b1416e6413a62a8b1e2a1f971bdbc8bf86f3baf29828557fa2cd568c3e5a7`。

网页使用 `/api/v2/web/collect`，插件沿用现有 app `/api/v3/member/collect/comic`，两者不能混同。本轮没有取得该 app API 的服务端 schema 或进行认证写入；证据是用户的服务端拒绝信息、成品离线请求复现与原站表单声明，不宣称线上收藏效果已实测。

## 同类请求与离线验证

新增 [cloud_write_bundle.test.ts](../tests/cloud_write_bundle.test.ts)，直接加载 `dist/breeze-plugin-copy-comic.bundle.cjs`，拦截最终 Request，不替换生产序列化 helper。全部外发均由离线 fixture 接管。

| 路径 | 最终类型及验证 |
| --- | --- |
| 收藏 POST | form Content-Type、UUID/is_collect 字段、授权头及成功提交状态 |
| 取消收藏 DELETE（两个入口） | 已有 form Content-Type、正确 collect ID、仅一次写入 |
| 登录 POST | 已有 form Content-Type，特殊字符/空格/中文正确转义 |
| 头像上传 POST | 保持 multipart boundary、JPEG 类型、文件名及原始字节 |
| 资料保存 POST | 保持 form Content-Type，昵称及 opaque avatar handle 特殊字符正确转义，不变成 text/plain |
| 业务拒绝/未登录 | 不回报已提交；未登录不发收藏请求 |

验证记录位于本插件 `dist/validation/`：

- `cloud-write-red.log`：旧 0.1.7 成品 5/6，通过的同类写入保持正常；唯一失败是收藏返回上述英文错误。
- `cloud-write-green.log`：新成品 6/6 通过。
- `cloud-write-all-tests.log`：全部插件测试 58/58 通过。
- `cloud-write-build.log`：typecheck、版本生成、manifest、Rspack 与 Brotli 全流程成功。
- 定向 oxlint 通过，新测试 oxfmt 检查通过。实际 CJS `getInfo()`、manifest、package 均为 0.1.8，UUID 保持 `b28da416-f2d4-4208-a85e-8b4c7c648e48`，Brotli 解压逐字节等于 CJS。

冻结前同版本补充：详情 `normal.extern.metricAvailability` 将没有真实来源、仅合同占位的 `totalViews` 与 `totalLikes` 标为 `false`，让支持该声明的宿主显示未知；原数值合同保持，实际评论数不标为不可用。[detail_metrics_bundle.test.ts](../tests/detail_metrics_bundle.test.ts) 直接测试成品，评论总数 0 和 27 均保留。旧成品 2/2 失败、新成品 2/2 通过；全部插件测试增为 60/60 通过。日志为 `dist/validation/detail-metrics-{red,green,all-tests,build}.log`。以下为最终冻结成品，取代此前仅媒体类型修复的同版本 hash。

| 成品 | 字节数 | SHA-256 |
| --- | ---: | --- |
| 本轮基线 0.1.7 CJS | 82,587 | `b2d1c205487edeb7bfe9789f1377eebc47d1fdfc18bc0bf22e9ce12de128ea9f` |
| 0.1.8 CJS | 82,705 | `d467867dad062a1c5eece74d86668fe100e4d092a8a141613d392faaf9138076` |
| 0.1.8 CJS.br | 22,156 | `35dd4a50c1cc2cc464366892212e89f7d7014762ef01e904ea3c9e6e9349c01c` |

未验证：真实账号的收藏/取消及其他写入效果、所有线路服务端兼容、实机运行。没有运行 Flutter/Dart、设备、上传、发布或根目录商店清单生成。
