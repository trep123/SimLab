# 3D Network & Computer Digital Twin Simulator
---
# 0. Agent 主任务声明

你现在不是在“给项目提建议”，而是在**直接实施一个可运行的软件项目**。

项目名称：`3D Network & Computer Digital Twin Simulator`

中文名称建议：`三维计算机与网络设备数字孪生仿真实验平台`

最终目标：让用户在浏览器中看到并操作一个 3D 实验空间，在空间中真实地“组装 PC、放置服务器/交换机/路由器/防火墙/AP/ONU/OLT 等设备、插拔线缆、开关机、配置设备、查看状态、进行网络通信、注入故障、恢复实验”，并让后台按照设备类型选择 QEMU/KVM、Open vSwitch、ns-3 或自研仿真器作为执行后端。

必须遵守以下总原则：

1. 前端 3D 不是“动画播放器”，而是后端运行状态的可视化投影。
2. 用户的物理操作必须转化为结构化 Command，由后端验证后改变数字孪生状态。
3. 真实 OS、真实网络、无线仿真、光链路仿真必须通过统一 Runtime Adapter 接口接入。
4. 不允许把所有设备都强行放进 QEMU。
5. 不允许让前端直接控制 QEMU、OVS 或 ns-3；所有高权限操作必须经过后端 Runtime 层。
6. 每个模块必须有单元测试；每个关键跨模块行为必须有集成测试；核心闭环必须有端到端测试。
7. 每个阶段完成后都必须让项目处于可运行状态，禁止“先写完全部代码再调试”。
8. 所有外部镜像、设备固件、系统镜像必须通过管理员注册。
10. 开发过程中不得删除已完成的可运行闭环；新增模块必须通过回归测试。
11. 开发中程序格式必须遵循rule.md。

---

# 1. 最终产品效果

## 1.1 用户进入系统后看到什么

浏览器打开：

```text
登录
 ↓
实验大厅
 ↓
新建实验
 ↓
进入 3D 场景
```

场景中包含：

```text
地板 / 房间 / 机柜 / 桌面
PC
服务器
交换机
路由器
防火墙
AP
光猫/ONU
OLT
显示器
键盘
鼠标
网线
光纤
HDMI
USB
电源线
```

用户可以：

```text
拖动设备
旋转设备
缩放场景
点击设备
打开设备面板
插拔硬件
插拔线缆
按电源键
重启
关机
配置 IP
打开控制台
查看端口状态
查看数据包
制造故障
保存实验
恢复实验
```

## 1.2 PC 装机效果

例：

```text
选择机箱
 ↓
选择主板
 ↓
选择 CPU
 ↓
安装 CPU
 ↓
安装散热器
 ↓
安装 RAM
 ↓
安装 SSD
 ↓
安装 GPU
 ↓
安装 PSU
 ↓
连接主板供电
 ↓
连接 CPU 供电
 ↓
连接 GPU 供电
 ↓
连接 SATA/M.2
 ↓
连接显示器
 ↓
连接键盘
 ↓
连接鼠标
 ↓
插电
 ↓
开机
 ↓
BIOS
 ↓
启动操作系统
```

任何安装动作都必须调用 Compatibility / Assembly Rule Engine 验证。

例如：

```text
CPU socket 不兼容       -> 拒绝安装
RAM 类型不兼容          -> 拒绝安装
GPU 无 PCIe 槽           -> 拒绝安装
电源额定功率不足         -> 允许物理安装，但禁止通过电源检查
未接 24-pin              -> 禁止完整上电
未接显示器              -> OS 可启动，但显示器无画面
未连接网线              -> OS 可启动，但 Link Down
```

## 1.3 网络实验效果

例如：

```text
PC1 ── Switch1 ── Router1 ── Firewall1 ── Server1
                 │
                 └── AP1 ))) Laptop1
```

其中：

- PC1、Server1、Router1 等可以使用 QEMU/KVM 运行真实系统；
- Switch1 可以由 OVS 提供真实二层转发；
- AP1/Laptop1 可以由 ns-3 提供无线信道/协议仿真；
- 防火墙可以运行 Linux nftables / FRR / OPNsense 等合法导入的镜像，具体由 Device Manifest 指定。

用户在前端拔掉 `PC1 -> Switch1` 网线后，后端真实数据平面必须发生 Link Down；PC1 的网卡最终观察到链路中断。

---

# 2. 总体技术架构

```text
┌──────────────────────────────────────────────────────────────┐
│                       Browser / Frontend                     │
│                                                              │
│ React + TypeScript + Three.js + WebGPU/WebGL2               │
│ Scene / Device / Assembly / Cable / Inspector / Terminal    │
└───────────────────────────────┬──────────────────────────────┘
                                │
                        HTTPS / WebSocket
                                │
┌───────────────────────────────▼──────────────────────────────┐
│                         API / Control                         │
│                                                              │
│ Django_DRF                                                      │
│ Auth / Command / Query / Experiment / Runtime Proxy         │
└─────────────┬──────────────────┬───────────────────┬─────────┘
              │                  │                   │
              ▼                  ▼                   ▼
      Topology Engine      Device Registry       Event Bus
              │                  │                   │
              ▼                  ▼                   ▼
        Rule Engine        Runtime Hub        Event Projector
              │                  │                   │
              │          ┌───────┼────────┐          │
              │          │       │        │          │
              ▼          ▼       ▼        ▼          ▼
         Assembly      QEMU     OVS      ns-3      WebSocket
          Rules         │        │        │
                        └────────┴────────┘
                                 │
                    Linux Simulation Host
```

---

# 3. 技术选型：每一层使用什么语言

## 3.1 前端

### TypeScript

用于：

- UI
- 3D 场景
- 设备交互
- 状态管理
- WebSocket
- Command 构造
- 数据模型

原因：类型系统可以约束设备、端口、连接、事件等复杂数据结构。

### React

用于：

- 页面
- 属性面板
- 设备目录
- 实验管理
- 终端窗口
- 日志
- 命令面板

### Three.js

用于：

- 3D 渲染
- 模型加载
- 射线拾取
- 鼠标交互
- 线缆
- 状态灯
- 动态效果
- 摄像机

渲染器优先使用 Three.js `WebGPURenderer`，对不支持 WebGPU 的环境保留 WebGL2 路径。Three.js 官方文档说明该渲染器会优先使用 WebGPU，不支持时可回退到 WebGL2。

---

## 3.2 后端

### Python

作为主后端语言。

用途：

- DRF
- 数据模型
- API
- WebSocket
- Command Handler
- Rule Engine
- Runtime Adapter
- QEMU/libvirt 控制编排
- OVS 控制
- ns-3 作业控制
- 实验快照
- Agent/MCP 接口

### C++

用于：

- 高频仿真
- ns-3 扩展
- 光链路/无线电底层模型
- 对性能敏感的 Protocol Engine
- 自定义 NetDevice / Channel

### Rust（第二阶段可选）

仅在以下情况使用：

- 需要极高并发事件处理
- 需要更强内存安全保证的长期运行 Runtime
- 需要独立编译为单二进制设备仿真器

第一版不要强行引入 Rust。

### Java

第一版不采用。

原因：本项目没有必须使用 JVM 的核心组件；会增加工程复杂度。

---

# 4. 仿真后端选择规则

设备不是按照“看起来像什么”决定后端，而是按照“运行时需求”决定。

| 设备/对象 | 默认 Runtime | 目的 |
|---|---|---|
| PC | QEMU/KVM | 真实 OS |
| Server | QEMU/KVM | 真实 OS/服务 |
| Router | QEMU/KVM + Linux/合法网络OS | 真实协议栈 |
| Firewall | QEMU/KVM | 真实策略/服务 |
| Switch | OVS | L2 数据平面 |
| L3 Switch | Linux/FRR + OVS 或 QEMU | L2/L3 |
| AP | ns-3 | WLAN/信道 |
| Laptop/Phone | ns-3 或轻量逻辑节点 | Wi-Fi STA |
| ONU/OLT | Custom Simulator | PON 状态机/链路 |
| Fiber | Custom / Network impairment | 时延/损耗/断裂 |
| Radio | ns-3/C++ | RF/协议模型 |
| Power Supply | Custom State Machine | 电气状态 |
| Monitor | QEMU display/noVNC + 3D model | 画面 |
| Keyboard/Mouse | QEMU input | 输入 |
| Cable | Topology + Runtime adapter | 物理/逻辑连接 |

QEMU 官方文档把系统仿真与设备仿真作为一整套能力，并支持多类网络、存储、USB、PCI 等设备，因此它应该承担“需要真实来宾 OS”的部分，而不是整个系统唯一的仿真器。

