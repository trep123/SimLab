# 开发运行手册

本地模式使用 SQLite 与内存 Channels layer，适合 API、领域规则和 3D 交互开发。页面顶部显示 `可视仿真 · DEV MOCK`。

生产设置要求 PostgreSQL、Redis 与 `SIMLAB_RUNTIME_MODE=runtime_real`；缺少任一项时启动检查失败。API 与 Worker 使用普通账号。host-agent 单独部署，且只接受平台生成的实验 UUID、动作枚举和资源清单。

重置本地演示数据可删除 `runtime-data/simlab.sqlite3` 后重新迁移。不要对真实环境目录执行此步骤。
