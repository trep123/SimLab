# ADR-0001：Runtime 与控制平面的边界

状态：接受。

控制平面只保存期望状态、命令、事件和资源映射。它不挂载 libvirt socket，也不接受用户提供的 shell、XML、接口名或文件路径。独立 host-agent 通过结构化动作和由 UUID 派生的资源名执行 libvirt/OVS 操作。

开发环境使用 `development_mock`，观测质量固定为同名标签。生产设置拒绝该模式。启用 `runtime_real` 只表示选择真实适配器，最终能力仍以 G0/G1 的主机集成证据为准。
