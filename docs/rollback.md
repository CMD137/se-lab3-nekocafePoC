# Rollback

## 本地 PoC 回滚

本地环境以 `docker compose` 为主，最小回滚动作如下：

```bash
make down
make up
```

如果只需回滚应用容器而保留数据库：

```bash
docker compose stop reservation member
docker compose up -d --build reservation member
```

## Kubernetes / Helm 回滚口径

实验三的 CD 方案预留以下标准回滚命令：

```bash
helm rollback nekocafe-reservation -n prod
helm rollback nekocafe-member -n prod
```

## 自动回滚触发条件

- 预约核心接口 `P95 > 800ms` 持续 `5m`
- 关键交易错误率 `> 1%` 持续 `5m`
- 新版本 health check 连续失败 `3` 次

## 回滚后检查项

1. `healthz / readyz` 是否恢复
2. 关键 API 是否能重新返回 `2xx`
3. PostgreSQL / Redis 是否仍处于健康状态
4. 告警是否恢复为绿色
