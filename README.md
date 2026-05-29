# NekoCafé

> NekoCafé 智慧餐饮预约平台 - 实验三 DevOps PoC 仓库

## 技术边界

- PoC 服务: `reservation-service` + `member-service`
- 技术基线: `Express + PostgreSQL + Redis + JWT`
- 异步基线: 采用 `RocketMQ-compatible outbox` 设计，默认本地栈先跑同步链路，消息队列通过 `mq` profile 补齐
- API 契约: 对齐实验二 `D2-5` 的预约服务与会员服务 OpenAPI

## 仓库结构

```text
nekocafe/
|-- README.md
|-- docker-compose.yml
|-- Makefile
|-- .env.example
|-- scripts/
|   `-- generate-jwt.mjs
|-- services/
|   |-- reservation/
|   `-- member/
|-- infra/
|   `-- observability/
|-- .github/workflows/
`-- docs/
```

## 本地启动

### 1. 准备环境变量

PowerShell:

```powershell
Copy-Item .env.example .env
```

Bash:

```bash
cp .env.example .env
```

### 2. 启动本地 PoC

先安装依赖:

```bash
make deps
```

再启动容器:

```bash
make up
```

如需同时拉起 RocketMQ nameserver / broker：

```bash
make up-mq
```

## 本地验证

### 1. 生成开发 JWT

```bash
node scripts/generate-jwt.mjs
```

将返回的 token 设置到环境变量:

PowerShell:

```powershell
$env:ACCESS_TOKEN = "替换为生成结果"
```

Bash:

```bash
export ACCESS_TOKEN="替换为生成结果"
```

### 2. 健康检查

```bash
curl http://localhost:8081/healthz
curl http://localhost:8082/healthz
```

### 3. 预约服务示例

```bash
curl -X GET "http://localhost:8081/reservation/v1/availability?storeId=STORE-BJ-001&date=2026-05-10&partySize=4" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

```bash
curl -X POST "http://localhost:8081/reservation/v1/reservations" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "CUS-10086",
    "storeId": "STORE-BJ-001",
    "partySize": 4,
    "seatPreference": "quiet",
    "timeSlot": {
      "startTime": "2026-05-10T10:30:00Z",
      "endTime": "2026-05-10T12:00:00Z"
    }
  }'
```

### 4. 会员服务示例

```bash
curl -X GET "http://localhost:8082/member/v1/members/MEM-220501208" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

## 运行测试

```bash
make test
```

当前路由级自动化覆盖的主要端点包括:

- `reservation-service`: `healthz`、余位查询、预约列表、创建预约、查询单条预约、确认、取消、改期、到店核销、候补登记
- `member-service`: `healthz`、会员档案、偏好更新、权益列表、权益核销、积分流水、隐私导出、隐私删除

## Smoke 验证

在 `make up` 成功后，可直接运行:

```bash
make smoke
```

该命令会自动:

- 读取本地 `.env`
- 生成开发态 JWT
- 校验 `reservation` / `member` 的 `healthz`
- 调用预约余位与会员档案接口

## Monorepo 取舍说明

本实验选择 `Monorepo`，原因如下：

- 两个 PoC 服务共享一套 DevOps 规则、环境变量约定与本地起栈方式
- CI/CD 可以在一个仓库内串联 `lint -> unit test -> build -> smoke`
- 实验三重点在端到端工程链路，而不是仓库拆分治理

## 关键说明

- `PostgreSQL` 负责核心交易数据，两个服务通过独立 schema 隔离
- `Redis` 负责预约锁位与余位缓存
- `RocketMQ` 在本地仓库中通过 outbox 兼容设计预留，后续可接实验四的异步集成测试
- 所有敏感项均通过 `.env` 注入，不在代码内硬编码
