# SimLab 前后端部署说明

## 一键部署（推荐）

发布目录提供 `simlab-full-source-YYYYMMDD.tar.gz`，其中包含 `web/`、`backend/`、
`runtime/`、`ops/linux/deploy.sh` 及部署文档；也提供独立的前端和后端源码包。
三者都是源码包，不包含镜像、虚拟机磁盘、数据库或凭证。可在开发机执行
`python3 ops/package_source.py` 重新生成，并用 `release/SHA256SUMS` 校验。

目标服务器为 Ubuntu/Debian x86_64，须有 Python 3.12–3.14，并能通过 `apt` 安装
PostgreSQL、Redis、Nginx 等服务。部署脚本在缺少 Node.js 22+ 时从 Node.js 官方
v22 LTS 发布目录下载并校验包；`--check` 是只读检查，首次执行若缺 Node.js 会提示，
可继续执行正式部署命令。将整套包复制到服务器后执行：

```bash
cd /opt/simlab
sha256sum -c SHA256SUMS
tar -xzf simlab-full-source-YYYYMMDD.tar.gz
cd simlab-full-source-YYYYMMDD
bash ops/linux/deploy.sh --check
sudo bash ops/linux/deploy.sh --mode mock --domain 服务器IP或域名
```

`mock` 模式在页面中明确显示 `development_mock`，只用于界面与领域测试。
需要真实 PC/笔记本虚拟机时，准备 KVM 可用的服务器、域名和已安装的 TLS 证书：

```bash
cd /opt/simlab/simlab-full-source-YYYYMMDD
sudo bash ops/linux/deploy.sh --mode real --domain simlab.example.com \
  --tls-cert /etc/ssl/simlab/fullchain.pem \
  --tls-key /etc/ssl/simlab/privkey.pem
```

真实模式会安装并预检 KVM、QEMU、libvirt、OVS，下载并校验固定版本的基础镜像，
安装受限 Host Agent；预检失败会停止部署，不能宣称真实 Runtime 验收。
脚本会创建 PostgreSQL 数据库、Redis 服务、Python 虚拟环境、前端静态构建、
四个 systemd 服务和 Nginx 反向代理。它在 `/etc/simlab/app.env` 保存随机生成的密钥，
再次运行会复用该文件；源码目录必须保留在 `/opt` 下。真实模式不自动创建或信任
`simlab-g0-pc1` 等外部虚拟机，若要绑定现有域，请按第 7 节配置白名单。

首次部署后按脚本输出的命令创建管理员，例如：

```bash
sudo -u simlab-app bash -c 'set -a; . /etc/simlab/app.env; set +a; \
  /opt/simlab/simlab-full-source-YYYYMMDD/.venv/bin/python \
  /opt/simlab/simlab-full-source-YYYYMMDD/backend/manage.py createsuperuser'
```

部署后可检查 `systemctl status simlab-api simlab-worker simlab-outbox simlab-eventrelay nginx`。
部署脚本支持重复运行以更新同一路径的应用；切换模式或域名须先备份并明确调整
`/etc/simlab/app.env`、Nginx 证书和相应服务配置。**请先备份数据库再更新。**

以下是分步部署方式，适合需要自行配置数据库、服务账户或反向代理的场景。
本文档同时对应 `simlab-web-source-*.tar.gz` 与 `simlab-backend-source-*.tar.gz`。源码包不包含
`node_modules`、Python 虚拟环境、构建产物、数据库、虚拟机镜像、overlay、密钥、PCAP 或其他运行时数据。

## 1. 功能与数据位置

- Web 前端默认进入空白实验台，不会自动摆放设备。需要演示拓扑时可显式使用
  `?models=型号1,型号2`。
- Web 实验库保存在服务器数据库，保存内容包括设备稳定 ID、型号、名称、位置、端口配置、
  开关机状态、线缆、标签、走线和三维画面设置。旧版本浏览器 `localStorage` 实验会在用户
  首次登录后逐个迁移到该用户的服务器实验库，成功迁移后删除对应本地副本。
- Django Session 账户用于登录；实验成员权限分为 OWNER、EDITOR、VIEWER。OWNER 可保存、
  删除和管理成员，EDITOR 可保存，VIEWER 只能读取，不能操控 VNC 桌面。实验、文档、命令、成员和 Runtime 绑定
  保存在 PostgreSQL；Redis 只用于任务唤醒、Channels 和事件中继，不作为实验事实存储。
- PC/笔记本手动关机、刷新或关闭实验、新建或载入其他实验时，后端会正常关闭虚拟机并自动
  解绑。删除前端设备时，平台创建的虚拟机由 Host Agent 精确销毁；白名单中的宿主机已有域
  只关机解绑，禁止删除未受管的宿主资源。
