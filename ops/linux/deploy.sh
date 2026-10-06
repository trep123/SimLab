#!/usr/bin/env bash
# 在 Ubuntu/Debian 单机安装 Web、控制平面和可选的真实 Runtime。
set -euo pipefail

readonly PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_MODE=mock
DOMAIN=localhost
TLS_CERT=
TLS_KEY=
CHECK_ONLY=0

usage() {
  cat <<'EOF'
用法：sudo bash ops/linux/deploy.sh [--mode mock|real] [--domain 主机名或IP] \
  [--tls-cert 证书绝对路径 --tls-key 私钥绝对路径] [--check]

mock：安装完整 Web/API/数据库，但所有 Runtime 结果明确标为 development_mock。
real：安装 KVM/libvirt/OVS/Host Agent；必须提供域名、TLS 证书和私钥。
--check：只检查当前源码、平台和现有工具版本，不修改服务器。
首次部署后运行 sudo -u simlab-app /opt/simlab/.../.venv/bin/python .../manage.py createsuperuser。
EOF
}

fail() {
  printf 'DEPLOY_%s: %s\n' "$1" "$2" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --mode) (($# >= 2)) || fail ARGUMENT "--mode 缺少值"; DEPLOY_MODE=$2; shift 2 ;;
    --domain) (($# >= 2)) || fail ARGUMENT "--domain 缺少值"; DOMAIN=$2; shift 2 ;;
    --tls-cert) (($# >= 2)) || fail ARGUMENT "--tls-cert 缺少值"; TLS_CERT=$2; shift 2 ;;
    --tls-key) (($# >= 2)) || fail ARGUMENT "--tls-key 缺少值"; TLS_KEY=$2; shift 2 ;;
    --check) CHECK_ONLY=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail ARGUMENT "未知参数 $1；运行 --help 查看用法" ;;
  esac
done

[[ "$DEPLOY_MODE" == mock || "$DEPLOY_MODE" == real ]] || fail MODE "请选择 mock 或 real"
[[ "$DOMAIN" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || fail DOMAIN "域名或 IP 格式错误"
if [[ "$DEPLOY_MODE" == real ]]; then
  url_scheme=https
else
  url_scheme=http
fi
[[ -f "$PROJECT_ROOT/backend/manage.py" && -f "$PROJECT_ROOT/web/package-lock.json" ]] || \
  fail SOURCE "请从 simlab-full-source 包的根目录运行脚本，或把前后端包合并到同一目录"
[[ -f /etc/os-release ]] || fail PLATFORM "仅支持带 apt 的 Ubuntu/Debian Linux"
# shellcheck disable=SC1091
. /etc/os-release
[[ "$ID" == ubuntu || "$ID" == debian ]] || fail PLATFORM "当前只支持 Ubuntu/Debian"
[[ "$(uname -m)" == x86_64 ]] || fail PLATFORM "当前只支持 x86_64"

if [[ "$DEPLOY_MODE" == real ]]; then
  [[ "$DOMAIN" != localhost ]] || fail DOMAIN "真实模式请指定可访问域名"
  if ((CHECK_ONLY == 0)); then
    [[ "$TLS_CERT" == /* && "$TLS_KEY" == /* ]] || \
      fail TLS "真实模式必须提供 --tls-cert 和 --tls-key 的绝对路径"
    [[ -r "$TLS_CERT" && -r "$TLS_KEY" ]] || fail TLS "证书或私钥不可读，请检查路径"
  fi
fi

check_versions() {
  local python_major python_minor node_major
  command -v python3 >/dev/null || fail PYTHON "请先安装 Python 3.12 至 3.14"
  read -r python_major python_minor < <(python3 -c 'import sys; print(*sys.version_info[:2])')
  ((python_major == 3 && python_minor >= 12 && python_minor <= 14)) || \
    fail PYTHON "需要 Python 3.12 至 3.14，当前是 ${python_major}.${python_minor}"
  command -v node >/dev/null || fail NODE "请先安装 Node.js 22 或更高的受支持 LTS 版本"
  node_major=$(node --version | sed -E 's/^v([0-9]+).*/\1/')
  ((node_major >= 22)) || fail NODE "需要 Node.js 22+，当前是 $(node --version)"
  command -v npm >/dev/null || fail NPM "请安装与 Node.js 配套的 npm"
}

install_node_if_needed() {
  # Ubuntu 发行版仓库的 Node.js 版本可能过旧；固定从官方 v22 LTS 目录取包并验 SHA-256。
  if command -v node >/dev/null && command -v npm >/dev/null; then
    local installed_major
    installed_major=$(node --version | sed -E 's/^v([0-9]+).*/\1/')
    if ((installed_major >= 22)); then
      return
    fi
  fi
  local checksum_file archive_name expected_hash install_directory
  checksum_file=$(mktemp)
  curl --fail --location --retry 4 --silent --show-error \
    https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$checksum_file"
  archive_name=$(awk '$2 ~ /^node-v22\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ {print $2; exit}' \
    "$checksum_file")
  [[ -n "$archive_name" ]] || fail NODE_DOWNLOAD "官方 Node.js v22 校验清单中未找到 x64 包"
  expected_hash=$(awk -v archive="$archive_name" '$2 == archive {print $1; exit}' "$checksum_file")
  rm -f "$checksum_file"
  [[ "$expected_hash" =~ ^[0-9a-f]{64}$ ]] || fail NODE_HASH "Node.js 校验值无效"
  install_directory="/opt/simlab/toolchain/${archive_name%.tar.xz}"
  if [[ ! -x "$install_directory/bin/node" ]]; then
    install -d -m 0755 /opt/simlab/toolchain
    curl --fail --location --retry 4 --silent --show-error \
      "https://nodejs.org/dist/latest-v22.x/$archive_name" \
      -o "/opt/simlab/toolchain/$archive_name"
    printf '%s  %s\n' "$expected_hash" "/opt/simlab/toolchain/$archive_name" | \
      sha256sum --check --strict || fail NODE_HASH "Node.js 包校验失败；请删除下载文件后重试"
    tar -xJf "/opt/simlab/toolchain/$archive_name" -C /opt/simlab/toolchain
    rm -f "/opt/simlab/toolchain/$archive_name"
  fi
  for executable in node npm npx; do
    ln -sfn "$install_directory/bin/$executable" "/usr/local/bin/$executable"
  done
  hash -r
}

if ((CHECK_ONLY)); then
  check_versions
  printf 'DEPLOY_CHECK_OK: 源码、平台、Python 和 Node.js 满足部署前置条件\n'
  if [[ "$DEPLOY_MODE" == real ]]; then
    python3 "$PROJECT_ROOT/ops/linux/preflight.py" || \
      fail RUNTIME_PREFLIGHT "真实 Runtime 预检未通过；安装宿主依赖后重试"
  fi
  exit 0
fi

((EUID == 0)) || fail ROOT "请使用 sudo 运行部署脚本"
[[ "$PROJECT_ROOT" == /opt/* ]] || \
  fail LOCATION "请将源码解压到 /opt 下的永久目录后再运行；systemd 会引用该目录"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y python3 python3-venv python3-pip postgresql redis-server \
  nginx novnc curl ca-certificates openssl xz-utils
install_node_if_needed
check_versions

systemctl enable --now postgresql redis-server
if [[ "$DEPLOY_MODE" == real ]]; then
  bash "$PROJECT_ROOT/ops/linux/install_runtime.sh"
  python3 "$PROJECT_ROOT/ops/linux/preflight.py" || \
    fail RUNTIME_PREFLIGHT "真实 Runtime 预检未通过，不会启动真实模式"
  bash "$PROJECT_ROOT/ops/linux/fetch_g0_image.sh"
  bash "$PROJECT_ROOT/ops/linux/install_host_agent.sh"
  readonly appliance_password_file=/etc/simlab/appliance-console-password
  if [[ ! -f "$appliance_password_file" ]]; then
    openssl rand -base64 24 >"$appliance_password_file"
    chmod 0600 "$appliance_password_file"
  fi
  appliance_password_hash=$(openssl passwd -6 -stdin <"$appliance_password_file")
  printf 'SIMLAB_APPLIANCE_PASSWORD_HASH=%s\n' "$appliance_password_hash" >> \
    /etc/simlab/host-agent.env
  systemctl restart simlab-host-agent.service
fi

getent group simlab >/dev/null || groupadd --system simlab
if ! getent passwd simlab-app >/dev/null; then
  useradd --system --home-dir /var/lib/simlab/app --create-home \
    --shell /usr/sbin/nologin --gid simlab simlab-app
fi
if [[ "$DEPLOY_MODE" == real ]]; then
  install -d -o simlab-app -g simlab -m 0755 /var/lib/simlab/image-store/imported
  install -d -o root -g simlab -m 0750 /var/lib/simlab/image-store/vendor
fi
if [[ "$DEPLOY_MODE" == real ]]; then
  usermod -aG simlab simlab-app
fi
runuser -u simlab-app -- test -r "$PROJECT_ROOT/backend/manage.py" || \
  fail SOURCE_ACCESS "simlab-app 无法读取源码；请把源码放在权限为 0755 的 /opt 目录"

readonly ENV_DIRECTORY=/etc/simlab
readonly ENV_FILE="$ENV_DIRECTORY/app.env"
install -d -o root -g simlab -m 0750 "$ENV_DIRECTORY"
if [[ -f "$ENV_FILE" ]]; then
  # 只读取管理员维护的受限配置，重复部署保持密钥和数据库密码稳定。
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  [[ "${SIMLAB_DEPLOY_MODE:-}" == "$DEPLOY_MODE" && "${DJANGO_ALLOWED_HOSTS:-}" == "$DOMAIN" ]] || \
    fail EXISTING_CONFIG "已部署配置的模式或域名不同；先备份并调整 $ENV_FILE"
  database_password=${POSTGRES_PASSWORD:-}
  [[ "$database_password" =~ ^[0-9a-f]{48}$ ]] || \
    fail EXISTING_CONFIG "现有数据库密码不是脚本生成的格式；请检查 $ENV_FILE"
else
  database_password=$(openssl rand -hex 24)
  django_secret=$(openssl rand -hex 48)
  if [[ "$DEPLOY_MODE" == real ]]; then
    django_settings=config.settings.production
    runtime_mode=runtime_real
  else
    django_settings=config.settings.local
    runtime_mode=development_mock
  fi
  cat >"$ENV_FILE" <<EOF
SIMLAB_DEPLOY_MODE=$DEPLOY_MODE
DJANGO_SETTINGS_MODULE=$django_settings
DJANGO_SECRET_KEY=$django_secret
DJANGO_ALLOWED_HOSTS=$DOMAIN
DJANGO_CSRF_TRUSTED_ORIGINS=$url_scheme://$DOMAIN
SIMLAB_RUNTIME_MODE=$runtime_mode
SIMLAB_DESKTOP_RUNTIME_BRIDGE_ENABLED=1
SIMLAB_DESKTOP_EXTERNAL_DOMAINS=
SIMLAB_NETWORK_EXTERNAL_DOMAINS=
SIMLAB_CLOUD_UPLINK_BRIDGES=
SIMLAB_IMAGE_IMPORT_ROOT=/var/lib/simlab/image-store/imported
SIMLAB_VENDOR_IMAGE_ROOT=/var/lib/simlab/image-store/vendor
SIMLAB_DESKTOP_NOVNC_BASE_URL=/novnc/vnc.html
SIMLAB_HOST_AGENT_SOCKET=/run/simlab/host-agent.sock
SIMLAB_HOST_AGENT_CONSOLE_SOCKET=/run/simlab/console.sock
SIMLAB_STATIC_ROOT=/var/lib/simlab/app/static
POSTGRES_PASSWORD=$database_password
DATABASE_URL=postgresql://simlab:$database_password@127.0.0.1:5432/simlab
REDIS_URL=redis://127.0.0.1:6379/0
CELERY_BROKER_URL=redis://127.0.0.1:6379/0
CHANNEL_REDIS_URL=redis://127.0.0.1:6379/1
EVENT_STREAM_REDIS_URL=redis://127.0.0.1:6379/2
PYTHONPATH=$PROJECT_ROOT:$PROJECT_ROOT/backend
EOF
  chown root:simlab "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
fi

if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='simlab'" | grep -qx 1; then
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 -c \
    "CREATE ROLE simlab LOGIN PASSWORD '$database_password'"
else
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 -c \
    "ALTER ROLE simlab PASSWORD '$database_password'"
fi
if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='simlab'" | grep -qx 1; then
  runuser -u postgres -- createdb -O simlab simlab
fi

if [[ ! -d "$PROJECT_ROOT/.venv" ]]; then
  python3 -m venv "$PROJECT_ROOT/.venv"
  chown -R simlab-app:simlab "$PROJECT_ROOT/.venv"
fi
runuser -u simlab-app -- "$PROJECT_ROOT/.venv/bin/python" -m pip install \
  -r "$PROJECT_ROOT/backend/requirements/production.lock.txt"
runuser -u simlab-app -- bash -c \
  'set -a; . "$1"; set +a; "$2/.venv/bin/python" "$2/backend/manage.py" migrate --noinput; "$2/.venv/bin/python" "$2/backend/manage.py" check' \
  bash "$ENV_FILE" "$PROJECT_ROOT"

if [[ "$DEPLOY_MODE" == real ]]; then
  runuser -u simlab-app -- bash -c \
    'set -a; . "$1"; set +a; "$2/.venv/bin/python" "$2/backend/manage.py" register_runtime_catalog' \
    bash "$ENV_FILE" "$PROJECT_ROOT"
fi

(
  cd "$PROJECT_ROOT/web"
  npm ci
  npm run build
)
install -d -o root -g root -m 0755 /var/www/simlab
cp -a "$PROJECT_ROOT/web/dist/." /var/www/simlab/
runuser -u simlab-app -- bash -c \
  'set -a; . "$1"; set +a; "$2/.venv/bin/python" "$2/backend/manage.py" collectstatic --noinput' \
  bash "$ENV_FILE" "$PROJECT_ROOT"
install -d -o root -g root -m 0755 /var/www/simlab/static
cp -a /var/lib/simlab/app/static/. /var/www/simlab/static/

for service_name in api worker outbox eventrelay; do
  case "$service_name" in
    api) command_line="$PROJECT_ROOT/.venv/bin/uvicorn config.asgi:application --host 127.0.0.1 --port 8000" ;;
    worker) command_line="$PROJECT_ROOT/.venv/bin/celery -A config worker -l INFO" ;;
    outbox) command_line="$PROJECT_ROOT/.venv/bin/python manage.py run_outbox_dispatcher" ;;
    eventrelay) command_line="$PROJECT_ROOT/.venv/bin/python manage.py run_event_relay" ;;
  esac
  cat >"/etc/systemd/system/simlab-$service_name.service" <<EOF
[Unit]
Description=SimLab $service_name
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=simlab-app
Group=simlab
WorkingDirectory=$PROJECT_ROOT/backend
EnvironmentFile=$ENV_FILE
ExecStart=$command_line
Restart=on-failure
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
done

cat >/etc/nginx/conf.d/simlab-websocket.conf <<'EOF'
map $http_upgrade $simlab_connection_upgrade {
    default upgrade;
    '' close;
}
EOF
if [[ "$DEPLOY_MODE" == real ]]; then
  nginx_listeners="listen 443 ssl;\n    ssl_certificate $TLS_CERT;\n    ssl_certificate_key $TLS_KEY;"
  cat >/etc/nginx/sites-available/simlab-redirect <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}
EOF
  ln -sfn /etc/nginx/sites-available/simlab-redirect /etc/nginx/sites-enabled/simlab-redirect
else
  nginx_listeners='listen 80;'
  rm -f /etc/nginx/sites-enabled/simlab-redirect
fi
cat > /etc/nginx/sites-available/simlab <<EOF
server {
    $(printf '%b' "$nginx_listeners")
    server_name $DOMAIN;
    root /var/www/simlab;
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }
    location = /api/v1/runtime/images/import/ {
        client_max_body_size 8200m;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
    location /admin/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
    location /ws/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$simlab_connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
    }
    location /novnc/ {
        alias /usr/share/novnc/;
    }
    location /static/ {
        alias /var/www/simlab/static/;
    }
}
EOF
ln -sfn /etc/nginx/sites-available/simlab /etc/nginx/sites-enabled/simlab
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl daemon-reload
for service_name in api worker outbox eventrelay; do
  systemctl enable --now "simlab-$service_name.service"
  systemctl restart "simlab-$service_name.service"
done
systemctl enable --now nginx
systemctl reload nginx
health_ready=0
for attempt in $(seq 1 30); do
  health_status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
    -H "Host: $DOMAIN" -H "X-Forwarded-Proto: $url_scheme" \
    http://127.0.0.1:8000/api/v1/health/live/ || true)
  if [[ "$health_status" == 200 ]]; then
    health_ready=1
    break
  fi
  sleep 1
done
((health_ready == 1)) || fail HEALTH \
  "API 健康检查失败；查看 journalctl -u simlab-api -n 100"
printf 'DEPLOY_OK: Web 与 API 已部署，模式=%s，入口=%s://%s\n' \
  "$DEPLOY_MODE" "$([[ "$DEPLOY_MODE" == real ]] && printf https || printf http)" "$DOMAIN"
printf '首次使用请创建管理员：sudo -u simlab-app bash -c '\''set -a; . /etc/simlab/app.env; set +a; %s/.venv/bin/python %s/backend/manage.py createsuperuser'\''\n' \
  "$PROJECT_ROOT" "$PROJECT_ROOT"
if [[ "$DEPLOY_MODE" == mock ]]; then
  printf '保真度：development_mock（仅界面与领域模拟，不能作为真实 Runtime 验收）\n'
fi
