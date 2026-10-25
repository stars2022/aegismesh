# 生产智能体端口

2026-10-25 只读核对生产进程环境、数据库名称、systemd 状态及监听套接字。以下 12 个服务均为 active，端口均在监听；这不是业务任务执行或端到端调用成功的证明。

公开主机名为 `aip.demmo.cc.cd`，当前解析至生产服务器 `34.150.109.119`。RPC 地址形式为 `https://aip.demmo.cc.cd:<端口>/aip/<ID>/rpc`，要求现有 mTLS 身份验证；不要改用裸 IP 绕过证书主机名校验。

| 智能体 | ID | HTTPS/mTLS 端口 |
| --- | --- | --- |
| 旅行规划与行程协调智能体 | `travel_coordinator` | 8450 |
| 名胜古迹与文化导览智能体 | `heritage_guide` | 8451 |
| 地方美食与餐饮推荐智能体 | `food_guide` | 8452 |
| 出行交通与预算智能体 | `travel_logistics` | 8453 |
| 新闻研判与简报协调智能体 | `news_coordinator` | 8454 |
| 新闻检索与摘要智能体 | `news_retrieval` | 8455 |
| 事件时间线与背景梳理智能体 | `news_timeline` | 8456 |
| 信息来源与事实核验智能体 | `news_verification` | 8457 |
| 科研智能体协作工作台 | `research_leader` | 8458 |
| 文献检索与知识综述智能体 | `docs_overview` | 8459 |
| 研究设计与数据分析智能体 | `empirical_design` | 8460 |
| 论文评审与学术写作智能体 | `peer_review` | 8461 |

每个智能体由 `aegismesh-aip-agent@<ID>.service` 独立监听。网页入口为 `https://demmo.cc.cd` 的 443；业务 API 内部监听 `127.0.0.1:8000`，经 Nginx 代理，与独立 AIP 端口不同。

早期文档中的科研端口 8443–8446 是历史记录，不应作为当前部署配置。新测试服务器 `111.91.23.163` 为独立空白部署，没有迁入这些生产身份和端口；不能把上述列表套用到测试服务器。
