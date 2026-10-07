# 3D Network SimLab

面向网络教学的浏览器实验室。当前仓库包含可运行的 React/Three.js 前端、Django/DRF 控制平面、命令与事件模型、拓扑/装配规则、冷快照元数据流程，以及严格标注的 `development_mock` Runtime。

完整的 Nginx、WebSocket、noVNC、真实 Runtime、备份与更新操作见
[详细部署说明](DEPLOYMENT_README.md)。下文使用仓库根目录的 `ops/linux/deploy.sh`，
部署当前 `web/` 前端和 `backend/` 后端。

## 新服务器部署

建议使用 Ubuntu 24.04 LTS x86_64；脚本也支持满足版本要求的 Debian x86_64。
需要 Python 3.12–3.14、Node.js 22+、npm 和 `apt`。脚本会安装 PostgreSQL、Redis、
Nginx、noVNC 等系统包；缺少 Node.js 22+ 时会下载并校验官方 Node.js v22 包。
服务器须能访问软件仓库和 npm 包仓库。真实虚拟机模式还需要可用的 KVM、libvirt、
Open vSwitch，以及域名和 TLS 证书。Windows/macOS 可作为浏览器客户端，不能按此脚本充当真实 Runtime Host。

在空白服务器上先安装 Git 和 Python 基础工具，再将源码放到 `/opt` 下的**永久目录**。
下例使用本项目仓库；如果使用源码压缩包，解压后在包根目录执行相同的部署脚本。

```bash
sudo apt-get update
sudo apt-get install -y git python3 python3-venv python3-pip curl ca-certificates
python3 --version                    # 应为 3.12–3.14
sudo install -d -m 0755 /opt/simlab
sudo git clone https://github.com/trep123/SimLab.git /opt/simlab/SimLab
cd /opt/simlab/SimLab
sudo bash ops/linux/deploy.sh --mode mock --domain 服务器IP或域名
```

`mock` 会安装前端、API、PostgreSQL、Redis、Nginx 和 systemd 服务，页面必须明确显示
`development_mock`：它只用于界面和领域测试，不代表真实设备网络已打通。
浏览器打开 `http://服务器IP或域名/`。脚本会把数据库密码和 Django 密钥写到
`/etc/simlab/app.env`，不会预置管理员密码。首次部署后创建管理员：

```bash
sudo -u simlab-app bash -c 'set -a; . /etc/simlab/app.env; set +a; \
  /opt/simlab/SimLab/.venv/bin/python \
  /opt/simlab/SimLab/backend/manage.py createsuperuser'
```

若要部署真实虚拟机，在满足上述宿主条件、准备好域名及证书后，从同一源码目录执行：

```bash
sudo bash ops/linux/deploy.sh --mode real --domain simlab.example.com \
  --tls-cert /etc/ssl/simlab/fullchain.pem \
  --tls-key /etc/ssl/simlab/privkey.pem
```

真实模式的脚本会安装宿主依赖并运行预检；失败时会停止。不要在已有 `mock` 配置上
直接切换模式：脚本会拒绝与 `/etc/simlab/app.env` 不一致的模式或域名。真实 Runtime 的
能力仍须在目标主机按 [Runtime 验收手册](docs/runbooks/runtime-g0.md) 验收，
未通过 `ops/linux/preflight.py` 时不得宣称已验收。

部署后检查服务和 API；真实模式通过已配置的 HTTPS 域名访问：

```bash
sudo systemctl status simlab-api simlab-worker simlab-outbox simlab-eventrelay nginx --no-pager
curl -fsS http://服务器IP或域名/api/v1/health/live/
# 真实模式另检查：sudo systemctl status simlab-host-agent --no-pager
```

只检查现有环境而不安装时可运行 `bash ops/linux/deploy.sh --check`；该检查要求 Python
和 Node.js 已安装。真实模式的 `--check` 还会运行 Runtime 预检。部署产生的镜像、密钥、
overlay、PCAP、数据库和运行时文件不得提交到 Git。

## 后端 pip 软件包

以仓库中的 [生产依赖文件](backend/requirements/production.lock.txt) 为安装来源；
不要用服务器上现有的全局 `pip list` 反推依赖。该文件目前固定下列**直接依赖**的版本，
pip 还会安装它们的间接依赖：

| 包 | 固定版本 | 用途 |
| --- | --- | --- |
| Django | 5.2.7 | Web/API 框架与 ORM |
| djangorestframework | 3.16.1 | REST API |
| channels | 4.3.1 | ASGI/WebSocket |
| channels-redis | 4.3.0 | Redis 频道层 |
| celery | 5.5.3 | 后台任务 |
| uvicorn | 0.37.0 | ASGI 服务进程 |
| websockets | 15.0.1 | WebSocket 支持 |
| psycopg[binary] | 3.2.10 | PostgreSQL 驱动 |

本地开发和测试改用 [开发依赖文件](backend/requirements/development.lock.txt)：
前七项版本相同，另有 `pytest==8.4.2`、`pytest-django==4.11.1`、`ruff==0.14.1`；
开发文件不包含 `psycopg[binary]`，默认使用 SQLite。两个文件只固定了直接依赖，
间接依赖版本由 pip 在安装时解析，因此目前并非完整哈希锁文件。
真实 Host Agent 的 `libvirt` Python 模块由 `ops/linux/install_runtime.sh` 安装的
系统包 `python3-libvirt` 提供，不在 API 虚拟环境中执行 `pip install libvirt`。

一键部署已自动创建 `/opt/simlab/SimLab/.venv` 并执行生产依赖安装。手动安装后端时，
在仓库根目录使用同一个文件：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements/production.lock.txt
```

查看一键部署环境实际安装的
**完整**包清单、版本及安装一致性：

```bash
/opt/simlab/SimLab/.venv/bin/python -m pip list
/opt/simlab/SimLab/.venv/bin/python -m pip freeze
/opt/simlab/SimLab/.venv/bin/python -m pip check
```

## 本地启动

以下为源码开发模式；在仓库根目录执行，使用 `development_mock` 保真度。
Python 3.12–3.14 和 Node.js 22+ 已安装时：

```bash
cp .env.example .env
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r backend/requirements/development.lock.txt
set -a; . ./.env; set +a
python backend/manage.py migrate
read -rsp "演示账号密码: " SIMLAB_DEMO_PASSWORD && echo
export SIMLAB_DEMO_PASSWORD
python backend/manage.py seed_demo
cd backend
../.venv/bin/uvicorn config.asgi:application --reload --host 127.0.0.1 --port 8000
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
