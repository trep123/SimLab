## 11. 质量、观测与可验证验收

### 11.1 测试分层和证据

规则/状态机的关键分支使用 pytest，Django/API 使用 pytest-django，前端投影与交互状态使用 Vitest，浏览器核心路径使用 Playwright。Adapter 契约测试验证基础接口及能力声明；Linux 自托管 runner 执行真实 libvirt/OVS/Guest 测试。

Mock 可以验证命令与失败分支，但 G0/G1/G2 的真实通信证据必须来自实际 Runtime。没有 `/dev/kvm` 或验收镜像时，测试应明确标为未执行；开发机可跳过真 Runtime 测试，Release gate 不允许用该跳过结果宣称通过。

每次真实验收记录 `run_id`、源码提交、锁文件、OS/kernel/CPU、libvirt/QEMU/OVS/ns-3 版本、模板版本、镜像哈希、资源分配、实验 revision/generation、命令结果、Guest 观测、PCAP/统计、退出码及清理结果。示例命令成功、灯亮或 `query-status=running` 不构成 OS/网络就绪证据。

| 编号 | 层次 | 关键验收 | 必须取得的证据 |
|---|---|---|---|
| T01 | 规则 | 错插槽/错误内存被拒绝，物理安装与供电检查分别处理 | 无非法 AssemblyBinding；错误码具体 |
| T02 | Guest | 配置的 vCPU/RAM/磁盘与装配一致 | 客体实际核心/内存/块设备信息，容许固件保留量的已定义偏差 |
| T03 | 权限 | 跨用户/跨实验设备、端口、runtime、快照、WS、console 请求拒绝 | 数据和 Runtime 无副作用；审计拒绝原因 |
| T04 | Command | 相同幂等键重试不创建第二台 VM；不同 payload 不复用同一键 | DB Command、host journal、VM UUID 一致 |
| T05 | 并发 | 两人抢同一端口、同一槽位、保存与插线竞争 | 一个操作提交；另一操作确定失败或重新取得版本 |
| T06 | 半失败 | DB 接受命令后 host-agent/OVS 失败 | 命令可查，端口预留可恢复，UI 不把 pending 当成功 |
| T07 | 恢复 | Worker 在执行后、确认前崩溃并重启 | 核对已有资源；无重复 VM、无孤儿线路；不凭任务重试重做副作用 |
| T08 | G0 数据面 | 两台 VM 通过对应可见交换机的 OVS ping/HTTP | Guest 报文、交换机端口计数及接线映射 |
| T09 | 载波 | 拔线后 NIC 仍存在，但 Guest `NO-CARRIER` 且流量断开；重接恢复 | 稳定 MAC/alias、libvirt link 读回、Guest 链路、流量 |
| T10 | 交换机电源 | 交换机断电，所有相关转发停止；恢复后按配置工作 | 停机前/后流量证据与恢复的 VLAN/端口配置 |
| T11 | 路径 | 路由器和防火墙不可被隐藏 bridge 绕过 | 分段网段、PCAP；防火墙阻断后实际请求失败 |
| T12 | 配置 | IP/route/nftables 从平台修改后客体实际生效；客体手工修改被观察 | 应用日志/配置读回/真实 HTTP 与 NAT；不得只更新 DB |
| T13 | 桌面 | 显示器断线主机继续运行；拔键盘、鼠标分别影响输入 | 客体服务继续；网关拒绝无权限输入；恢复无卡键 |
| T14 | WS | 重连、重复、乱序、断流后状态仍正确 | revision/seq 补齐，旧 generation 事件不污染冷恢复后的场景 |
| T15 | 磁盘 | 两个实验用同一基础镜像但各自写盘 | 基础 hash 不变；写入互不可见；重置不影响另一实验 |
| T16 | 冷快照 | 保存/破坏/恢复后配置、磁盘、线路、模板一致 | 停机一致性点与资源清单；活跃会话丢失符合契约 |
| T17 | 失败恢复 | 冷恢复中途失败不放行半恢复网络 | 恢复失败标记、保持隔离、重试或恢复前回退点 |
| T18 | netem | 延迟、丢包和速率分别影响真实流量 | 双向参数及测量分布；统计样本数和容差明确 |
| T19 | 无线 | 外部真实流量穿过声明的无线模型；移动/干扰影响结果 | 同一流量的 TAP/模型/对端证据；实时 drift 受控 |
| T20 | 光网络 | ONU 授权/注册/业务开通控制数据；断纤触发 LOS 与中断 | OLT/ONU 事件与实际业务流量；重接重新满足条件 |
| T21 | 版本 | 新模板发布后旧实验、旧保存点保持原版本 | 不可变版本/镜像引用；不自动替换旧配置 |
| T22 | 插件 | 非法路径、未知运行能力、未验证镜像无法发布 | 校验/审计/隔离导入，不把 schema 成功当运行成功 |
| T23 | 网络协议 | 需要 STP/LLDP/LACP 时隐藏线缆不吞相关控制帧 | 针对已声明能力的控制帧捕获；未验证能力不得显示可用 |
| T24 | 清理 | 停止/删除仅清理本实验资源，重启能收养或清理遗留资源 | ownership 标签、命令 journal 和跨实验完整性检查 |