---

# 5. 仓库标准

最终仓库：

```text
3d-network-simlab/
├── AGENTS.md
├── README.md
├── Makefile
├── .env.example
├── docker-compose.yml
│
├── frontend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── public/
│   │   ├── models/
│   │   ├── textures/
│   │   └── icons/
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── api/
│       ├── components/
│       ├── scene/
│       ├── devices/
│       ├── topology/
│       ├── assembly/
│       ├── runtime/
│       ├── websocket/
│       ├── stores/
│       ├── terminal/
│       └── utils/
│
├── backend/
│   ├── pyproject.toml
│   ├── alembic.ini
│   ├── migrations/
│   └── app/
│       ├── main.py
│       ├── config.py
│       ├── db.py
│       ├── models/
│       ├── schemas/
│       ├── api/
│       ├── services/
│       ├── topology/
│       ├── assembly/
│       ├── events/
│       ├── devices/
│       ├── runtime/
│       ├── experiments/
│       ├── websocket/
│       ├── auth/
│       └── workers/
│
├── runtime/
│   ├── qemu/
│   ├── ovs/
│   ├── ns3/
│   └── custom/
│
├── simulator/
│   ├── optical/
│   ├── radio/
│   └── power/
│
├── schemas/
│   ├── device-manifest.schema.json
│   ├── topology.schema.json
│   ├── command.schema.json
│   └── event.schema.json
│
├── ops/
│   ├── windows/
│   └── linux/
│
├── tests/
│   ├── backend/
│   ├── frontend/
│   ├── integration/
│   └── e2e/
│
├── docs/
│   ├── architecture/
│   ├── implementation/
│   └── runbooks/
│
└── assets/
    ├── device-models/
    ├── textures/
    └── sample-images/
```

---

# 6. 模块总表：每个模块做什么、用什么、最终效果

| 模块 | 主要语言 | 核心技术 | 最终效果 |
|---|---|---|---|
| 3D Scene | TS | Three.js | 能看见整个实验空间 |
| Device Renderer | TS | Three.js/GLTF | 设备可以显示 |
| Device Catalog | TS/Python | REST | 从目录选择设备 |
| Device Registry | Python/PostgreSQL | FastAPI/SQLAlchemy | 后台登记设备 |
| Assembly Engine | Python/TS | Rule Engine | 真实装配逻辑 |
| Cable Engine | Python/TS | Graph + Port Rules | 插拔线缆 |
| Topology Engine | Python | Graph | 网络拓扑一致性 |
| State Machine | Python | FSM | POWER/LINK/BOOT 状态 |
| Command Bus | Python | Command pattern | 所有操作统一进入后台 |
| Event Bus | Python | Async event | 实时状态广播 |
| WebSocket | Python/TS | WS | 前后端实时同步 |
| QEMU Runtime | Python | libvirt/QMP | 真OS运行 |
| OVS Runtime | Python/Shell | ovs-vsctl/ip | 真L2转发 |
| Linux Net Runtime | Python/Shell | netns/veth/tc | 网络实验 |
| Router Runtime | Python | QEMU/FRR | 路由实验 |
| Firewall Runtime | Python | QEMU/nftables | 防火墙实验 |
| ns-3 Runtime | C++/Python | ns-3 | WiFi/RF |
| Optical Runtime | C++/Python | FSM/Discrete Event | 光猫/光链路 |
| Power Runtime | Python | FSM | 通电/断电 |
| Terminal | TS | noVNC/xterm | 看到真实 OS |
| Snapshot | Python | QEMU snapshot + DB | 保存/恢复实验 |
| Experiment | Python | PostgreSQL | 实验管理 |
| Scoring | Python | Rule engine | 自动评分 |
| Agent | Python | MCP + tool API | AI 自动搭建/排障 |
| Plugin System | Python/TS | manifest | 动态添加设备 |
| Audit/Security | Python | JWT/RBAC/audit | 安全控制 |

---

# 7. 核心领域模型

所有模块统一围绕这些对象编写。

## 7.1 User

```text
id
username
password_hash
role
status
created_at
```

角色至少：

```text
ADMIN
TEACHER
STUDENT
OPERATOR
```

---

## 7.2 Experiment

```text
id
name
owner_id
status
simulation_mode
created_at
updated_at
```

`simulation_mode`：

```text
VISUAL
PROTOCOL
REAL_RUNTIME
HYBRID
```

---

## 7.3 Scene

```text
id
experiment_id
name
world_json
camera_json
settings_json
```

`world_json` 保存：

```json
{
  "gravity": 9.81,
  "units": "meter",
  "grid": {
    "enabled": true,
    "size": 1
  }
}
```

---

## 7.4 DeviceInstance

```text
id
experiment_id
device_model_id
name
runtime_type
runtime_instance_id
position_x
position_y
position_z
rotation_x
rotation_y
rotation_z
power_state
operational_state
metadata_json
```

---

## 7.5 DevicePort

```text
id
device_instance_id
port_name
port_type
protocol
speed_bps
admin_state
oper_state
mac_address
ip_config_json
position_json
```

---

## 7.6 Cable

```text
id
experiment_id
cable_type
source_device_id
source_port_id
target_device_id
target_port_id
length_m
bandwidth_bps
latency_ms
packet_loss
state
metadata_json
```

---

# 8. Device Manifest 规范

所有可插拔设备必须通过 Manifest 描述。

示例：

```json
{
  "manifest_version": "1.0",
  "device_type": "pc",
  "model_id": "pc-atx-demo-001",
  "name": "ATX Desktop PC",
  "visual": {
    "model": "models/pc-atx-demo.glb",
    "scale": 1.0,
    "pivot": [0, 0, 0]
  },
  "ports": [
    {
      "id": "eth0",
      "name": "Ethernet",
      "type": "RJ45",
      "protocol": "ethernet",
      "speed_bps": 1000000000,
      "position": [0.42, 0.80, -0.25]
    },
    {
      "id": "hdmi0",
      "name": "HDMI",
      "type": "HDMI",
      "protocol": "display",
      "position": [0.42, 0.90, -0.25]
    }
  ],
  "components": [
    {
      "slot_id": "cpu_socket",
      "slot_type": "cpu_socket",
      "accepted": ["LGA1700"]
    }
  ],
  "runtime": {
    "type": "qemu",
    "profile": "linux-desktop"
  }
}
```

Agent 必须实现 JSON Schema 校验，并在导入时拒绝非法 Manifest。

---

# 9. Device Registry 模块

## 9.1 技术

语言：Python

框架：DRF

ORM：SQLAlchemy 2.x

数据库：PostgreSQL

文件：MinIO/S3

## 9.2 功能

管理员：

```text
新增设备模型
上传 3D 模型
上传镜像
创建端口
创建硬件槽位
定义兼容规则
指定 Runtime
禁用设备
删除设备
查看镜像哈希
```

## 9.3 API

```http
GET    /api/v1/device-models
POST   /api/v1/device-models
GET    /api/v1/device-models/{id}
PATCH  /api/v1/device-models/{id}
DELETE /api/v1/device-models/{id}
POST   /api/v1/device-models/{id}/publish
POST   /api/v1/device-models/{id}/assets
```

## 9.4 验收

添加一台交换机后：

```text
后台数据库出现 device_model
 ↓
前端目录出现设备卡片
 ↓
拖入场景
 ↓
3D模型出现
 ↓
端口数量正确
```

---

# 10. 3D Scene 模块

## 10.1 技术

语言：TypeScript

技术：React + Three.js

模型格式：GLB/GLTF

## 10.2 文件

```text
frontend/src/scene/
├── SceneRoot.tsx
├── CameraController.ts
├── Lighting.ts
├── Grid.ts
├── SelectionManager.ts
├── TransformController.ts
├── RaycastService.ts
└── SceneSerializer.ts
```

## 10.3 SceneRoot

负责：

- 创建 renderer
- 创建 scene
- 创建 camera
- 创建 lights
- 创建 controls
- 注册 pointer 事件
- 管理设备实体
- 管理线缆实体

## 10.4 单位

全平台统一：

```text
1 Three.js unit = 1 meter
```

## 10.5 交互

左键：选择设备

双击：打开设备

拖动：移动

右键：上下文菜单

鼠标滚轮：缩放

中键：平移/旋转

键盘：

```text
R = rotate
G = move
Delete = delete
Space = power
Ctrl+S = save
```

## 10.6 效果

选中设备后：

```text
设备外轮廓高亮
出现属性面板
显示设备名称
显示运行状态
显示端口状态
```

---

# 11. Device Renderer 模块

不要为每种设备写大量固定代码。

采用：

