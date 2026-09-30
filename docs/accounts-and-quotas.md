# 账号、会话归属与配额模块

2026-09-30 已部署至 `aegismesh-release-accounts-20260930`：账号与邮箱已启用、`QUOTA_MODE=enforce`、`ACCOUNT_OAUTH={}`。公开 demo 不要求注册，访客凭据限 3 个成功根任务；邮箱登录入口为 `/login`，个人账号管理和配额在设置中。管理员控制台使用独立登录，不与用户账号权限混用。

## 管理员控制台

后台新增独立入口 `/admin?tab=accounts`（账号管理）与 `/admin?tab=quotas`（配额管理），不再嵌套于访问与数据。

- 账号管理：按名称、邮箱、ID 搜索；角色/启停筛选；20 条分页。详情含基本信息、单独额度、有效登录会话、用量明细和最近 20 条管理审计。
- 可修改显示名称、member/trusted/admin 角色和启停状态。停用或改角色会撤销全部现存登录；可单独或批量退出设备。不提供直接改邮箱、密码或删除账本的后台捷径。
- 应用用户的 admin 角色控制额度，**不授予管理后台权限**。已验证的站点所有者邮箱仍受保护，不能从这些接口停用、改角色、撤销设备或限制额度。
- 配额管理：全局、角色、供应商、用量四个标签。全局/角色默认与供应商约束同时生效；单用户覆盖可分别设置轮次、并发、上传、模型额度和供应商额度。字段留空继承，显式 0 禁止，清除覆盖不清除消费记录。额度豁免仍受真实上游容量及输出上限约束。
- 最近 30 天的模型账本支持主体、供应商、状态筛选与分页，保留会话和调用关联。结算点数是应用侧计量，不是供应商账单。
- 管理界面显式保存并填写原因，提交读取时的 revision；并行编辑冲突返回 409，不静默覆盖。账号开关与配额按 section PATCH，互不覆盖。兼容原 PUT 及 PATCH 入口，权限不放宽。
- 角色/启停/额度/会话撤销与审计在同一事务中提交；审计失败返回 503 并回滚。审计保留原因和策略前后值，不记录密码、令牌或原始显示名称。记录也可在“日志与审计”中查阅。
- 侧栏品牌、新建按钮和底部账号不参与压缩；导航独立滚动，窄/矮窗口保留正常按钮尺寸。

本地隔离验收：后端 457 项、前端 92 项通过。`frontend/tests/account-administration.html` 使用内存样例，不调用或改动真实用户；生产部署与备份以实际发布记录为准。

2026-09-30 管理扩展已发布：13 个运行服务健康，账号/聊天公开配置及数据库配额策略前后一致，未登录访问两个新管理 API 均返回 401。备份 `var/production-backups/pre-accounts-20260930T083206Z.tar.gz` 已回传本地（0600，Git 忽略），SHA-256 `d6176e978a35212df8c92e4efcec5c5a3ef59f0719f518f6671f282a917de5f7`；离线恢复的 28 张表行数与 quick_check 验证通过。回退源文件和旧网页入口在服务器 `deployment-backup/admin-controls-20260930T084251Z`。没有为验收调整真实用户的角色、启停或额度。

生产邮件使用 Resend SMTP/TLS，已从服务器完成认证和向所有者发送一封测试邮件（SMTP 接受不等于收件箱送达确认）。Turnstile 仅绑定 `demmo.cc.cd`，服务端验证 `success`、操作和域名；缺少验证令牌的请求实测返回 403。真实挑战通过与重放验收另见本节末尾的上线记录，不以 mock 测试代替。

## 身份与会话

| 对象 | 标识与边界 |
| --- | --- |
| 匿名访客 | 高熵 HttpOnly 浏览器凭据；数据库只存摘要，不再使用 IP 合并访客 |
| 用户账号 | 稳定 `account_<id>`，登录凭据可轮换、撤销；和管理员账号完全独立 |
| API 调用 | **验证成功后**才从 API key 派生主体，随意填写请求头不能改变浏览器画布归属 |
| AIP 入站 | 保留已验证的 peer + target AIC 隔离规则，不接受客户端声明用户身份 |
| 聊天会话 | `conversations.id → owner_id` 在 invocation 创建前绑定，后续不能换所有人 |
| 主调用 / 子调用 | 根调用持有 owner/session；子记录携带 invocation/root/session/owner，工具实际读写时再验证归属 |
| 画布 / 群聊 | 每次读取、写入和派发都校验所有人；群聊仅能派发已启用的真实成员 |

