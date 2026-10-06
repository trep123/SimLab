# Outbox、Redis Streams 与 WebSocket 运行手册

## 数据路径

```text
PostgreSQL/SQLite Event + Outbox
  → run_outbox_dispatcher
  → Redis Stream DB 2
  → run_event_relay consumer group
  → channels_redis DB 1
  → 鉴权 ASGI WebSocket
```

数据库中的 `ExperimentEvent` 是权威记录。Redis 重启、重复 XADD、relay 在发送和 ACK
之间退出，都不会改变事件序号；客户端按 `experiment_id + seq + generation` 去重。Outbox
只有在 XADD 成功后才写 `published_at`。

## 启动

本机 Redis：

```bash
sudo systemctl enable --now redis-server
redis-cli ping
```

控制平面环境至少配置：

```text
CELERY_BROKER_URL=redis://127.0.0.1:6379/0
CHANNEL_REDIS_URL=redis://127.0.0.1:6379/1
EVENT_STREAM_REDIS_URL=redis://127.0.0.1:6379/2
SIMLAB_EVENT_STREAM_KEY=simlab:events:v1
SIMLAB_EVENT_STREAM_GROUP=simlab-event-relay-v1
SIMLAB_CHANNEL_PREFIX=simlab
```

长期进程分别启动：

```bash
.venv/bin/python backend/manage.py run_outbox_dispatcher
.venv/bin/python backend/manage.py run_event_relay
```

Compose 已包含 `outbox` 和 `eventrelay` 独立服务。生产环境仍使用 PostgreSQL；SQLite
只用于本机开发和探测。

## 重连与补齐

WebSocket 接受连接后返回 `subscription.ready`，包含 `latest_seq`、`generation` 和
`control_epoch`；连接期间每 10 秒发送一次 `subscription.cursor`。浏览器发现序号缺口、
更高 generation 或尾部游标领先时，通过事件 API 的 `after_seq` 读取持久记录并刷新状态。

```text
GET /api/v1/experiments/<experiment_id>/events/?after_seq=<last_seq>
```

## 验证

三个独立 Redis/Channels 进程：

```bash
.venv/bin/python ops/linux/event_pipeline_probe.py
```

真实 Uvicorn、Django Session WebSocket、断线和 REST 补齐：

```bash
.venv/bin/python ops/linux/websocket_pipeline_probe.py
```

证据分别写入 `docs/poc/event-pipeline-evidence.json` 和
`docs/poc/websocket-pipeline-evidence.json`。探测使用随机 Stream、consumer group 和
Channels prefix，结束时只删除本次探测的 Redis key 和数据库对象。
