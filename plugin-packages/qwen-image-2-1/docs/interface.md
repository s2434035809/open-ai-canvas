# Qwen-Image-2.1 接口字段

## 协议身份

- 插件 ID / Provider ID：`qwen-image-2-1`
- 能力：`image`
- 默认 Base URL：`http://47.111.83.139:13527`
- 鉴权：`Authorization: Bearer <API Key>`
- 创建：`POST /v1/images/generations`
- 查询：`GET /v1/images/generations/{id}`

## 请求映射

| 影策字段 | 上游字段 | 说明 |
| --- | --- | --- |
| `model` | `model` | 默认填写 `qwen_image_2.1` |
| `prompt` | `prompt` | 必填 |
| `images` | `ref_images` | 参考图最多 10 张，支持 URL 或 Data URI，传入自动路由到 edit 模式 |
| `aspectRatio` | `size` | 比例转换为官方推荐 16 倍数像素尺寸（如 9:16→768x1360, 16:9→1360x768, 21:9→1568x672 等），也可直接填 `宽x高` |
| `transparentBackground=true` | `background=transparent` | 输出原生透明 PNG |
| `providerOptions.qwen-image-2-1.output_format` | `output_format` | 默认 `png`；透明必须为 `png` |
| `providerOptions.qwen-image-2-1.response_format` | `response_format` | 默认 `url`，可选 `b64_json` |
| `providerOptions.qwen-image-2-1.seed` | `seed` | 可选固定随机种子 |
| `providerOptions.qwen-image-2-1.negative_prompt` | `negative_prompt` | 可选负面提示词 |
| `providerOptions.qwen-image-2-1.resolution` | `resolution` | 仅编辑模式生效，传 `0` 保持参考图尺寸 |

服务支持智能路由与异步降级：同步直接返回图片 `data[].url`；若排队超长或异步任务则返回任务 `id` / `task_id`，宿主按状态轮询，完成后下载 `data[].url` 并持久化；每次只生成一张图片。

## 状态与结果

`pending` / `running` / `completed` / `failed` 会统一映射到影策任务状态。成功结果来自 `data[]`，支持 `url` 和 `b64_json`。错误读取 `error.type`、`error.code` 与 `error.message`，保持失败语义，不会包装成成功。

## 兼容边界

`steps`、`cfg`、`sampler_name`、`scheduler`、`denoise` 是服务固定参数，不应通过插件发送。`mask` 当前不参与合成；请使用参考图编辑流程。

