# 4. 数据模型、版本与约束

## 4.1 数据存储的职责

业务数据统一使用 Django ORM 和 Django migrations 管理 PostgreSQL。禁止在同一业务库并行维护 SQLAlchemy/Alembic 模型。Django 用户模型从首次迁移前确定，密码使用 Django 密码哈希接口；不自行维护可解密密码或另一套登录用户表。

PostgreSQL 保存用户权限、实验配置、命令、业务事件、Runtime 资源关系和操作结果。Redis 用于任务唤醒、跨进程事件传递和 WebSocket 通知；清空或重启 Redis 不得丢失已接受命令、有效实验配置和事件序号。MinIO/S3 保存镜像、模型、抓包和快照文件；数据库保存其不可变对象键、哈希、大小、访问级别及引用关系。高频指标、逐包数据不全部写入业务事件表，按采样窗口进入独立指标/抓包存储。

所有实验对象使用服务端生成的 UUID；设备名称 `PC01`、端口显示名 `eth0` 只用于展示，不能作为宿主机资源名称或跨设备唯一身份。对外接口中的对象 ID 必须通过所属实验解析，不能直接透传为宿主机路径、Linux 接口名或 libvirt domain 名称。

## 4.2 核心关系

以下为实施必须具备的最小模型；实际 Django 字段、外键和迁移应由实施阶段形成，不把本表当作已存在的代码。

| 模型 | 关键字段与关系 | 目的 |
|---|---|---|
| User / Organization | 用户、组织、停用状态、平台角色 | 认证与组织边界；首版单组织也保留组织归属 |
| Experiment | organization_id、owner_id、mode、status、config_revision、last_event_seq、control_epoch、assigned_host_id、active_command_id | 配置版本、事件顺序与单写者控制 |
| ExperimentMember | experiment_id、user_id、permission_role | OWNER / EDITOR / VIEWER；教学角色不自动得到所有实验权限 |
| Scene | experiment_id、world_json、camera_json、scene_settings | 米制坐标、场景与相机；不承载 Runtime 事实 |
| DeviceModel | 稳定目录 ID、名称、分类、当前推荐 release、停用状态 | 可变目录入口 |
| DeviceModelRelease | model_id、release_version、schema_version、manifest_hash、manifest_json、publication_status | 不可变设备定义，发布后不原地修改 |
| ComponentRelease / ImageArtifact / AssetArtifact | 版本、sha256、对象键、架构/格式、审核状态、来源及授权 | 不可变硬件定义、镜像和 3D 资产 |
| DeviceInstance | experiment_id、model_release_id、名称、position、rotation、desired_json、observed_json、model_estimates_json | 实验内设备；三类状态明确区分 |
| ComponentInstance / SlotInstance / AssemblyInstallation | 实验、组件 release、宿主设备/组件、槽位、安装及拆卸状态 | 表达多级装配；同一部件不能同时装入两处 |
| DevicePort | experiment_id、device_id、port_key、connector_type、protocol、admin_state、observed_link、guest_identity | 稳定端口身份及客体映射 |
| Cable / CableEnd / PortAttachment | 实验、线缆类型、线端 A/B、端口、插入/释放状态、故障与模型参数 | 双端插拔；占用与链路有效性独立 |
| RuntimeUnit | experiment_id、host_id、backend、scope、external_resource_id、spec_hash、desired_state、observed_state、generation | 执行单元，可代表一个 VM 或共享无线 scenario |
| DeviceRuntimeBinding | device_id、runtime_unit_id、role、backend、backend_node_key | 一台设备使用多个引擎，一个 scenario 绑定多个设备 |
| RuntimePortBinding / RuntimeResource | runtime_unit_id、device_port_id、角色、稳定 backend key；资源所有者、类型、generation | 网卡、TAP、OVS port、网络与磁盘的可追踪映射 |
| Command / OperationStep / ExperimentEvent / OutboxMessage | 见 §5 | 持久工作流、事件与可靠发送 |
| ExperimentSnapshot / ResourceReservation / AuditRecord | 快照引用清单、资源配额预留、操作者和审计结果 | §8 冷快照、容量控制和审计 |

示例：一台带真实 OS 的笔记本可以绑定 QEMU 单元 `role=guest_os` 和共享 ns-3 单元 `role=radio_model`，后者通过 `backend_node_key=sta-7` 指向 scenario 内节点。该笔记本的两个绑定都属于同一个实验；移动笔记本更新场景位置并按能力更新无线模型，不能停止一个笔记本就无条件销毁所有 AP/STA 共用的 scenario。绑定定义和实际连接方式由 §6–§7 的 Runtime 契约决定。

## 4.3 不可变发布版本

`schema_version` 表示 Manifest 格式版本，`release_version` 表示某型号的内容版本，两者不能混用。设备实例绑定已发布的 `DeviceModelRelease`，其中引用具体组件 release、镜像 artifact 哈希和 Runtime profile 版本。管理员修改型号时创建新 release；旧实验继续使用原 release。停用禁止新实例选用，已有引用不能直接删除。外键使用 PROTECT 或受控归档；资产垃圾回收依据引用计数和保留策略，不能依赖前端目录是否还显示。

Manifest 片段示例：

```json
{
  "schema_version": "1.0",
  "model_id": "pc-atx-demo",
  "release_version": "1.0.0",
  "visual_asset_id": "asset-pc-atx-v1",
  "runtime_profiles": [
    {"role": "guest_os", "backend": "qemu", "profile_release_id": "linux-pc-v1"}
  ],
  "ports": [
    {"port_key": "lan-0", "connector_type": "RJ45", "protocol": "ethernet"}
  ],
  "capabilities": ["power", "link", "console", "cold_snapshot"]
}
```

