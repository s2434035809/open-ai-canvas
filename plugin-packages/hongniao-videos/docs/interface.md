# 红鸟AI 视频接口字段

## 协议身份

- 插件 ID：`hongniao-videos`。
- Provider ID：`hongniao-videos`。
- 能力：`video`。
- 默认 Base URL：`https://open.hongniaoai.com`。
- 鉴权驱动：`bearer`。
- 创建：`POST /v1/videos`。
- 查询：`GET /v1/videos/{{taskId}}`。
- 参考媒体要求公开可访问的 HTTPS URL（`requiresPublicMediaUrls`）。

## 配置字段

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `apiKey` | secret | 是 | 红鸟AI 平台 API Key，随请求发送 `Authorization: Bearer <apiKey>`。 |

## 统一字段映射

| 统一字段 | 类型 | 必填 | 上游映射 | 说明 |
| --- | --- | --- | --- | --- |
| `model` | string | 是 | `model` | 上游模型 ID，如 `wan3-720p`。 |
| `prompt` | string | 是 | `prompt` | 视频提示词。 |
| `images` | media[] | 否 | `images` | 参考图片 URL 字符串数组，最多 10 张。 |
| `videos` | media[] | 否 | `videos` | 参考视频 URL 字符串数组，最多 5 个。 |
| `audios` | media[] | 否 | `audios` | 参考音频 URL 字符串数组，最多 5 段。 |
| `duration` | integer | 是 | `seconds` | 输出时长 4–30 秒；按上游示例以字符串提交，缺省 15。 |
| `aspectRatio` | string | 否 | `aspect_ratio` | 画幅比例 `16:9` / `9:16`，默认 `9:16`。 |

## 上游请求模板逐字段清单

| 上游位置 | 值或转换表达式 |
| --- | --- |
| `create.method` | `"POST"` |
| `create.path` | `"/v1/videos"` |
| `create.contentType` | `"application/json"` |
| `create.body.model` | `{"$ref":"request.model"}` |
| `create.body.prompt` | `{"$ref":"request.prompt"}` |
| `create.body.aspect_ratio` | `{"$coalesce":[{"$ref":"request.aspectRatio"},"9:16"]}` |
| `create.body.seconds` | `{"$if":{"condition":{"$gt":[{"$ref":"request.duration"},0]},"then":{"$toString":{"$ref":"request.duration"}},"else":"15"}}` |
| `create.body.images` | `{"$omitEmpty":{"$map":{"from":{"$sortByOrder":{"$ref":"request.images"}},"as":"media","in":{"$ref":"media.value"}}}}` |
| `create.body.videos` | `{"$omitEmpty":{"$map":{"from":{"$ref":"request.videos"},"as":"media","in":{"$ref":"media.value"}}}}` |
| `create.body.audios` | `{"$omitEmpty":{"$map":{"from":{"$ref":"request.audios"},"as":"media","in":{"$ref":"media.value"}}}}` |
| `poll.method` | `"GET"` |
| `poll.path` | `"/v1/videos/{{taskId}}"` |
| `poll.contentType` | `"application/json"` |

## 响应映射逐字段清单

| 映射位置 | 上游路径或转换表达式 |
| --- | --- |
| `response.taskId` | `{"$coalesce":[{"$ref":"response.id"},{"$ref":"response.task_id"},{"$ref":"response.taskId"},{"$ref":"response.data.id"},"taskId"]}` |
| `response.status` | `{"$coalesce":[{"$ref":"response.status"},{"$ref":"response.state"},{"$ref":"response.data.status"},"pending"]}` |
| `response.message` | `{"$coalesce":[{"$ref":"response.error.message"},{"$ref":"response.message"},{"$ref":"response.fail_reason"}]}` |
| `response.videos` | 优先 `metadata.direct_url`，再依次取 `metadata.url`、`metadata.video_url`、`video_url`、`videoUrl`、`result_url`、`url` 及 `data.*` 变体 |
| `response.errorPaths[0]` | `"error.message"` |
| `response.errorPaths[1]` | `"error.code"` |
| `response.resultEphemeral` | `true` |

## 响应与错误

上游校验失败（HTTP 400）返回 `{"code":400,"message":"...","error":...}`；`message` 是人类可读原因，`error` 可能是裸 HTTP 状态短语（如 `"Bad Request"`），宿主展示错误详情时以 `message` 为准。创建成功返回任务 ID，查询按 `status`/`state`/`data.status` 取状态，`completed`/`succeeded` 归一为成功，`failed`/`expired`/`error` 归一为失败。视频地址是临时地址（`resultEphemeral`），由宿主立即下载并转存为项目资源。

## 兼容边界

该包只代表上述线协议 profile。上游以 `GET /v1/models` 公布每个模型的参数档位与参考素材上限，同一站点的其他 endpoint、内部创作接口或网关包装必须使用独立插件，不能根据模型名猜测。

