# 无线客体接入路线

状态：逻辑 AP LAN → VM TAP 的编译路径已实现，真实 Host Agent/客体流量未验收。
`LocalRadioModel` 仍在浏览器计算关联、RSSI 和速率；`wireless_associations` 与 AP 的
`ap_radio` 保存于服务器实验文档。关联使 Host Agent 将笔记本 `eth1` 的 TAP 接入 AP
上联对应的 OVS 网段，解除关联或 AP 关机使链路隔离；不模拟 802.11 数据帧。

当前选择是射频关联映射独立虚拟以太网接口：笔记本机身 RJ45 → `eth0`，
逻辑射频口 `RADIO0` → `eth1`，AP 射频侧加入 AP 有线上联所在 LAN。
客体系统看到的是 Ethernet 接口；浏览器射频参数提供关联/覆盖控制，
业务报文设计为走 OVS 二层桥，不经过 802.11 PHY/MAC。因此该能力只能标为
“以太网桥接的无线拓扑接入”，不得宣称真实 Wi-Fi 驱动、WPA 或射频损耗影响实际吞吐。
已有单网卡 VM 仍可绑定实体 RJ45，但无法启动独立的射频业务；必须使用双网卡 VM。

若将来需要真实 802.11 认证与射频损耗作用于客体报文，须按任务书 §7.3–7.4
另做 hwsim/ns-3/硬件通路，不能把当前 OVS 桥接称为真实无线空口。

## 已搁置的平台专用软件适配器候选

目标客体固定为 Ubuntu 24.04、Windows 10、Windows 11。可以在无物理 USB 设备时开发：
QEMU C 设备前端提供专用 PCI/USB 设备 ID、DMA/队列与控制命令；Ubuntu 24.04
客体驱动接入 cfg80211/mac80211；Windows 10 驱动接入 WDI，
Windows 11 优先使用 WiFiCx（若选择沿用 WDI，需先做系统兼容性验证）；
宿主介质服务把扫描、Beacon、关联、认证、数据帧和断线事件送到
前端 AP 对应的后端模型。Python 可负责编排和设备配置，但不能替代客体驱动。
这是一套新的虚拟硬件/双系统驱动产品，不能仅通过现有 virtio-net 改名实现。

入口顺序：先固定客体 OS 版本与设备 ABI，再做 Linux 客体 `wlan` 可见性和单 AP
双向报文 PoC，然后开发对应 Windows 驱动，最后接入 SimLab Command/Host Agent、
多实例隔离、位置/信道变化和实机验收。每阶段均以客体识别、扫描、关联、
ARP/DHCP、ping/TCP 和断关联证据推进；未通过时不开放为可用 Runtime Profile。

当前部署须先通过 `ops/linux/preflight.py`，然后以双向 ARP/DHCP、ping/TCP、
断关联、AP 关机、RJ45 与 `eth1` 隔离的抓包证据验收。未完成前 UI 只报告
Host Agent 返回的接线状态，不宣称真实流量已验收。
