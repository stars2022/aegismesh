# 可选结构化输入输出

普通聊天、数字人、群聊和既有 API 请求均不自动启用此功能。不会因为能力声明中的 `application/json` 强制模型返回 JSON。

## 配置与使用

1. 管理面板 → 智能体 → 点开详情 → 能力 → 内置能力：点开“结构化输入输出”的“详情配置”，开启能力并填写输入或输出 Schema，至少一项。默认关闭，字段编辑器默认收起；关闭能力仍保留配置。
2. 技能编辑中的“结构化字段（可选）”可覆盖该技能的输入或输出 Schema；留空的方向沿用智能体默认配置。
3. 普通聊天选择该智能体后，勾选“本次使用结构化输入输出”，选择技能并填写字段。未勾选时仍是自然语言聊天，不校验这些业务字段。
4. 校验通过的输出显示为 JSON，支持复制和下载；历史、任务恢复和队列保留真实结果。画布与群聊暂不提供入口，数字人仍采用普通对话。

智能体开关决定能力是否开放，任务开关决定本次是否使用，两者独立。关闭智能体开关保留 Schema，不改变普通聊天。已接受的执行任务使用 Schema 快照；尚未执行的队列任务会重新检查可用性，关闭后明确拒绝结构化任务，不静默丢弃参数或影响普通请求。

## API

创建/更新智能体：

```json
{
  "structured_io_enabled": true,
  "input_schema": {
    "type": "object",
    "properties": {
      "topic": {"type": "string", "title": "主题", "minLength": 1},
      "limit": {"type": "integer", "title": "数量", "minimum": 1, "maximum": 10}
    },
    "required": ["topic"],
    "additionalProperties": false
  },
  "output_schema": {
    "type": "object",
    "properties": {
      "summary": {"type": "string"},
      "sources": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "title": {"type": "string"},
            "url": {"type": ["string", "null"]}
          },
          "required": ["title", "url"],
          "additionalProperties": false
        },
        "maxItems": 10
      }
    },
    "required": ["summary", "sources"],
    "additionalProperties": false
  }
}
```

`POST /api/chat`、`/api/chat/stream` 及对应 `/api/demo/chat` 路径：

```json
{
  "message": "检索并总结相关文献；没有核实的来源请如实说明",
  "agent_id": "docs_overview",
  "structured_io": true,
  "input_data": {"topic": "多智能体协作", "limit": 3}
}
```

需要技能覆盖时另传 `requested_skill`。结构化任务必须明确选择智能体；调用者不能临时覆盖管理员 Schema。只需结构化输出时可不配置输入 Schema，也不用传 `input_data`。

响应保留既有 `answer`、`result_data`、用量及审计字段，新增 `structured_output`（校验通过的对象）。未启用或失败时该字段为 `null`。不要从普通文本或任意工具回执推断结构化成功。

## 约束与失败行为

- 使用 JSON Schema 2020-12 的有界子集：对象、数组、标量/可空类型、嵌套属性、必填、额外字段开关、枚举、常量、长度/数量与数值边界、标题、描述、默认值。默认值仅作为表单便利，不由服务端静默填充。
- 根类型为 `object`。Schema 上限 16 KB、128 个定义节点、8 层；输入 32 KB、输出 128 KB；数据另限制 16 层和 4096 个节点。
- 不接受 `$ref`、正则、组合 Schema 或未支持的关键字；校验不访问网络。类型、必填字段和数组元素等使用 [jsonschema 校验器](https://python-jsonschema.readthedocs.io/en/stable/validate/)验证。
- 当前采用跨供应商的格式提示 + 服务端严格验收，不冒充供应商原生约束解码，不向不支持的供应商强塞 `response_format`。输出只接受完整 JSON 对象，兼容单一 JSON 围栏；拒绝多余正文、重复字段、NaN/Infinity 和字段不合规结果。
- 输入错误在会话绑定、额度预留和模型调用前返回 422。输出错误记录 `STRUCTURED_OUTPUT_REJECTED`、任务失败，保留已产生的真实用量，不发出“任务完成”。通过则记录 `STRUCTURED_OUTPUT_VALIDATED`。
- 结构化输出不发布未经校验的增量正文，进度与工具事件仍正常。格式错误不会启动自动修复或重试；兼容 Chat 适配器也关闭结构化输出任务的自动网络重试和额外文本补写。结构化协调任务遇到异常时不会额外启动自执行兜底调用。
- 协调与竞标任务的最终答复按本次选择的协调器契约验收；契约不自动强加给子智能体。启用结构化输出时，竞标任务缺少合规的最终汇总也会失败，而不把局部提交当作结构化成功。

## AIP

出站沿用标准 `StructuredDataItem`，业务数据的 `kind` 为 `aegismesh.structured-io.v1`，包含 `enabled: true`、`input_data`、`requested_skill`。入站仍依照目标智能体本地配置校验，载荷不能改写 Schema、身份、权限或预算。普通 AIP 请求没有此数据项，行为不变；第三方可忽略该可选业务数据项，发送方仍校验最终答复。

数据库升级只增加三列，既有智能体默认关闭；导入同样验证 Schema，旧备份缺少新字段仍可读取。此功能不修改账号、额度策略、模型预算或上游限制。

## 发布保护

发布前先将数据库与程序/配置备份回传本地，并离线恢复数据库执行 `quick_check`。服务器磁盘余量不足以放置完整数据库副本时，可用 `backup-production.py --stream-database` 导出已有 WAL 数据库的一致性压缩 SQL，另用 `--files-only` 备份程序和配置；两份都校验后才能发布。

`deploy-structured-io.py` 对源文件使用哈希白名单，检查无在途任务，保留账号、角色、配额、模型和智能体配置，应用增量迁移并检查现有能力仍关闭。重启仅涉及 API 与已在线的独立 AIP 入口；不更改服务单元、TLS、审计转发或身份。健康检查、未授权管理接口及无模型消耗的结构化拒绝校验通过后，才切换前端入口；失败恢复原程序和前端，保留兼容旧版的新增数据库列。