```text
Manifest
  ↓
GenericDeviceRenderer
  ↓
加载 GLB
  ↓
绑定端口锚点
  ↓
绑定 LED
  ↓
绑定按钮
  ↓
绑定可拆卸部件
```

## 11.1 Node Naming 规范

GLB 模型内节点名：

```text
DEVICE_BODY
PORT_ETH_01
PORT_ETH_02
PORT_HDMI_01
PORT_USB_01
POWER_BUTTON
LED_POWER
LED_STATUS
FAN_CPU
COMP_CPU_SOCKET
COMP_RAM_SLOT_01
COMP_RAM_SLOT_02
COMP_PCIEX16_01
```

Agent 导入模型后按照 Node Name 自动注册节点。

## 11.2 如果模型不存在

允许使用程序化简化模型：

```text
BoxGeometry
CylinderGeometry
PlaneGeometry
Line
```

先让系统跑起来，再替换真实 GLB。

---

# 12. Port 系统

端口是整个系统非常重要的基础对象。

接口：

```python
class PortRuntime:
    id: str
    device_id: str
    type: str
    protocol: str
    speed_bps: int | None
    admin_state: str
    oper_state: str
    connected_to: str | None
```

端口状态：

```text
DISABLED
DOWN
CONNECTING
UP
ERROR
```

插线必须执行：

```text
检查 source port
 ↓
检查 target port
 ↓
检查 connector compatibility
 ↓
检查端口是否占用
 ↓
创建 cable
 ↓
调用 runtime adapter
 ↓
等待 link event
 ↓
广播 link.up/down
```

---

# 13. Cable Engine

## 13.1 Cable 分类

```text
ETHERNET_COPPER
OPTICAL_FIBER
HDMI
DISPLAYPORT
USB
SATA
PCIE
POWER_AC
POWER_DC
CONSOLE
```

## 13.2 每种 Cable 有规则

例如 RJ45：

```text
RJ45 -> RJ45
Ethernet -> Ethernet
```

HDMI：

```text
HDMI_SOURCE -> HDMI_INPUT
```

电源：

```text
PSU_OUTPUT -> DEVICE_POWER_INPUT
```

## 13.3 3D 效果

线缆不是一条静态 Line。

使用：

```text
CatmullRomCurve3
TubeGeometry
```

根据两个端口位置生成曲线。

拖动设备时实时重新计算 curve。

拔线时：

```text
mouse down cable
 ↓
拖出
 ↓
端口解除
 ↓
动画缩回/消失
 ↓
runtime link down
```

---

# 14. Assembly Engine：装机系统

这是 PC 数字孪生最核心模块之一。

语言：Python

规则表达：JSON + Python Rule Handler

## 14.1 Component

```text
Case
Motherboard
CPU
Cooler
RAM
GPU
SSD
HDD
PSU
NIC
Fan
```

## 14.2 Slot

```text
CPU_SOCKET
RAM_SLOT
PCIE_X16
PCIE_X4
M2
SATA
PSU_24PIN
CPU_POWER_8PIN
GPU_POWER
FAN_HEADER
```

## 14.3 安装动作

Command：

```json
{
  "type": "assembly.install_component",
  "device_id": "pc01",
  "component_id": "cpu01",
  "slot_id": "cpu_socket"
}
```

## 14.4 后端处理

```text
AssemblyService.install_component()
 ↓
load component
 ↓
load slot
 ↓
CompatibilityRule.validate()
 ↓
检查冲突
 ↓
更新数据库
 ↓
更新 3D state
 ↓
产生 event
```

## 14.5 Rule 示例

```python
def cpu_socket_rule(cpu, motherboard):
    return cpu.socket == motherboard.cpu_socket
```

## 14.6 Power Rule

总功耗：

```text
system_power = sum(component.tdp * usage_factor)
```

安全上限：

```text
required_power = system_power * 1.25
```

如果 PSU < required_power：

```text
power_check = FAIL
```

但不要把“功率不足”误判为“组件不能物理安装”。

---

# 15. Power Engine

语言：Python

采用 FSM。

```text
OFF
 ↓ power_on
STANDBY
 ↓ power_button
POWERING
 ↓ power_good
POST
 ↓ boot
BOOTING
 ↓ OS_READY
RUNNING
```

异常：

```text
POWERING
  ↓ power_fail
FAULT_POWER
```

## 15.1 检查项

PC 开机前：

```text
主板存在？
CPU存在？
CPU供电连接？
RAM至少一条？
24-pin供电？
CPU 8-pin供电？
PSU已通电？
短路状态？
```

GPU、SSD、显示器不一定都是“禁止开机条件”，而根据设备定义决定。

---

# 16. Device State Machine

统一状态：

```text
CREATED
ASSEMBLING
READY_FOR_POWER
POWERING_ON
BIOS
BOOTING
RUNNING
SHUTTING_DOWN
OFF
FAULT
```

后端禁止前端直接写状态。

前端只能发 Command：

```text
power_on
power_off
restart
reset
```

由 StateMachine 判断是否允许转换。

---

# 17. Command 系统

所有改变状态的操作统一 Command。

```text
CreateDevice
DeleteDevice
MoveDevice
InstallComponent
RemoveComponent
ConnectCable
DisconnectCable
PowerOn
PowerOff
Restart
ConfigurePort
ConfigureIPAddress
ConfigureRoute
InjectFault
CreateSnapshot
RestoreSnapshot
```

接口：

```python
class CommandHandler:
    async def execute(command: Command) -> CommandResult:
        ...
```

## 17.1 CommandResult

```json
{
  "success": true,
  "command_id": "cmd_xxx",
  "state_changes": [
    {
      "entity": "pc01",
      "field": "power_state",
      "from": "OFF",
      "to": "POWERING_ON"
    }
  ],
  "events": ["device.powering_on"]
}
```

失败：

```json
{
  "success": false,
  "error_code": "POWER_CABLE_NOT_CONNECTED",
  "message": "设备未连接电源"
}
```

---

# 18. Event Bus

语言：Python

第一版实现：asyncio in-process event bus。

后续可替换：Redis Streams / NATS。

事件格式：

```json
{
  "event_id": "evt_001",
  "event_type": "port.link.changed",
  "experiment_id": "exp01",
  "device_id": "sw01",
  "timestamp": "2026-10-03T20:00:00Z",
  "data": {
    "port": "1",
    "old": "DOWN",
    "new": "UP"
  }
}
```

必须做到：

```text
Runtime event
 ↓
Event Bus
 ├── DB projector
 ├── WebSocket projector
 ├── Score projector
 └── Agent projector
```

---

# 19. WebSocket 系统

连接：

```text
/ws/experiments/{experiment_id}
```

客户端发送：

```json
{
  "type": "command",
  "command": {
    "type": "device.power_on",
    "device_id": "pc01"
  }
}
```

服务端发送：

```json
{
  "type": "event",
  "event_type": "device.state.changed",
  "payload": {
    "device_id": "pc01",
    "state": "BOOTING"
  }
}
```

前端只能把 Event 当作事实同步源，不自行猜测后端真实状态。

---

# 20. Topology Engine

语言：Python

数据结构：Graph

可用：

```python
networkx
```

第一版目标不是用 NetworkX 直接控制数据平面，而是用它进行：

- 拓扑图管理
- 环路检查
- 端口占用检查
- 连通性分析
- 路径搜索
- 实验评分

真正的数据包走向由 OVS/QEMU/ns-3 等 Runtime 决定。

---

# 21. QEMU Runtime Adapter

## 21.1 技术

语言：Python

调用：

```text
libvirt Python API
QMP
virsh
```

QEMU 负责：

```text
CPU
RAM
Disk
NIC
PCI
USB
Display
BIOS/UEFI
Guest OS
```

官方 QEMU 文档将其定位为完整系统仿真器，并提供设备仿真及网络设备等能力；QMP 用于外部程序通过 JSON 命令控制实例。

## 21.2 Adapter

```python
class QemuRuntimeAdapter(RuntimeAdapter):
    async def create(self, spec): ...
    async def start(self, runtime_id): ...
    async def stop(self, runtime_id): ...
    async def reset(self, runtime_id): ...
    async def destroy(self, runtime_id): ...
    async def snapshot(self, runtime_id, name): ...
    async def restore(self, runtime_id, name): ...
    async def attach_nic(self, runtime_id, network): ...
    async def detach_nic(self, runtime_id, interface): ...
    async def console(self, runtime_id): ...
    async def status(self, runtime_id): ...
```

## 21.3 VM Specification

