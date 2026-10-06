# 6. Runtime 接口、QEMU/libvirt、OVS 与端点编译

本节定义后台怎样把领域状态转成真实执行对象。这里的代码、XML 和数据路径均是待实现契约，不代表已经部署或验证。第一版运行主机固定为 Linux；Windows/macOS 浏览器作为客户端。API、Channels、Celery 不持有创建 TAP、修改 OVS、启动虚拟机等宿主权限，所有此类操作由 `LinuxHostAgent` 执行。

## 6.1 运行单元、设备绑定与控制归属

`runtime_unit_id` 是全项目统一的运行单元标识，替代含义不明确的 `runtime_id`。运行单元可以是一台 VM、一台可见的软件交换机，或包含多台无线设备的一个 ns-3 scenario；不能假定一个设备永远对应一个后台进程。

领域层至少保存以下对象：

| 对象 | 必要字段与约束 |
|---|---|
| `RuntimeUnit` | `id, experiment_id, host_id, backend, unit_kind, spec_version, spec_hash, runtime_generation, desired_state, observed_state, capability_profile_id`；`unit_kind` 为 `device` 或 `scenario` |
| `DeviceRuntimeBinding` | `device_id, runtime_unit_id, role, backend, member_key`；同一设备可有多个不同 role，同一 scenario 可绑定多个设备 |
| `PortEndpoint` | `device_port_id, runtime_unit_id, member_key, endpoint_kind, media, frame_boundary, capability_profile_id, runtime_generation`；端点的领域 ID 稳定，内核接口索引只是一次运行中的发现结果 |
| `EndpointAttachment` | `device_port_id, domain_uuid, interface_alias, mac, pci_address, tap_name, tap_ifindex, ovs_bridge, ovs_port_uuid, ovs_ofport, netns_name, runtime_generation`；后端不适用的字段为空，禁止用空字符串假冒有效映射 |
| `LinkBinding` | `cable_id, experiment_id, source_device_port_id, target_device_port_id, endpoint_a, endpoint_b, dataplane_plan_hash, applied_config_revision, observed_state` |

设备 Manifest schema 固定为 1.1，使用 `release_version` 和 `runtime_profiles[{role, profile_release_id}]`；端口定义用模型内稳定 `port_key`（如 eth0）及 `connector_type`。设备实例生成 UUID `device_port_id`，用于接线、数据库约束与 runtime 绑定。Experiment 的 `generation` 表示冷恢复/全实验重建代，`config_revision` 表示有效配置变化，`control_epoch` 表示执行控制代；Event/state 带 generation、config_revision 与 seq。运行单元局部重建可另使用 runtime_generation，不能用它替代实验代次。

例如一台带 Wi-Fi 的路由器，可以有 `guest_os → QemuAdapter`、`radio → Ns3Adapter` 两个绑定；AP 的有线桥接、路由、DHCP 服务可以运行于 VM 或经验收的 Linux 网络节点，射频端口绑定 ns-3 节点。把整个 AP 标成 `backend=ns3` 并不能自动提供真实 Linux 的无线管理界面和 DHCP 服务。

管理权必须唯一：

- `QemuAdapter` 通过 libvirt 管理 Domain 的创建、启动、关机、设备配置、链路载波和恢复。`virsh` 仅用于同一 libvirt 管理路径的诊断与复现，不构成另一套状态来源。
- QMP 默认只读查询。确需使用 libvirt 尚未覆盖的功能时，只允许经过版本与 profile 验收的白名单，而且必须确认不修改 libvirt 正在管理的状态；不得额外连接 libvirt 占用的 monitor socket。
- `OvsSwitchAdapter` 管理用户看得见的交换机，`FabricService` 管理隐藏端点、线缆和承载。二者共享 Host Agent 的资源注册表，不能各自删除或重命名对方资源。
- `Ns3Adapter` 管理 scenario 的进程和生命周期，成员节点的移动、信道和电源由无线能力接口控制，不因关闭一个 Laptop 就终止整个 scenario。
- `OpticalAdapter`、`RadioAdapter` 管理各自模型状态和真实帧入口。领域 Command 由执行计划选择正确 role；不得把一个 `device.force_off` 无差别广播给所有共享运行单元。

