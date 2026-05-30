# Rollback

## 本地 PoC 回滚

如果只是基础 PoC 服务异常，最小回滚动作如下：

```bash
make down
make up
```

如果只需要重建应用容器而保留数据库：

```bash
docker compose stop reservation member
docker compose up -d --build reservation member
```

## 本地金丝雀一键回滚

本地渐进式发布演示采用 Traefik 加权流量切分，因此一键回滚命令为：

```bash
node scripts/rollback-canary.mjs
```

该脚本会把 `reservation-stable / reservation-canary` 权重改为 `100 / 0`，使全部流量回到稳定版本。

## 自动回滚触发条件

默认阈值如下：

- 预约核心接口 `P95 > 800ms` 且持续观察窗口仍超阈值
- 预约服务 `5xx error rate > 1%`

自动回滚 watcher：

```bash
node scripts/watch-canary.mjs
```

## Kubernetes / Kustomize 目标态回滚口径

对于 Kubernetes 目标态，可按以下方式回退：

1. 将 `staging / prod` overlay 中的 canary 权重改回 `0`
2. 重新执行：

```bash
kubectl apply -k infra/kustomize/overlays/staging
kubectl apply -k infra/kustomize/overlays/prod
```

## 回滚后的检查项

1. `healthz / readyz` 是否恢复
2. 关键 API 是否重新返回 `2xx`
3. Prometheus 中的 P95 与错误率是否回落
4. Grafana Dashboard 是否恢复绿色趋势