示例中的短 ID 是说明性标识；接口实例 ID 使用 UUID。Runtime profile 保存 CPU 架构、machine、固件、磁盘控制器、网卡型号、启动方案、资源上限、客体身份发现方式和验收记录。选择外观为某款 CPU/GPU 不代表虚拟机获得该型号精确性能；实际分配的 vCPU/RAM/磁盘必须回显，配额不足要拒绝或让用户显式选择受限方案。

发布验收至少验证：schema、锚点与端口一一对应、Runtime profile 可用、镜像启动与网卡身份稳定、正常关机/断电语义、支持能力及限制。`qemu=true` 只证明引擎可用，不能代替某个镜像/板卡组合的兼容验收。实验导入和恢复保留原版本，升级须由单独迁移命令生成迁移记录。

## 4.4 必须落实的数据库与服务约束

使用 Django `UniqueConstraint` / `CheckConstraint` 定义数据库可表达的约束，迁移纳入版本控制；跨表归属检查通过统一领域服务、外键和事务实现，不伪称普通 CHECK 可以验证另一张表的实验 ID。参考：[Django 约束文档](https://docs.djangoproject.com/en/5.2/ref/models/constraints/)。

- `(model_id, release_version)`、`(device_id, port_key)`、`(experiment_id, user_id)` 唯一；已发布 release 的内容不可变。
- 一个活动 `AssemblyInstallation` 只能占用一个槽位；一个部件只能有一个活动安装。禁止安装循环，主板等部件的移除需先检查依赖部件、内部线缆和供电。
- 每根线缆有 A/B 两个线端；同一线端仅有一个活动连接，同一物理端口仅有一个活动 `PortAttachment`。用归一化连接表和条件唯一约束实现，不能分别对 Cable.source 和 Cable.target 加 UNIQUE 后宣称阻止全部双占用。
- 端口、线缆、设备、部件、runtime_unit、snapshot 必须属于同一实验及组织。插线时按稳定 ID 排序锁定两端口并验证实验归属；断线只释放指定端点，断电/线缆故障不释放物理占用。
- 长度、带宽、内存等非负；丢包率限定在 `[0,1]`。对连接器类型、协议、接口能力分别校验，不能仅凭 RJ45 外形认定业务兼容。
- Host 与用户配额采用事务内 ResourceReservation；先预留再启动，终止后依据观测确认释放。即使第一版单节点也要拒绝超额分配，并限制同时开机数量。
- Runtime 资源名称由服务端从 UUID 派生，数据库保存完整映射；Linux 接口名满足宿主机限制。删除实验先进入 DELETING，经确认仅清理该实验资源后再归档；资源删除失败保留清单以便重试。

`desired_json` 是用户意图，`observed_json` 是引擎/客体实际观测，`model_estimates_json` 是近似模型结果。观测必须带来源、时间、generation、质量或 UNKNOWN 标记；不能把数据过期当作设备已关机。前端用于发命令的版本只读，不能 PATCH `observed_link=UP` 或 `operational_state=RUNNING`。

# 5. Command、事件、并发与恢复契约

## 5.1 统一改变状态的入口

所有改变实验状态的操作都通过 `CommandSubmissionService`：REST、WebSocket、MCP、教学评分触发的自动配置使用相同校验、权限、幂等和审计链。便利 REST 可存在，但只负责转换为 Command，不直接 `serializer.save()` 修改拓扑，也不能旁路调用 host-agent。

最小 Command 名称：`device.create`、`device.delete`、`device.move`、`device.power_on`、`device.shutdown`、`device.force_off`、`device.restart`、`device.reset`、`assembly.install`、`assembly.remove`、`cable.connect`、`cable.disconnect`、`port.configure`、`device.configure_ip`、`device.configure_route`、`fault.inject`、`fault.clear`、`snapshot.create_cold`、`snapshot.restore_cold`。正常关机、强制断电、重启、硬复位语义不同，支持条件由 Runtime capability 声明。镜像/型号管理另有管理员域 Command；创建实验也记录幂等与审计，不要求对尚不存在的实验进行归属检查。

统一 API 路由（末尾斜杠在实现中固定一致）：

```text
POST /api/v1/auth/login/
POST /api/v1/auth/logout/
GET  /api/v1/auth/me/
POST /api/v1/experiments/                     # 幂等创建，返回实验与创建命令
GET  /api/v1/experiments/
GET  /api/v1/experiments/{experiment_id}/state/
POST /api/v1/experiments/{experiment_id}/commands/
GET  /api/v1/experiments/{experiment_id}/commands/{command_id}/
GET  /api/v1/experiments/{experiment_id}/events/?after_seq=104&limit=200
GET  /api/v1/experiments/{experiment_id}/snapshots/
GET  /api/v1/device-models/                   # 仅返回可见、已发布的 release
GET  /api/v1/runtime/capabilities/            # 主机、模板与能力的可用情况
POST /api/v1/experiments/{experiment_id}/devices/{device_id}/console-sessions/
WS   /ws/experiments/{experiment_id}/
WS   /ws/consoles/{console_session_id}/
```

控制台会话是经授权签发的短期通道，不改变设备配置；实际控制台内用户操作属于客体访问，不能承诺每次客体配置都被 Command 捕获。平台 Inspector 代用户写配置时必须发 Command。任何运行时观察日志均不写回执行队列成为新命令。

便利接口例如 `POST .../devices/`、`POST .../cables/`、`DELETE .../cables/{id}/`，须携带 `Idempotency-Key` 和预期配置版本，由服务转成上面同名 Command，返回同样的 accepted 响应。普通用户不开放 `POST /runtime/{id}/start` 这种凭 runtime ID 绕过装配规则的接口。WS 首版只收订阅/游标/心跳；若实现 WS 命令接收，必须调用相同提交服务。

## 5.2 Command 信封与响应

```json
{
  "schema_version": "1.0",
  "command_id": "c6dcc41c-84bf-47b2-8b15-ae286ab24ea5",
  "type": "cable.connect",
  "expected_config_revision": 12,
  "payload": {
    "cable_id": "cc56073a-760b-4dc0-a322-90299792df87",
    "end": "A",
    "device_port_id": "5c638331-1f82-4313-9a27-f722f606b02f"
  }
}
```

`actor_id`、组织、实验 ID、受权范围、host_id、control_epoch 由服务端补充，禁止相信请求内的角色或 owner。Command 表保存归一化 payload 的 request_hash、actor、accepted_order、expected_config_revision、status、operation_id、尝试记录、result/error、时间和审计关联。幂等键在实验内唯一，创建实验则在调用者与创建命名空间内唯一；同一键不同 payload 返回 `409 IDEMPOTENCY_KEY_REUSED`，相同请求返回原命令的当前结果，不能再执行。重试请求仍重新检查调用者有权读原结果。

schema 错误直接 400，未登录 401，无权 403（或统一隐藏资源返回 404），版本或占用冲突 409，能力不可用/配额不足返回结构化错误。成功接受返回 202：

```json
{
  "command_id": "c6dcc41c-84bf-47b2-8b15-ae286ab24ea5",
  "status": "QUEUED",
  "config_revision": 12,
  "accepted_event_seq": 105,
  "status_url": "/api/v1/experiments/exp-id/commands/c6dcc41c-84bf-47b2-8b15-ae286ab24ea5/"
}
```

202 表示持久化接受，不表示接线成功、VM 启动完成或 broker 已处理。终态从状态接口/事件获取。状态为 `QUEUED → RUNNING → SUCCEEDED`，失败路径可进入 `COMPENSATING → FAILED`；无法确认副作用时进入 `RECONCILING`，实验进入 `RECOVERY_REQUIRED`，不把超时简单标记失败后允许后续相冲突命令运行。错误统一含 code、message、retryable、suggested_action、operation_id，不把宿主机敏感堆栈直接回传。

`config_revision` 只在有效配置变化时增加，不被每次流量统计改变。修改命令提交和开始执行时均检查预期版本；执行期间前序命令已改变版本，后序命令可被拒绝为冲突。前端等待前一配置命令结果后再提交依赖命令，批量搭建使用有明确依赖的任务计划，不能以忽略版本代替并发设计。

补偿撤销已提交的期望配置时产生新的config_revision及事件，不能把计数器回滚后复用旧版本。复用同一幂等键查询终态不会再次增加版本；轮询状态或读取控制台也不产生设备配置版本变化。

## 5.3 DB + Outbox + Worker 的执行步骤

一次短数据库事务内锁定 Experiment，检查权限、模式、幂等和版本，创建 Command、`command.accepted` Event 及 OutboxMessage 后提交。`transaction.on_commit()` 可以加速唤醒 dispatcher，但不能作为唯一交付保障：回调执行失败不会撤销已提交事务。独立 outbox dispatcher 必须扫描未发送记录并重试。参考：[Django 事务与 on_commit](https://docs.djangoproject.com/en/5.2/topics/db/transactions/)。

```text
DRF/WS/MCP → 统一提交服务
  → PostgreSQL事务：Command + Event + Outbox
  → Outbox dispatcher：发送 Celery 唤醒消息、Redis Streams 事件
  → Celery Worker：从 DB 领取该实验最早可执行命令
  → DB短事务：校验、预留、记录操作计划与期望状态
  → 事务外调用 Linux host-agent，携带 operation_id / control_epoch
  → 查询并验证实际运行结果
  → DB短事务：观测状态 + 结果 + Event + Outbox
  → Streams消费者 → channels_redis通知 → 客户端补齐事件
```

Celery + Redis 只承担“有工作可做”的唤醒和运行协作；Command 状态不能以 Celery task result 为事实。Celery 消息、Streams 消息、HTTP 到 host-agent 的重试都可能重复，因此任务只传 Command/实验 ID，执行前从 DB 读当前状态，不能把过期的完整 spec 当作事实再次执行。broker ACK、Streams XACK 或 host-agent 返回“已接收”都不是 Runtime 完成证据。参考：[Celery 的任务与幂等说明](https://docs.celeryq.dev/en/stable/userguide/tasks.html)。

dispatcher 在发送成功后记录发送状态；发送成功后进程崩溃可能再次发送，消费者按 event_id / operation_id 去重。事件消费投影在 DB 事务内持久游标与结果后再 ACK。Redis 被清空时，dispatcher/恢复工具可从 DB 重新发布；周期性调度同时扫描仍可运行但未获处理的 Command，不能只依赖一次 broker 消息。

耗时宿主机调用不得放在持有 PostgreSQL 行锁的事务内。进入 RUNNING 后记录分步计划：`OperationStep(command_id, step_key, stable_resource_key, desired_spec_hash, state, observation, compensation)`，状态至少 PLANNED/APPLIED/VERIFIED/COMPENSATED/UNKNOWN。创建 VM、TAP、overlay 等资源使用稳定标识；重复步骤先查已存在资源的所有者和 spec，再采用或报告不匹配。不能每次重试生成一个新的 VM UUID。

## 5.4 每实验串行、单写者与 fencing

先实现单 Linux Runtime Host，同一实验只在该 host 运行。Celery 可以并发处理不同实验，但某实验只有一个 active_command。领取在短事务中 `select_for_update()` 锁实验行，检查 active_command 与租约，按 accepted_order 领取；租约到期触发协调恢复，不直接另起一个 Worker 执行下一条。稳定排序、条件约束和数据库状态决定执行顺序，不能用 `worker --concurrency=1` 假定所有未来部署天然单写者。

`control_epoch` 是实验控制代次，区别于 config_revision 和 event_seq。host-agent 是每台 host 的唯一变更入口：单进程锁、每实验操作锁、持久化最高 epoch、已受理 operation journal；上层 Worker 没有直连 libvirt/OVS 的权限。每个请求绑定 experiment、runtime_unit、host、epoch、operation_id 和 spec hash。agent 拒绝更低 epoch 与其他实验资源；接受更高 epoch前须结束/确认旧代次在途操作，再安装并持久化新授权。journal 是本地执行证据，平台 Command 事实仍在 PostgreSQL。

租约续期中断后 agent 停止接受新变更；已发给 libvirt 的调用可能继续完成，因此单纯在 DB 回写时检查 epoch 并不能阻止旧进程副作用。恢复步骤是：冻结实验 → 确认旧 Worker 无执行权限 → agent 汇报在途 journal 与资源 → 协调完成/补偿旧步骤 → 安装新 epoch → 读取资源并核对 → 恢复队列。旧 Worker 的迟到结果可保存审计，但不能覆盖新 generation 的观测状态。

MVP 不自动把失联实验迁移到新 host。若旧 host 无法证明已停止、隔离或断电，实验保持 RECOVERY_REQUIRED，用户可查看已知状态但不能继续会造成双写的操作。未来多节点自动故障转移须增加基础设施级 fencing（确认关闭旧节点、撤销共享存储/网络写权限等）和可验证证据，再开启新节点；HTTP token 或 Redis 分布式锁不能隔离已获得本机特权的旧 agent。

## 5.5 补偿与宿主机状态核对

DB 事务无法回滚 libvirt、OVS 和磁盘文件。实施采用持久操作计划与补偿，避免承诺分布式原子事务。接线先验证/预留端口并记录 desired=connected、observed=PENDING；agent 实施数据平面和 link；确认后写 observed。失败时清理本命令创建的连接、恢复上一配置并释放预留，不能删除已属于其他命令的 bridge。若完成与否未知，先查资源、guest carrier 和 journal，再决定继续或补偿。

正常关机发送请求后等待观测，超时返回 `SHUTDOWN_TIMEOUT` 并保持实际观测；强制断电是另一条命令。QEMU 进程运行仅表示 runtime alive，OS_READY 需要客体 agent/服务探测或明确标记未知；没有探针的镜像不能靠定时器宣称进入真实 OS 桌面。

agent 启动、Worker 重启、控制恢复和周期巡检均执行 reconciliation：比对数据库资源清单、libvirt domain 元数据、本实验网络端点和磁盘；发现已存在的受管资源可采用，发现缺失或 spec 不匹配则告警并冻结相关动作。带本平台所有者标签但无数据库记录的资源进入隔离待核对清单；未带本平台标签的宿主机资源禁止清理。禁止重启时用名称通配符删除全部 `br-*`、TAP 或 VM。

## 5.6 持久事件、重连与指标

关键 Event 与对应状态变更在同一数据库事务提交。事件带 `schema_version, event_id, experiment_id, seq, type, command_id, config_revision, control_epoch, occurred_at, data`；`(experiment_id, seq)` 唯一，seq 在锁定实验后递增，时间戳不代替顺序。审计、评分和回放消费相同已确认事件，保存各自游标和去重记录。高频指标另有采样时间与序列，丢指标不会造成设备状态缺口。

```json
{
  "schema_version": "1.0",
  "event_id": "21061d1a-ec12-49b2-9d9f-7e9700b69e3e",
  "experiment_id": "exp-id",
  "seq": 108,
  "type": "port.link_changed",
  "command_id": "c6dcc41c-84bf-47b2-8b15-ae286ab24ea5",
  "config_revision": 13,
  "control_epoch": 2,
  "occurred_at": "2026-10-03T12:00:00Z",
  "data": {"device_port_id": "port-id", "observed_link": "UP", "source": "libvirt_and_guest_probe"}
}
```

Redis Streams 用于跨进程投递已持久化业务事件，按 event_id 去重、消费组确认和故障重试；PostgreSQL Event 表负责长期恢复。首版单 dispatcher 可简化次序；扩容时消费者按 seq 补齐，不依赖 Streams 全局流 ID 等于实验 seq。配置 Streams 保留、pending reclaim、消费滞后告警；过期缺口从 DB 重建，不能静默跳过影响评分的事件。

`channels_redis` 是 Channels 的通知层，group_send 可能因容量静默丢弃，不能承担唯一事件保存。参考：[Channels channel layer 规范](https://channels.readthedocs.io/en/stable/channel_layer_spec.html)。WS 可推完整事件或 `events_available(last_seq)`；客户端按序应用，只接受当前 generation，发现重复忽略，发现 seq 缺口调用 events API。心跳定期公布 latest_seq，弥补尾部事件丢失而没有后续消息触发缺口的情况。

`GET state` 返回一致性投影及 `{config_revision, control_epoch, last_event_seq}`。读取需使用同一数据库快照（短 REPEATABLE READ 只读事务，或短时锁实验行并按所有写者遵守的顺序读），不能在多个不一致 SELECT 后随手附上最新 seq。重连先取全量状态 S，再拉取 `after_seq=S.last_event_seq`，并合并期间缓存的 WS 事件；重复事件去重。事件已超出保留窗口返回 `410 RESYNC_REQUIRED`，客户端重新取 state。冷快照恢复按 §8 执行，恢复成功产生新的配置版本和事件，不将 event_seq 回拨到旧快照。

## 5.7 观测进入平台与操作边界

Runtime 回报先进入受鉴权的内部观测入口，携带 host、runtime_unit、epoch、agent_boot_id、source_seq、operation_id 及观测时间。服务核对绑定和当前代次，再在领域事务中更新状态/追加事件；旧代次回报进入诊断记录，不反向改变最新状态。agent 重启后 boot_id 改变，平台需先完成资源核对，再接受该进程的状态流。关键观测在本地受限大小的journal或重传队列中保存直到平台确认，网络中断不得无限消耗宿主机磁盘；队列溢出/缺口要求全量观测核对，不制造完整历史。

异步发生的来宾掉电、进程退出和接口变化也需走统一状态归并服务，使用实验锁分配事件序号。若观测与命令计划冲突，不直接重复执行旧命令；先以来源/代次判断是用户意图尚未生效、硬件故障还是外部修改。重试循环要有次数、总时限和退避，超限进入需要排障的状态。指标的短暂丢失只影响统计，不自动触发Runtime重建。

操作计划保存开始前的必要配置及资源所有权，但不能承诺撤销任意来宾业务副作用：硬断电造成的文件系统损失、串口里用户执行的删除和已经发出的业务报文没有通用补偿。配置命令只有在支持的客体管理接口读取/写入/验证均成立时才提供平台可回滚语义；其他情形明确标记人工恢复或从§8冷快照重建。用户取消已开始命令是取消请求，由执行器在安全步骤边界处理，不能用Celery terminate杀进程后立即宣称系统已恢复。

前端看到202后显示等待/执行中并保留command_id；关闭浏览器不取消后台命令。HTTP超时后以同一个command_id查询或重发，不能重新生成ID“再试一次”。遇到epoch变化或RECOVERY_REQUIRED先获取全量state，完成重同步再允许修改；不能过滤掉新epoch事件后继续展示旧设备状态。

# 9. 权限、镜像与插件安全

## 9.1 用户、实验与服务权限

Web API、Celery Worker、host-agent 和来宾系统使用不同身份。ADMIN 管理目录和组织策略；TEACHER 管理被授权课程/实验；STUDENT 操作自己的或共享授权实验；OPERATOR 运维 host。平台角色不能替代对象权限，每个入口同时检查组织、ExperimentMember 和动作范围。

| 动作 | 最低授权 |
|---|---|
| 查看实验、事件、指标 | 实验 VIEWER；私有抓包/控制台可单独禁止 |
| 装配、接线、开关机、平台配置 | EDITOR 且实验模式允许该动作 |
| 发起冷快照、恢复或删除实验 | OWNER 或明确授予该能力的 EDITOR |
| 进入控制台并发送键盘/串口输入 | 独立 console.write 权限；只读会话单独签发 |
| 导入与发布设备、镜像 | registry.manage；不能仅凭自己建实验得到 |
| 更新 host 授权、排障与 fencing | OPERATOR；高权限操作留完整审计 |

REST 查询先按组织和实验权限过滤 QuerySet；Command 每个嵌套 device/port/component/snapshot/runtime_unit ID 再核对归属。Worker 开始时重查账号停用、授权和执行策略；排队期间撤权不能继续执行未开始命令。控制台输入、MCP 和便利 REST 不设授权例外。必须测试跨用户开机、跨实验插线、恢复他人快照、猜 runtime_unit ID、越权 WS 订阅和控制台进入均被拒绝。

首版浏览器采用 Django Session + CSRF，同源反向代理提供 `/api` 与 `/ws`；登录接口也实施 CSRF 与速率限制。生产启用 HTTPS、Secure/HttpOnly cookie、限定 SameSite、ALLOWED_HOSTS 和精确 Origin 白名单。Channels 使用 AuthMiddlewareStack 和 Origin 校验，连接前检查成员关系，长连接周期性/权限变化时重新校验并关闭失效连接。WebSocket 可携带有效会话 cookie，不能因此跳过跨站防护；参考：[Channels 安全文档](https://channels.readthedocs.io/en/stable/topics/security.html)。

MCP/自动化使用独立、短期、可撤销、限定实验/动作 scope 的凭证；服务端映射到真实 actor，不允许模型自报 admin。前端、日志和普通用户的请求不能接触 host-agent 私钥或 Redis/数据库管理员凭证。

## 9.2 控制台授权和外围设备约束

创建 ConsoleSession 时检查 device 到 runtime_unit 的关系，签发随机、短期、单次握手的票据，绑定 user、experiment、device、runtime_unit、epoch、输入/只读能力和期限。控制台网关再次验证票据，并通过 host-agent/libvirt 取得 VNC/串口流；VNC、QMP、libvirt 端口不直接暴露给浏览器。票据不进入普通访问日志；既有连接在退出登录、撤权、Runtime generation 更换或设备断电后关闭。

显示器线路有效才开放设备画面；键盘和鼠标线路分别控制输入权限。禁止仅把前端按钮变灰，网关也必须拦截无输入权限的 RFB 键盘/鼠标消息。显示器断开不关闭 VM，拔电源不靠隐藏 noVNC 代替停机。若底层实现只提供视觉/输入门控而未让客体真实识别 USB 热拔插，模板须明确能力边界。

串口/SSH 控制台拥有客体系统权限，不等于宿主机权限。通过 API 的 IP/路由配置必须使用模板声明的受支持客体代理或管理接口；不能向宿主机执行用户输入的 `ip`/`nft` 命令来伪装来宾配置效果。真实终端中发生的客体配置若无观测器，应标记配置状态未同步，不能承诺完整回放全部用户操作。

## 9.3 host-agent 最小权限

API/Celery 容器不挂载 `/dev/kvm`、Docker socket、libvirt socket，也不以 root/privileged 运行。host-agent 使用独立 `simlab-runtime` 账号，由 systemd 管理，通过本机 Unix socket 或受 mTLS 保护的运维网络接受白名单结构化操作；上层服务无 shell 与直接 libvirt/OVS 访问权。

VM 生命周期、XML、磁盘/NIC 变更和控制台开通仅通过 libvirt，由 `QemuAdapter` 使用受管 domain UUID 与元数据操作；不得同时用 `qemu-system-*` 进程和直接 QMP 写操作维护同一 VM。确需 QMP 观测时限定只读白名单并保留 libvirt 所有权。libvirt ACL/Polkit、文件权限和受限网络辅助程序按动作授予；账号加入可管理全部 domain 的组不等于实现实验隔离。参考：[libvirt 认证与访问说明](https://libvirt.org/auth.html)。

网络操作需要的能力交给小型受限 helper：仅能在本平台预分配资源范围内创建/更新/销毁；参数使用枚举、整数范围和服务端生成名称，拒绝用户提供任意 argv/XML/path。仅使用 argv 数组并不足以防止 OVS 参数注入或误操作，仍须拒绝 `--` 形式附加命令、未知接口和其他实验 bridge；限定超时、输出大小与环境。来宾实验网络默认无外网、无宿主机管理网通路，开放出口按单独策略执行。

## 9.4 镜像导入、资产与插件

上传进入隔离 staging，记录文件大小、哈希、格式、架构、来源、授权、提交人和审批状态。上传成功不等于可运行；只允许管理员审核后把 ImageArtifact 与经过验收的 Runtime profile 发布。导入检查限大小/时长/磁盘空间，在无敏感挂载、无管理网络、资源受限的导入进程中解析；解析器和 QEMU/libvirt保持受支持版本。

qcow2 可能引用 backing file，不能把未知上传文件的 backing chain 或外部数据文件路径当成可信路径。MVP 拒绝外部引用/加密或不支持特性；允许的源镜像经过校验或受限环境归一化后存储，最终通过 registry artifact ID 使用。ISO 作为只读安装媒体，基础镜像只读，每台设备的独立 overlay 与冷快照按 §8 管理。API 不接受服务器绝对镜像路径，浏览器 URL 也不能直接作为 QEMU/libvirt磁盘源。

GLB/纹理校验文件类型、大小、节点/多边形/纹理预算和 URI；拒绝任意外部 URI、目录穿越及未受信任活动脚本。归档导入逐项验证解析后的目标路径属于 staging、禁止逃逸符号链接；失败不发布部分资产。服务端下载来源若提供该能力，应单独实施出口允许列表，禁止访问本机、内网和云元数据地址。

MVP 的“插件”是声明式 Device Manifest + 已批准资产 + 现有 Runtime capability 的组合，不能上传 Python/C++/JS 后在 API 或 agent进程中执行。新的 Runtime Adapter 属代码发布，经审查、构建、契约测试和运维安装；热加载第三方可执行插件不属于 MVP。manifest 中的 rule 采用有限 DSL/注册规则名，禁止 `eval/exec` 与任意 Python 导入。

业务审计保存 actor、Command、目标归属、操作代次、受影响资源、已确认结果与失败原因；敏感凭证、VNC 票据及客体密码脱敏。抓包可能含凭证与业务内容，必须继承实验访问权限、存储限额和保留策略，不能用公开对象 URL 绕过授权。

## 9.5 管理变更与保护模式

学生登录、实验EDITOR和OPERATOR不自动获得设备目录发布权；OPERATOR的受限运维入口也不得成为执行任意宿主机命令的网页终端。对管理员修改设备模板、停用镜像、调整配额、更新host授权和恢复实验记录变更前后版本，影响运行中的实例时先展示具体影响范围并执行受控命令，不通过后台表单直接改Runtime映射。

文件下载使用经权限检查的短期URL或受鉴权代理；猜出asset/snapshot对象键不能读取其他实验资料。组织删除和实验删除遵守引用、保留期限及审计策略，危险清理操作以精确资源清单实施。平台不可用时，host-agent保护模式只允许授权运维查看受管资源和进行明确的紧急停机，恢复平台后先核对该操作记录再开放一般变更，避免离线操作与排队命令相互覆盖。

# 10. 部署、依赖与开发命令

## 10.1 环境与边界

候选实现基线采用 Python 3.12、Django 5.2 LTS、DRF、Channels、channels_redis、Celery、Redis、PostgreSQL、MinIO/S3、Uvicorn。此处是技术基线，具体补丁版和相互兼容性仍须实施阶段锁定并验收；不使用 `latest`，也不声称本文件已验证版本组合。Django 5.2 支持 Python 3.12，可参考[官方发布说明](https://docs.djangoproject.com/en/5.2/releases/5.2/)。

初版推荐一台 Ubuntu 24.04 LTS x86_64 Linux host运行 QEMU/KVM、libvirt、OVS 与 host-agent；API/DB/Redis/对象存储可同机容器部署，但权限仍隔离。设备 Runtime 不跟随 HTTP API 的重载而销毁。Windows 可原生开发前端/API；Celery 及 Runtime 放在 Linux、Linux 容器或经预检的 WSL2 环境，Celery 不作为 Windows 原生服务支持目标。[Celery 官方 FAQ](https://docs.celeryq.dev/en/stable/faq.html#does-celery-support-windows)

WSL2 不自动满足 KVM、OVS、无线内核功能和网络隔离要求；必须实际检查 `/dev/kvm`、libvirt、OVS、网络功能与端到端闭环。未通过就使用独立 Linux host，或声明 `development_mock` 模式。mock 仅用于 UI/领域测试，不能显示“真实通信验收通过”。

## 10.2 Django 项目与运行目录

```text
3d-network-simlab/
├── compose.yaml
├── .env.example
├── frontend/                         # React/TS，含package-lock.json
├── backend/
│   ├── manage.py
│   ├── pyproject.toml
│   ├── requirements/
│   │   ├── development.in
│   │   ├── development.lock.txt       # API开发，包含uvicorn和测试依赖
│   │   └── production.lock.txt
│   ├── config/
│   │   ├── __init__.py                # 导出celery_app
│   │   ├── celery.py
│   │   ├── asgi.py                    # Django HTTP + Channels WS路由
│   │   ├── urls.py
│   │   └── settings/{base,local,production}.py
│   ├── apps/
│   │   ├── accounts/
│   │   ├── registry/
│   │   ├── experiments/
│   │   ├── topology/
│   │   ├── assembly/
│   │   ├── commands/
│   │   ├── events/
│   │   ├── runtime_control/
│   │   ├── consoles/
│   │   └── audit/
│   └── tests/
├── runtime/host_agent/                # 独立Linux包、锁、journal、adapter
├── schemas/                          # Manifest/Command/Event JSON schema
├── ops/linux/                        # systemd、最小权限策略、预检脚本
└── docs/runbooks/                     # 安装、备份、恢复与故障处理
```

每个 Django app 按需包含 models、migrations、serializers、services、tasks、urls、tests。统一提交服务与领域服务放在明确模块，View/Consumer 不直接操纵 Runtime。`config/asgi.py` 先初始化 Django，再装配 ProtocolTypeRouter、HTTP application、WS AuthMiddlewareStack及 Origin/权限校验。Uvicorn 是 Django ASGI服务器，入口必须是 `config.asgi:application`；参考：[Django 官方 Uvicorn 指南](https://docs.djangoproject.com/en/5.2/howto/deployment/asgi/uvicorn/)。

宿主机目录由安装脚本创建并授权：`/var/lib/simlab/base-images` 只读基础镜像、`/var/lib/simlab/experiments/<uuid>` 独立磁盘与快照、`/var/lib/simlab/host-agent` 本地 journal、`/run/simlab` agent socket/锁。QEMU服务身份须能读基础镜像和写其设备目录；不以 chmod 777 解决权限。Linux资源目录不与前端静态资产目录共用。

## 10.3 配置与锁定

实施必须提交 Python完全版本与哈希锁、Node锁文件、容器镜像 digest、Linux包/镜像来源、ns-3版本和构建参数、测试设备镜像哈希及验收结果。依赖更新在独立变更中重新验证，普通开发安装使用锁文件，不每次重新解析范围依赖。Linux host-agent 的 libvirt-python/系统库在专门 Linux环境构建或安装，不能进入 Windows API 锁文件。

`.env.example` 至少声明以下配置及用途，真正秘密不进仓库：

```text
DJANGO_SETTINGS_MODULE=config.settings.local
SIMLAB_ENV=development
SIMLAB_RUNTIME_MODE=development_mock
DJANGO_SECRET_KEY=<仅本地随机值>
DJANGO_ALLOWED_HOSTS=localhost,127.0.0.1
DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:5432/simlab
CELERY_BROKER_URL=redis://127.0.0.1:6379/0
CHANNEL_REDIS_URL=redis://127.0.0.1:6379/1
EVENT_STREAM_REDIS_URL=redis://127.0.0.1:6379/2
OBJECT_STORAGE_ENDPOINT=http://127.0.0.1:9000
SIMLAB_HOST_AGENT_URL=<本机unix socket或受mTLS保护的URL>
SIMLAB_HOST_AGENT_CA_FILE=<服务端受保护路径>
```

以上变量解析器由项目实现，并显式读取仓库 `.env` 或进程环境；不能假定 Django 自动读取 `.env`。开发 Redis 可分 DB/前缀，生产按职责分实例/ACL，Channels缓存不可无意清掉事件和任务。Compose服务名固定为 `postgres/redis/minio/api/worker/beat/outbox/eventrelay`；同一环境只运行一套调度器。MinIO账户/桶初始化属于幂等安装步骤，不能只启动进程就认定存储已可写。

## 10.4 Windows PowerShell：开发 API 与前端

下面是软件实施后必须提供并验收的操作说明，不表示当前文档目录已存在可运行仓库。前提：Python 3.12、项目规定的 Node版本、Docker Desktop/WSL2或其他可连接的 Linux服务。工作目录换成实际源码根；命令分别执行，不把 Windows激活写成 bash命令。

首次复制`.env`后必须填写本地凭证、数据库和对象存储配置，再启动相关服务；以下初始化命令只在新环境执行，不能每次开发启动覆盖已有`.env`。锁文件与Compose定义须先由工程初始化阶段生成并提交。

```powershell
Set-Location C:\src\3d-network-simlab
Copy-Item -LiteralPath .env.example -Destination .env
docker compose up -d postgres redis minio
Set-Location backend
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --require-hashes -r requirements\development.lock.txt
$env:DJANGO_SETTINGS_MODULE = 'config.settings.local'
.\.venv\Scripts\python.exe manage.py migrate
.\.venv\Scripts\python.exe manage.py createsuperuser
.\.venv\Scripts\python.exe -m uvicorn config.asgi:application --host 127.0.0.1 --port 8000 --reload
```

另外一个 PowerShell终端：

```powershell
Set-Location C:\src\3d-network-simlab\frontend
npm ci
npm run dev -- --host 127.0.0.1
```

Vite将 `/api` 和 `/ws` 代理至本地 API，启用WS代理与cookie/CSRF约定。Celery Worker、outbox和eventrelay使用Linux终端或 `docker compose up -d worker beat outbox eventrelay`；它们必须连接同一个DB/Redis及正确host-agent。Windows API进程不安装或启动QEMU/libvirt。

验证示例（需要项目实现所列测试配置）：

```powershell
Set-Location C:\src\3d-network-simlab\backend
Invoke-RestMethod -Uri http://127.0.0.1:8000/api/v1/health/live/
.\.venv\Scripts\python.exe manage.py check
.\.venv\Scripts\python.exe manage.py makemigrations --check --dry-run
.\.venv\Scripts\python.exe -m pytest tests\unit tests\api
```

## 10.5 Linux：控制平面与 Runtime Host

控制平面开发终端；各长期运行服务使用独立终端或Compose/systemd，不在同一个终端串行等待前一服务退出：

```bash
cd /srv/3d-network-simlab
cp .env.example .env
docker compose up -d postgres redis minio
cd backend
python3.12 -m venv .venv
.venv/bin/python -m pip install --require-hashes -r requirements/development.lock.txt
export DJANGO_SETTINGS_MODULE=config.settings.local
.venv/bin/python manage.py migrate
.venv/bin/python -m uvicorn config.asgi:application --host 127.0.0.1 --port 8000 --reload
```

另外的Linux终端，均从 backend目录启动并使用同一配置：

```bash
.venv/bin/celery -A config worker --loglevel=INFO --concurrency=4
.venv/bin/celery -A config beat --loglevel=INFO
.venv/bin/python manage.py run_outbox_dispatcher
.venv/bin/python manage.py run_event_relay
```

后三个长期服务各占独立终端。Celery app 在 `config/celery.py` 通过 namespace=`CELERY` 读取Django设置并 autodiscover_tasks，在 `config/__init__.py` 导出；参考：[Celery官方Django集成](https://docs.celeryq.dev/en/stable/django/first-steps-with-django.html)。`run_outbox_dispatcher` / `run_event_relay` 是本项目必须实施的管理命令，并非Django自带工具。

Linux Runtime Host的安装由 `ops/linux` 受控脚本完成，锁定QEMU/libvirt/OVS与内核能力，安装host-agent包、systemd单元和受限权限；不同libvirt版本可能采用libvirtd或virtqemud等模块化daemon，脚本先识别运行形态，不能硬编码单一服务名。预检至少包括：

```bash
test -c /dev/kvm
virsh -c qemu:///system version
virsh -c qemu:///system list --all
ovs-vsctl show
systemctl status simlab-host-agent --no-pager
```

`ovs-vsctl show` 按部署的受限operator权限执行；不为方便给Web用户sudo权。上述只证明基础组件存在，完整预检还需验证host-agent身份实际能执行白名单动作、实验隔离、桥端口、独立磁盘、输入门控、关闭/恢复和清理。

实施阶段应提供 `manage.py runtime_preflight --host <id>` 与 `manage.py verify_runtime_loop --host <id> --image-release <id>` 两个项目命令，分别输出结构化能力报告与两台Linux VM通信/拔线/恢复报告；必须有真实证据后才允许登记模板为已验收。这些命令尚需开发，不能当成现成工具或本次已运行结果。

## 10.6 生产与运维完成条件

生产由反向代理提供HTTPS和WS升级，ASGI进程、Celery、dispatcher、relay及host-agent分别受进程管理器监管；关闭 `--reload` 与DEBUG，执行 Django部署检查。控制服务容器无需privileged；Runtime Host与来宾网络保留独立权限边界。部署支持单host及绑定实验的资源限额，首版不引入Kubernetes与自动跨host迁移。

存活检查只报告进程存在；就绪检查报告DB、必要通知通道和依赖可用性；Runtime能力单独按host/profile展示。监控至少包含Command最老等待时间、超时与UNKNOWN、outbox积压、Streams消费游标滞后、WS重同步率、宿主机内存/磁盘、预留资源、VM启动峰值与残留资源。日志带command/operation/experiment/runtime_unit/epoch，不能依靠设备显示名定位。

数据库备份、不可变资产备份和§8冷快照分别制定保留及恢复演练；只有DB备份不足以恢复磁盘。升级先禁止新变更、排空执行或冻结未知操作、备份、迁移、滚动重启、reconciliation和能力检查，再开放修改。停机和删除须经过同样资源清单，禁止自动清理不属于平台的VM或网络。版本矩阵、命令输出、测试报告和故障恢复证据形成后，才能在README写“已验证运行”。
