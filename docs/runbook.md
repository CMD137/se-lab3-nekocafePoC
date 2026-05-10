# Runbook

## 适用范围

本手册用于实验三本地 PoC 的常见排障，覆盖 `reservation-service`、`member-service`、`PostgreSQL`、`Redis` 以及可选 `RocketMQ` profile。

## 服务异常时的最小定位顺序

1. 先看 `docker compose ps`，确认容器是否都为 `healthy` 或 `running`
2. 再看 `docker compose logs reservation member --tail 200`
3. 如果是接口异常，优先定位响应体中的 `traceId`
4. 用 `traceId` 检索结构化日志，确认失败节点、接口路径和错误码

## 常见问题

### 1. `401 Unauthorized`

- 检查请求头是否包含 `Authorization: Bearer <token>`
- 重新运行 `node scripts/generate-jwt.mjs` 生成开发 token
- 检查 `.env` 中的 `JWT_SECRET` 是否被误改

### 2. `409 RESERVATION_CONFLICT`

- 表示 Redis 锁位或预约状态冲突
- 先检查是否重复创建相同时间段预约
- 如需清理本地状态，可执行 `make down` 后重新 `make up`

### 3. `503 Service not ready`

- 检查 `postgres`、`redis` 健康状态
- 检查容器内数据库连接参数是否与 `.env` 一致

### 4. RocketMQ profile 未启动

- 默认 `make up` 不启动消息队列
- 如需验证异步基础设施，请改用 `make up-mq`

## 指标与阈值

- 接口错误率预警阈值: `> 1%`，持续 `5m`
- 预约接口 P95 预警阈值: `> 800ms`，持续 `5m`
- 容器 CPU 预警阈值: `> 80%`，持续 `10m`

## 建议留痕

- 故障描述
- 触发时间
- 影响接口
- `traceId`
- 处置动作
- 恢复时间