libvirt 官方指出，QMP 修改其已追踪状态可能破坏管理一致性；因此这里明确选择 libvirt 单一所有者，而不是把两种控制手段任意混用。参见 [libvirt QEMU monitor API](https://libvirt.org/html/libvirt-libvirt-qemu.html#virDomainQemuMonitorCommand)。

## 6.2 统一接口契约与可选能力

所有 backend 使用下列同名最小接口。后端实现类固定使用 `QemuAdapter`、`OvsSwitchAdapter`、`Ns3Adapter`、`OpticalAdapter`、`RadioAdapter`，保持这一命名。

```python
from dataclasses import dataclass
from typing import Literal, Mapping, Protocol

@dataclass(frozen=True)
class OperationContext:
    command_id: str
    experiment_id: str
    generation: int
    config_revision: int
    control_epoch: int
    runtime_unit_id: str
    expected_runtime_generation: int
    idempotency_key: str
    spec_hash: str
    timeout_ms: int

@dataclass(frozen=True)
class AdapterResult:
    outcome: Literal['completed', 'pending', 'failed']
    operation_token: str | None
    observed: Mapping[str, object]
    error_code: str | None
    retryable: bool

class RuntimeAdapter(Protocol):
    async def validate_spec(self, spec: Mapping[str, object]) -> Mapping[str, object]: ...
    async def provision(self, ctx: OperationContext, spec: Mapping[str, object]) -> AdapterResult: ...
    async def start(self, ctx: OperationContext) -> AdapterResult: ...
    async def request_shutdown(self, ctx: OperationContext) -> AdapterResult: ...
    async def force_off(self, ctx: OperationContext) -> AdapterResult: ...
    async def get_state(self, runtime_unit_id: str) -> Mapping[str, object]: ...
    async def collect_metrics(self, runtime_unit_id: str) -> Mapping[str, object]: ...
    async def destroy(self, ctx: OperationContext) -> AdapterResult: ...
```

`validate_spec` 检查架构、镜像 profile、资源上限、支持的接口类型和宿主能力，不创建进程。`provision` 分配独立磁盘、Domain 定义或 scenario 配置，默认保持停止。`start` 只负责运行单元启动；返回 `completed` 不代表来宾 OS、IP 或业务服务已经就绪。`request_shutdown` 是正常停止请求，允许返回 `pending`；`force_off` 是明确的非协作停止；`destroy` 清理资源，默认只接受已停止对象，活跃对象必须先完成停止操作。

下面能力独立注册，接口存在不意味着 profile 一定支持。后台根据实际能力决定是否展示按钮；不支持时返回确定的 `CAPABILITY_UNSUPPORTED`，不得用空实现返回成功。

```python
class LinkProvider(Protocol):
    async def set_link(self, ctx: OperationContext, device_port_id: str, up: bool) -> AdapterResult: ...

class ResetProvider(Protocol):
    async def restart(self, ctx: OperationContext) -> AdapterResult: ...
    async def reset(self, ctx: OperationContext) -> AdapterResult: ...

class ConsoleProvider(Protocol):
    async def open_console(self, ctx: OperationContext, console_kind: str) -> AdapterResult: ...

class NicHotplugProvider(Protocol):
    async def attach_nic(self, ctx: OperationContext, nic_spec: Mapping[str, object]) -> AdapterResult: ...
    async def detach_nic(self, ctx: OperationContext, device_port_id: str) -> AdapterResult: ...

class ColdSnapshotProvider(Protocol):
    async def export_cold(self, ctx: OperationContext) -> AdapterResult: ...
    async def import_cold(self, ctx: OperationContext, artifact: Mapping[str, object]) -> AdapterResult: ...
```

QEMU 和 OVS 实现 `LinkProvider`，但两者的 `set_link` 都在本后端范围内生效，跨设备线缆必须由 `FabricService` 协调。`NicHotplugProvider` 表示拆装网卡，不是拔插网线。ns-3 的 `set_radio_enabled(member_key, enabled)`、`set_node_position(member_key, position_m)` 和 `set_wifi_config(member_key, config)` 是 scenario 成员能力，不能误作虚拟网卡热插拔。

能力 profile 必须区分 `supported`、`verified`、`disabled`，记录 backend/version、设备型号、来宾驱动、验收案例及日期。`verified` 只能在目标组合实际通过验证后写入。生产代码不能因为二进制存在就宣称它支持所有镜像、所有网卡的载波变化和任意快照恢复。

实现目录固定：`runtime/host_agent/` 是独立 Linux Python 包，backend 实现放其 `adapters/` 子目录，FabricService、资源注册与受限执行也在此包中。`backend/apps/runtime_control/` 只放 Django 编排、模型、OperationStep、Host Agent 客户端和协议序列化，不在 API/Worker 包中直接 import libvirt 或运行 ovs-vsctl。接口数据类型可共享为纯协议包，不能让前端/API 因共享 SDK 获得宿主控制入口。跨主机请求携带 timeout_ms，Host Agent 接受后用自己的 monotonic clock 计算截止时间，不能比较两个主机各自的 monotonic_ns。

## 6.3 Command 到 Host Agent 的执行语义

命令名称统一为 `device.power_on`、`device.shutdown`、`device.force_off`、`device.restart`、`device.reset`、`cable.connect`、`cable.disconnect`、`assembly.install`、`assembly.remove`、`snapshot.create_cold`、`snapshot.restore_cold`。API 接受的是授权后的结构化意图，不接收 QMP JSON、Shell 命令、任意磁盘路径或 OVS 流表文本。

数据库 Command、Outbox、Event 是持久事实。Celery＋Redis 负责唤醒和调度；Host Agent 的执行日志负责恢复正在进行的宿主操作，但不另建一套领域 Command 状态。完成过程必须是：

```text
授权与参数校验 → DB 中锁定目标、预留端口、保存 Command/Outbox
  → Worker 唤醒 → 编译带 config_revision/control_epoch 和 spec_hash 的执行计划
  → Host Agent 核验身份、资源所有权和重复操作
  → 幂等执行/读回 → 持久保存结果与领域 Event
  → Outbox 发布 → Redis Streams → Channels/其他消费者
```

Host Agent 请求至少携带 Command ID、实验 ID、运行单元 ID、操作类型、generation、config_revision、control_epoch、期望 runtime_generation、规范化 spec 和幂等键。mTLS 或等效的双向服务身份验证限定哪些 Worker 可调用；Host Agent 只接受与数据库授权记录匹配的计划。Celery 重试、连接中断或 Worker 重启时，先用幂等键和实际资源读回判断上次结果，不重复创建 Domain、veth 或差异盘。config_revision、control_epoch 和 last_event_seq 不能合并；Host Agent journal 只是执行证据，细粒度进度写入数据库 OperationStep。

Host Agent 对同一个运行单元串行化生命周期修改；涉及两个端点时按排序后的 port ID 获取锁，避免双向接线死锁。跨数据库、libvirt 和 OVS 不能声称是一个原子事务；采用预留、分步执行、检查点和补偿。补偿只回收该 Command 所拥有且未被后继 generation 使用的资源，不删除正在使用的新线路。未确定结果时保持 `pending/reconciling` 并阻断再次修改相关端点，不能把 DB 期望状态强行当作 observed 状态。

观察结果至少含 `runtime_unit_id`、`runtime_generation`、`generation`、`config_revision`、`control_epoch`、`source`、`observed_at`、单调时钟时间及具体状态。API 侧为持久 Event 分配实验内 seq；Host Agent 的时间戳不充当跨进程全局事件排序依据。读回失败、过期 epoch/generation、部分应用和能力不匹配必须有独立错误码。无法联系旧 Host Agent 且无法确认其已被 fencing 时，实验进入 RECOVERY_REQUIRED 并禁止迁移或并行启动副本，不能仅靠修改数据库 epoch 就证明旧主机停止写入。

## 6.4 稳定端口与接线编译器

UUID `device_port_id` 属于设备实例，模型内 `port_key=eth0` 属于定义锚点；线缆更换、VM 重启和快照恢复都不改变该实例端口 ID。网卡 MAC、libvirt Domain UUID、用户定义 alias 和 PCI 地址在实例内稳定。`vnetN`、OVS `ofport`、内核 `ifindex` 由运行时发现，每次 provision/start/restore 后重新核验并写入新的 runtime_generation。绝对不能把 `eth0` 当作来宾和宿主共用的接口名；来宾可能实际显示 `ens3`，配置按 MAC 或已验收 profile 的匹配机制关联。

同一物理端口最多同时存在一条活跃或正在预留的线路，无论它在请求中位于 source 还是 target。数据库通过 `CableEndpointReservation` 的 `device_port_id` 唯一约束实现，两端按一个事务写入；只给 `source_device_port_id` 与 `target_device_port_id` 各设 UNIQUE 无法阻止 A 端口在不同列被重复占用。共享无线信道、PON 分光器是专用介质对象，不通过允许 RJ45 端口多条线来冒充。

第一版采用下面的参考承载设计，作为实现与 PoC 的固定方案：

1. 每个可见 OVS Switch 对应一个独立 `switch bridge`，交换、VLAN 和允许的 STP/RSTP 都发生在这个对象中。
2. 每个 QEMU Ethernet 端口永久接入一个私有的隐藏 `endpoint bridge`，libvirt Domain 的 source bridge 不随线缆移动。未连线时保留 NIC，载波设为 down，端点默认丢弃数据。
3. 每条 Ethernet 线缆由独占的 veth pair 承载，两端分别接入目标 endpoint/switch bridge。每端有真实 Linux netdev，可独立配置两个方向的 qdisc；第一版不采用无法直接附着 tc 的纯 OVS patch port 作为有损线缆。
4. 隐藏 endpoint bridge 只安装 `TAP → 该线缆端点` 和反向的精确 `in_port/output` 规则，并保持默认 drop；不使用 NORMAL 学习，不生成/消费 STP、LLDP、LACP、BFD 等设备控制协议，不承担用户看不见的交换机角色。
5. 隐藏承载没有 IP、DHCP、IPv6 自动配置或宿主业务路由；对 OVS LOCAL 端口和非注册入口默认 drop。所有接口、bridge、flow cookie 都带 Host Agent 注册的实验/端点归属。

实际数据路径：

```text
PC 的 guest virtio NIC
  → libvirt 创建的 TAP
  → PC.port 的私有 endpoint bridge（成对 output）
  → cable-1 veth.A ── veth.B
  → 可见 Switch-1 bridge（实际二层转发）
  → cable-2 veth.A ── veth.B
  → Firewall.port1 的 endpoint bridge → TAP → Firewall guest NIC1
  → guest nftables / 路由
  → Firewall guest NIC2 → TAP → port2 的另一 endpoint bridge
  → cable-3 → 可见 Switch-2 → Server
```

两台 VM 直连时，只连接双方 endpoint bridge；两个可见交换机直连时，线缆两端分别成为两台 bridge 的一个端口。防火墙两个接口永远不因为“属于同一设备”而放入同一个隐藏广播域。不得将所有实验设备放到同一个 bridge 后用 3D 连线图假装存在路径。

隐藏承载和可见交换机必须区别对待控制帧。Linux bridge 默认 `group_fwd_mask=0` 会过滤部分链路本地帧；OVS NORMAL 也有保留组播规则，开启本地 STP/LLDP 时会消费相应报文。隐藏 endpoint 采用关闭本地协议参与的明确 output 规则，并通过 STP、LLDP、LACP、802.1Q/QinQ PCAP 用例验证透明性；可见交换机则按自身能力处理控制帧，不为“让包通过”而全局开启所有 BPDU 转发。依据见 [Linux bridge](https://www.kernel.org/doc/html/latest/networking/bridge.html)、[OVS actions](https://docs.openvswitch.org/en/stable/ref/ovs-actions.7/)、[OVS 控制帧配置](https://www.openvswitch.org/support/dist-docs/ovs-vswitchd.conf.db.5.html)。

所有 Linux netdev 名称由短 ID 注册表生成并检查冲突，遵守接口名长度限制；领域完整 UUID 进入 `external_ids`/数据库，不直接拼到 `simlab-<完整UUID>-<完整port>`。ifindex、ofport 的再利用必须通过 generation 防止旧事件误改新线路。

接线编译器输出资源差异和执行步骤，而不是直接修改数据库图。计划记录端点能力、介质兼容、端口 admin 状态、目标帧边界、veth 名、bridge、流表 cookie、qdisc、载波目标与读回条件。连接顺序是预留端口、创建并验证隔离承载、配置两向通路、校验对端状态、最后恢复载波；断开时先关闭载波并阻断两向流量，确认后再删除本线缆资源。失败时按原状态补偿，并将受影响设备保持可解释的 `CONNECTING`、`DISCONNECTING` 或故障状态。

端口状态不能只有一个 `UP/DOWN` 字段。`admin_state` 是用户或设备配置，`attachment_state` 是物理接线事实，`carrier_state` 是本地与对端供电/介质条件计算并实际应用后的结果，`oper_state` 是 runtime 读回；下游 IP、路由和服务状态另行观察。端口管理关闭、对端关机、线缆拔除都可产生 carrier down，但错误 IP/ACL 丢弃通常保持 carrier up。交换机关机需要关闭其全部业务通路并使相邻端点载波按 profile 变化，不能只把机箱 LED 变暗；交换机重启后的 FDB/VLAN 行为由设备 profile 决定。

同一个断线动作有两条证据：本地数据面禁止继续转发，以及 guest/对端观察到载波条件变化。后台达到第一条而第二条尚未确认时显示“通路已阻断，链路状态待确认”；失败不能伪造一个 guest 已观察到的状态。设备停机时没有 guest 可探测，记录下一启动所需的 link down 配置并标注观测来源，不能把缓存的 NO-CARRIER 当作当前 guest 检测结果。

为每个执行步骤设置可取消的 deadline 和资源所有权。OVS 流表变更写入与读回、libvirt 参数更改、carrier 应用、事件持久化是不同检查点；取消操作只能在安全边界回滚。端口锁占用与外部运行故障分别展示，避免“用户拔线但另一重试任务重新把线路接回去”。周期性 reconciliation 对照数据库计划和 libvirt/OVS 实态，漂移时先冻结受影响端点，发布带实际证据的 drift 事件，再由授权计划修复。

## 6.5 QEMU 配置编译、生命周期与就绪判断

Device Manifest 的 `runtime_profiles` 中 `role=guest_os` 指向不可变 `profile_release_id`，其中包含 image/兼容配置；经装配规则生成 `QemuSpec`。基本字段如下：

```json
{
  "runtime_unit_id": "ru-pc01",
  "backend": "qemu",
  "architecture": "x86_64",
  "runtime_profile_release_id": "linux-amd64-profile-release-001",
  "machine_profile_id": "pinned-q35-profile",
  "cpu": {"profile_id": "tested-cpu-profile", "vcpus": 2},
  "memory_mib": 4096,
  "firmware": {"kind": "uefi", "template_id": "verified-ovmf-template"},
  "disks": [{"disk_id": "disk01", "base_image_id": "img01", "bus": "virtio"}],
  "nics": [{"device_port_id": "b6d60dd0-0b41-4aa5-a62f-b7028f937f21", "port_key": "eth0", "model": "virtio", "mac": "52:54:00:10:00:01",
            "alias": "ua-pc01-eth0", "endpoint_bridge_id": "endpoint-pc01-eth0", "initial_link": "down"}],
  "readiness_profile_id": "guest-agent-and-service-probe"
}
```

本示例中的 profile 名是结构示例，不是已验收版本。实际 `machine`、CPU、固件版本、网卡模型、PCI 地址必须由 profile 给出；CPU 架构相同不等于任意路由器/光猫固件可启动。`.qcow2` 是磁盘格式，不是兼容性证明。消费级 CPU 型号、内存频率、显卡外观属于教学属性，转换到 vCPU/RAM/受支持虚拟设备后不得宣称性能等同真实商品硬件。

libvirt Ethernet 接入 OVS 的 XML 编译结构示例：

```xml
<interface type='bridge'>
  <mac address='52:54:00:10:00:01'/>
  <source bridge='se9af31b'/>
  <virtualport type='openvswitch'/>
  <model type='virtio'/>
  <alias name='ua-pc01-eth0'/>
  <link state='down'/>
</interface>
```

`se9af31b` 是 Host Agent 预先创建的该网口私有 endpoint bridge。Domain 定义且停止时可以还没有实际 TAP；每次 start 后通过 libvirt 实际 XML 获取 target TAP，再读 OVS Interface/Port 确认绑定，安装端点转发并最后计算/恢复载波；不得猜测 `vnet0`。停机设备可提前保存接线关系和承载资源，但其 oper_state 保持 down，TAP 映射为待发现。完整 Domain XML 还必须指定固件、独立 NVRAM、磁盘、PCI 地址、console、资源配额与安全标签。官方接线依据见 [OVS with libvirt](https://docs.openvswitch.org/en/latest/howto/libvirt/)。

生命周期语义必须明确：

| Command | 行为及完成条件 |
|---|---|
| `device.power_on` | 装配/供电通过后 provision/start；Domain 已运行只进入启动过程，后续 readiness probe 成功才声明 OS/服务就绪 |
| `device.shutdown` | 发送来宾协作关机请求，等待 Domain SHUTOFF；超时标为关机未完成，不自动改为断电 |
| `device.force_off` | 明确模拟电源硬切断，通过 libvirt 非协作停止；记录磁盘可能只具崩溃一致性，不冒充正常关机 |
| `device.restart` | 经过 profile 验收的来宾正常重启；若无法探测重新启动周期则使用正常关机完成后再 start 的可观察序列 |
| `device.reset` | 硬件复位语义，区别于正常重启；清除上一轮 readiness，等待新启动周期 |
| `cable.disconnect` | 保留 NIC；关闭虚拟载波并撤销/阻断独占线路，读回完成 |
| `assembly.remove` 网卡 | 第一版关机后变更 spec，再重新 provision；热拔插仅对已验收的能力开放 |

`QemuAdapter.set_link` 使用 libvirt 的接口 link state 更新，并明确运行中配置与下次启动配置的同步策略。绑定载波操作的不是漂移的来宾网卡名，而是稳定 MAC/alias。来宾中链路变化依赖受支持的网卡/驱动组合，因此每个镜像 profile 验收 guest `NO-CARRIER`、网卡持续存在、MAC 不变及重连后恢复；仅 ping 失败无法证明载波断开。[libvirt Domain link state](https://libvirt.gitlab.io/libvirt/formatdomain.html#modifying-virtual-link-state)、[virsh domif-setlink](https://www.libvirt.org/manpages/virsh.html#domif-setlink)

就绪分为 `PROCESS_RUNNING`、`OS_READY`、`NETWORK_READY`、`SERVICE_READY`，不可合并。QEMU running、VNC 可连接、看到 BIOS 都不是 OS_READY。profile 指定 guest agent、串口 prompt 或管理探针、截止时间和可解释错误；网络服务通过实际服务 probe 判断，不从拓扑连通性推断。Guest agent 和 cloud-init 必须在目标 guest 镜像内存在并验收；宿主安装同名包不会为所有 guest 添加能力。允许空盘 VM 通电并显示无启动介质，其 OS 就绪状态保持未满足。

noVNC/串口连接通过独立鉴权网关建立短期、绑定实验与用户的会话；VNC/QMP/libvirt socket 不直接暴露给浏览器。显示器拔掉只影响对应显示路径和无信号状态，键鼠未连接只影响其输入能力，不能默认把 VM 一起关闭。guest 配置读取采用 profile 声明的 guest agent、SSH/CLI、SNMP/NETCONF 等能力，QMP 本身不是路由表和防火墙策略的数据源。

## 6.6 实验隔离与 Host Agent 边界

第一版选择单 Linux 主机，但仍须隔离实验数据面。参考实现中 OVS daemon 位于宿主网络 namespace，按实验创建独立 bridge/端点/线路；模型进程可置于独立 netns。netns 是独立网络视图，不是 `experiment → switch → router` 的天然层级树；把名字相似的 namespace 创建出来也不会自动隔离 OVS/Domain。不得直接把 TAP 移入另一个 namespace 而不同时解决 libvirt、OVS 和进程访问归属。

Host Agent 必须执行以下策略：仅连接注册且属于同一实验的端点；不给实验 bridge 配置宿主 IP/默认路由，关闭这些接口的 IPv6 自动地址；默认拒绝物理网卡、管理网口、未知隧道和实验外 VLAN 的接入；隐藏桥 LOCAL 默认 drop；可见桥的 LOCAL 也不提供宿主业务。接入 profile 需定义 OVS LOCAL 转发控制及宿主侧 ingress/input 防护，防止 guest 用宿主 IP/bridge MAC 构造报文进入共享宿主协议栈，单纯“不配 IP”不能作为安全证明。禁止实验内数据进入 API、数据库、对象存储和宿主管理网。若用户需要互联网，则创建明确的 `ExternalNetwork` 网关设备和经过授权的出口策略，不默默复用宿主默认 bridge 或 libvirt default NAT 网络。

QEMU 进程由 libvirt 的非特权账号及适用的 SELinux/AppArmor 隔离管理，配额覆盖 CPU、RAM、磁盘、VM 数、接口数、流量、日志和抓包体积。Host Agent 单独运行，所有可执行文件/路径/参数采用允许列表及资源所有权核验。namespace 只能隔离网络视图，不能替代 VM、进程权限和内核安全边界；公开多租户部署前需要针对不可信镜像的额外安全验收。

本节退出条件：两台 Linux VM 与一个 OVS Switch 的真实 ping 成功；无网线启动时 NIC 存在但 NO-CARRIER；插拔无需删除网卡且 MAC 不变；防火墙确在两段独立网络之间；移除防火墙通路后流量不可绕行；两个实验使用相同 IP/MAC 时不互通；进程重启后能发现原 TAP/OVS 绑定并拒绝旧 generation 事件。这些是待完成测试，不得预先写为已通过。

# 7. 有线、无线、光与无线电的保真度、混合报文及时钟

## 7.1 保真等级与可互通边界

设备的外观、业务角色、运行后端与保真能力分别建模，不能以“长得像 AP”就判定能调试真实无线驱动。每个设备和实验至少公布下表中的当前能力；前端可采用统一操作形式，但不得隐藏实际支持范围。

| 等级 | 运行方式 | 可观察结果 | 必须说明的限制 |
|---|---|---|---|
| `VISUAL` | 场景与教学状态规则 | 组装、线缆、LED、故障提示 | 没有真实协议/实际帧通路 |
| `PROTOCOL` | 明确实现范围的状态/协议模型 | 状态迁移、模型报文、简化配置效果 | 不自动等同真实 OS 或完整标准 |
| `REAL_RUNTIME` | VM、Linux 网络节点、OVS | 实际 Ethernet/IP 报文及业务配置 | 无自动物理传播/商品硬件性能复刻 |
| `HYBRID` | 真实帧经已验收模型边界穿过模拟介质 | 真实应用受无线/光/链路模型影响 | 受时间同步、MAC、模型能力与资源限制 |

纯逻辑设备要与真实 VM 通信，必须实现并声明 `ethernet_frame_endpoint` 或明确的 L3/IP 网关边界，具备收发实际帧、地址解析/转发、MTU/checksum、缓冲与 backpressure、丢包计数和错误处理。只实现状态机或图上的 reachability 不能获得这个 capability；默认拒绝在 REAL_RUNTIME/HYBRID 实验中连接这种端点，并在界面解释限制。

`DeviceRuntimeBinding` 允许一个模型角色嵌在同一可见设备内部。backend capability 指明其帧边界是 Ethernet、IP、802.11 模型入口还是 PON 业务抽象；编译器只组合兼容的边界。所有跨 backend 组合先建立独立 PoC，完成双向真实通信及错误场景后，再发布为可用 profile。不要以“统一 Adapter”推断所有 backend 天然可替换。

## 7.2 Ethernet 与线路退化

第一版有线模型支持 RJ45 Ethernet 和经过 profile 声明的以太网光接口，实际数据走第 6 节线路。物理兼容检查包括介质、插头、端口占用、供电和端口 admin 状态。速率协商首版使用明确的共同支持速率规则；不宣称完整模拟 PHY、自协商脉冲、铜缆串扰或线路电气波形。

每个线缆同时保存 A→B、B→A 两组 impairment：`rate_bps`、`one_way_latency_ms`、`jitter_ms`、`loss_probability`、`duplicate_probability`、`reorder_probability`、`queue_limit_packets`、随机种子/实现版本。值有单位、取值范围和缺省语义，0 时延、无限速率与断线不能混用。RTT 是实际测量结果，不能直接把单向 latency 贴为 ping 延时。

Host Agent 在独占 veth pair 的两个发送方向各配置对应 qdisc；删除/替换时仅操作自身登记的 handle，不覆盖未知 QoS。带宽使用 tc 支持的已验收整形组合，netem 管理延迟、抖动、丢包、重复、乱序；必要的 IFB/接收侧部署必须被纳入完整计划，不能只改一个方向后宣称链路已对称退化。配置成功通过 `tc` 读回和实际流量测量双重确认。

netem 会受内核计时粒度、队列、宿主负载和 offload 影响，不能承诺任意微秒精度或线速。测试 profile 固定 qdisc 配置、MTU、GSO/TSO/GRO/checksum offload 策略和流量负载；把生成的超大分段包直接交给不支持 offload 的模型可能破坏校验或限速统计。需要时在模型边界关闭相关 offload/处理实际帧分段，并保存差异配置。依据见 [iproute2 netem](https://kernel.googlesource.com/pub/scm/network/iproute2/iproute2-next/%2B/refs/heads/main/man/man8/tc-netem.8)。

有线验收包含双向 UDP/TCP 与 ping、两组非对称参数、断线后的队列策略、VLAN 标签保留、被测防火墙丢弃。对随机丢包用足够样本和事先声明的统计容差判断，不要求 100 个包恰好丢 5 个；配置项、观察计数和应用测量值在 UI 分开显示。

## 7.3 Wi-Fi 的两条实现路线

**路线 A：真实 Linux 无线管理与认证。**采用 `mac80211_hwsim`＋`hostapd`＋`wpa_supplicant`，用于 SSID、关联、WPA 配置、认证失败和 Linux 无线工具。虚拟无线电按实际 Linux 驱动/namespace 支持配置，基础 hwsim 主要按信道复制无线帧，不自动包含真实的距离、墙体衰减和复杂干扰模型。若后续加入外部媒介模型，单独记录其版本和支持范围，不把基础 hwsim 描述为精确射频传播。参考 [Linux Wireless hwsim](https://wireless.docs.kernel.org/en/latest/en/users/drivers/mac80211_hwsim.html)。

**路线 B：传播和 MAC/PHY 性能。**采用 ns-3 Wi-Fi＋Propagation/Spectrum，以位置、发射功率、信道、介质访问和模型误包决定传输；第一版混合 PoC 只支持已验证的 AP/单 MAC STA 和单一实时 scenario。ns-3 文档列出认证和加密缺失，不能用关联成功冒充 WPA 密码验证；TAP 提供 Ethernet 边界，也不会给 QEMU guest 自动添加支持扫描 SSID 的无线网卡。参考 [ns-3 Wi-Fi 模型及限制](https://www.nsnam.org/docs/models/html/wifi-design.html)。

首版业务路线选择 B，WPA 调试 capability 关闭；需要路线 A 时另立 profile/实验类型。两条路线不能未经 PoC 混装成“真实 WPA＋任意 guest 无线驱动＋精确传播”的承诺。普通 QEMU Laptop 可通过隐藏 Ethernet NIC 承载真实流量并绑定 STA 射频角色；前端必须标为“guest 通过模拟无线介质联网”，而不是声称 guest 正在控制真实 wlan 设备。

AP 需要明确两个角色：`radio_model` 负责 ns-3 AP/STA 空口，`wired_bridge_or_router` 负责有线 uplink、业务桥接/路由和可选 DHCP。组合 profile 指定桥接边界、BSSID/SSID、STA MAC 策略和 IP 配置归属。若 ns-3 模型中的 AP 使用了 AP-aware bridge/gateway 扩展，该扩展必须列为实现项；不能直接把一个 TapBridge 贴在 AP 无线端口后假定所有无线 STA 的源 MAC 都透明保留。

## 7.4 ns-3 与真实 VM 的报文接入 PoC

采用 `TapBridge`/必要时 `FdNetDevice` 的已验证方案，而不是从 ns-3 指标生成前端假流量。以下是第一版 PoC 的角色图，不是对所有场景通用的自动接线保证：

```text
Laptop guest Ethernet NIC → QEMU TAP → 私有 endpoint/VM bridge
  → 独立 ns-3 接入 TAP → TapBridge 的 STA ghost node
  → ns-3 WifiNetDevice(STA) → 模拟无线信道
  → ns-3 AP/经验证的有线网关组合
  → 独立有线接入 TAP → 实验 fabric → Router/Server guest
```

两个不同的用户态程序不能同时读取同一个 QEMU TAP FD 并假装不会竞争。QEMU 侧 TAP 与 ns-3 侧 TAP 为不同接口，通过独占 OS bridge/端点通路相连；namespace、接口创建者、读取 FD 的进程及清理责任写进计划。ghost node 的桥接设备接收回调交给 TapBridge，不能又把同一个接收通路当成普通 ns-3 IP host 使用而造成重复栈/错误地址归属。

AP 有线出口的具体桥接候选这样构造：ns-3 AP node 包含 `WifiNetDevice(ApWifiMac)` 与一个 `CsmaNetDevice`，通过 `BridgeNetDevice` 在两者之间转发；独立 wired ghost node 的 Csma 设备与 AP Csma 处在一个专用模拟有线信道，wired ghost 的 `TapBridge(UseBridge)` 接实验内的有线 TAP。真实 Router/Server 在 TAP 外；DHCP 可由 Router guest 提供，AP 不额外制造第二套 DHCP/IP 地址管理。首版 WLAN 设备的管理地址若需要，通过单独 role/管理界面实现，不能在已被桥接回调接管的设备上重复安装收发路径。

该候选的入场断言包括 AP Wifi 与 Csma 对所需 `SendFrom()`/promiscuous callback 的支持、桥接回调没有冲突、无线方向能正确处理 STA 地址、Ethernet VLAN/广播符合所声明 profile。测试程序在启动前检查实际对象能力，未满足即拒绝发布透明 AP profile；允许另立清楚标明子网/路由语义的网关方案。不能把必须开发的适配逻辑藏在“接一下 TAP”中，也不需要为了做第一个混合演示自行实现全部 Wi-Fi 协议栈。

STA ghost 的 Wi-Fi MAC 优先设为对应 guest 的稳定 MAC，使 UseLocal 单来源映射容易解释；跨独立实验可重用地址，单一 scenario 内则保持唯一。VM 自行改变源 MAC、增加桥接后的多个来源、虚拟化嵌套 guest 等超出首版契约时，要计数并拒绝或明确采用另一个已验收 profile。广播、组播、DHCP 的 Ethernet 地址与协议 payload 地址必须一起测试；成功发送一次静态 IP 的 ping 不能证明完整的 L2 桥接兼容。

模式约束必须在编译时执行：

- STA 使用 `UseLocal` 时，Linux 一侧仅允许单一来源 MAC；多 VM、Linux bridge 内多个独立来源 MAC 不可直接接到同一 STA。
- `UseBridge` 要求具体 ns-3 NetDevice 支持 `SendFrom()` 和相应接收能力。模型名称或“这是 Wi-Fi”不能证明它满足要求。
- AP 侧多 STA 的有线出口需要逐跳 PoC；若不能保留所需 L2 语义，可提供明确的受支持路由/NAT 网关 profile，不得偷偷改成 NAT 后仍宣称透明桥接。
- 固定校验和计算配置、MTU、ARP/DHCP/multicast 行为及抓包点。ns-3 与真实网络接入时启用正确 checksum 行为，guest offload 与模型支持相匹配。

这些边界依据 [ns-3 TapBridge](https://www.nsnam.org/docs/models/html/tap.html)；实时与 checksum 的集成例子见 [官方 VM/TAP 示例](https://www.nsnam.org/docs/doxygen-old/d9/d1c/tap-csma-virtual-machine_8py_source.html)。示例是设计证据，不是复制旧版本代码即可得到当前项目的兼容保证。

PoC 最低验收：一个真实 VM STA 与实验内真实服务双向 ping/TCP；接入线断开即失去通信；STA 移动或降低发射功率能改变实际吞吐/丢包；抓包证明实际业务经过模拟空口对应的 trace；ARP/DHCP 与重关联符合 profile 声明；加入第二个来源 MAC 时准确拒绝或走已实现的网关；scenario 超负载有状态告警。未通过这些用例时，Wi-Fi 只能发布 PROTOCOL 模式。

## 7.5 实时调度、动作时间与观测

HYBRID 模式中的 VM 和 Linux 协议栈使用现实时间，ns-3 必须启用 `RealtimeSimulatorImpl`，以墙钟节奏推进事件并监控落后量。普通离散事件默认会跳到下一事件，不能直接与正在运行的 TCP 协议栈混合。BestEffort/HardLimit 及允许 drift 由 profile 规定；超过阈值进入实验降级/失败状态，保留错误证据，不继续把结果标为满足实时性。[ns-3 实时调度](https://www.nsnam.org/docs/manual/html/realtime.html)

第一版公开以下时间语义：

| 操作 | REAL_RUNTIME/HYBRID | 纯模型 |
|---|---|---|
| 正常运行 | 1× 现实时间，记录 measured drift | 可用离散事件时间 |
| 暂停 | 停止用户修改不等于暂停协议；全运行时暂停尚未支持 | 由模型提供，受能力声明限制 |
| 倍速/逐步执行 | 禁用 | 仅对实现该能力的独立模型开放 |
| 回放 | 展示已记录事件、指标与 PCAP，不向活跃 VM 重新注入历史命令 | 可另实现带种子的重运行，不能默认保证完全一致 |
| 冷恢复 | 重建配置并重新启动，活跃会话丢失 | 重新构建 scenario/模型，不恢复中途事件队列 |

位置/信道更新由 Host Agent 的受限 IPC 请求进入 ns-3 scheduler 线程，在下一可执行事件边界应用并返回实际 `effective_sim_time_ns`；不要从 Python 外部线程直接修改正在运行的模型对象。每条无线指标包含成员 ID、观测对象/接收方、`sim_time_ns`、单调时间、profile/version、generation 和单位。3D 世界统一使用米和约定坐标轴，位置转换经过显式矩阵；不能把模型缩放后的屏幕像素直接当传播距离。

RSSI/SNR 是特定接收者和时刻的测量/模型值，不是 AP 独自拥有的常数。覆盖圈为可解释的近似可视化，阈值和模型名称公开；物理颜色图、预测覆盖与实际丢包测量分开。3D 以采样/聚合更新 LED、流量光点和告警，不每帧处理所有报文，也不让动画碰撞决定 packet delivery。服务端持久事件序号负责同步，浏览器动画帧率不参与网络时钟。

## 7.6 ONU、OLT、光纤和业务门控

第一版光网络定义为 PON 行为与业务承载的简化模型，不实现完整光波形、GTC/GEM、DBA、PLOAM、OMCI。仍必须实现 OLT、ONU、ODN/分光器和运营商业务端四类角色；光猫不能只靠一个固定启动定时器自动进入 ONLINE。

模型 profile 明确 GPON 或其他 PON 类型、端口介质、允许拓扑、ONU 标识、OLT 注册策略、业务 VLAN、桥接/路由模式、可用上下行带宽、注册/测距超时、LOS 恢复时间及故障事件。一个 PON 下的多 ONU 经分光器连接，由专用模型对象管理共享资源；不直接复用“一物理端口多根 Ethernet 线”。

状态至少区分：`OFF`、`WAIT_DOWNSTREAM`、`DISCOVERY`、`RANGING`、`PON_OPERATIONAL`、`SERVICE_UNPROVISIONED`、`SERVICE_READY`、`LOS`、`REGISTRATION_REJECTED`。这些是平台简化状态；如果声称遵循 GPON O1–O7，则要提供明确映射、事件/guard/计时器，不能把任意字符串重命名就声称完整标准实现。OLT 与 ONU 的发现、测距及运行过程可参考 [ITU-T G.984.3](https://www.itu.int/rec/dologin_pub.asp?id=T-REC-G.984.3-202003-I%21Amd1%21PDF-E&lang=e&type=items)。

每次状态迁移必须有 guard：双方电源有效、介质连通、接收条件满足、OLT 发现正确 ONU 标识、测距成功、注册策略接受、业务 VLAN/线路 profile 已开通。`PON_OPERATIONAL` 只表示 PON 接入正常，不能自动表示 PPPoE、DHCP、DNS 或互联网都可用。`Internet LED` 由明确服务 probe/profile 决定，LED 行为不硬编码为所有厂家一致。

真实业务路径采用以下抽象，并公开“业务帧通道，不是完整 PON 帧仿真”：

```text
PC/Router VM → ONU 的 Ethernet LAN 端点
  → ONU 业务 VLAN/桥接或路由角色
  → PON Gate（OLT/ONU 注册及介质条件）
  → 共享带宽/故障模型
  → OLT 业务 uplink 端点
  → 实验内 PPPoE/DHCP/Router/Server
```

`PON Gate` 必须处于实际数据平面中：只有 PON_OPERATIONAL 且业务已开通时放行对应 VLAN/业务帧，拔光纤、注册失败或断电时双向丢弃/停止转发。ONU 仍通电时，LOS 不必令其 Ethernet LAN 的载波 down；光接入失败、LAN 插拔与业务失败分别观察，不能把三者合并。门控不是 WebSocket 上的一个布尔值；执行结果以线路计数、guest 流量和 PCAP 验证。首版未实现 PPPoE 时，只提供明确的 DHCP/静态业务 profile，不能用直接给 PC 配 IP 假装拨号成功。

后续光预算按上下行波长分别计算：`P_rx_dBm = P_tx_dBm - alpha_dB_per_km * length_km - splitter_loss_dB - connector_loss_dB - splice_loss_dB - margin_dB`。发射功率、损耗、接收灵敏度与过载阈值来自选定 profile，含单位和适用标准；功率太弱或过载影响 LOS/误包模型。分光损耗使用 profile/器件数据，不把分光比当无损复制。反射/弯曲等没有验证模型时只作为显式故障参数。物理边界依据 [ITU-T G.984.2](https://www.itu.int/rec/T-REC-G.984.2-201908-I)。

光网络验收：未登记 ONU 拒绝注册；拔纤同时出现 LOS 和真实通信中断；重新插纤必须经历允许的恢复过程；PON 正常而业务未开通时实际通信仍失败；错误 VLAN 不放行；两个 ONU 的带宽/故障按声明共享；功率阈值变化有单位与可解释状态。完整 DBA/OMCI 或更高保真必须另立项目阶段和独立标准符合性测试。

## 7.7 无线电、物理模型与扩展门槛

无线电第一版仅做明确频段、调制/带宽、发射功率、传播损耗、误包与干扰的 packet-level 或状态模型。选择 ns-3 的已有模型或经过验证的 C++ 插件；Python 适合参数、编排和低频规则，不由语言选择来证明模型准确。需要真实波形、IQ 数据、接收机 DSP 时，另引入 GNU Radio 等专用后端，并声明处理成本和实时性。

任意 Radio 设备不能默认与 Wi-Fi STA 通信；双方协议、帧边界、频谱模型和接收条件兼容后才建立可用通路。每个自研插件提供 schema、capability、输入输出单位、状态迁移、帧接口、计时机制、随机种子、资源上限和参考场景。没有实际帧接口的插件可以做独立教学效果，但不能偷偷改变真实 VM 的业务状态。

扩展保真度的顺序为：先实现正确数据路径和端口断开，再实现统计性链路退化，然后实现无线/光状态门控，最后提高传播、干扰和标准协议细节。每提高一个等级，都新增基准用例和已知限制说明。视觉效果只能表达所选模型已经产生的结果，不代替验证。

# 8. 镜像、独立差异盘与冷快照恢复

## 8.1 镜像注册是兼容 profile 注册

管理员导入镜像后，记录文件哈希、原始大小、虚拟容量、实际格式、CPU 架构、OS/固件版本、授权来源、用途、分发权限与许可说明。上传文件名不能决定真实格式；受隔离、限资源的检查程序识别格式并检查 backing chain、外部依赖、异常虚拟容量、路径引用。禁止管理员上传任意宿主路径或自由 QEMU 参数来绕过 Host Agent 允许列表。

`ImageProfile` 至少包含已验收 machine/version、CPU profile、BIOS/UEFI、固件模板、磁盘总线、网卡型号/驱动、默认端口顺序、最小资源、console、bootstrap/readiness、正常关机能力、载波能力与适用 backend 版本范围。商业网络设备镜像能启动也不代表可再分发；用户提供的授权镜像与可公开预装镜像采用不同登记和访问策略。

基础镜像在哈希确认后不可变；新版本生成新 `base_image_id`，不在原路径覆盖旧文件。所有引用、快照和链路都以 ID/哈希关联，平台内部路径由 Host Agent 解析。镜像 profile 生命周期为导入待检、兼容待验、可用、禁用、归档；未验收不得因名称像 Ubuntu/VyOS 就标为 verified。

## 8.2 每个实例独立可写状态

运行结构为“不可变基础盘＋每实验/设备/磁盘独立差异盘”。禁止两台 PC 都把 `/images/ubuntu.qcow2` 作为可写运行盘，也禁止重置一台设备时改动别人正在使用的 base。示意布局：

```text
image-store/<base_image_id>/<sha256>/base.qcow2          # 不可变
runtime-data/<experiment_id>/<device_id>/<generation>/disk01.qcow2
runtime-data/<experiment_id>/<device_id>/<generation>/nvram.fd
runtime-data/<experiment_id>/<device_id>/<generation>/seed.iso
snapshots/<snapshot_id>/manifest.json + disk artifacts + nvram artifact
```

创建差异盘时显式指定 base 格式，并限制完整 backing chain；命令由 Host Agent 用 argv 生成，不能把用户给出的路径拼到 Shell。链中基础文件不得在实验运行或快照有效期内改变。参考 [QEMU qemu-img backing file 文档](https://www.qemu.org/docs/master/tools/qemu-img.html)。

UEFI NVRAM 从对应 profile 模板为每个实例单独复制，不能让所有设备共写同一 NVRAM。每个 snapshot 保存其独立 NVRAM 或明确保存无持久 NVRAM 的 BIOS 模式。固件代码模板只读，固件变量写入本实例文件；TPM 等额外持久设备未定义保存方法时 capability 禁用。空白磁盘、安装介质和预装系统镜像分别建模，装 SSD 不代表自动获得可启动 OS。

cloud-init 仅对镜像内已安装且支持相应 datasource 的 profile 使用，seed disk 独立；guest agent 需要 guest 安装服务和 Domain 通道。bootstrap 注入的用户名、凭证和网络设置由秘密管理路径生成，不以永久明文保存进公开事件、manifest 或下载包。guest 内路由/防火墙状态优先从实际工具/API 读取，后台不要把期望配置当作运行成功。

## 8.3 第一版只提供 cold snapshot

`snapshot.create_cold` / `snapshot.restore_cold` 保存和重建停止状态的实验配置、磁盘与规定的持久状态。它不是整个运行网络的热快照。TCP/SSH 会话、进程 RAM、DHCP 动态租约/邻居缓存、OVS FDB、ns-3 的待处理事件、无线关联和光模型中途计时器不保证恢复；UI、API response 和 manifest 必须明确 `snapshot_kind=cold`、`active_sessions_preserved=false`。

纯模型保存的是配置、版本、初始随机种子和明确定义的持久参数，恢复时新建 scenario。只有某个 backend 自己实现并验证 checkpoint 时才可另声明其能力，不能因为保存 `ns-3 parameters` 就称为 Simulation Memory Snapshot。多 VM 磁盘在不同时间截取也不是全实验一致性快照。libvirt 区分磁盘、内存和完整系统状态，内存与磁盘不匹配可能损坏 guest；参考 [libvirt Snapshot XML](https://libvirt.org/formatsnapshot.html)。

冷快照内容至少包括：

| 类别 | 保存内容 |
|---|---|
| 领域与场景 | schema_version、实验 revision、设备/组件/槽位、稳定端口、线缆、位置、供电、配置、capability/profile 引用 |
| VM | Domain UUID/规范化 spec、稳定 MAC/alias/PCI、base hashes、每个 disk artifact、独立 NVRAM、镜像/固件/backend 兼容元数据 |
| Fabric | 逻辑 bridge/端点/线缆计划、VLAN/STP/QoS/两向 impairment；不保存 ifindex/ofport 为恢复目标 |
| 模型 | scenario/无线/光/Radio 配置、坐标单位、seed、模型/version、初始化策略；不承诺保留运行队列 |
| 完整性 | 每个 artifact 的 checksum、大小、依赖列表、加密/访问策略、完成状态、创建来源 Command ID |

## 8.4 创建冷快照的协调流程

SnapshotCoordinator 获取实验排他锁，冻结目标 config_revision 的配置修改，拒绝新的接线、装配、开关机及模型参数修改。生命周期子步骤通过持久 OperationStep 记录，last_event_seq 继续单调递增；它记录快照前各设备的运行意图，但默认不自动重新开机。只冻结 API 修改而让 VM 持续写磁盘不满足冷快照条件。

创建步骤固定为：

1. 授权、容量预估、profile 支持检查；创建 `incomplete` 快照记录及 staging 区。
2. 对有来宾正常关机能力的 VM 发 `device.shutdown`，等待实际 SHUTOFF；停止 ns-3/scenario/自研模型，阻断继续进入其状态的外部流量。
3. 到截止时间仍有 VM 运行时创建失败，释放锁并保留明确错误。仅在调用方显式选择允许硬断电的策略时转 `device.force_off`，记录该磁盘为 crash-consistent；不得为完成快照偷偷强制关闭。
4. 确认全部受保存运行单元停止，所有在途宿主修改均已完成/补偿，保存同一领域 revision 的 scene、topology 和运行 spec。
5. 在离线条件下导出每个实例磁盘与 NVRAM。第一版优先生成不依赖可写 runtime 链的独立磁盘 artifact；若保留只读 base 依赖，manifest 列出所有依赖并由引用计数保护。
6. 计算 checksum、校验文件与元数据，写入 manifest；所有 artifact 完成后才把快照标为 `complete`，发布 `snapshot.created`。
7. 实验保持 STOPPED，释放锁。若产品以后开放恢复原运行意图，必须作为独立且可观察的开机计划，重新经过装配/供电和 readiness 检查。

对象存储多文件写入不是一个事务；使用 staging、checksum 和最后完成标记防止半份快照可见。快照失效或创建失败不删除任何活跃实例盘。失败垃圾由带 ownership 的清理任务回收，不能根据文件名前缀遍历删除整个运行目录。

## 8.5 冷恢复、兼容检查与失败回滚

`snapshot.restore_cold` 是覆盖实验状态的操作，先对目标实验授权并在 UI 明示活跃会话将丢失。Coordinator 获取排他锁；保存当前可恢复的停机状态或采取可恢复 generation 切换，不能先破坏旧资源再发现快照缺失。

恢复前检查完整性、schema migrations、backend/profile 版本、architecture、CPU features、machine、网卡模型、固件/NVRAM、base hashes、持久存储和资源配额。快照缺少依赖、版本不支持或 target host 不兼容时明确拒绝；不要自动换成另一 CPU/machine 后宣称恢复原实验。磁盘格式识别及校验限制资源，快照 manifest 不可作为可执行脚本。

恢复顺序如下：

```text
停止并确认旧运行单元停止 → 校验快照与目标能力
  → 为新 generation 恢复领域对象及稳定 ID（暂不发布成功）
  → 重建实验隔离、可见 switch bridge、私有 endpoint、线路计划
  → 导入独立磁盘/NVRAM、定义停止状态的 libvirt Domain
  → 核验已创建 OVS/内核资源 ownership、登记逻辑绑定（TAP 下一次 start 才发现）
  → 按配置重新创建 ns-3/光/Radio scenario（尚不启动）
  → 校验端口唯一占用、业务门控、VLAN、impairment 和物理规则
  → 原子切换新的 generation/config_revision/control_epoch 和运行资源代次，发布全量状态＋最新事件序号
  → 实验保持 STOPPED，用户或独立启动计划重新开机
```

不能先启动 VM，再重建它依赖的 source bridge/端点承载；TAP 由 libvirt 在 start 时创建并再发现。新 Domain 默认接口 link down，开机计划待端点和通路完成后再计算载波。恢复后的光猫重新注册、无线 STA 重新关联，业务服务重新产生状态；前端不先显示旧 ONLINE/RUNNING 再慢慢改回真实状态。恢复绝不回拨 config_revision/last_event_seq，快照中的历史 revision 仅作来源；实验 generation 递增，旧 generation/control_epoch/runtime_generation 的 Host Agent 回执、Streams 增量和浏览器缓存被丢弃。

新 generation 在切换前失败时清理其私有 staging 资源，并恢复/保留旧的停止 generation；切换后失败进入可恢复故障，禁止再回放不匹配的旧事件。每个恢复操作持久保存分步状态，可在 Worker/Host Agent 重启后继续核验。复制磁盘、更新 OVS 与写数据库不能被一个不存在的跨系统事务掩盖。

## 8.6 存储生命周期与退出验收

实例盘、快照 artifact、base、固件模板实行引用计数/依赖检查；删除用户设备只回收其私有运行文件，不能删被快照或其他实验引用的 base。磁盘配额按实际与虚拟容量分别记录，快照导出前预留空间，超限时失败而不破坏原盘。日志、抓包、seed disk 和 console 记录纳入保留策略，下载权限不由“知道对象 URL”决定。

本节验收必须包括：从同一 base 创建两台 PC 后磁盘写入相互独立；UEFI 设置变化互不影响；空盘/预装盘启动行为符合 profile；正常关机超时不被隐藏强制停止；创建中断不出现 complete 快照；缺少 base、hash 错误和固件不兼容时拒绝恢复；恢复重建线缆/VLAN/门控但丢失活跃会话并重新完成 readiness；旧 generation 事件不污染新实验；存储清理无法删除仍被引用的依赖。这里只定义目标，实际通过结果应由 CI/集成环境生成。
