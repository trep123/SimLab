# SimLab 开发约束

- 以 `3D_NETWORK_SIMLAB_TASKBOOK.md` 与 `rule.md` 为规范来源。
- Python 业务代码使用 Django ORM，不引入第二套 ORM；前端启用 TypeScript strict。
- `development_mock` 仅供界面和领域测试，任何页面及证据都必须明确显示其保真度。
- 未通过 `ops/linux/preflight.py` 时不得宣称真实 Runtime 已验收。
- 镜像、密钥、overlay、PCAP 和运行时数据不得提交。
- 改动状态必须经过 Command 服务；视图不得直接操作 Runtime。
- 用户可见文字优先使用中文，错误需包含稳定错误码与可执行建议。