释放矩阵：G0 必须通过 T08/T09/T15 与资源清理；G1 增加 T01–T07、T10、T13–T17、T21、T24；G2 增加 T11/T12/T18 和已发布协议的 T23；G3 分别通过对应 T19/T20；G4 增加 T22 与课程/MCP专项。G0 为精简验证工程，G1 实现完整生产契约后需要重新跑 G0，不把早期手工结果当最终集成验收。

### 11.2 日志、指标和诊断

所有服务日志含 `timestamp`（UTC RFC3339）、`service`、`request_id`、`command_id`、`experiment_id`、`device_id/runtime_unit_id`、`generation`、执行结果和结构化错误。用户界面按 Asia/Shanghai 或用户明确设置显示时间，不能把本地时间错误地标成 `Z`。

指标至少包括：命令排队/执行/确认延迟、失败与重试数、outbox 积压、host 心跳/核对状态、VM 数与实际 CPU/RAM/I/O、OVS 端口、控制台会话、事件丢流补齐、WS 连接数、无线实时 drift、磁盘与快照容量。真实报文丢包率和“用户配置的丢包目标”是不同指标。

Prometheus 端点按部署授权访问；stdout JSON 为初期日志输出，后续可接 Loki/OpenTelemetry。提供一次实验的证据包导出；PCAP 有容量与保留上限，默认不把全部 payload 永久入库。

诊断层分别检查电源、装配、连接、carrier/admin、VLAN/转发、IP/route、Guest 服务和实际业务探测。无法取得某项状态时显示 unavailable，不用缓存中的期望配置伪造“当前状态”。

### 11.3 性能目标与容量

以下是初始工程目标，P00/P02 必须记录基准后确认。`performance-profile.json` 包含硬件、浏览器、版本、分辨率、模型面数/纹理、设备数、线缆数、活跃桌面数、Guest 工作负载、采样窗口和结果。

| 场景 | 初始目标 | 解释 |
|---|---|---|
| 全景 100 个简化设备、150 根线、1080p、无活跃桌面 | P95 frame time ≤ 33 ms，60 FPS 为优化目标 | 不等于同时运行 100 台 VM；最终数字在参考硬件上确认 |
| 一个装配视图与一个活跃 noVNC | 交互可用，避免连续 >100 ms 主线程阻塞 | 桌面解码/输入与场景分别测量 |
| Command 接受 API | P95 ≤ 200 ms（本地网络，正常 DB） | 仅包含授权/校验/持久化接受，不包含 VM 启动与实际完成 |
| Worker 观察后到浏览器确认 | 正常负载 P95 ≤ 250 ms | 另记录长尾、积压和重连，不能把业务响应与消息延迟混算 |
| 启动、关机、探测 | 按 RuntimeProfile 的超时，不统一强制 200 ms | 同时启动限流；超过超时有明确状态和排查路径 |
| 控制台纹理扩展 | 默认仅 1 个活跃屏幕；非可见屏幕停止纹理复制 | 允许帧率与分辨率降级，非 MVP 必需 |

容量同时按 Guest RAM、vCPU、I/O、快照增长和启动峰值预算。默认每实验/用户有限额，资源不足排队或明确拒绝，禁止先启动再静默减配。16 核/64 GB/NVMe 只是小规模候选节点，不作为已验证容量承诺。多租户隔离与容量验收见 §9。

### 11.4 MVP Release Candidate 的硬验收