<!-- YINGCE_MANIFEST_CONTRACT_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "yingce.plugin/v2",
  "id": "hongniao-videos",
  "name": "红鸟AI 视频",
  "version": "1.0.0",
  "author": "Yingce / 红鸟AI",
  "description": "红鸟AI（open.hongniaoai.com）视频生成协议：POST /v1/videos 提交，GET /v1/videos/{id} 查询，wan3 系列顶层字段与 URL 数组参考素材。",
  "permissions": [
    "generation.run",
    "media.read"
  ],
  "configuration": {
    "fields": [
      {
        "name": "apiKey",
        "type": "secret",
        "label": "API Key",
        "required": true
      }
    ]
  },
  "contributes": {
    "providers": [
      {
        "id": "hongniao-videos",
        "label": "红鸟AI 视频（Wan 3.0 等）",
        "description": "wan3-720p / wan3.0-1080p 等：POST /v1/videos，顶层 prompt/aspect_ratio/seconds，参考素材为 URL 字符串数组。",
        "capabilities": [
          "video"
        ],
        "scopes": [
          "admin.system-channel",
          "user.custom-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "https://open.hongniaoai.com",
        "requiresPublicMediaUrls": true,
        "auth": {
          "type": "bearer",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "model",
            "description": "上游模型 ID，如 wan3-720p。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "prompt",
            "description": "视频提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "images",
            "description": "参考图片 URL 数组，最多 10 张，仅公网 HTTP(S) 直链。"
          },
          {
            "name": "videos",
            "type": "media[]",
            "required": false,
            "mapping": "videos",
            "description": "参考视频 URL 数组，最多 5 个。"
          },
          {
            "name": "audios",
            "type": "media[]",
            "required": false,
            "mapping": "audios",
            "description": "参考音频 URL 数组，最多 5 段。"
          },
          {
            "name": "duration",
            "type": "integer",
            "required": true,
            "mapping": "seconds",
            "description": "输出时长，单位秒，4–30；按上游示例以字符串提交。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "aspect_ratio",
            "description": "画幅比例，16:9 或 9:16，默认 9:16。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/v1/videos",
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "prompt": {
              "$ref": "request.prompt"
            },
            "aspect_ratio": {
              "$coalesce": [
                {
                  "$ref": "request.aspectRatio"
                },
                "9:16"
              ]
            },
            "seconds": {
              "$if": {
                "condition": {
                  "$gt": [
                    {
                      "$ref": "request.duration"
                    },
                    0
                  ]
                },
                "then": {
                  "$toString": {
                    "$ref": "request.duration"
                  }
                },
                "else": "15"
              }
            },
            "images": {
              "$omitEmpty": {
                "$map": {
                  "from": {
                    "$sortByOrder": {
                      "$ref": "request.images"
                    }
                  },
                  "as": "media",
                  "in": {
                    "$ref": "media.value"
                  }
                }
              }
            },
            "videos": {
              "$omitEmpty": {
                "$map": {
                  "from": {
                    "$ref": "request.videos"
                  },
                  "as": "media",
                  "in": {
                    "$ref": "media.value"
                  }
                }
              }
            },
            "audios": {
              "$omitEmpty": {
                "$map": {
                  "from": {
                    "$ref": "request.audios"
                  },
                  "as": "media",
                  "in": {
                    "$ref": "media.value"
                  }
                }
              }
            }
          }
        },
        "poll": {
          "method": "GET",
          "path": "/v1/videos/{{taskId}}",
          "contentType": "application/json"
        },
        "response": {
          "taskId": {
            "$coalesce": [
              {
                "$ref": "response.id"
              },
              {
                "$ref": "response.task_id"
              },
              {
                "$ref": "response.taskId"
              },
              {
                "$ref": "response.data.id"
              },
              "taskId"
            ]
          },
          "status": {
            "$coalesce": [
              {
                "$ref": "response.status"
              },
              {
                "$ref": "response.state"
              },
              {
                "$ref": "response.data.status"
              },
              "pending"
            ]
          },
          "message": {
            "$coalesce": [
              {
                "$ref": "response.error.message"
              },
              {
                "$ref": "response.message"
              },
              {
                "$ref": "response.fail_reason"
              }
            ]
          },
          "videos": {
            "$coalesce": [
              {
                "$ref": "response.metadata.direct_url"
              },
              {
                "$ref": "response.data.metadata.direct_url"
              },
              {
                "$ref": "response.metadata.url"
              },
              {
                "$ref": "response.metadata.video_url"
              },
              {
                "$ref": "response.video_url"
              },
              {
                "$ref": "response.videoUrl"
              },
              {
                "$ref": "response.result_url"
              },
              {
                "$ref": "response.url"
              },
              {
                "$ref": "response.data.metadata.url"
              },
              {
                "$ref": "response.data.video_url"
              },
              {
                "$ref": "response.output.url"
              }
            ]
          },
          "errorPaths": [
            "error.message",
            "error.code"
          ],
          "resultEphemeral": true
        }
      }
    ]
  },
  "documentation": "<当前插件的完整 documentation，由 README.md 与 docs/interface.md 拼接而成；为避免 JSON 递归，此处不重复展开正文。>"
}
```
<!-- YINGCE_MANIFEST_CONTRACT_END -->