```json
{
  "name": "pc01",
  "machine": "q35",
  "vcpu": 2,
  "memory_mb": 4096,
  "disk": {
    "path": "/var/lib/simlab/images/ubuntu.qcow2",
    "format": "qcow2"
  },
  "nics": [
    {
      "port_id": "eth0",
      "backend": "ovs",
      "bridge": "br-simlab-sw01"
    }
  ],
  "display": {
    "type": "vnc"
  }
}
```

## 21.4 VM生命周期

```text
DB DeviceInstance
 ↓
RuntimeRegistry
 ↓
QEMU Adapter
 ↓
libvirt define/create
 ↓
QEMU starts
 ↓
wait state
 ↓
emit runtime.ready
```

## 21.5 真实 OS 控制台

推荐第一版使用：

```text
QEMU VNC
 ↓
noVNC
 ↓
Browser
```

后续加入 SPICE 或 serial console。

---

# 22. Open vSwitch Runtime

## 22.1 语言

Python + Shell

## 22.2 功能

Switch 实例的核心对象：

```text
OVS Bridge
OVS Port
OVS Interface
VLAN
STP/RSTP（按需）
QoS
Mirror
```

OVS 官方文档列出了 VLAN、LACP、RSTP、QoS、端口流量控制、OpenFlow、VXLAN/GRE 等能力，因此足够承担第一阶段软件交换机数据平面。

## 22.3 Adapter

```python
class OvsRuntimeAdapter(RuntimeAdapter):
    async def create_switch(self, switch_id): ...
    async def delete_switch(self, switch_id): ...
    async def add_port(self, switch_id, port): ...
    async def remove_port(self, switch_id, port): ...
    async def set_port_up(self, port): ...
    async def set_port_down(self, port): ...
    async def set_vlan(self, port, vlan): ...
    async def get_port_state(self, port): ...
```

## 22.4 物理端口映射

```text
3D Switch Port 01
        ↓
DevicePort(sw01,p01)
        ↓
OVS Port sim-sw01-p01
```

必须保存映射。

---

# 23. Linux Network Runtime

Linux 网络命名空间用于隔离实验。

例如：

```text
namespace exp_001
 ├── switch namespace
 ├── router namespace
 └── custom node namespace
```

使用：

```text
ip netns
ip link add ... type veth
ip link set ... netns ...
bridge
ovs-vsctl
ip addr
ip route
tc qdisc netem
```

注意：所有 Shell 调用必须从 Python 的受限命令层执行，不能直接拼接用户输入。

---

# 24. 链路损耗 / tc-netem

每条实验链路支持：

```text
bandwidth
latency
jitter
packet_loss
duplication
reordering
```

后端将参数转换成 `tc qdisc netem` 配置。

例如：

```text
delay = 50ms
loss = 5%
```

前端实时显示：

```text
50 ms
5 % loss
```

实验结果必须与真实 runtime 状态同步。

---

# 25. Router Runtime

第一版默认：

```text
Linux
+
FRRouting
```

用于：

```text
IPv4
IPv6
Static Route
OSPF
BGP
RIP（按需求）
```

每个 Router 设备可以是：

```text
QEMU Router
```

也可以是：

```text
Lightweight Router Runtime
```

后者不运行完整 OS，仅使用逻辑协议模型。

通过 Manifest：

```json
{
  "runtime": {
    "type": "qemu",
    "features": ["routing", "console"]
  }
}
```

---

# 26. Firewall Runtime

可选实现路径：

```text
Linux + nftables
```

或合法导入并有授权的防火墙 VM 镜像。

第一阶段推荐：

```text
QEMU
+
Linux
+
nftables
```

规则操作：

```text
allow
reject
drop
nat
forward
```

前端效果：

```text
Firewall
 ↓
Policies
 ↓
Packet flow
 ↓
ALLOW / DROP
```

---

# 27. Packet Visualization 模块

第一版不要求抓所有真实 payload；先展示 metadata。

事件：

```json
{
  "event_type": "packet.observed",
  "src": "pc01.eth0",
  "dst": "server01.eth0",
  "protocol": "ICMP",
  "size": 98,
  "state": "FORWARDED"
}
```

3D 中：

```text
PC1
 ●━━━━━━▶
       Switch
         ●━━━━━━▶ Router
```

后续可以做：

```text
Ethernet
IPv4
TCP/UDP
HTTP/DNS
ARP
```

详情面板展示字段。

---

# 28. ns-3 Runtime

## 28.1 语言

C++：核心仿真模型

Python：作业生成、参数配置、启动/采集

## 28.2 使用场景

```text
WiFi
无线信道
RSSI
传播模型
干扰
移动节点
丢包
时延
5G/NR等扩展
```

ns-3 是离散事件网络模拟器；当前官方发布线已经进入 3.47 系列，因此 Agent 不得把项目版本写死为旧版本，安装阶段必须锁定实际测试过的版本，并把版本号写入 runtime capability。

## 28.3 Runtime API

```python
class Ns3RuntimeAdapter:
    async def create_scenario(self, spec): ...
    async def start(self, scenario_id): ...
    async def stop(self, scenario_id): ...
    async def set_node_position(self, node_id, x, y, z): ...
    async def update_wifi_config(self, node_id, config): ...
    async def get_metrics(self, node_id): ...
```

## 28.4 数据同步

ns-3产生：

```text
RSSI
SNR
Tx
Rx
Drop
Latency
Channel
Association
```

后端通过 Event Bus 推送给前端。

---

# 29. Wi-Fi 3D 效果

前端显示：

```text
AP
  ))))))
 ))))))))
)))))))))
```

用多个透明圆环/扇形或 shader 进行可视化。

信号强度与 ns-3 数据绑定：

```text
RSSI > -50    -> strong
-50~-67       -> good
-67~-75       -> fair
< -75         -> poor
```

阈值必须允许管理员配置。

---

# 30. Optical / ONU / OLT Runtime

第一版不模拟完整 PON 物理层。

先实现：

```text
Power
LOS
PON Registration
Authentication State
Upstream/Downstream Link
```

状态机：

```text
OFF
 ↓
BOOT
 ↓
LOS
 ↓
SEARCH
 ↓
SYNC
 ↓
REGISTERING
 ↓
REGISTERED
 ↓
ONLINE
```

光纤拔掉：

```text
ONLINE -> LOS
```

3D：

```text
PON LED: Green -> Off
LOS LED: Off -> Red
Internet LED: Green -> Off
```

第二阶段再扩展：

```text
光功率
距离
损耗
分光比
反射
```

---

# 31. Radio Runtime

第一阶段：离散事件 + 简化信号模型。

实现对象：

```text
RadioNode
Antenna
Channel
Frequency
Power
Bandwidth
Modulation
Interference
```

核心语言：

```text
C++
```

控制层：

```text
Python
```

如需真实波形级处理，再引入 GNU Radio 等专用工具；第一版禁止把波形级 RF DSP 强行塞入 Web 应用。

---

# 32. Device Plugin System

管理员可以添加：

```text
3D Model
Manifest
Image
Runtime Profile
Compatibility Rules
UI schema
```

插件结构：

```text
plugins/
└── demo-router/
    ├── manifest.json
    ├── model.glb
    ├── icon.png
    ├── runtime.json
    ├── rules.json
    └── README.md
```

导入流程：

```text
Upload
 ↓
Hash
 ↓
Virus/File Validation
 ↓
Manifest Validation
 ↓
Asset Registration
 ↓
Runtime Capability Check
 ↓
Publish
```

---

# 33. Terminal / Console 模块

## PC/Server

使用：

```text
VNC + noVNC
```

## Router/Firewall

支持：

```text
Serial Console
SSH Console
Web Console
```

前端统一接口：

```typescript
interface ConsoleSession {
    sessionId: string;
    type: 'vnc' | 'serial' | 'ssh';
    wsUrl: string;
}
```

后端：

```http
POST /api/v1/runtime/{id}/console
```

---

# 34. Inspector 属性面板

点击设备后右侧面板：

```text
设备
────────────────
名称：PC01
类型：PC
状态：RUNNING

CPU
Intel...

Memory
16 GB

Power
ON

Network
eth0 UP
192.168.10.10/24

Ports
ETH0   UP
HDMI0  CONNECTED
USB0   DISCONNECTED

Runtime
QEMU
vm-001
```

属性面板必须由 schema 动态生成，避免给每种设备写独立 UI。

---

# 35. Experiment Engine

创建实验：

```http
POST /api/v1/experiments
```

保存场景：

```http
POST /api/v1/experiments/{id}/snapshot
```

恢复：

```http
POST /api/v1/experiments/{id}/restore/{snapshot_id}
```

实验状态：

```text
DRAFT
RUNNING
PAUSED
COMPLETED
FAILED
ARCHIVED
```