本地聊天缓存同样按稳定主体分区。常规退出账号会返回该浏览器原来的访客身份，但不会把访客历史自动合并进账号。更换账号或其他窗口切换身份后，页面获得焦点会重新核对身份；旧 SSE 会话保护仍保留。

**迁移限制**：旧的无主画布、混合 owner 会话、按共享 IP 归属的数据不能安全自动认领。保留原始服务端记录和旧 localStorage 键，不按“最新一条调用”或 IP 抢占。管理员需以可信归属证据单独迁移；否则新建会话。已验证的旧 `demo:<random>` cookie 可延续原 owner。过期/被撤销凭据不作为迁移证明。

这能解决主体漂移、同 IP 访客混用、换账号后看到旧缓存和错误 session 越权，但不能代替前端异步事件校验，也不能解决模型回传缺失、外部协议故障或文件沙箱问题。

## 邮箱与第三方登录

邮箱支持注册验证、登录、一次性密码重置和设备退出。验证码摘要保存 15 分钟，绑定发起浏览器，不在 API、日志或前端构建配置中返回令牌；邮件链接用 fragment，需用户主动确认。密码使用已有 scrypt。重置会撤销全部登录会话。

第三方统一走服务端授权码交换，不信任前端提交的姓名/邮箱作为身份凭据。`provider + 应用 namespace + subject` 唯一；同邮箱不自动合并。已有用户可主动绑定第三方，已属于另一个账号的身份拒绝合并，解绑不能删掉最后一种登录方式。

| 提供商 | 已实现的协议处理 | 将来接入前还需要 |
| --- | --- | --- |
| Google | state、nonce、PKCE、RS256/JWKS、issuer/audience/expiry 验证 | OAuth client ID/secret 和回调白名单 |
| Apple | `form_post` 回调、跨站回调浏览器 proof cookie、nonce、RS256/JWKS | Services ID、签发并轮换的 client-secret JWT、域名审核 |
| 华为 | 授权码交换、nonce、RS256/JWKS | client ID/secret，并确认当前区域的 issuer 和官方 JWKS 地址 |
| 微信 | 网站应用扫码授权、服务端换 token、匹配 OpenID | 已审核网站应用 AppID/AppSecret、授权域名；**未做公众号内置浏览器登录** |
| QQ | 授权码换 token、JSON OpenID 回查及 client ID 校验 | QQ 互联 AppID/AppKey、回调白名单 |

OAuth state 一次性使用且绑定独立浏览器 proof，不能在另一个浏览器重放。凭据从服务端 `ACCOUNT_OAUTH` 配置读取，状态接口只给“可用/未配置”，不会返回 secret。HTTPX/应用访问日志会剥离授权 URL 的敏感查询参数；**上线时还须在反向代理禁记 OAuth callback 的 query string**。

示例只说明结构，不应现在启用：

```json
{"google":{"enabled":false,"client_id":"","client_secret":""},"apple":{"enabled":false,"client_id":"","client_secret":""},"huawei":{"enabled":false,"client_id":"","client_secret":"","issuer":"","jwks_uri":""},"wechat":{"enabled":false,"client_id":"","client_secret":""},"qq":{"enabled":false,"client_id":"","client_secret":""}}
```

邮件通道使用 SMTP over TLS（默认 465）；需要 SMTP_HOST/USERNAME/PASSWORD/MAIL_FROM 和 HTTPS `ACCOUNT_PUBLIC_ORIGIN`。未配置通道时不伪装发送成功。邮箱及第三方集成测试使用 fake mailer / MockTransport，不证明生产供应商审核和真实授权已经通过。

