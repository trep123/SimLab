# 真实 Host Agent 运行手册

## 安装与更新

先完成 G0 镜像登记，再安装服务：

```bash
sudo ops/linux/fetch_g0_image.sh
sudo ops/linux/install_host_agent.sh
```

安装脚本创建专用 `simlab-runtime` 系统用户、`simlab` 控制组和
`simlab-ovs` 数据平面组。服务不以 root 身份运行；它通过 `libvirt`、`kvm`、
`libvirt-qemu` 组、OVS DB 专用组和 `CAP_NET_ADMIN` 获得限定宿主能力。

控制服务账号需要加入 `simlab` 组，重新登录或重启对应服务后权限才生效：

```bash
sudo usermod -aG simlab <api-worker-user>
```

控制平面配置：

```text
SIMLAB_RUNTIME_MODE=runtime_real
SIMLAB_HOST_AGENT_SOCKET=/run/simlab/host-agent.sock
SIMLAB_HOST_AGENT_TIMEOUT_SECONDS=180
```

## 安全边界

- Unix Socket 为 `simlab-runtime:simlab`、模式 `0660`，没有 TCP 监听。
- 请求只接受固定 JSON schema、UUID、Profile、资源范围和动作枚举。
- 请求不能提交宿主路径、libvirt XML、shell、OVS argv 或未知字段。
- domain、TAP、bridge、MAC 和运行目录均从 UUID 推导。
- domain metadata 与 OVS `external_ids:simlab-owner` 必须匹配后才允许修改或删除。
- SQLite journal 按 `operation_id + request hash` 防重；相同操作复用结果，冲突请求拒绝。
- 基础镜像在 agent 启动时验证固定 SHA-256 和只读权限。

## 真实验证

Agent 到 libvirt/OVS：

```bash
sudo ops/linux/host_agent_probe.py \
  --evidence docs/poc/host-agent-evidence.json
```

Django Command 到 Agent：

```bash
DJANGO_SETTINGS_MODULE=config.settings.local \
  .venv/bin/python backend/manage.py migrate

sudo .venv/bin/python ops/linux/control_plane_runtime_probe.py
```

登记受支持的设备版本并核对证据：

```bash
SIMLAB_RUNTIME_MODE=runtime_real \
  DJANGO_SETTINGS_MODULE=config.settings.local \
  .venv/bin/python backend/manage.py register_runtime_catalog

SIMLAB_RUNTIME_MODE=runtime_real \
  DJANGO_SETTINGS_MODULE=config.settings.local \
  .venv/bin/python backend/manage.py verify_runtime_loop \
  --host local --image-release ubuntu-noble-20260725
```

两个 probe 都使用随机 UUID，最后通过相同 Agent API 精确删除临时 VM、overlay 和
OVS bridge，不扫描或按前缀删除其他资源。

## 运维检查

```bash
systemctl status simlab-host-agent --no-pager
stat -c '%U %G %a %n' /run/simlab/host-agent.sock
journalctl -u simlab-host-agent.service --since '-15 minutes' --no-pager
```

当前批准的 `linux-cloud-profile-v1` 使用官方 Ubuntu cloud image。该镜像未预装
`qemu-guest-agent`，因此当前 profile 不声明 QGA readiness 或桌面能力。Guest 内真实
通信和载波变化由 G0 串口证据验证；应用鉴权 noVNC/串口网关属于后续 TSK-012。