用户登录 → 新建实验 → 放入通用 PC 和交换机 → 安装合法 CPU/RAM/SSD/PSU 并接供电 → 接显示器与输入设备 → 按电源 → 观察 Guest 实际就绪与资源 → noVNC 操作真实 OS → 加第二台 PC → 接网线并配置地址 → 真实 ping/HTTP → 拔线（网卡身份不变、载波下降、通信失败）→ 重接恢复 → 交换机断电停止转发 → 保存冷快照 → 修改拓扑/磁盘 → 冷恢复 → 验证原配置和磁盘。

同时通过未授权请求、重复命令、Worker 中断、WS 重连、独立写盘与清理验证。只有上述证据完整，才把 G1 标记为完成。

## 12. 按依赖实施的任务与阶段

每行是一个明确工作包。工作包开始前拆成一次会话可完成的小任务；超过约 2–8 小时的部分继续拆分，不以整个无线或快照模块作为一次 Agent 会话。表中的时间窗口是任务粒度目标，不是交付工期保证。

`Phase` 与 `Gate` 不同：Phase 是实施顺序，Gate 是必须取得证据的验收关口。使用受控 mock 的交互预览标为 VISUAL；G0 无法通过时不得转而使用逻辑 ping 宣称真实闭环成功。

### P00：真实 Runtime 技术验证（G0，前置）

| ID | 任务与依赖 | 主要文件 | 验收 |
|---|---|---|---|
| TSK-001 | 建立最小 repo、默认 rule、锁文件策略与 Linux preflight；无依赖 | `AGENTS.md`、`rule.md`、`ops/linux/preflight.py`、`docs/runtime-lock.json`、`docs/runbooks/preflight.md` | 记录架构、KVM、libvirt/OVS 权限及版本；缺环境明确失败，不自动安装/改宿主机 |
| TSK-002 | 单 VM 模板、独立 overlay/NVRAM、Guest 初始配置、console/readiness；依赖 001 | `ops/linux/poc_vm.py`、`ops/linux/poc_guest.yaml`、`docs/poc/image-profile.json` | 真实启动/正常关闭/断电/桌面或串口可用；Guest 资源与配置匹配；基础镜像不变 |
| TSK-003 | 两 VM + OVS 端点/线路与载波 PoC；依赖 002 | `ops/linux/poc_network.py`、`tests/runtime/test_poc_link.py`、`docs/poc/g0-evidence.json` | T08/T09/T15；稳定接口、拔线断流且 carrier DOWN、重接恢复；清理成功 |

TSK-002 使用的桌面镜像和云镜像要分别验证。Ubuntu Cloud Image 默认不等于已安装图形桌面，必须配置合法账号/密钥及需要的 GUI；`qemu-guest-agent` 安装在客体并配置 virtio channel，安装宿主机同名包不能代替客体代理。

### P01：控制服务与可靠执行基础

| ID | 任务与依赖 | 主要文件 | 验收 |
|---|---|---|---|
| TSK-004 | Django/DRF/Channels scaffold、认证与配置；依赖 003 | `backend/manage.py`、`backend/config/{settings,urls,asgi,celery}.py`、`backend/pyproject.toml`、`compose.yaml` | Django check、迁移、HTTP/WS 服务均可启动；没有 FastAPI/Alembic 数据层 |
| TSK-005 | 核心模型、实验成员与关系约束；依赖 004 | `backend/apps/{accounts,experiments,devices,topology}/models.py`、各 `migrations/` | 同一端口/槽位占用冲突被 DB 拒绝；跨实验关联被拒绝；模板版本不可变 |
| TSK-006 | Manifest/RuntimeProfile schema、模型注册与发布；依赖 005 | `schemas/device-manifest.schema.json`、`backend/apps/devices/{serializers,services}.py` | 合法注册，非法引用/重复锚点拒绝；发布需绑定已验镜像/能力记录 |
| TSK-007 | Command 生命周期、幂等/版本、outbox 与事件；依赖 005/006 | `backend/apps/commands/{models,services,tasks}.py`、`backend/apps/events/`、`schemas/{command,event}.schema.json` | T04/T05/T06；API 返回已接受，不伪造运行完成；通知可重复 |
| TSK-008 | 统一 Adapter、Linux host-agent、执行日志、核对与资源配额；依赖 007 | `backend/runtime/contracts.py`、`backend/runtime/{qemu,ovs,profiles}.py`、`backend/host_agent/` | 所有实现通过相同契约测试；单 writer，重启不重复创建 VM；T07/T24 |
| TSK-009 | Query 快照、Redis Streams projector、Channels WS 补齐；依赖 007/008 | `backend/apps/events/{outbox,streams,projectors}.py`、`backend/apps/realtime/{consumers,routing}.py` | T14；跨进程真实事件进入浏览器；缺事件重取快照而不跳序假成功 |

