# 网络设备真实虚拟化

SimLab 保留现有 Web 3D 机箱、端口、线缆和实验布局。运行时采用与 EVE-NG、PNETLab
相近的“设备类型 + 已批准系统镜像 + CPU/内存/磁盘/网卡规格”模型，但不导入两者的代码、
模板文件或商业镜像。两者的公开资料分别说明了 QEMU 镜像和设备模板的关系：
[EVE-NG QEMU 镜像命名](https://www.eve-ng.net/index.php/documentation/qemu-image-namings/)、
[PNETLab 设备与镜像概览](https://www.pnetlab.com/pages/documentation?slug=PNETLab-Supported-Images)。

## 当前可用能力

- 在 Web 现有设备目录选择交换机、三层交换机、路由器或防火墙时，可以绑定白名单内已有
  libvirt VM，或从当前厂商与设备类型匹配的已登记 qcow2 创建虚拟机。网络设备没有
  默认系统镜像；镜像清单为空时需要管理员导入，或先选择“暂不绑定”。
- 创建对话框按“节点模板、系统镜像、节点名称、CPU、内存、磁盘、网卡型号、接口映射”组织
  参数，可选模板默认、轻量、高性能或自定义资源规格。架构、UEFI 与 VNC 控制台显示为
  当前固定能力，不允许提交任意 QEMU 命令行；实体接口数由 3D 设备模块决定。
- 创建 VM 时前端每个 RJ45/SFP 以太网模块按面板顺序映射到独立的 `ethN` 虚拟网卡，
  最多 32 口。SFP 模块映射的是虚拟以太网，尚不模拟光模块物理层。
- 真实交换机的每条前端线缆连接到独立 OVS 网段。客体内的 Linux `br0` 桥接各口，
  因而流量必须经过 VM；交换机停机或拔线后接口载波会同步。未绑定的交换机仍采用
  原有前端仿真/宿主 OVS 教学行为，不能当作真实厂商交换机。
- 导入的厂商镜像不会自动注入通用 Linux 用户、网卡地址、路由或防火墙策略；
  网口驱动、接口名称和系统配置须按该镜像文档在客体内核对。
- 客体 VNC 通过现有鉴权 WebSocket 中继打开；在设备检视中选择“放大 VNC 画面”。
  前端交换机等网络设备没有物理屏幕，VNC 仅在放大控制台显示。
- 底部“设备调试终端”在设备已绑定且运行时，使用一次性鉴权令牌连接该 VM 的
  libvirt 串口，键盘输入与客体输出实时双向传输。未绑定设备仍明确标为
  `development_mock · 模拟 CLI`。每台设备有独立 CLI 标签；切换标签保留终端内容和连接，
  关闭标签释放对应会话，断开后可在标签内重连。已绑定但关机时需先开机；客体镜像没有串口配置或
  没有在串口启动登录服务时，需按镜像说明启用串口或使用放大的 VNC 控制台。

`ubuntu-noble-20260725` 仍是 PC/笔记本教学基础镜像的内部版本 ID：`noble` 指
Ubuntu 24.04 LTS。网络设备创建表单不再提供这个镜像。`linux-switch-profile-v1`
等 Profile 只定义运行角色、资源范围和网卡数量；厂商 CLI 取决于实际导入的镜像。

这些 Profile **不是** Cisco、华为、H3C 等厂商网络操作系统。前端相应机箱只作
物理布局与接口展示；厂商 CLI、VLAN、路由协议、防火墙策略等必须由已授权且单独
验收的镜像/模板提供。

## 从创建表单导入镜像

### 按厂商与设备类型目录发现

服务器可按下列结构放置管理员提供的镜像候选。目录只匹配到
`厂商-设备类型`（`ruijie-switch`、`ruijie-router`、`ruijie-firewall`），后续型号与版本
可自由命名并由用户在创建表单手动选。厂商目录名大小写不敏感：

```text
/var/lib/simlab/image-store/vendor/
└── Ruijie/
    ├── ruijie-switch-rg-s2910-v1/
    │   └── virtioa.qcow2
    └── ruijie-router-rsr20-v2/
        └── router-disk.qcow2
```

刷新资源池时只检查每个候选目录是否**恰有一个** `.qcow2` 文件；没有文件或存在多块
磁盘时会提示修正。文件名不限，但当前虚拟机模板仍固定 virtio 磁盘，厂商镜像必须
实际支持该总线；EVE-NG 的 `hda.qcow2` 命名可能代表不同磁盘控制器，不能据文件名
假定与本模板兼容。
目录及文件由宿主管理员放置，API 服务用户需要只读权限；禁止软链接。
打开对应设备的创建表单并刷新资源池，即可看到是否找到匹配目录。管理员点击
“登记此镜像”后，平台会执行与上传相同的格式、容量、SHA-256 检查和 Command 审计，
将不可变副本放入 `/var/lib/simlab/image-store/imported/<sha256>/base.qcow2`。
发现目录只表示候选存在；**名称匹配不等于厂商 NOS 兼容性已验收**。需核对镜像授权、
启动方式、串口、网卡驱动和设备接口语义。此目录方案借鉴
[EVE-NG 官方 QEMU 镜像目录命名](https://www.eve-ng.net/index.php/documentation/qemu-image-namings/)，
但不直接读取 EVE-NG 的 `/opt/unetlab/addons/qemu` 或导入其模板。

登记时镜像会绑定 `vendor_id` 与设备类型，用户在相同厂商类型的镜像清单中手动选择
详细型号；后端拒绝跨厂商或跨类型创建。网络设备没有 Ubuntu 默认项。创建表单还可
指定 1–20 台及起始节点名，例如 `router1` 或 `R1`，系统跳过实验中已有名称并递增；
批量创建逐台执行，失败时保留已成功的设备并显示完成数量。

管理员登录后，在“创建新虚拟机”的“导入系统镜像”区选择本机 `.qcow2` 文件、填写
显示名称并点击“导入镜像”。上传完成后，新镜像会出现在当前设备类型的“系统镜像”
下拉框；再按 CPU、内存、磁盘、网卡型号等规格创建节点。非管理员可选择已登记镜像，
不能上传。上传和登记会留下 `runtime.image.import` 命令记录。

目前只支持 **8 GiB 以内、虚拟容量 4–64 GiB、无 backing、无加密、无外部数据文件**
的独立 qcow2。运行模板固定为 x86_64/Q35、UEFI、virtio 磁盘和 VNC；客体镜像本身
必须支持这些条件。导入时检查格式并计算 SHA-256；Host Agent 创建实例时再次校验
哈希，差异盘 backing 指向只读镜像。镜像存放于
`/var/lib/simlab/image-store/imported/<sha256>/base.qcow2`，不进入源码包。
导入镜像不会被写入 `simlab` 账号、Linux 桥、路由或网卡配置。前端 `ethN` 是 libvirt
虚拟网卡别名，厂商系统内的接口名称及启动配置须按该镜像说明手工核对。

格式校验不能保证厂商 NOS 能启动或正常关机；镜像许可、系统凭据、BIOS/UEFI 支持、
网卡驱动和厂商功能均需管理员逐镜像验收。若客体不响应正常关机，运行时的
`GUEST_SHUTDOWN_TIMEOUT` 表示仍在运行，应先在客体内关机或由管理员执行受控强制关机。

## 控制台账号

真实模式的一键部署脚本为通用网络设备生成每台宿主共用的教学控制台口令，
只把密码文件放在 `/etc/simlab/appliance-console-password`，Host Agent 读取 SHA-512
哈希并写入每台新客体的 cloud-init seed。宿主管理员可通过以下命令读取并安全地
交付给实验用户；不要把密码写进实验文档或源码包：

```bash
sudo cat /etc/simlab/appliance-console-password
```

客体用户名为 `simlab`。更改宿主密码只影响之后新建的 VM，已创建 VM 的 guest 密码
仍由其原始 cloud-init seed 决定。若手工部署 Host Agent，需在
`/etc/simlab/host-agent.env` 配置 `SIMLAB_APPLIANCE_PASSWORD_HASH`，否则该账号默认锁定。

## 已有厂商虚拟机绑定

不符合上述导入模板但已由管理员配置好的厂商 VM，仍可绑定已有 libvirt domain。
SimLab 不下载或再分发厂商镜像。关机后核对 VM 网卡数量与前端实体以太网口数量完全一致，再在控制平面
`/etc/simlab/app.env` 配置 `SIMLAB_NETWORK_EXTERNAL_DOMAINS`，格式例如：

```dotenv
SIMLAB_NETWORK_EXTERNAL_DOMAINS=vendor-sw:switch,vendor-router:router,vendor-fw:firewall
```

同时在 Host Agent 的 `/etc/simlab/host-agent.env` 白名单中写入这些 domain 名称：

```dotenv
SIMLAB_EXTERNAL_DOMAINS=vendor-sw,vendor-router,vendor-fw
```

随后重启 `simlab-host-agent`、`simlab-api`、`simlab-worker`，在前端刷新虚拟机资源池。
已有 domain 的操作系统登录凭据仍由该镜像及管理员提供；平台不推测或重置密码。
删除前端设备只关闭、解绑这种外部 VM，不删除其镜像和 domain。

## 验收边界

真实 Runtime 必须先通过 `python3 ops/linux/preflight.py`。已在本机通过预检，并用
临时 VM 验证 26 网口 libvirt 定义/启动、两个独立 OVS 端口接线，以及三台 VM 中
流量经过交换机客体 `br0` 的跨网口 ping。另用隔离 VM 验证了导入镜像成为差异盘
backing、启动/强制停止，以及不注入通用 Linux 配置；临时资源已清理。完整网络设备验收仍应逐镜像做启动、
控制台、客体端口枚举、转发、断线和重启恢复测试。当前没有内置厂商镜像导入审批、
VLAN/Trunk 到客体的配置通道，也没有把客户提供的厂商镜像称为已认证。