官方协议依据：[Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect)、[Apple Web 授权](https://developer.apple.com/documentation/signinwithapple/incorporating-sign-in-with-apple-into-other-platforms)、[华为授权码交换](https://developer.huawei.com/consumer/en/doc/hmscore-guides/web-get-access-token-0000001050048946)、[QQ 授权码](https://wiki.connect.qq.com/使用authorization_code获取access_token)、[QQ OpenID](https://wiki.connect.qq.com/获取用户openid_oauth2-0)。微信官方文档本次抓取不可用，适配器仅通过隔离契约测试，接入时必须以当时官方文档和审核要求复核。

## 配额语义

- `off`：默认，不产生配额账单、不拦截。
- `observe`：记录预留、消耗、失败/取消释放，不拦截。
- `enforce`：先原子预留，再执行；超过每日任务、并发或每日上传字节额度时，同步 API 返回 429；已建立的 SSE 任务流返回失败事件，不继续执行模型调用。

生产普通账号为每日 20 个成功根任务、2 个并发、100 MiB 上传；可信账号默认三倍任务额度。访客为凭据有效期内 3 轮、1 并发。轮次按主体计数、每日窗口 UTC 0 点切日，子调用不重复收取根任务轮次。

模型预算按“输入 Token + 4 × 输出 Token（缓存输入按 2%）”计量：普通账号 30 天 160 万点，共享池 1.6 亿点，作为 100 名普通用户的应用侧预算；同时执行 5 小时 20%、7 天 50% 的滚动窗口。逐次请求先保守预留再按返回用量结算，失败/中断无完整 usage 时保留预估。后台支持供应商共享预算及供应商 × 角色额度。**这是应用预算，不是供应商美元账单或套餐额度保证**；没有积分购买。完成指定所有者邮箱验证的账号免除本站用户额度，仍受上游服务及实际资源约束。

计量键为服务端生成的调用/上传 ID，不能被请求方指定。预留和结算使用数据库条件更新及唯一键，重复结算无副作用。关闭额度后仍释放已有预留。启动恢复会释放失败/取消调用及超时孤儿预留；不抹掉账单或用户数据。当前外部 AIP 入站按已认证 peer + target 主体单独计算，不把远端自报 trace 当成用户账单；一次用户任务经官方网络进入另一个本地服务时，会另记该 peer 主体的接收任务，不重复扣原用户的额度。这不是跨平台统一结算或计费系统。

## 验收与启用边界

本地测试覆盖默认公开 demo、两个同 IP 浏览器、假 cookie/header、会话与画布工具归属、群聊成员、注册/验证/密码重置/退出、OAuth 浏览器绑定和重放、签名令牌校验、并发预留与幂等结算、恢复和浏览器缓存隔离。

2026-09-30 本地验收：后端 414 项、前端 60 项通过，生产构建通过（保留现有大 chunk 提示）。390px 手机宽度下检查登录/账号态、折叠项、深浅色和横向溢出；第三方按钮在未配置时不可用。`frontend/tests/accounts.html` 为完全隔离的模拟预览，不转发真实账号写请求。

本次上线补齐文件提取工具的上传目录边界（含符号链接与同前缀目录检查），上传主动内容强制下载并使用 sandbox/nosniff，DOCX 解压正文上限 8 MiB、PDF 最多提取 100 页。它们不是完整的多租户文件沙箱、恶意文件扫描或 CPU 资源隔离。公开上传链接仍属难猜链接模型，不承诺按账号隔离下载。访客可清除凭据重新体验，3 轮不是跨设备身份识别；共享模型池仍负责总量保护。平台 Kafka 的 TLS/认证能力仍属于外部接入条件。

回退只关闭账号/额度配置，不删除表、不重写历史 owner、不重新开放私人资产。

## 界面与数字人入口（2026-09-30）

- `/login`：独立邮箱注册/登录页面；第三方未启用时隐藏。设备与绑定信息在设置的账号管理中，默认折叠。登录后通过左下角账号菜单打开居中设置浮窗，窄视口自动变为半模态。
- `/account`、`/quota`：兼容入口，分别打开设置中的账号管理与配额面板。沿用全局主题、圆角及绿色进度条；`off` 隐藏配额入口，关闭账号模块也隐藏对应管理入口。
- 工作台侧栏新增“账号与配额”；新会话菜单新增“数字人服务厅”。`/digital-human` 的复古蓝白门户样式独立隔离，不改变工作台和后台主题。

数字人使用本地待机、招手和讲解短视频及静态后备形象，朗读状态驱动讲解动作；不是逐字音素对口型服务。用户可新建咨询、切换本浏览器历史、停止答复、刷新恢复尚有服务端记录的任务。手机页面和消息列表分别可滚动，无横向挤出；没有假麦克风、假红包或假营销按钮。

数字人界面的千禧年科技蓝改版已在本地完成，尚未部署：三栏服务目录/人物/咨询窗口、玻璃渐变、斜切铭牌和静态仪表环，随可用宽度重排，工作台和设置主题不变。装饰由 CSS/SVG 绘制，不使用参考页面的标志或截图。人物背景仍为哑光，不叠加暂停按钮；系统减少动效、节省流量及不可见状态仍回退静态封面。

咨询走现有 `/api/demo/chat/stream`，使用 `interface=harness`、`mode=collaborate` 和新增的 `presentation=assistant`。新字段默认 `workspace`，普通工作台行为不变。助手模式只增加对话呈现指令；兼容模式、真实路由、工具、根/子调用归属、配额和审计继续走原管道。前端忽略工具、路由事件及中间 delta，仅在收到属于当前 session 的终态答复后显示气泡；真实失败、取消和额度错误仍有可见提示。**隐藏调用详情是界面策略，不是新的数据访问安全边界。**

咨询缓存使用固定 owner 命名空间以及独立的 `human-*` session ID；旧请求不能因全局身份变量改变而写入另一个账号缓存，换 owner 时组件重新挂载。缓存只保存可读消息、恢复所需 task ID 和 pending ID，不缓存路由/工具原始数据。此处尚无跨设备历史列表同步，不会自动迁移访客记录。

语音默认关闭，仅选择设备报告为 `localService` 的中文声音；不可用则保留文字，不回退到云端语音。没有接入麦克风或语音识别。实现依据：[SpeechSynthesis](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis)、[localService](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisVoice/localService)。形象使用内置 imagegen 生成，素材及完整提示词位于 `frontend/public/media/README.md`。

本轮隔离验收：后端 416 项、前端 70 项通过，生产构建通过。浏览器检查覆盖桌面与 390px 手机视口、深浅色登录/账号/配额、停止与恢复、跨访客缓存隔离、失败提示和隐藏调用明细。`frontend/tests/accounts.html`、`frontend/tests/digital-human.html` 拦截全部测试 API，不调用真实邮件、OAuth、模型或外部智能体。这些检查不代表线上联调或部署已经完成。

## 2026-09-30 上线记录

- 上线前完整备份已回传本地 `var/production-backups/pre-accounts-20260930T064010Z.tar.gz`；Git 忽略、目录 0700、文件 0600，含敏感配置和证书，不可上传 GitHub。服务器与本地 SHA-256 一致，离线恢复数据库 quick_check 和 19 张原表行数校验通过。
- 新版完整后端 440 项、前端 84 项通过，构建通过。12 个独立 AIP 证书入口预检通过，实际 13 个运行服务切换成功；Fluent Bit 独立服务未修改。
- 公网健康 200，账号/邮箱 enabled、quota enforce、访客剩余 3 轮、Secure Cookie、缺少 Turnstile 返回 403；5 家第三方登录均关闭。
- 生产浏览器已检查公开工作台、独立登录页、居中设置和 390px 窄屏半模态，访客配额实际显示 0/3。数字人入口可访问，待机视频 readyState=4、无媒体错误；本次未额外消费模型额度验证咨询。
- Turnstile 官方配置/密钥探测及服务端拒绝缺失令牌已通过；真实验证码交互仍等待用户动作时授权，故真实令牌首次成功与重放拒绝尚未完成，不视为端到端验收通过。
- 回退目录为 `aegismesh-release-session-activity-20260930`。当前发布目录 `deployment-backup` 保存旧 systemd override 和旧 index；数据库采用增量迁移，不自动删除历史表或重写所有者。切换前若存在运行任务会拒绝重启。
