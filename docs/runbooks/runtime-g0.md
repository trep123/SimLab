# G0 Runtime Gate 运行手册

当前主机已安装并验证 QEMU/KVM、libvirt、Open vSwitch、cloud-init、noVNC 和 websockify。G0 使用两台真实 Ubuntu 24.04 LTS VM，通过无宿主 IP 的专用 OVS bridge 通信。

## 安装 Runtime Host

以下命令会通过 Ubuntu 软件仓库安装宿主机组件并启用 libvirt/OVS：

```bash
sudo ops/linux/install_runtime.sh
```

安装后只读预检应显示 `passed: true`：

```bash
python3 ops/linux/preflight.py --json docs/poc/preflight-result.json
```

## 拉取并校验基础镜像

镜像脚本使用 Ubuntu 官方固定发布目录，不使用滚动 `current` 链接。文件不会写入仓库。

```bash
sudo ops/linux/fetch_g0_image.sh
```

登记信息：

- 发布：Ubuntu 24.04 LTS `release-20260725`
- 官方页面：<https://cloud-images.ubuntu.com/releases/noble/release-20260725/>
- 镜像：`ubuntu-24.04-server-cloudimg-amd64.img`
- SHA256：`d1940f7d69d343355e183dff1e08a59852d32e7309baa7a4bad8365b11b005ac`
- 本地只读路径：`/var/lib/simlab/image-store/ubuntu-noble-20260725/base.qcow2`

平台不提交或再分发该镜像；管理员必须继续保留来源与许可记录。

## 执行真实 G0

```bash
read -rsp 'G0 客体密码: ' SIMLAB_G0_GUEST_PASSWORD && echo
read -rsp 'G0 VNC 密码（最多 8 字符）: ' SIMLAB_G0_NOVNC_PASSWORD && echo
export SIMLAB_G0_GUEST_PASSWORD SIMLAB_G0_NOVNC_PASSWORD
sudo --preserve-env=SIMLAB_G0_GUEST_PASSWORD,SIMLAB_G0_NOVNC_PASSWORD \
  python3 ops/linux/g0_runtime_gate.py \
  --image /var/lib/simlab/image-store/ubuntu-noble-20260725/base.qcow2 \
  --sha256 d1940f7d69d343355e183dff1e08a59852d32e7309baa7a4bad8365b11b005ac \
  --evidence docs/poc/g0-evidence.json \
  --keep
```

脚本只管理以下固定资源：

- libvirt Domain：`simlab-g0-pc1`、`simlab-g0-pc2`
- OVS bridge：`simlab-g0`
- Runtime 目录：`/var/lib/simlab/runtime-data/g0`
- 本机 noVNC 服务：`simlab-g0-novnc.service`

Gate 会从 PC1 的真实串口登录 Guest，依次验证初始 `NO-CARRIER`、接线后的 PC1→PC2 ping、拔线后的通信中断、重连恢复和 MAC 不变。每台 VM 使用独立 overlay、cloud-init seed 和 UEFI NVRAM。

## noVNC

noVNC 只监听 `127.0.0.1:6080`，VNC 目标只监听 `127.0.0.1:5905`。在 Runtime Host 本机打开：

```text
http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale
```

远程访问时使用 SSH 隧道，不要把 6080/5905 暴露到公网：

```bash
ssh -L 6080:127.0.0.1:6080 <runtime-host>
```

浏览器检查：通过 SSH 隧道打开本机 noVNC 地址，确认画布出现客体画面并可操作。
将测试结果保存在本机 `docs/poc/`，不要提交会话画面或凭据。

当前 noVNC 是本机 G0 诊断入口，连接时输入运行 Gate 时设定的 VNC 密码。
生产应用仍需实现用户鉴权、实验归属校验、短期令牌、TLS 和输入审计。

## 查看与清理

```bash
virsh -c qemu:///system list --all
ovs-vsctl show
systemctl status simlab-g0-novnc.service
```

清理只针对上述固定名称：

```bash
sudo python3 ops/linux/g0_runtime_gate.py --cleanup-only
```

基础镜像保留在 image-store，不随实验 Runtime 清理。