---

# 36. Snapshot System

快照由三层组成：

```text
Layer 1: Scene Snapshot
```

保存：

```text
设备位置
旋转
设备组成
连接关系
UI设置
```

```text
Layer 2: Runtime Snapshot
```

保存：

```text
QEMU VM snapshot
VM disk state
network config
```

```text
Layer 3: Simulation Snapshot
```

保存：

```text
ns-3 parameters
optical states
radio states
```

恢复时必须按照：

```text
停止运行时
 ↓
恢复 Runtime
 ↓
恢复 Topology
 ↓
恢复 Simulation State
 ↓
广播全量状态
```

---

# 37. REST API 完整规划

## 认证

```http
POST /api/v1/auth/login
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
GET  /api/v1/auth/me
```

## Experiment

```http
GET    /api/v1/experiments
POST   /api/v1/experiments
GET    /api/v1/experiments/{id}
PATCH  /api/v1/experiments/{id}
DELETE /api/v1/experiments/{id}
```

## Devices

```http
GET    /api/v1/device-models
GET    /api/v1/device-models/{id}
POST   /api/v1/experiments/{id}/devices
DELETE /api/v1/experiments/{id}/devices/{device_id}
```

## Ports

```http
GET  /api/v1/devices/{device_id}/ports
PATCH /api/v1/devices/{device_id}/ports/{port_id}
```

## Cables

```http
POST   /api/v1/experiments/{id}/cables
DELETE /api/v1/experiments/{id}/cables/{cable_id}
```

## Commands

```http
POST /api/v1/experiments/{id}/commands
```

## Runtime

```http
GET  /api/v1/runtime/{id}
POST /api/v1/runtime/{id}/start
POST /api/v1/runtime/{id}/stop
POST /api/v1/runtime/{id}/restart
POST /api/v1/runtime/{id}/console
```

## Snapshot

```http
POST /api/v1/experiments/{id}/snapshots
GET  /api/v1/experiments/{id}/snapshots
POST /api/v1/experiments/{id}/snapshots/{snapshot_id}/restore
```

---

# 38. REST API 示例：创建 PC

```http
POST /api/v1/experiments/exp01/devices
Content-Type: application/json
```

```json
{
  "device_model_id": "pc-atx-demo-001",
  "name": "PC01",
  "position": [2, 0, 3]
}
```

返回：

```json
{
  "id": "pc01",
  "state": "ASSEMBLING",
  "runtime_type": "qemu"
}
```

---

# 39. 创建连接

```http
POST /api/v1/experiments/exp01/cables
```

```json
{
  "source": {
    "device_id": "pc01",
    "port_id": "eth0"
  },
  "target": {
    "device_id": "sw01",
    "port_id": "1"
  },
  "cable_type": "ETHERNET_COPPER"
}
```

后端执行：

```text
Compatibility Rule
 ↓
DB topology
 ↓
OVS connect
 ↓
QEMU NIC backend
 ↓
wait link
 ↓
Event
```

---

# 40. 数据库 Schema

建议 PostgreSQL 表：

```text
users
roles
experiments
scenes
device_models
device_components
device_slots
device_ports
device_images
device_plugins
device_instances
cables
runtime_instances
runtime_networks
simulation_jobs
simulation_events
experiment_snapshots
experiment_scores
audit_logs
```

## 40.1 关键索引

```sql
CREATE INDEX idx_device_instances_experiment
ON device_instances(experiment_id);

CREATE INDEX idx_device_ports_device
ON device_ports(device_instance_id);

CREATE INDEX idx_cables_experiment
ON cables(experiment_id);

CREATE INDEX idx_events_experiment_time
ON simulation_events(experiment_id, created_at);
```

---

# 41. Runtime Adapter 统一接口

这是整个平台最核心的软件抽象之一。

```python
from abc import ABC, abstractmethod

class RuntimeAdapter(ABC):
    @abstractmethod
    async def provision(self, spec):
        raise NotImplementedError

    @abstractmethod
    async def start(self, runtime_id):
        raise NotImplementedError

    @abstractmethod
    async def stop(self, runtime_id):
        raise NotImplementedError

    @abstractmethod
    async def reset(self, runtime_id):
        raise NotImplementedError

    @abstractmethod
    async def destroy(self, runtime_id):
        raise NotImplementedError

    @abstractmethod
    async def get_state(self, runtime_id):
        raise NotImplementedError

    @abstractmethod
    async def attach(self, runtime_id, port_spec):
        raise NotImplementedError

    @abstractmethod
    async def detach(self, runtime_id, port_id):
        raise NotImplementedError

    @abstractmethod
    async def metrics(self, runtime_id):
        raise NotImplementedError
```

实现：

```text
QemuRuntimeAdapter
OvsRuntimeAdapter
Ns3RuntimeAdapter
OpticalRuntimeAdapter
RadioRuntimeAdapter
PowerRuntimeAdapter
```

---

# 42. Runtime Registry

启动时注册：

```python
registry.register('qemu', QemuRuntimeAdapter())
registry.register('ovs', OvsRuntimeAdapter())
registry.register('ns3', Ns3RuntimeAdapter())
registry.register('optical', OpticalRuntimeAdapter())
registry.register('radio', RadioRuntimeAdapter())
registry.register('power', PowerRuntimeAdapter())
```

Manifest 写：

```json
{
  "runtime": {
    "type": "qemu"
  }
}
```

系统自动选择。

---

# 43. 权限与安全

因为 QEMU、OVS、网络命名空间操作都可能具备宿主机级权限，所以必须把 Web 用户和 Host Operator 分开。

## 43.1 Web 用户

只允许：

```text
创建实验
编辑拓扑
发送白名单 Command
```

## 43.2 Runtime Worker

使用专门 Linux service account：

```text
simlab-runtime
```

禁止使用 root 直接运行 Web API。

## 43.3 高权限命令

所有 host command 必须经过：

```text
AllowedCommand
 ↓
Argument Validator
 ↓
Execution Policy
 ↓
Audit Log
 ↓
execute
```

绝对禁止：

```python
subprocess.run(user_input, shell=True)
```

必须采用：

```python
subprocess.run(
    ['ovs-vsctl', '--may-exist', 'add-port', bridge, port],
    check=True,
    text=True,
    capture_output=True,
)
```

---

# 44. 文件/镜像安全

管理员上传镜像后记录：

```text
filename
size
sha256
format
architecture
license
source_url
uploaded_by
created_at
```

镜像类型：

```text
qcow2
raw
iso
img
```

禁止通过 API 接口直接把浏览器文件路径传给宿主机命令执行层。

---

# 45. Linux 仿真节点安装

推荐 Ubuntu 24.04 LTS。

执行：

```bash
sudo apt update
sudo apt install -y \
  qemu-system-x86 \
  qemu-utils \
  qemu-guest-agent \
  libvirt-daemon-system \
  libvirt-clients \
  libvirt-dev \
  virtinst \
  ovmf \
  cloud-image-utils \
  openvswitch-switch \
  openvswitch-common \
  iproute2 \
  iptables \
  nftables \
  tcpdump \
  git \
  curl \
  wget \
  jq \
  build-essential \
  pkg-config \
  python3 \
  python3-venv \
  python3-pip
```

启动：

```bash
sudo systemctl enable --now libvirtd
sudo systemctl enable --now openvswitch-switch
```

用户组：

```bash
sudo usermod -aG libvirt,kvm "$USER"
```

重新登录后检查：

```bash
ls -l /dev/kvm
virsh -c qemu:///system list --all
ovs-vsctl show
```

---

# 46. QEMU 最小验证

先单独确认：

```bash
qemu-system-x86_64 --version
virsh --version
```

准备一个合法的 Linux QCOW2 镜像，例如管理员自行下载的 Ubuntu Cloud Image。

然后先手工启动单台测试 VM，再接入项目。

目标：

```text
VM 能创建
VM 能启动
VM 能关机
VM 能查看状态
VM 能打开 VNC/serial console
```

不要在这一步同时引入 OVS、ns-3 和 3D。

---

# 47. OVS 最小验证

创建 bridge：

```bash
sudo ovs-vsctl --may-exist add-br br-simlab-test
sudo ovs-vsctl show
```

删除：

```bash
sudo ovs-vsctl --if-exists del-br br-simlab-test
```

目标：

```text
3D Switch
 ↕
OvsRuntimeAdapter
 ↕
br-simlab-*
```

---

# 48. 两台 Linux VM + OVS 闭环

必须做出这个验收：

```text
PC1(QEMU)
   │
 vNIC
   │
 OVS
   │
 vNIC
   │
PC2(QEMU)
```