- 画质面板提供自动、低、中、高、极致五档，以及实时阴影、摄影棚光照、光照强度和曝光控制。
  低档限制为 30 FPS、0.75 像素比、8 FPS VNC 纹理上传，并关闭实时阴影和环境反射。

## 2. 运行条件

Cloud 桥接节点在真实 Runtime 中把实验二层网段接到管理员预先建立的 **OVS 桥**。
先由宿主管理员创建并维护物理网卡到该桥的上联；平台不会移动物理网卡，也不会修改
宿主 IP、默认路由或管理网。将允许的桥名（逗号分隔，例如 `br-lab,br-uplink`）同时写入
`/etc/simlab/app.env` 和 `/etc/simlab/host-agent.env` 的
`SIMLAB_CLOUD_UPLINK_BRIDGES`，然后重启 `simlab-api`、`simlab-worker` 与
`simlab-host-agent`。页面 Cloud 检视面板只显示该白名单中的桥。
选择桥后保存实验，Cloud 的 eth0–eth3 下联口可通过现有网线连到 PC、交换机等设备。
删除 Cloud、取消上联或改选桥时会拆除旧的受管 OVS patch 接线。
Cloud 只提供二层桥接，外部 DHCP、网关和 VLAN 需由上联网络提供；
`development_mock` 只保存配置，不会打通宿主网络。

将管理网桥暴露给实验会让实验设备进入管理网段；应优先使用专用上联桥，
并由宿主管理员决定物理网卡/VLAN 的接入范围。
例如，在专用且尚未配置宿主 IP 的 `enp2s0` 上建立上联时，管理员可执行：

```bash
sudo ovs-vsctl --may-exist add-br br-lab
sudo ovs-vsctl --may-exist add-port br-lab enp2s0
sudo ip link set br-lab up
sudo ip link set enp2s0 up
```

不要把现有管理网卡直接作为上述专用网卡操作；如果宿主自身需要该网络的 IP，
应由管理员按宿主网络配置系统的规则给桥配置地址和路由。

基础控制平面需要：

- Linux x86_64；
- Python 3.12 至 3.14；
- Node.js 22 或更高的受支持 LTS 版本；
- PostgreSQL 17、Redis 8；
- Nginx 1.24 或更高版本；
- 支持 WebGL 2 的 Chromium、Chrome、Edge 或 Firefox。

需要真实 PC/笔记本虚拟机时，Runtime Host 还需要 KVM、QEMU、libvirt、Open vSwitch、
noVNC 与 websockify。先执行预检，只有结果为 `passed: true` 才启用真实 Runtime：

```bash
sudo apt-get update
sudo apt-get install -y python3 python3-venv nodejs npm nginx postgresql redis-server
python3 ops/linux/preflight.py --json /tmp/simlab-preflight.json
cat /tmp/simlab-preflight.json
```

## 3. 解压源码包

两个压缩包可以解压到同一父目录，也可以独立部署：

```bash
mkdir -p /opt/simlab
tar -xzf simlab-backend-source-20261005.tar.gz -C /opt/simlab
tar -xzf simlab-web-source-20261005.tar.gz -C /opt/simlab
```

下文假定后端位于 `/opt/simlab/simlab-backend-source-20261005`，前端位于
`/opt/simlab/simlab-web-source-20261005`。不同日期的包只需替换目录名。

## 4. PostgreSQL 与 Redis

可以使用仓库根目录的 Compose 文件只启动基础服务：

```bash
cd /opt/simlab/simlab-backend-source-20261005
cp .env.example .env
# 修改 .env 中的 POSTGRES_PASSWORD、DJANGO_SECRET_KEY、域名和可信来源
docker compose up -d postgres redis
```

也可以直接使用系统服务。创建数据库的示例：

```bash
sudo -u postgres psql <<'SQL'
CREATE USER simlab WITH PASSWORD '请替换为强密码';
CREATE DATABASE simlab OWNER simlab;
SQL
```

生产环境 `.env` 至少应包含：

```dotenv
DJANGO_SETTINGS_MODULE=config.settings.production
DJANGO_SECRET_KEY=请使用随机长密钥
DJANGO_ALLOWED_HOSTS=simlab.example.com
DJANGO_CSRF_TRUSTED_ORIGINS=https://simlab.example.com
SIMLAB_RUNTIME_MODE=runtime_real
DATABASE_URL=postgresql://simlab:数据库密码@127.0.0.1:5432/simlab
REDIS_URL=redis://127.0.0.1:6379/0
CELERY_BROKER_URL=redis://127.0.0.1:6379/0
CHANNEL_REDIS_URL=redis://127.0.0.1:6379/1
EVENT_STREAM_REDIS_URL=redis://127.0.0.1:6379/2
SIMLAB_HOST_AGENT_SOCKET=/run/simlab/host-agent.sock
```