TSK-004 开始实现 `health`，TSK-008 实现 `runtime_preflight`，TSK-009 实现 `verify_runtime_loop` 与 state/event API；§10 中同名自定义命令只有完成这些任务后才可执行。

### P02：3D 与真实设备闭环

| ID | 任务与依赖 | 主要文件 | 验收 |
|---|---|---|---|
| TSK-010 | 场景引擎、目录、程序化/GLB Renderer 与选择移动；依赖 006/009 | `frontend/src/scene/`、`frontend/src/devices/`、`frontend/src/stores/` | 拖入设备、语义锚点正确；生命周期释放；服务端确认后提交位置 |
| TSK-011 | Cable UI、半接线/占用和真实连接命令；依赖 010/008 | `frontend/src/cables/`、`backend/apps/topology/services.py`、`backend/runtime/links.py` | UI 拔线完成 T09；接线失败正确回退；不删除 vNIC |
| TSK-012 | noVNC/串口网关、显示器和独立输入 gating；依赖 008/010 | `frontend/src/console/`、`backend/apps/consoles/`、`backend/host_agent/consoles.py` | T13；学生网关权限独立核对；按键焦点不触发场景快捷键 |
| TSK-013 | 装配实例/规则与 VM spec 编译、预设；依赖 006/010/008 | `backend/apps/assembly/`、`backend/runtime/spec_compiler.py`、`frontend/src/assembly/` | T01/T02；Guest 资源与选件一致；资源不足有明确错误 |
| TSK-014 | 供电/正常关机/断电、Guest 就绪、OVS 电源及面板；依赖 011/012/013 | `backend/apps/devices/state_machine.py`、`frontend/src/inspector/` | T10；请求成功与运行完成分开；未接显示器不阻止正常主机启动 |

### P03：冷恢复与 MVP 释放（G1）

| ID | 任务与依赖 | 主要文件 | 验收 |
|---|---|---|---|
| TSK-015 | 停机保存/冷恢复、模板和磁盘清单、失败回退；依赖 014 | `backend/apps/checkpoints/`、`backend/runtime/cold_restore.py` | T15/T16/T17/T21；网络先就绪，全部重建后放行；不承诺保存 TCP 活跃会话 |
| TSK-016 | 镜像导入隔离、跨对象授权、额度/审计/清理强化；依赖 015 | `backend/apps/{assets,audit}/`、`backend/apps/experiments/permissions.py`、`backend/host_agent/policy.py` | T03/T22/T24；未授权请求及未知参数无宿主机副作用 |
| TSK-017 | 真实浏览器 E2E、基准、证据导出与运行手册；依赖 016 | `tests/e2e/`、`tests/runtime/`、`docs/performance-profile.json`、`docs/runbooks/` | §11.4 全链和 G1 矩阵；真实测试不能被 mock/skip 抵消 |

G1 达成后才称为核心 MVP。登录、预设、装配、console、接线、状态同步、冷恢复和失败路径都需要可用，不能只交一段录屏。

### P04：路由、防火墙与线路实验（G2）

| ID | 任务与依赖 | 主要文件 | 验收 |
|---|---|---|---|
| TSK-018 | 服务器/路由模板、GuestConfigProvider、配置读回；依赖 017 | `backend/runtime/guest_config/`、`assets/profiles/`、`frontend/src/inspector/config/` | DHCP/DNS/HTTP/静态路由实际工作；配置与客体读回一致；独立管理渠道 |
| TSK-019 | Linux+nftables 防火墙、NAT 与路径验证；依赖 018 | `backend/runtime/guest_config/nftables.py`、`tests/runtime/test_firewall_path.py` | T11/T12；默认阻断与放行真实生效，隐藏线路不绕过设备 |
| TSK-020 | tc/netem、抓包采样、端口诊断与控制帧矩阵；依赖 019 | `backend/runtime/{impairment,capture}.py`、`frontend/src/inspector/traffic/` | T18/T23；双向退化测量，性能与采样有上限 |

