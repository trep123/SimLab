# 3D Network SimLab

完整的前后端安装、Nginx/WebSocket/noVNC 配置、真实 Runtime 接入、验证与备份步骤见
[部署说明](DEPLOYMENT_README.md)。

面向网络教学的浏览器实验室。当前仓库包含可运行的 React/Three.js 前端、Django/DRF 控制平面、命令与事件模型、拓扑/装配规则、冷快照元数据流程，以及严格标注的 `development_mock` Runtime。

真实 QEMU/KVM + libvirt + Open vSwitch 闭环必须在目标 Linux Runtime Host 上单独验收。运行时证据保存在本机 `docs/poc/`，不会提交到 Git。在新主机上先运行：

```bash
python3 ops/linux/preflight.py --json docs/poc/preflight-result.json
```

宿主组件安装、官方镜像拉取、双 VM + OVS Gate、noVNC 访问及安全清理见 [G0 Runtime Gate](docs/runbooks/runtime-g0.md)。

## 本地启动

```bash
cp .env.example .env
python3 -m venv .venv
. .venv/bin/activate
pip install -r backend/requirements/development.lock.txt
python backend/manage.py migrate
read -rsp "演示账号密码: " SIMLAB_DEMO_PASSWORD && echo
export SIMLAB_DEMO_PASSWORD
python backend/manage.py seed_demo
cd backend
../.venv/bin/uvicorn config.asgi:application --reload --host 0.0.0.0 --port 8000
```

另开终端：

```bash
cd web
npm ci
npm run dev
```

打开 `http://localhost:5181`。开发服务器将 `/api`、`/ws` 和 `/novnc` 分别代理到
Django ASGI 与本机 noVNC 静态服务。VNC 使用 WebSocket，后端必须用上面的 `uvicorn`
启动，`manage.py runserver` 只能处理 HTTP，不能承载设备屏幕中继。演示账号由
`seed_demo` 输出；仅用于本地开发。

登录后实验保存到 Django 数据库。实验所有者可在实验库中按用户名添加 EDITOR 或 VIEWER；
未授权账户看不到其他用户的实验。旧版浏览器本地实验会在首次登录时迁移到服务器。

## PC 与笔记本虚拟机

- 从设备栏拖入 PC 或笔记本时，可选择 `simlab-g0-pc1`、`simlab-g0-pc2` 等白名单已有
  libvirt 域；已关机且未绑定的域仍可选择，每台虚拟机同一时间只绑定一台前端设备。
- 没有空闲实例时，选择已登记镜像并填写 vCPU、内存和磁盘容量。控制平面校验范围后，
  由受限 Host Agent 创建独立 overlay、cloud-init、OVS 接口和 libvirt 域。
- 不需要后端虚拟机时可选择“暂不绑定”，之后再从设备检视面板绑定或创建。
- 设备检视面板可改绑、解绑、开关机和放大 VNC。PC 与笔记本的三维屏幕分别映射各自
  noVNC Canvas。
- 控制平面白名单使用 `SIMLAB_DESKTOP_EXTERNAL_DOMAINS`，Host Agent 白名单使用
  `SIMLAB_EXTERNAL_DOMAINS`；两者应配置为同一组已有域。
- PC/笔记本手动关机或关闭实验时会正常关闭虚拟机并自动解绑。删除前端设备时，平台创建的
  虚拟机同时销毁；宿主机已有的外部域只关机解绑，仍保留在宿主机资源池中。

## 3D 画布操作

- 单击设备选中，在右侧检查器中修改名称或精确填写 X/Z 坐标。
- 按住设备拖动可调整位置；松开后位置会通过命令接口保存，失败时自动回滚。
- 单击一个空闲端口进入接线模式，再单击另一台设备上兼容的空闲端口完成连接；单击已连接端口可拔线。
- 双击设备将镜头聚焦到该设备；工具栏中的定位按钮可自动整理当前拓扑。
- 场景工具栏可切换正面、45°、俯视和聚焦视角，并提供外观、透视、爆炸图、流量走向及自动旋转模式。
- 检查器同时提供开关机和删除操作。删除设备前必须先关机并清理相关连接。

如果本机 8000 端口被占用，可为前端指定其他后端地址：

```bash
VITE_SIMLAB_API_ORIGIN=http://127.0.0.1:8010 npm run dev
```

## 验证

```bash
.venv/bin/python backend/manage.py check
.venv/bin/python -m pytest -q
cd web && npm test && npm run build
```

完整环境变量、真实 Runtime 安装边界与验收说明见 [本地运行](docs/runbooks/development.md) 和 [Runtime 预检](docs/runbooks/preflight.md)。

真实 Django Command 已接入本机受限 Host Agent；安装、权限和证据复核见
[Host Agent 运行手册](docs/runbooks/host-agent.md)。这项完成 TSK-008 的本机运行路径，
不表示 G1 的装配、应用鉴权控制台、Guest readiness 和冷恢复已经完成。

跨进程事件、WebSocket 游标和断线补齐见
[事件投递运行手册](docs/runbooks/event-delivery.md)。

当前使用的前端位于 `web/`；`npm ci && npm run build` 可验证其 TypeScript 与生产构建。
旧版 `frontend/`、构建产物、运行时数据库和本机验收截图不进入 Git 仓库。

## 安全边界

API 进程不访问 libvirt socket、`/dev/kvm` 或 Docker socket。真实宿主机操作只能由独立 host-agent 的结构化白名单接口执行。本仓库不会下载或再分发操作系统镜像。