在 PC1：

```bash
ping PC2_IP
```

应该成功。

然后由系统执行：

```text
DisconnectCable(pc1.eth0, sw01.p01)
```

PC1：

```text
Link DOWN
```

重新连接：

```text
Link UP
```

这是第一条真正的“数字孪生闭环”验收标准。

---

# 49. ns-3 安装原则

不要把 ns-3 直接安装到 Web API 容器里。

采用单独 Simulation Worker：

```text
simlab-api
simlab-worker
simlab-ns3-worker
```

Agent 在安装时：

1. 检测系统编译器。
2. 检测 CMake/Ninja。
3. 安装并锁定 ns-3 版本。
4. 编译 demo。
5. 运行 Wi-Fi sample。
6. 保存版本信息。
7. 通过 capability API 上报。

当前官方资料显示 ns-3 已发布到 3.47 系列，因此不要照抄旧版本脚本；应该以实际安装验证版本为准。

---

# 50. Docker Compose

容器只承载：

```text
PostgreSQL
Redis
MinIO
API
Worker
```

第一版不要把 QEMU/KVM 强制塞进普通 Docker Compose 容器。

结构：

```text
Docker
├── postgres
├── redis
├── minio
├── backend
└── worker

Host
├── libvirt
├── QEMU/KVM
├── OVS
└── ns-3
```

如果后续做专用模拟计算节点，再单独制定 privileged runtime worker 镜像。

---

# 51. `.env` 标准

```env
APP_ENV=development
APP_HOST=0.0.0.0
APP_PORT=8000

DATABASE_URL=postgresql+asyncpg://simlab:simlab@localhost:5432/simlab
REDIS_URL=redis://localhost:6379/0
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=simlab
S3_SECRET_KEY=change-me

RUNTIME_HOST=192.168.1.100
LIBVIRT_URI=qemu:///system
QEMU_IMAGE_ROOT=/var/lib/simlab/images
QEMU_RUNTIME_ROOT=/var/lib/simlab/runtime

OVS_PREFIX=simlab
NS3_ROOT=/opt/ns-3
```

正式环境必须改密码和密钥。

---

# 52. 后端启动

进入：

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

运行：

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

检查：

```text
http://127.0.0.1:8000/docs
```

---

# 53. 前端启动

Windows/Linux/macOS 均可：

```bash
cd frontend
npm install
npm run dev
```

访问：

```text
http://localhost:5173
```

前端环境变量：

```env
VITE_API_BASE=http://localhost:8000
VITE_WS_BASE=ws://localhost:8000
```

---

# 54. 最小 MVP 必须实现什么

MVP 不包含所有设备。

只包含：

```text
PC
Switch
Ethernet Cable
Monitor
Power
```

必须实现：

```text
3D PC
3D Switch
3D Monitor
拖动
选择
端口
插网线
拔网线
电源按钮
状态灯
实验保存
```

Backend：

```text
Device API
Topology API
Command API
WebSocket
```

Runtime：

```text
逻辑状态机
```

先不要依赖真实 QEMU。

---

# 55. MVP 第二阶段

加入：

```text
QEMU
OVS
```

效果：

```text
3D PC01
 ↓
QEMU PC01
 ↓
OVS
 ↓
QEMU PC02
```

真实：

```text
ping
```

---

# 56. MVP 第三阶段

加入：

```text
Router
Server
Firewall
```

真实：

```text
DHCP
DNS
ICMP
HTTP
Static Route
NAT
Firewall Rule
```

---

# 57. MVP 第四阶段

加入：

```text
AP
Laptop
WiFi
```

Runtime：

```text
ns-3
```

前端实时显示：

```text
RSSI
Association
Throughput
Packet Loss
```

---

# 58. MVP 第五阶段

加入：

```text
OLT
ONU
Fiber
Radio
```

使用：

```text
C++/Python custom runtime
```

---

# 59. 前端 State Store

推荐 Zustand。

Stores：

```text
useExperimentStore
useSceneStore
useDeviceStore
useTopologyStore
useRuntimeStore
useSelectionStore
useEventStore
useUiStore
```

状态来源：

```text
REST -> initial state
WebSocket -> authoritative event updates
```

禁止多个 store 同时持有互相冲突的设备状态。

---

# 60. 前端 Command Client

```typescript
export async function sendCommand(
  experimentId: string,
  command: Command,
) {
  const response = await fetch(
    `${API}/api/v1/experiments/${experimentId}/commands`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(command),
    },
  );

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}
```

UI 永远调用 Command，不直接修改后端状态。

---

# 61. 3D 与业务状态映射

例如：

```typescript
switch (device.powerState) {
  case 'OFF':
    setPowerLed(false);
    setFanSpeed(0);
    break;
  case 'BOOTING':
    setPowerLed(true);
    setFanSpeed(0.7);
    break;
  case 'RUNNING':
    setPowerLed(true);
    setFanSpeed(1.0);
    break;
  case 'FAULT':
    setPowerLed(true);
    setFaultLed(true);
    break;
}
```

这段逻辑只负责“表现”，状态仍来自后端。

---

# 62. 3D 物理效果模块

需要实现：

```text
重力感
磁吸/插槽吸附
设备碰撞盒
端口吸附
线缆弯曲
设备移动
旋转
拆卸动画
安装动画
灯光
风扇
散热器
电源灯
Link灯
Wi-Fi 信号
光纤发光
数据包运动
```

## 62.1 第一版物理

不要引入复杂物理引擎。

用：

```text
AABB
BoundingBox
CollisionBox
SnapPoint
```

完成：

```text
拖到主板附近
 ↓
自动吸附
```

## 62.2 第二版

再评估 Rapier 等 Web 物理库。

---

# 63. PC 装配 3D 实现方式

每个部件需要两个状态：

```text
Logical Component State
Visual Component State
```

例如 GPU：

```text
logical.installed = true
visual.position = slot.worldPosition
visual.rotation = slot.worldRotation
```

拆卸：

```text
visual -> animation
logical -> command
```

不能先视觉安装后才告诉后端。

必须：

```text
用户释放鼠标
 ↓
frontend provisional placement
 ↓
POST command
 ↓
backend rule validation
 ↓
SUCCESS
    -> commit visual placement
FAIL
    -> animate back
```

---

# 64. 设备开机时的真实流程

用户点击电源：

```text
Frontend
 ↓
Command: device.power_on
 ↓
Backend
 ↓
Assembly Validation
 ↓
Power Validation
 ↓
Device State Machine
 ↓
Runtime Adapter
 ↓
QEMU start
 ↓
QEMU event
 ↓
Event Bus
 ↓
WebSocket
 ↓
Frontend
 ↓
3D LED / Fan / Monitor
```

这个流程必须写成自动化测试。

---

# 65. “开机失败”的表现

例：CPU 供电没接。

用户按电源：

```text
状态：POWERING_ON
 ↓
检测失败
 ↓
FAULT
```

前端：

```text
电源灯：红色
风扇：停止
错误面板：
CPU 供电未连接
```

错误信息：

```json
{
  "error_code": "CPU_POWER_MISSING",
  "severity": "ERROR",
  "recoverable": true,
  "suggested_action": "connect_cpu_power"
}
```

---

# 66. 逻辑仿真模式

当用户选择：

```text
Protocol Simulation
```

PC 不启动完整 OS。

只建立：

```text
Node
NIC
IPv4
ARP
ICMP
DHCP
DNS
```

这样能够让大量设备同时存在。

---

# 67. 混合模式

推荐正式产品使用：

```text
HYBRID
```

例如：

```text
100 PC -> 90 logical + 10 QEMU
20 Switch -> OVS
5 Router -> QEMU
1 WiFi -> ns-3
```

前端完全看不出实现差异，只看到：

```text
设备状态
```

这是项目大规模运行的关键。

---

# 68. 调度器

Runtime Scheduler 负责决定：

```text
哪个 Runtime 跑在哪个 Host
```

输入：

```text
CPU demand
RAM demand
Device count
Network complexity
Priority
```

输出：

```text
host_id
runtime_type
resource allocation
```

第一版：单节点。

第二版：多节点。

---

# 69. Simulation Job

数据：

```text
id
experiment_id
runtime_type
host_id
status
started_at
finished_at
error
metrics_json
```

状态：

```text
QUEUED
PROVISIONING
RUNNING
STOPPING
STOPPED
FAILED
```

---

# 70. 后台 Worker

必须把耗时操作移出 API 进程：

```text
QEMU 创建
QEMU 快照
OVS 批量配置
ns-3 运行
文件校验
镜像导入
```

第一版：Celery 或 Arq。

本项目推荐：