### P05：无线、光网络与无线电（G3，分别验收）

| ID | 任务与依赖 | 主要文件 | 验收 |
|---|---|---|---|
| TSK-021 | 无线路线 ADR + 外部真实流量桥接 PoC + AP/STA 前端；依赖 020 | `docs/adr/wireless.md`、`simulator/wireless/`、`backend/runtime/ns3.py` | T19；明确 ns-3 或 hwsim 主路线及认证边界；MAC/TAP/时钟/过载全部有证据 |
| TSK-022 | ONU/OLT/分光器/光纤状态与业务通路 + 参数化光预算；依赖 020 | `simulator/optical/`、`backend/runtime/optical.py`、`tests/runtime/test_pon_gate.py` | T20；光连通、注册授权和业务开通分别影响通信；禁止只靠 LED 判成功 |
| TSK-023 | 简化无线电场景、模型参数与能力标签；依赖 020 | `simulator/radio/`、`docs/models/radio.md`、`frontend/src/inspector/radio/` | 频道/位置/功率对已声明报文或逻辑业务产生可复现影响；不宣称波形级 DSP |

无线任务先拆为路线确认、桥接、实时调度、节点更新、遥测五个小任务。光网络任务先拆状态/guard、报文门控、光预算、故障恢复四个小任务。任一引擎无法通过通路 PoC 时冻结该能力，不影响已经通过的有线 MVP。

### P06：教学与受控扩展（G4）

| ID | 任务与依赖 | 主要文件 | 验收 |
|---|---|---|---|
| TSK-024 | 声明式设备包、不可变版本和动态面板；依赖 017，具体设备另需对应 G2/G3 | `backend/apps/plugins/`、`schemas/plugin-package.schema.json`、`assets/plugins/` | 原有实验版本不变；未知 Runtime 不因上传 JSON 自动获得执行权 |
| TSK-025 | 课程/故障注入/评分与只读事件回放；依赖 017，网络检查需对应 G2/G3 | `backend/apps/courses/`、`backend/apps/scoring/`、`frontend/src/timeline/` | 分数来自 Guest/真实探测或已标模型；回放不重新执行宿主机命令 |
| TSK-026 | MCP 工具接口与受限 Agent 操作；依赖 025 | `backend/apps/agent_tools/`、`docs/tools.md`、`tests/integration/test_tools_authorization.py` | Tool 转同一 Command/Query；继承成员权限/额度；无任意 shell/文件路径 |

### 12.1 多节点、迁移和后续研究

多节点不列为上述 26 个工作包的默认验收。需要另写 ADR 和任务：节点授权注册、跨节点链路 encapsulation/MTU、带宽控制、镜像分发、调度与旧节点隔离证据。只有能证明旧 host 不再写状态/转发/运行，才允许自动迁移；未知或失联状态冻结实验并要求运行维护人员处理，不能仅靠 DB lease 假定安全。

未来的波形级 RF、完整 OMCI/DBA/PON、GPU passthrough、热快照、模拟时钟倍速和多节点通信分别是能力项目，必须有范围、资源、校准和验证计划，不追加到已冻结 MVP 的必需清单。

### 12.2 预估投入与未决条件

已有 Linux/QEMU/网络经验且资产有限时，2–3 名开发约 2–4 周可完成 PoC；4–6 人涵盖 3D、后端、虚拟化、建模与测试，约 10–16 周可形成限定设备范围的 G1。均为规划估算，需 G0 结果、团队和镜像确定后重估；不能将 TSK 数量乘固定时长作为正式工期。

尚需在实施启动时记录：首批镜像/使用权、运行主机与虚拟化权限、Guest 桌面方案、参考浏览器/硬件、实验并发与单用户配额、资产预算、是否必须真实 WPA、无线/光模型精度。未决条件有负责人和决策时点；可先做不依赖它的任务，不能伪造条件已满足。

## 13. 开发者与 Agent 执行规则

### 13.1 当前任务与权限

实施前确认用户确实要求开发项目，检查仓库 `AGENTS.md`、本任务书和已有代码，建立当前 Gate/任务清单。本文编辑完成本身不触发软件实施。

