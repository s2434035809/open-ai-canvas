# 红鸟AI 视频

声明式 `yingce.plugin/v2` 插件，适配红鸟AI（`https://open.hongniaoai.com`）的视频生成协议，覆盖 `wan3-720p`、`wan3.0-1080p` 等 `video_generation` 模型。

接口按红鸟公开模型合同编写：`POST /v1/videos` 提交，`GET /v1/videos/{id}` 查询。创建体为顶层字段 `model`、`prompt`、`aspect_ratio`、`seconds`，参考素材 `images`、`videos`、`audios` 均为公网 URL 字符串数组；`seconds` 按上游请求示例以字符串提交（4–30 秒，缺省 15），不传 `resolution`（分辨率档位包含在模型 ID 中）。

模型清单、参数档位与参考素材上限以渠道令牌的 `GET /v1/models` 返回为准；wan3 系列当前支持 16:9 / 9:16，参考图最多 10 张、参考视频最多 5 个、参考音频最多 5 段，仅接收公网 HTTP(S) 直链，不支持 base64。上游按输出秒计费（如 wan3-720p ¥0.25/秒），宿主将临时结果地址立即下载转存。

完整请求、响应映射与错误合同见 [docs/interface.md](docs/interface.md)。