若只进行界面和领域模拟，将设置改为
`DJANGO_SETTINGS_MODULE=config.settings.local` 与 `SIMLAB_RUNTIME_MODE=development_mock`。
`development_mock` 必须在页面和验收记录中保持明确标注，不能作为真实 Runtime 结果。

## 5. 安装并启动后端

```bash
cd /opt/simlab/simlab-backend-source-20261005
python3 -m venv .venv
. .venv/bin/activate
pip install --upgrade pip
pip install -r backend/requirements/production.lock.txt
set -a
. ./.env
set +a
python backend/manage.py migrate
python backend/manage.py check
```

首次部署必须创建管理员账户，然后登录 `/admin/` 创建教师或学生账户；也可以继续使用下方
`seed_demo` 创建本地演示账户：

```bash
python backend/manage.py createsuperuser
```

用户登录 Web 后只能看到自己拥有或被授权的实验。OWNER 可在“实验库 → 当前实验成员”中按
用户名授予 EDITOR 或 VIEWER 权限。生产环境禁止共用一个演示账户。

开发模拟模式可以创建演示账号：

```bash
read -rsp '演示账号密码: ' SIMLAB_DEMO_PASSWORD && echo
export SIMLAB_DEMO_PASSWORD
python backend/manage.py seed_demo
```

后端必须使用 ASGI 服务器，因为拓扑事件和 VNC 中继都需要 WebSocket：

```bash
cd backend
../.venv/bin/uvicorn config.asgi:application --host 127.0.0.1 --port 8000
```

另开三个服务进程：

```bash
cd /opt/simlab/simlab-backend-source-20261005
set -a; . ./.env; set +a
.venv/bin/celery -A config --workdir backend worker -l INFO
.venv/bin/python backend/manage.py run_outbox_dispatcher
.venv/bin/python backend/manage.py run_event_relay
```

生产部署应把以上四个进程分别配置成 systemd 服务，并设置 `Restart=on-failure`。API、Worker、
Outbox 和 Event Relay 必须读取同一份 `.env`。不要使用 `manage.py runserver` 承载 WebSocket。

## 6. 构建并发布前端

```bash
cd /opt/simlab/simlab-web-source-20261005/web
npm ci
VITE_SIMLAB_API_ORIGIN=http://127.0.0.1:8000 \
VITE_SIMLAB_NOVNC_ORIGIN=http://127.0.0.1:6080 \
npm run build
sudo install -d -o root -g root -m 0755 /var/www/simlab
sudo cp -a dist/. /var/www/simlab/
```

Vite 的生产构建为静态文件。前端和 API 推荐放在同一域名下，由 Nginx代理 `/api`、`/ws`、
`/novnc` 与 `/g0-novnc`，这样浏览器不会遇到跨域 Cookie 与 WebSocket 限制。

Nginx 示例：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name simlab.example.com;
    root /var/www/simlab;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }

    location /novnc/ {
        proxy_pass http://127.0.0.1:6080/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
    }

    location /g0-novnc/ {
        proxy_pass http://127.0.0.1:6080/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
    }
}
```

启用 HTTPS 后，把 `listen 80` 改为 TLS 配置，并确保 `.env` 中的
`DJANGO_CSRF_TRUSTED_ORIGINS` 使用相同的 `https://` 域名。VNC 和 WebSocket 也必须通过同一
TLS 入口，不能把 5900、6080 或宿主控制 Socket 直接暴露到公网。

## 7. 真实 PC/笔记本 Runtime

在 Runtime Host 上依次执行：

```bash
sudo ops/linux/install_runtime.sh
sudo ops/linux/fetch_g0_image.sh
sudo ops/linux/install_host_agent.sh
sudo usermod -aG simlab <运行 API 和 Worker 的系统用户>
```

重新登录服务账号后检查：

```bash
systemctl status simlab-host-agent --no-pager
stat -c '%U %G %a %n' /run/simlab/host-agent.sock
python3 ops/linux/preflight.py --json /tmp/simlab-preflight.json
```

控制平面与 Host Agent 的已有虚拟机白名单应一致：

```dotenv
SIMLAB_EXTERNAL_DOMAINS=simlab-g0-pc1,simlab-g0-pc2
SIMLAB_DESKTOP_EXTERNAL_DOMAINS=simlab-g0-pc1,simlab-g0-pc2
SIMLAB_NETWORK_EXTERNAL_DOMAINS=vendor-sw:switch,vendor-router:router,vendor-fw:firewall
SIMLAB_DESKTOP_RUNTIME_BRIDGE_ENABLED=1
SIMLAB_DESKTOP_NOVNC_BASE_URL=/novnc/vnc.html
```