只实施当前依赖已满足的任务，不提前创建所有 Runtime 的占位成功返回。运行环境缺少 Linux/KVM/镜像时记录具体阻塞与可继续的工作；不能用“全部完成”覆盖跳过的 Runtime 测试。

不自动购买/重新分发商业镜像，不执行未知安装脚本，不通过 MCP/插件开放 root shell。清理只针对本实验 ownership 标记的资源。用户已经授权的具体可逆开发工作持续推进，不为每个小步骤重复请求确认。

### 13.2 默认工程规范与 rule.md

原稿引用的 `rule.md` 未随文件提供。P00 必须生成项目自身的默认 `rule.md` 并把本段规则写入；若用户提供了其规范则合并并明确差异，不能声称已遵循未读文件。

- Python 统一 Ruff 格式/检查，业务与 ORM 模型有明确类型，使用 Django migrations；不要引入第二套 ORM。
- TypeScript 开启 strict，使用 ESLint 和项目统一格式化工具；稳定 DTO 类型由 schema 或契约生成，不用大量 `any` 掩盖缺字段。
- 对 Runtime 的同步 libvirt/subprocess 操作使用受限后台执行路径，不能阻塞 ASGI 请求，也不能因为方法写成 async 就认为底层是非阻塞。
- 时间保存 UTC，界面转换；统一容量与速率单位（MiB/GiB、bytes、bit/s、ms、dBm/dB），字段名体现单位。
- 动态路径来自受控资产/实验资源 ID，使用 argv 参数和 allowlist；失败有领域错误码，不吞异常或自动伪造成功。
- 每个变更保存相应迁移/契约/schema/文档；对有行为意义的规则写测试，对跨系统副作用跑相应集成测试；不机械为薄包装堆测试。
- 秘密、镜像、PCAP、大模型资产、overlay、临时文件不提交到 Git；必要依赖与示例授权信息清楚。
- 不为通过测试而删已通过闭环或把真实测试改成 mock。变更门禁保留对应证据。

### 13.3 每任务的 Definition of Done

1. 对应代码/迁移/schema 和错误码完成，服务可启动。
2. 相关 lint/type/unit/契约测试通过；需要真 Runtime 的任务有实际证据。
3. 预期/观测状态与失败路径符合规范，权限/资源/清理边界完整。
4. README 或 runbook 有可复现步骤，说明环境、镜像和待实现限制。
5. 不影响已通过 Gate；有问题可回退或通过文档中的恢复流程修复。
6. 输出真实进度：完成、未执行、失败、环境阻塞分别报告。只有仓库政策或用户范围允许时提交版本控制，不自动 push、发布或部署。

API、Event、Manifest 版本变更通过迁移/升级策略兼容旧实验；旧模板不可变不等于永远不升级安全补丁，升级需要新版本和回归验收。无法保证兼容时先标能力不可用并说明迁移路径。

### 13.4 评分、回放与 Agent 工具契约

评分检查定义类型、目标、期望、分值、证据来源、超时和缺证据的结果。逻辑评分与真 Runtime 探测分开标注；检查 Guest IP/route 用实际读回，ping/HTTP 从对应源设备执行，NetworkX 设计连通不算通信成功。

事件时间轴记录用户动作与运行结果；3D 回放只投影已记录数据，不运行 QEMU、安装部件或重新发送 Command。确定性仿真 replay 与运行中检查点不属于这项能力。

MCP 工具示例：create_experiment、add_device、install_component、connect_cable、shutdown、force_off、configure_interface、inspect_port、capture_sample、create_cold_snapshot、restore_cold_snapshot、validate_topology、run_connectivity_check。工具使用本人的受限凭据，转换为 §5 的规范命令或查询；审计 agent 身份与委托用户。没有任意 host shell、任意文件写入和绕过规则的 runtime.start 后门。

## 14. 技术依据与版本核查

这些是一手资料入口，用来核查能力和限制；设计建议与软件验收结果仍需本项目自己的 G0/G1 证据。链接中的 `master/latest/stable` 文档可能随时间变化，实施时保存适用版本 URL 与检索日期到 `docs/runtime-lock.json`。