<!-- YINGCE_MANIFEST_CONTRACT_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "yingce.plugin/v2",
  "id": "qwen-image-2-1",
  "name": "Qwen-Image-2.1",
  "version": "1.0.0",
  "author": "影策",
  "description": "Qwen-Image-2.1 异步图片生成协议，支持文生图、图生图和原生透明 PNG。",
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
        "id": "qwen-image-2-1",
        "label": "Qwen-Image-2.1",
        "capabilities": [
          "image"
        ],
        "scopes": [
          "admin.system-channel",
          "user.custom-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "http://47.111.83.139:13527",
        "requiresPublicMediaUrls": false,
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
            "description": "默认模型为 qwen_image_2.1。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "prompt",
            "description": "图片提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "ref_images",
            "description": "参考图或编辑源图，最多 10 张；服务自动切换到编辑模式。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "size",
            "description": "比例会转换为合法像素尺寸，也可直接填写宽x高。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "required": false,
            "mapping": "provider-specific fields",
            "description": "透明、输出格式、种子和负面提示词等厂商扩展字段。"
          }
        ],
        "validations": [
          {
            "assert": {
              "$lte": [
                {
                  "$ref": "request.imageCount"
                },
                1
              ]
            },
            "message": "Qwen-Image-2.1 每次请求只支持生成 1 张图片"
          },
          {
            "assert": {
              "$lte": [
                {
                  "$len": {
                    "$ref": "request.images"
                  }
                },
                10
              ]
            },
            "message": "Qwen-Image-2.1 最多支持 10 张参考图"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/v1/images/generations",
          "originPath": true,
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "prompt": {
              "$ref": "request.prompt"
            },
            "ref_images": {
              "$omitEmpty": {
                "$map": {
                  "from": {
                    "$sortByOrder": {
                      "$ref": "request.images"
                    }
                  },
                  "as": "media",
                  "in": {
                    "$coalesce": [
                      {
                        "$ref": "media.dataUrl"
                      },
                      {
                        "$ref": "media.url"
                      }
                    ]
                  }
                }
              }
            },
            "size": {
              "$omitEmpty": {
                "$switch": {
                  "cases": [
                    {
                      "when": {
                        "$in": [
                          {
                            "$lower": {
                              "$trim": {
                                "$ref": "request.aspectRatio"
                              }
                            }
                          },
                          [
                            "",
                            "auto"
                          ]
                        ]
                      },
                      "then": null
                    },
                    {
                      "when": {
                        "$eq": [
                          {
                            "$ref": "request.aspectRatio"
                          },
                          "1:1"
                        ]
                      },
                      "then": "1024x1024"
                    },
                    {
                      "when": {
                        "$eq": [
                          {
                            "$ref": "request.aspectRatio"
                          },
                          "9:16"
                        ]
                      },
                      "then": "768x1360"
                    },
                    {
                      "when": {
                        "$eq": [
                          {
                            "$ref": "request.aspectRatio"
                          },
                          "16:9"
                        ]
                      },
                      "then": "1360x768"
                    },
                    {
                      "when": {
                        "$eq": [
                          {
                            "$ref": "request.aspectRatio"
                          },
                          "3:2"
                        ]
                      },
                      "then": "1248x832"
                    },
                    {
                      "when": {
                        "$eq": [
                          {
                            "$ref": "request.aspectRatio"
                          },
                          "2:3"
                        ]
                      },
                      "then": "832x1248"
                    },
                    {
                      "when": {
                        "$eq": [
                          {
                            "$ref": "request.aspectRatio"
                          },
                          "4:3"
                        ]
                      },
                      "then": "1184x880"
                    },
                    {
                      "when": {
                        "$eq": [
                          {
                            "$ref": "request.aspectRatio"
                          },
                          "3:4"
                        ]
                      },
                      "then": "880x1184"
                    },
                    {
                      "when": {
                        "$eq": [
                          {
                            "$ref": "request.aspectRatio"
                          },
                          "21:9"
                        ]
                      },
                      "then": "1568x672"
                    }
                  ],
                  "default": {
                    "$ref": "request.aspectRatio"
                  }
                }
              }
            },
            "background": {
              "$omitEmpty": {
                "$coalesce": [
                  {
                    "$ref": "request.providerOptions.qwen-image-2-1.background"
                  },
                  {
                    "$if": {
                      "condition": {
                        "$eq": [
                          {
                            "$ref": "request.extra.transparentBackground"
                          },
                          "true"
                        ]
                      },
                      "then": "transparent",
                      "else": null
                    }
                  }
                ]
              }
            },
            "transparent": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.qwen-image-2-1.transparent"
              }
            },
            "output_format": {
              "$coalesce": [
                {
                  "$ref": "request.providerOptions.qwen-image-2-1.output_format"
                },
                "png"
              ]
            },
            "response_format": {
              "$coalesce": [
                {
                  "$ref": "request.providerOptions.qwen-image-2-1.response_format"
                },
                "url"
              ]
            },
            "negative_prompt": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.qwen-image-2-1.negative_prompt"
              }
            },
            "seed": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.qwen-image-2-1.seed"
              }
            },
            "resolution": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.qwen-image-2-1.resolution"
              }
            }
          }
        },
        "poll": {
          "method": "GET",
          "path": "/v1/images/generations/{{taskId}}",
          "originPath": true,
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
                "$ref": "taskId"
              }
            ]
          },
          "status": {
            "$coalesce": [
              {
                "$ref": "response.status"
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
              }
            ]
          },
          "images": {
            "$map": {
              "from": {
                "$ref": "response.data"
              },
              "as": "item",
              "in": {
                "url": {
                  "$omitEmpty": {
                    "$ref": "item.url"
                  }
                },
                "dataUrl": {
                  "$if": {
                    "condition": {
                      "$ref": "item.b64_json"
                    },
                    "then": {
                      "$concat": [
                        "data:image/png;base64,",
                        {
                          "$ref": "item.b64_json"
                        }
                      ]
                    },
                    "else": null
                  }
                },
                "mimeType": "image/png"
              }
            }
          },
          "errorPaths": [
            "error.type",
            "error.code"
          ],
          "messagePaths": [
            "error.message",
            "message"
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
