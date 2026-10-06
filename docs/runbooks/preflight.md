# Runtime Host 预检

在 Ubuntu 24.04 x86_64 目标机运行 `python3 ops/linux/preflight.py`。脚本只读取环境，不安装软件、不修改权限、不创建网络。

通过条件：x86_64、`/dev/kvm` 可读写、libvirt 服务可访问、QEMU、Open vSwitch、`qemu-img`、`virsh` 和 `ovs-vsctl` 均可执行。失败项会给出稳定错误码并使进程返回 1。

预检通过仍不代表 G0 通过。G0 还需要管理员提供有合法来源的基础镜像，随后执行两台 VM、独立 overlay/NVRAM、OVS 接线、载波变化和清理测试，并把原始观测写入 `docs/poc/g0-evidence.json`。

当前主机已于 2026-10-04 通过预检和 G0。完整复现、noVNC 访问与清理方法见 [G0 Runtime Gate](runtime-g0.md)。

真实控制平面接入、专用服务身份与权限检查见 [Host Agent 运行手册](host-agent.md)。
