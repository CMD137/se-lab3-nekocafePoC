# Infra

本目录保存与 D3-2 仓库直接相关的基础设施说明与最小配置。

- `observability/alerts.yaml`: 供 D3-6 直接引用的告警规则草案
- Helm Chart 正式模板保留在兄弟目录 `D3-5_K8s部署清单与Helm_Chart/helm`

这样处理的目的是让 D3-2 聚焦“可运行 PoC 仓库”，而将正式 Helm 交付仍保持在 D3-5 模板目录中。