```text
Arq + Redis
```

因为 Python asyncio 场景简单。

---

# 71. Agent / MCP 层

Agent 后续不是直接操作底层 Linux，而是调用平台 Tool。

Tools：

```text
create_experiment
add_device
remove_device
move_device
install_component
connect_cable
disconnect_cable
power_on
power_off
configure_ip
configure_route
configure_firewall
start_runtime
stop_runtime
inspect_device
inspect_port
trace_packet
create_snapshot
restore_snapshot
validate_topology
run_experiment
```

Agent 输入：

```text
“创建一个两台电脑、一台交换机、一台路由器的网络，并让PC1可以访问PC2。”
```

Agent 调用：

```text
create_experiment
add_device ×4
connect_cable ×3
power_on ×4
configure_ip
configure_route
run_experiment
validate_topology
```

---

# 72. Agent 安全模型

Agent 不应拿到：

```text
root shell
任意 shell
任意文件写入
```

只拿到受控工具：

```text
create_device
connect_port
power_on
configure_ip
```

平台层负责把工具调用转换为 Command。

---

# 73. 自动评分

评分规则 JSON：

```json
{
  "checks": [
    {
      "id": "pc1_ip",
      "type": "ip_match",
      "device": "pc01",
      "expected": "192.168.10.10/24",
      "score": 10
    },
    {
      "id": "connectivity",
      "type": "ping",
      "from": "pc01",
      "to": "pc02",
      "score": 20
    }
  ]
}
```

结果：

```json
{
  "score": 90,
  "passed": 8,
  "failed": 2,
  "details": []
}
```

---

# 74. 实验日志

记录：

```text
谁
何时
对什么设备
执行什么动作
结果
错误
Runtime变化
```

例如：

```json
{
  "user": "student01",
  "action": "disconnect_cable",
  "device": "pc01",
  "port": "eth0",
  "result": "success"
}
```

用于：

```text
实验回放
评分
审计
Agent诊断
```

---

# 75. 实验回放

因为所有 Command + Event 都保存，所以可以：

```text
时间轴
0:00 创建PC
0:12 安装CPU
0:24 安装RAM
0:40 接线
1:12 开机
1:48 配置IP
2:10 Ping
```

第一版先做事件时间轴；第二版支持 3D 场景回放。

---

# 76. API 版本与兼容性

所有接口：

```text
/api/v1/...
```

Command 带：

```json
{
  "schema_version": "1.0",
  "command_version": "1.0"
}
```

未来修改字段时，不允许直接破坏旧实验。

---

# 77. 日志系统

后端统一 JSON log：

```json
{
  "timestamp": "...",
  "level": "INFO",
  "service": "runtime",
  "experiment_id": "exp01",
  "device_id": "pc01",
  "message": "VM started"
}
```

第一版 stdout。

第二版接 Loki / OpenTelemetry。

---

# 78. Metrics

至少统计：

```text
qemu_vm_count
qemu_vm_cpu
qemu_vm_memory
ovs_port_count
simulation_event_rate
websocket_connections
command_latency
runtime_start_latency
packet_loss
```

第一版可 Prometheus endpoint：

```text
/metrics
```

---

# 79. 性能目标

第一版目标：

```text
前端 3D 场景：60 FPS @ 100设备
WebSocket：<100ms 状态传播目标
Command API：P95 < 200ms（不含 QEMU 启动）
3D 操作：本地 < 16ms/frame
```

QEMU 启动时间不纳入同步 API 的严格延迟指标。

---

# 80. 3D 性能优化

必须：

```text
GLB
Draco compression（模型允许时）
InstancedMesh
LOD
Frustum Culling
Texture Atlas
对象池
避免每帧创建对象
```

不要：

```text
每根线每帧新建 geometry
每个设备每帧 setState
大量 React DOM overlay
```

---

# 81. 数据一致性原则

唯一事实来源：

```text
Backend Runtime + DB state
```

前端只是：

```text
Projection
```

如果 WebSocket 断线：

```text
自动重连
 ↓
GET snapshot/state
 ↓
重新同步
```

---

# 82. 断线恢复

WebSocket：

```text
CONNECTED
 ↓ network error
RECONNECTING
 ↓
RESYNC
 ↓
CONNECTED
```

前端必须显示：

```text
实时连接：正常 / 重连中
```

---

# 83. QEMU Runtime 健康检查

后台周期性检查：

```text
libvirt connected?
/dev/kvm?
QEMU binary?
image directory?
OVS available?
```

API：

```http
GET /api/v1/runtime/capabilities
```

返回：

```json
{
  "qemu": true,
  "kvm": true,
  "ovs": true,
  "ns3": true,
  "version": {}
}
```

前端设备目录根据 capability 决定哪些设备可以使用 REAL_RUNTIME。

---

# 84. Capability 模型

设备不是简单地：

```text
runtime=qemu
```

而应声明：

```json
{
  "capabilities": [
    "power",
    "console",
    "ethernet",
    "snapshot",
    "real_os"
  ]
}
```

这样前端动态显示按钮：

```text
支持开机 -> 显示电源按钮
支持 Console -> 显示控制台
支持 Snapshot -> 显示快照
```

---

# 85. 错误系统

统一错误码：

```text
DEVICE_NOT_FOUND
PORT_NOT_FOUND
PORT_ALREADY_CONNECTED
CABLE_INCOMPATIBLE
COMPONENT_INCOMPATIBLE
SLOT_OCCUPIED
POWER_CABLE_MISSING
POWER_INSUFFICIENT
RUNTIME_UNAVAILABLE
QEMU_START_FAILED
OVS_PORT_CREATE_FAILED
NS3_JOB_FAILED
SNAPSHOT_FAILED
PERMISSION_DENIED
```

所有错误必须：

```text
machine-readable code
human-readable message
retryable
suggested_action
```

---

# 86. 测试体系

## Unit Test

Python：pytest

TypeScript：Vitest

测试：

```text
Assembly Rules
Port compatibility
State machine
Command handler
Manifest parser
Topology validator
```

## Integration Test

测试：

```text
API + DB
API + OVS
API + libvirt
API + ns-3
```

## E2E

Playwright：

```text
登录
 ↓
新实验
 ↓
拖PC
 ↓
拖Switch
 ↓
连接线缆
 ↓
开机
 ↓
查看状态
```

---

# 87. 核心 E2E #1：PC 装配

测试流程：

```text
create experiment
add case
add motherboard
add cpu
install cpu
install ram
install gpu
install ssd
install psu
connect power
power on
```

期望：

```text
PC state = RUNNING
power LED = ON
fan = spinning
```

---

# 88. 核心 E2E #2：网络连接

```text
add pc1
add switch
add pc2
connect pc1.eth0 -> sw.1
connect pc2.eth0 -> sw.2
```

如果为 logical mode：

```text
link = UP
```

如果为 real mode：

```text
OVS port = UP
QEMU NIC = UP
```

---

# 89. 核心 E2E #3：真实 ping

```text
PC1 QEMU
  ↓
OVS
  ↓
PC2 QEMU
```

在 PC1 执行：

```bash
ping -c 4 192.168.10.20
```

系统必须能采集测试结果：

```text
success = true
latency_ms = ...
loss = 0
```

---

# 90. 核心 E2E #4：拔线

```text
disconnect cable
```

验证：

```text
frontend cable state = disconnected
port state = DOWN
QEMU NIC link = DOWN
ping = FAIL
```

然后重新连接：

```text
port state = UP
ping = PASS
```

---

# 91. 核心 E2E #5：故障注入

故障：

```text
disable switch port 1
```

结果：

```text
3D LED = OFF
port = DOWN
traffic = DROP
```

恢复：

```text
enable port
```

结果：

```text
Link UP
traffic restored
```

---

# 92. Agent 实施阶段

Agent 必须按顺序执行，不允许跳阶段。

---

## PHASE-00：工程初始化

任务：

```text
创建 monorepo
配置 frontend
配置 backend
配置 schemas
配置 tests
配置 docker-compose
```

验收：

```bash
npm install
npm run build

python -m pytest
```

必须通过。

---

## PHASE-01：后端骨架

实现：

```text
FastAPI
config
DB
models
Alembic
health endpoint
```

验收：

```http
GET /health
```

返回：

```json
{"status":"ok"}
```

---

## PHASE-02：前端 3D 骨架

实现：

```text
React
Three.js
camera
lights
grid
orbit
```

验收：

```text
浏览器看到 3D 场景
鼠标旋转/缩放正常
```

---

## PHASE-03：Device Catalog

实现：

```text
device_models
GET API
3D device card
```

验收：

```text
能够显示 PC/Switch/Router 设备卡片
```