更新桌面网口接线代码后，重启 Host Agent 和 API/Worker 进程以加载 `WIRE_PORT` 动作：

```bash
sudo systemctl restart simlab-host-agent
```

底部设备调试终端的真实 CLI 使用 `/run/simlab/console.sock`。Host Agent 与 API
须使用同一版源码；升级已有部署后重启 `simlab-host-agent` 和 `simlab-api`，
并确认 `/run/simlab/console.sock` 存在且 API 用户属于 `simlab` 组。
已绑定、开机的设备会连接其客体串口；未绑定设备显示 `development_mock` 模拟 CLI。
`ubuntu-noble-20260725` 是 PC/笔记本的教学基础镜像；网络设备没有默认系统镜像，
厂商 CLI 取决于导入的镜像以及镜像中的串口登录配置。

Web 中的 RJ45 网线保存到服务器实验时，Command 服务按前端模块端口名找到绑定的
`ethN` 虚拟网卡，并将运行中的 TAP 接入对应隔离 OVS 网段；拔线会关闭网卡载波。
未绑定真实 VM 的交换机可沿用原有同 VLAN 宿主 OVS 教学转发；绑定 VM 的交换机
各接口接入独立网段，由客体内的桥转发。路由器和防火墙也可绑定真实 VM，客体内
路由和策略需按实验自行配置；设备面板会显示网口的实际接线状态。虚拟机从宿主机侧
重新启动后，刷新平台虚拟机资源池会重新接线。

镜像、overlay、UEFI NVRAM 和虚拟机运行目录必须存放在 `/var/lib/simlab` 等受控运行目录，
不要放入源码目录或源码包。详细边界见 `docs/runbooks/host-agent.md` 和
`docs/runbooks/runtime-g0.md`。

交换机、路由器、防火墙的通用 Linux VM 与已有厂商 domain 绑定方式见
[`docs/runbooks/network-appliances.md`](docs/runbooks/network-appliances.md)。
管理员也可在网络节点创建表单直接上传符合当前 x86_64/UEFI/virtio 模板的独立 qcow2；
部署脚本为上传创建 `/var/lib/simlab/image-store/imported` 并设置单请求上限。
上传镜像仍须逐镜像验收，详细格式、容量与权限见上述运行手册。
如需按设备型号自动发现候选，可将只读 qcow2 放入
`/var/lib/simlab/image-store/vendor/<厂商>/<厂商>-<switch|router|firewall>-<型号版本>/*.qcow2`，
例如 `vendor/Ruijie/ruijie-router-rsr20-v2/router-disk.qcow2`；每个候选目录须恰有一个
`.qcow2` 文件并可由 `simlab-app` 读取。创建表单按厂商和类型显示候选，管理员登记后
用户手动选择详细镜像。
更新已有部署时先执行 Django 数据库迁移，再重启 API/Worker。

## 8. 验证

后端：

```bash
curl -fsS http://127.0.0.1:8000/api/v1/health/live/
.venv/bin/python backend/manage.py check
.venv/bin/python -m pytest -q
```

前端：

```bash
cd web
npm run typecheck
npm test
npm run build
```

浏览器验收步骤：

1. 首次打开登录页，使用服务器账户登录，确认场景中没有预置设备。
2. 从设备目录单击或拖入一台非计算设备，移动设备并修改端口配置。
3. 打开“实验库”，命名并保存；新建空白实验后再载入，核对位置、端口、线缆与标签。
4. 使用另一个未授权账户登录，确认无法看到该实验；授权 VIEWER 后确认可读取但不能保存。
5. 打开“画质/光照”，切换低画质，确认仍能移动镜头与操作设备；再按客户端能力调高。
6. 创建 PC/笔记本时确认已关机且空闲的 virsh 域可选择，并验证“暂不绑定”和“创建新虚拟机”。
7. 对已绑定的 PC/笔记本开机，确认三维小屏和放大窗口复用同一 noVNC 会话。

## 9. 备份、更新与回滚

- 定期使用 `pg_dump` 备份 PostgreSQL；Redis 可重建，不能代替数据库备份。
- 实验文档与成员权限保存在 PostgreSQL，应与其他控制平面表一起使用 `pg_dump` 备份。旧版
  浏览器实验只有在首次登录迁移完成前仍依赖站点 `localStorage`。
- 更新前保留旧的前端静态目录和源码包，先执行迁移和测试，再原子切换 Nginx 的静态目录。
- 回滚应用代码时不要回滚或删除 PostgreSQL 数据。涉及迁移的版本应先核对迁移兼容性。
- `release/SHA256SUMS` 用于确认源码包传输完整性：

```bash
sha256sum -c SHA256SUMS
```