| 主题 | 官方资料 | 本文用途 |
|---|---|---|
| Django 支持线 | [Django 下载与支持周期](https://www.djangoproject.com/download/) | 选择受支持的 5.2 LTS 线，不声称最新主版本 |
| Django 异步边界 | [Django Async support](https://docs.djangoproject.com/en/5.2/topics/async/) | ORM/同步调用与 ASGI 边界 |
| DRF | [DRF APIView](https://www.django-rest-framework.org/api-guide/views/) | 单一 Django REST 服务与权限 |
| Channels | [Channel Layers](https://channels.readthedocs.io/en/stable/topics/channel_layers.html) | 跨进程通知，进程内通道不能替代分布式消息 |
| Celery | [Django 集成](https://docs.celeryq.dev/en/stable/django/first-steps-with-django.html)、[任务与重投递](https://docs.celeryq.dev/en/stable/userguide/tasks.html) | 任务队列，不是设备状态的权威数据库 |
| Redis | [Streams](https://redis.io/docs/latest/develop/data-types/streams/) | 跨进程事件传输与消费组 |
| Three.js | [WebGPURenderer](https://threejs.org/docs/pages/WebGPURenderer.html)、[CanvasTexture](https://threejs.org/docs/pages/CanvasTexture.html) | 渲染后端、控制台纹理扩展 |
| glTF | [glTF 2.0 规范](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html) | 资产与节点元数据 |
| noVNC | [公开 API](https://novnc.com/noVNC/docs/API.html) | 桌面画面、输入和 viewOnly 边界 |
| QEMU | [设备模型](https://www.qemu.org/docs/master/system/device-emulation.html)、[ARM 板卡](https://www.qemu.org/docs/master/system/target-arm.html)、[CPU 模型](https://www.qemu.org/docs/master/system/i386/cpu.html) | 镜像兼容与硬件保真度 |
| QEMU 磁盘/隔离 | [qemu-img](https://www.qemu.org/docs/master/tools/qemu-img.html)、[Security](https://www.qemu.org/docs/master/system/security.html) | 独立差异盘、非特权执行与镜像隔离 |
| libvirt | [Domain XML](https://libvirt.org/formatdomain.html)、[domif-setlink](https://libvirt.org/manpages/virsh.html#domif-setlink)、[QMP 管理边界](https://libvirt.org/html/libvirt-libvirt-qemu.html#virDomainQemuMonitorCommand) | VM 管理与稳定虚拟载波 |
| libvirt 保存 | [Snapshot XML](https://libvirt.org/formatsnapshot.html) | 区分磁盘/内存/一致性，本项目首版限定冷恢复 |
| OVS | [libvirt 接入](https://docs.openvswitch.org/en/latest/howto/libvirt/)、[配置参考](https://www.openvswitch.org/support/dist-docs/ovs-vswitchd.conf.db.5.html) | 可见交换与隐藏线路，控制帧边界 |
| Linux 网络 | [TUN/TAP](https://www.kernel.org/doc/html/latest/networking/tuntap.html)、[Bridge](https://www.kernel.org/doc/html/latest/networking/bridge.html) | Ethernet 帧接入与链路本地帧规则 |
| ns-3 | [TapBridge](https://www.nsnam.org/docs/models/html/tap.html)、[实时调度](https://www.nsnam.org/docs/manual/html/realtime.html)、[Wi-Fi 限制](https://www.nsnam.org/docs/models/html/wifi-design.html) | 真报文桥接、时钟、MAC 与认证限制 |
| Linux Wireless | [mac80211_hwsim](https://wireless.docs.kernel.org/en/latest/en/users/drivers/mac80211_hwsim.html) | 真实 Linux Wi-Fi 协议路线 |
| GPON | [G.984.3](https://www.itu.int/ITU-T/recommendations/rec.aspx?rec=16552)、[G.984.2](https://www.itu.int/rec/T-REC-G.984.2-201908-I) | ONU 激活、物理层光预算 |
| 可复用平台 | [GNS3 Compute 架构](https://docs.gns3.com/docs-3.1-en/web-ui/manage-computes)、[Containerlab/vrnetlab](https://containerlab.dev/manual/vrnetlab/) | 镜像/拓扑 PoC 参考，不替代本平台装配、载波与保存契约 |

文档修订完成标准：不存在框架/ORM/启动入口冲突；基础接口命名一致；命令和事件字段统一；Gate 顺序可执行；所有真实能力有验收证据定义；未来能力不冒充 MVP；版本与未知条件可追踪。