---

## PHASE-04：Device Renderer

实现：

```text
GLB loader
port anchors
LED
power button
```

验收：

```text
PC 和 Switch 能拖进场景
```

---

## PHASE-05：Topology

实现：

```text
DeviceInstance
Port
Cable
Graph
```

验收：

```text
两设备可以连接
数据库保存连接
```

---

## PHASE-06：WebSocket

实现：

```text
WS connection
Event Bus
state events
```

验收：

```text
后端修改设备状态
前端实时更新
```

---

## PHASE-07：Assembly

实现：

```text
Component
Slot
Compatibility
Install
Remove
```

验收：

```text
正确部件可安装
错误部件被拒绝
```

---

## PHASE-08：Power

实现：

```text
Power FSM
PSU
power checks
```

验收：

```text
缺电源不能正常启动
完整设备可进入 RUNNING
```

---

## PHASE-09：QEMU

实现：

```text
QemuRuntimeAdapter
libvirt connection
VM provisioning
start/stop
console
```

验收：

```text
UI 点 PC power on
 ↓
QEMU VM 启动
```

---

## PHASE-10：OVS

实现：

```text
OvsRuntimeAdapter
bridge
ports
link state
```

验收：

```text
3D Switch = OVS switch
```

---

## PHASE-11：真实网络

完成：

```text
QEMU PC1
OVS
QEMU PC2
```

验收：

```text
ping success
```

---

## PHASE-12：真实插拔

实现：

```text
connect/disconnect cable
NIC link state
```

验收：

```text
拔线 -> ping fail
插线 -> ping success
```

---

## PHASE-13：Router

实现：

```text
FRR/static route
```

验收：

```text
PC1 -> R1 -> PC2
```

---

## PHASE-14：Firewall

实现：

```text
nftables adapter
rules
```

验收：

```text
allow traffic
block traffic
```

---

## PHASE-15：ns-3

实现：

```text
WiFi scenario
node position
RSSI
association
packet metrics
```

验收：

```text
移动 Laptop
 ↓
RSSI 改变
 ↓
前端信号覆盖改变
```

---

## PHASE-16：Optical

实现：

```text
OLT
ONU
Fiber
LOS
Registration
```

验收：

```text
拔光纤
 ↓
LOS
 ↓
Internet down
```

---

## PHASE-17：Plugin

实现：

```text
Manifest import
Asset storage
Runtime registry
```

验收：

```text
管理员上传新设备
 ↓
设备目录出现
 ↓
可拖进场景
```

---

## PHASE-18：Snapshot

实现：

```text
Scene Snapshot
Runtime Snapshot
Simulation Snapshot
```

验收：

```text
修改拓扑
 ↓
保存
 ↓
破坏
 ↓
恢复
 ↓
回到保存状态
```

---

## PHASE-19：Scoring

实现：

```text
实验规则
自动验证
得分
```

验收：

```text
完成实验自动得到分数
```

---

## PHASE-20：Agent/MCP

实现：

```text
平台 Tool
MCP Server
Agent tool schema
```

验收：

Agent 输入：

```text
创建两台电脑，通过交换机互联并测试通信
```

系统自动完成：

```text
创建设备
连接
开机
配置
测试
报告
```

---

# 93. Agent 执行规则

当 Agent 接收本文件后必须：

## Step A

扫描仓库：

```text
frontend
backend
runtime
schemas
ops
tests
```

## Step B

检查当前状态：

```text
build
lint
test
runtime capability
```

## Step C

建立 TODO：

```text
PHASE-00 ... PHASE-20
```

## Step D

一次只实施当前 Phase。

完成后：

```text
run tests
fix
commit
```

然后进入下一 Phase。

---

# 94. 不得自行改变的技术决策

除非发现明确无法运行的问题，否则不要改变：

```text
Frontend: React + TypeScript + Three.js
Backend: DRF + Python
Database: PostgreSQL
Cache: Redis
3D assets: GLB/GLTF
VM: QEMU/KVM
VM control: libvirt/QMP
L2: Open vSwitch
Wireless: ns-3
Custom physical: Python/C++
Realtime: WebSocket
```

---

# 95. Agent 可以优化的内容

允许：

```text
代码重构
异步优化
数据库索引
缓存
3D性能
任务队列
日志
测试
```

但任何优化必须：

```text
保留 API 兼容性
保留 Event schema
保留 Command schema
保留 Runtime Adapter 接口
```

---

# 96. Definition of Done

每个模块完成必须同时满足：

```text
[ ] 源码完成
[ ] 类型检查通过
[ ] 单元测试通过
[ ] 集成测试通过（适用时）
[ ] API 文档完成
[ ] 错误码完成
[ ] 日志完成
[ ] README更新
[ ] 至少一个运行示例
[ ] 可回滚
```

---

# 97. 项目最终验收标准

项目最终必须能够完成以下完整流程：

```text
用户登录
 ↓
新建实验
 ↓
进入 3D 实验室
 ↓
拖出一个 PC
 ↓
打开机箱
 ↓
选择主板
 ↓
安装 CPU
 ↓
安装 RAM
 ↓
安装 SSD
 ↓
安装 GPU
 ↓
安装 PSU
 ↓
连接供电
 ↓
连接显示器
 ↓
连接键盘鼠标
 ↓
连接网线
 ↓
开机
 ↓
3D 电源灯亮
 ↓
风扇转动
 ↓
真实 QEMU 启动
 ↓
打开 noVNC
 ↓
看到真实 OS
 ↓
再拖一台 PC
 ↓
拖一个 Switch
 ↓
两台 PC 接入 Switch
 ↓
OVS 建立真实二层
 ↓
配置两个 IP
 ↓
ping
 ↓
成功
 ↓
拔掉网线
 ↓
Link Down
 ↓
ping失败
 ↓
重新插线
 ↓
Link Up
 ↓
ping恢复
 ↓
保存快照
 ↓
修改网络
 ↓
恢复快照
 ↓
系统恢复
```

这条链必须作为产品 Release Candidate 的硬验收。

---

# 98. 推荐的第一版设备顺序

不要一开始就开发所有设备。

严格顺序：

```text
1. PC
2. Ethernet Cable
3. Switch
4. Monitor
5. Server
6. Router
7. Firewall
8. AP
9. Laptop
10. OLT
11. ONU
12. Fiber
13. Radio
14. IoT
```

原因：

```text
PC
 ↓
Power
 ↓
Cable
 ↓
Switch
 ↓
QEMU
 ↓
OVS
```

能够最快形成第一个“真实闭环”。

---

# 99. 推荐第一版实际运行拓扑

```text
                  ┌─────────────┐
                  │   PC01      │
                  │   QEMU      │
                  └──────┬──────┘
                         │
                       eth0
                         │
                  ┌──────▼──────┐
                  │   Switch01   │
                  │     OVS      │
                  └──────┬──────┘
                         │
                       eth0
                         │
                  ┌──────▼──────┐
                  │   PC02      │
                  │   QEMU      │
                  └─────────────┘
```

这是整个项目第一个正式 Demo。

---

# 100. 最终产品的模块边界

最终系统要保持下面这个边界：

```text
                    FRONTEND
                        │
                 Command / Event
                        │
                    BACKEND
                        │
        ┌───────────────┼────────────────┐
        │               │                │
      MODEL          TOPOLOGY          RUNTIME
        │               │                │
        │               │       ┌────────┼─────────┐
        │               │       │        │         │
        │               │      QEMU     OVS       ns-3
        │               │       │        │         │
        └───────────────┼───────┴────────┴─────────┘
                        │
                   EVENT BUS
                        │
              ┌─────────┼─────────┐
              ▼         ▼         ▼
            WebUI     Scoring    Agent
```

如果今后更换：

```text
Three.js -> Babylon.js
DRF -> Go
QEMU -> 其他 VMM
OVS -> 其他虚拟交换
ns-3 -> 其他仿真器
```

理论上都应该只替换 Adapter，而不用重写整个产品。

---

# 101. 最终运行命令标准

## 开发机

```bash
# backend
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate
# Linux: source .venv/bin/activate
pip install -e .
python manager runserver  0.0.0.0:8000
```

另一个终端：

```bash
cd frontend
npm install
npm run dev
```

Docker：

```bash
docker compose up -d postgres redis minio
```

## Linux Runtime Host

```bash
sudo systemctl status libvirtd
sudo systemctl status openvswitch-switch
ls -l /dev/kvm
virsh -c qemu:///system list --all
ovs-vsctl show
```

## 验证

```bash
curl http://127.0.0.1:8000/health
```

浏览器：

```text
http://localhost:5173
```

---