# Infra

本目录保存与 `D3-2` 仓库直接相关的基础设施配置。

## 子目录说明

- `observability/`
  - `alerts.yaml`：Prometheus 告警规则，当前至少包含 P95、错误率、CPU、服务不可达 4 条规则
  - `prometheus/`：Prometheus 抓取配置
  - `grafana/`：Grafana 数据源与 Dashboard 预置
  - `otel-collector/`：OpenTelemetry Collector 配置
  - `tempo/`：Tempo 配置
- `cd/`
  - `traefik/`：本地金丝雀流量切分配置
- `kustomize/`
  - `base/`：基础 Deployment / Service / Ingress
  - `overlays/dev|staging|prod`：环境差异化清单

## 设计口径

- `D3-2` 聚焦“可运行 PoC 仓库”
- 本地渐进式发布演示采用 `Traefik weighted routing + Prometheus watcher`
- Kubernetes 目标态交付采用 `Kustomize overlays`
- 旧的 `D3-5` Helm 目录仍可作为课程模板留存，但当前仓库里真正可演进的环境清单以 `kustomize/` 为准
