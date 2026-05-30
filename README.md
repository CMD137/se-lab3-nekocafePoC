# NekoCafe

> NekoCafe 智慧餐饮预约平台 - 实验三 DevOps PoC 仓库

## 技术边界

- PoC 服务：`reservation-service` + `member-service`
- 技术基线：`Express + PostgreSQL + Redis + JWT`
- 异步基线：沿用 `RocketMQ-compatible outbox` 口径，当前 PoC 仍以同步主链为主
- API 契约：对齐实验二 `D2-5` 的预约服务与会员服务 OpenAPI
- 可观测性：集成 OpenTelemetry SDK，输出 metrics / traces / logs 三类信号
- 本地渐进式发布：使用 `Traefik weighted routing + Prometheus watcher` 演示金丝雀发布与自动回滚
- 环境清单：仓库内同时保留 `Kustomize overlays (dev / staging / prod)` 作为 Kubernetes 目标态交付

## 仓库结构

```text
nekocafe/
|-- README.md
|-- docker-compose.yml
|-- docker-compose.observability.yml
|-- docker-compose.cd-demo.yml
|-- Makefile
|-- .env.example
|-- scripts/
|   |-- generate-jwt.mjs
|   |-- smoke.mjs
|   |-- loadgen.mjs
|   |-- set-canary-weight.mjs
|   |-- rollback-canary.mjs
|   `-- watch-canary.mjs
|-- services/
|   |-- reservation/
|   `-- member/
|-- infra/
|   |-- observability/
|   |-- cd/
|   `-- kustomize/
|-- .github/workflows/
`-- docs/
```

## 本地准备

### 1. 复制环境变量

PowerShell:

```powershell
Copy-Item .env.example .env
```

Bash:

```bash
cp .env.example .env
```

### 2. 安装依赖

```bash
make deps
```

## 基础 PoC 启动

```bash
make up
```

如需同时拉起 RocketMQ nameserver / broker：

```bash
make up-mq
```

## 基础验证

### 1. 生成开发态 JWT

```bash
node scripts/generate-jwt.mjs
```

### 2. 运行 smoke

```bash
make smoke
```

该命令会自动：

- 读取本地 `.env`
- 生成开发态 JWT
- 校验 `reservation` / `member` 的 `healthz`
- 调用预约余位与会员档案接口

### 3. 运行测试

```bash
npm --prefix services/reservation run lint
npm --prefix services/reservation test
npm --prefix services/member run lint
npm --prefix services/member test
```

当前路由级自动化覆盖的主要端点包括：

- `reservation-service`：`healthz`、余位查询、预约列表、创建预约、查询单条预约、确认、取消、改期、到店核销、候补登记
- `member-service`：`healthz`、会员档案、偏好更新、权益列表、权益核销、积分流水、隐私导出、隐私删除

## 可观测性启动

在基础 PoC 已经可启动的前提下，再叠加观测栈：

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

启动后可访问：

- Grafana: `http://localhost:3000` (`admin / admin`)
- Prometheus: `http://localhost:9090`
- Tempo: `http://localhost:3200`

Grafana 已预置 `NekoCafe PoC Overview` Dashboard，包含至少 4 个面板：

- Reservation QPS
- Reservation P99 Latency
- Reservation Error Rate
- Container Memory Usage

## 本地金丝雀 / 自动回滚演示

### 1. 启动基础服务 + 观测栈 + 金丝雀演示栈

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml -f docker-compose.cd-demo.yml up -d --build
```

其中：

- `reservation-stable` 承担稳定流量
- `reservation-canary` 承担灰度流量
- `traefik` 在 `http://localhost:8080` 提供 95 / 5 的加权转发

### 2. 调整金丝雀权重

```bash
node scripts/set-canary-weight.mjs 95 5
```

### 3. 启动自动回滚 watcher

```bash
node scripts/watch-canary.mjs
```

默认回滚阈值：

- `P95 > 800ms`
- `5xx error rate > 1%`

### 4. 一键回滚

```bash
node scripts/rollback-canary.mjs
```

### 5. 生成 Dashboard 流量

```bash
node scripts/loadgen.mjs <bearerToken>
```

如果需要演示“坏版本触发自动回滚”，可在 `.env` 中调高：

```text
CANARY_INJECT_LATENCY_MS=1200
CANARY_ERROR_RATE_PERCENT=5
```

然后重新启动 `reservation-canary` 并观察 Grafana 与 watcher 输出。

## Kustomize 目标态

仓库内额外提供了 Kubernetes 目标态清单：

- `infra/kustomize/overlays/dev`
- `infra/kustomize/overlays/staging`
- `infra/kustomize/overlays/prod`

设计要点：

- `dev`：单副本，便于联调
- `staging`：引入 `reservation-canary` 与 NGINX Ingress `canary-weight: 5`
- `prod`：保留相同金丝雀策略，并扩大 stable / member 副本数

可本地渲染：

```bash
kubectl kustomize infra/kustomize/overlays/dev
kubectl kustomize infra/kustomize/overlays/staging
kubectl kustomize infra/kustomize/overlays/prod
```

## Monorepo 取舍说明

本实验选择 `Monorepo`，原因如下：

- 两个 PoC 服务共享同一套 DevOps 规则、环境变量约定与本地起栈方式
- CI/CD 可以在一个仓库内串联 `lint -> unit test -> build -> scan -> smoke`
- 实验三重点在端到端工程链路，而不是仓库拆分治理

## 关键说明

- `PostgreSQL` 负责核心交易数据，两个服务通过独立 schema 隔离
- `Redis` 负责预约锁位与热点读
- `RocketMQ` 当前仍通过 outbox 兼容结构预留，不宣称已完成真实收发
- 所有敏感项均通过 `.env`、GitHub Secrets 或 K8s Secret 注入
- `Traefik + watcher` 是本地演示版渐进式发布实现；`Kustomize overlays` 是 Kubernetes 目标态交付
