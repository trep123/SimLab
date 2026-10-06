
# 1. 命名规约

## 1.1 通用命名

- **〖强制〗** 命名必须使用有意义的英文单词，禁止拼音、中文、无意义缩写。
- **〖强制〗** 禁止使用单字符命名，循环变量 `i`、`j`、`k` 除外。
- **〖强制〗** 禁止使用 Python 关键字、内置函数名作为变量名，如 `list`、`dict`、`str`、`id`、`type`。
- **〖推荐〗** 布尔变量使用 `is_`、`has_`、`can_`、`should_` 前缀。
- **〖推荐〗** 私有属性或方法使用单下划线 `_` 前缀；名称修饰使用双下划线 `__` 前缀，但慎用。

## 1.2 模块与包

- **〖强制〗** 模块名、包名使用小写字母，单词间用下划线分隔，如 `user_service.py`、`data_utils/`。
- **〖强制〗** 包名使用单数形式，如 `model` 而非 `models`，团队统一后可例外。
- **〖推荐〗** 模块名尽量简短，避免与标准库冲突，如 `json.py`、`types.py`。

## 1.3 类与异常

- **〖强制〗** 类名使用 `UpperCamelCase`，如 `UserService`、`HttpClient`。
- **〖强制〗** 异常类以 `Error` 或 `Exception` 结尾，如 `BusinessError`、`ConfigException`。
- **〖强制〗** 抽象基类以 `Base` 或 `Abstract` 开头，如 `BaseRepository`、`AbstractParser`。
- **〖推荐〗** 测试类以 `Test` 开头，如 `TestUserService`。

## 1.4 函数与变量

- **〖强制〗** 函数名、方法名、变量名使用 `snake_case`，如 `get_user_by_id`、`user_name`。
- **〖强制〗** 常量使用全大写下划线分隔，如 `MAX_RETRY_COUNT`、`DEFAULT_TIMEOUT`。
- **〖推荐〗** 函数名使用动词或动宾结构，如 `fetch_data`、`validate_input`。
- **〖推荐〗** 避免使用 `data`、`info`、`temp` 等模糊命名。

## 1.5 类型变量与泛型

- **〖强制〗** 类型变量使用 `UpperCamelCase`，如 `T`、`UserType`。
- **〖推荐〗** 类型变量尽量使用有意义的名称，如 `ResponseT`。
- **〖参考〗** 复杂泛型使用 `TypeVar`、`ParamSpec`、`TypeVarTuple`。

## 1.6 正例与反例

```python
# 正例
class UserService:
    MAX_RETRY_COUNT = 3

    def get_user_by_id(self, user_id: int) -> User | None:
        ...

# 反例
class userService:  # 类名未使用大驼峰
    maxRetryCount = 3  # 常量未全大写

def GetUser(id):  # 函数名未使用 snake_case，参数名无意义
    ...
```

---

# 2. 代码格式与风格

## 2.1 基础格式

- **〖强制〗** 每行代码不超过 100 个字符，推荐 88 字符。
- **〖强制〗** 文件末尾必须有一个空行。
- **〖强制〗** 禁止行尾多余空格。
- **〖强制〗** 使用 UTF-8 编码。
- **〖推荐〗** 使用 Ruff Format 或 Black 自动格式化，禁止手工调整格式。

## 2.2 空行

- **〖强制〗** 顶层函数、类之间空两行。
- **〖强制〗** 类内方法之间空一行。
- **〖推荐〗** 函数内逻辑块之间空一行。

## 2.3 运算符与空格

- **〖强制〗** 二元运算符两侧加空格，如 `a + b`、`x == y`。
- **〖强制〗** 逗号后加空格，如 `func(a, b, c)`。
- **〖强制〗** 冒号后加空格，如 `{"key": "value"}`。
- **〖推荐〗** 函数默认参数等号两侧不加空格，如 `def func(a=1)`。

## 2.4 正例与反例

```python
# 正例
def calculate_total(
    price: float,
    quantity: int,
    discount: float = 0.0,
) -> float:
    return price * quantity * (1 - discount)

# 反例
def calculate_total( price,quantity,discount = 0.0 ):
	return price*quantity*(1-discount)  # Tab 缩进，空格混乱
```

---

# 3. 导入规约

- **〖强制〗** 导入分为三组：标准库、第三方库、本地模块。组间空一行。
- **〖强制〗** 禁止使用 `from module import *`。
- **〖强制〗** 禁止在函数内导入，除非解决循环依赖或延迟加载重型模块。
- **〖强制〗** 导入必须放在文件顶部，位于模块 docstring 和 `__future__` 之后。
- **〖推荐〗** 使用绝对导入，避免隐式相对导入。
- **〖推荐〗** 按字母顺序排序，可使用 Ruff 或 isort 自动整理。

```python
# 正例
import os
import sys
from pathlib import Path

import httpx
from pydantic import BaseModel

from myproject.core.config import settings
from myproject.models.user import User
```

```python
# 反例
from myproject.models.user import *  # 禁止通配符导入
import sys, os  # 一行多个导入
```

---

# 4. 类型注解

- **〖强制〗** 注释必须使用中文进行注释
- **〖强制〗** 公共函数、方法必须注解参数类型和返回值类型。
- **〖强制〗** 禁止滥用 `Any`，使用 `Any` 必须写明原因。
- **〖强制〗** 可空类型使用 `X | None`，禁止使用 `Optional[X]` 混用。
- **〖强制〗** 容器类型必须标注元素类型，如 `list[str]`、`dict[str, int]`。
- **〖推荐〗** 使用 `mypy --strict` 或 `pyright` 严格模式。
- **〖推荐〗** 复杂结构使用 `TypedDict`、`dataclass`、`Protocol`、`TypeVar`。
- **〖参考〗** 公共 API 建议使用 `@overload` 提供重载签名。

```python
# 正例
def find_user(user_id: int) -> User | None:
    '''...'''
    ...

def process_items(items: list[dict[str, int]]) -> dict[str, int]:
    '''...'''
    ...

# 反例
def find_user(user_id):  # 缺少类型注解
    ...

def process_items(items: list) -> dict:  # 容器未标注元素类型
    ...
```

## 4.1 类型忽略

- **〖强制〗** 使用 `# type: ignore[code]` 必须指定错误码。
- **〖强制〗** 禁止无理由 `# type: ignore`。
- **〖推荐〗** 优先修复类型问题，而不是忽略。

---

# 5. 常量与枚举

- **〖强制〗** 禁止魔法值直接出现在代码中，必须定义为常量或枚举。
- **〖强制〗** 常量必须全大写，使用下划线分隔。
- **〖强制〗** 枚举使用 `enum.Enum` 或 `enum.IntEnum`，禁止使用散落的整数常量。
- **〖推荐〗** 常量按业务模块归类，不要全部堆放在一个文件。
- **〖推荐〗** 枚举成员命名使用全大写，值使用有意义的数据。

```python
# 正例
from enum import Enum

class OrderStatus(Enum):
    PENDING = "pending"
    PAID = "paid"
    CANCELLED = "cancelled"

MAX_RETRY_COUNT = 3
```

```python
# 反例
if status == 1:  # 魔法值
    ...
```

---

# 6. 变量与数据结构

- **〖强制〗** 变量在使用前必须初始化，禁止使用未定义变量。
- **〖强制〗** 禁止使用可变对象作为函数默认参数，如 `def func(items=[])`。
- **〖强制〗** 禁止在迭代过程中修改正在迭代的集合。
- **〖推荐〗** 优先使用 `list`、`dict`、`set`、`tuple` 内置类型，避免过度使用 `collections`。
- **〖推荐〗** 只读数据使用 `tuple` 或 `frozenset`。
- **〖推荐〗** 大集合使用生成器表达式，避免一次性构建大列表。
- **〖参考〗** 高性能场景可使用 `array`、`numpy`、`polars` 等。

```python
# 正例
def add_item(item: str, items: list[str] | None = None) -> list[str]:
    if items is None:
        items = []
    items.append(item)
    return items

# 反例
def add_item(item: str, items: list[str] = []) -> list[str]:  # 可变默认参数
    items.append(item)
    return items
```

## 6.1 None 判断

- **〖强制〗** 判断 `None` 必须使用 `is None` 或 `is not None`。
- **〖强制〗** 禁止使用 `== None`。
- **〖推荐〗** 使用 `if x:` 判断非空时，注意 `0`、`""`、`[]` 等假值。

## 6.2 拷贝

- **〖强制〗** 修改嵌套可变对象时必须明确使用深拷贝或浅拷贝。
- **〖推荐〗** 使用 `copy.deepcopy` 处理嵌套结构。
- **〖推荐〗** 优先使用不可变数据结构，减少拷贝。

---

# 7. 函数与方法

- **〖强制〗** 函数职责单一，禁止一个函数做多件不相关的事。
- **〖强制〗** 函数参数不宜过多，超过 5 个建议使用 dataclass 或配置对象。
- **〖强制〗** 禁止使用 `global` 修改全局变量。
- **〖推荐〗** 函数总行数不超过 50 行，圈复杂度不超过 10。
- **〖推荐〗** 优先使用纯函数，减少副作用。
- **〖推荐〗** 使用 `functools.lru_cache` 缓存纯函数结果。
- **〖参考〗** 高阶函数、装饰器必须保留原函数元信息，使用 `functools.wraps`。

```python
# 正例
from functools import wraps

def retry(times: int):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            for _ in range(times):
                try:
                    return func(*args, **kwargs)
                except Exception:
                    continue
            raise RuntimeError("retry failed")
        return wrapper
    return decorator
```

## 7.1 参数

- **〖强制〗** 禁止使用可变默认参数。
- **〖推荐〗** 使用关键字参数提升可读性。
- **〖推荐〗** 参数命名清晰，避免 `a`、`b`、`c`。
- **〖参考〗** 使用 `*` 强制关键字参数。

```python
def create_user(*, name: str, age: int) -> User:
    ...
```

## 7.2 返回值

- **〖强制〗** 函数返回值类型必须明确。
- **〖推荐〗** 避免返回 `None` 与其它类型混合，必要时使用 `Result` 模式。
- **〖推荐〗** 返回多个值时使用 `NamedTuple` 或 dataclass。

---

# 8. 面向对象与数据类

- **〖强制〗** 优先使用组合，避免过深的继承层次，继承不超过 3 层。
- **〖强制〗** 禁止在 `__init__` 中做耗时操作或 I/O。
- **〖强制〗** 重写 `__eq__` 必须同时重写 `__hash__`，或显式设为不可哈希。
- **〖推荐〗** 数据载体优先使用 `@dataclass`、`NamedTuple`、`pydantic.BaseModel`。
- **〖推荐〗** 使用 `__slots__` 减少内存占用，但注意继承影响。
- **〖推荐〗** 使用 `@property` 封装属性访问，避免直接暴露可变内部状态。
- **〖参考〗** 使用 `abc.ABC` 定义抽象基类，明确接口契约。

```python
# 正例
from dataclasses import dataclass

@dataclass(frozen=True)
class User:
    id: int
    name: str
    email: str
```

## 8.1 魔术方法

- **〖强制〗** 重写魔术方法必须符合 Python 语义。
- **〖推荐〗** `__repr__` 必须返回可读字符串，便于调试。
- **〖推荐〗** `__str__` 用于用户展示，`__repr__` 用于开发者调试。

---

# 9. 控制语句

- **〖强制〗** 禁止在 `if`、`while`、`for` 条件中赋值，除非使用海象运算符且语义清晰。
- **〖强制〗** `for...else`、`while...else` 必须加注释说明，否则禁止使用。
- **〖强制〗** 禁止使用 `==` 与 `True`、`False`、`None` 比较，应使用 `is`。
- **〖推荐〗** 使用卫语句减少嵌套，嵌套不超过 4 层。
- **〖推荐〗** 多分支使用 `match-case` 或字典映射，避免长 `if-elif` 链。
- **〖推荐〗** 循环内避免重复计算不变表达式。

```python
# 正例
def get_discount(user: User) -> float:
    if not user.is_active:
        return 0.0
    if user.is_vip:
        return 0.2
    return 0.05

# 反例
if user.is_active == True:  # 应使用 is True 或直接 if user.is_active
    ...
```

---

# 10. 异常处理

- **〖强制〗** 禁止裸 `except:`，必须捕获具体异常。
- **〖强制〗** 禁止 `except Exception: pass`，捕获后必须处理、记录或重新抛出。
- **〖强制〗** 重新抛出异常必须使用 `raise ... from e` 保留异常链。
- **〖强制〗** 禁止用异常做流程控制。
- **〖强制〗** `finally` 中禁止使用 `return`、`break`、`continue`。
- **〖推荐〗** 自定义异常继承自项目基础异常，再继承自 `Exception`。
- **〖推荐〗** 对外接口统一异常转换，避免泄露内部堆栈。

```python
# 正例
try:
    result = fetch_data()
except httpx.HTTPError as e:
    logger.exception("fetch data failed")
    raise ServiceError("fetch data failed") from e
```

```python
# 反例
try:
    result = fetch_data()
except:  # 裸 except
    pass  # 吞异常
```

## 10.1 自定义异常

- **〖强制〗** 项目必须定义基础异常类，如 `AppError`。
- **〖推荐〗** 业务异常携带错误码与上下文。
- **〖推荐〗** 异常信息避免泄露敏感数据。

```python
class AppError(Exception):
    """项目基础异常。"""

class BusinessError(AppError):
    """业务异常。"""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"[{code}] {message}")
```

---

# 11. 日志规约

- **〖强制〗** 使用 `logging` 模块，禁止使用 `print` 输出业务日志。
- **〖强制〗** 日志必须使用占位符延迟格式化，禁止 f-string 直接拼接。
- **〖强制〗** 禁止记录敏感信息，如密码、密钥、身份证、银行卡。
- **〖强制〗** 异常日志必须使用 `logger.exception` 或 `logger.error(..., exc_info=True)`。
- **〖推荐〗** 使用结构化日志，如 `structlog` 或 JSON 格式。
- **〖推荐〗** 日志级别使用规范：DEBUG、INFO、WARNING、ERROR、CRITICAL。
- **〖推荐〗** 生产环境禁止输出 DEBUG 日志。

```python
# 正例
logger.info("user login success: user_id=%s", user_id)
logger.exception("process order failed: order_id=%s", order_id)

# 反例
print(f"user login success: {user_id}")  # 禁止 print
logger.info(f"user login success: {user_id}")  # 日志不应使用 f-string
```

## 11.1 日志配置

- **〖强制〗** 日志配置集中管理，禁止散落在业务代码中。
- **〖推荐〗** 使用 `dictConfig` 或 `structlog` 配置。
- **〖推荐〗** 日志输出到 stdout/stderr，由容器或平台收集。

---

# 12. 注释与文档

- **〖强制〗** 注释必须使用中文进行注释
- **〖强制〗** 文件的开头添加注释

```python
#!/usr/bin/env python
# -*- coding: utf-8 -*-
# @Time : 2026-09-01 10:00
# @Author : Cetrp
# @File : example.py
# @Description : This script demonstrates Python file header comments
```
- **〖强制〗** 公共模块、类、函数必须写 docstring。
- **〖强制〗** docstring 使用 Google 风格或 NumPy 风格，团队统一。
- **〖强制〗** 注释必须与代码同步更新，禁止过期注释。
- **〖推荐〗** 复杂逻辑、边界条件、算法来源必须注释说明。
- **〖推荐〗** 使用 `# TODO:`、`# FIXME:` 标注待办，并注明负责人或 issue。
- **〖参考〗** 使用 MkDocs + mkdocstrings 自动生成 API 文档。

```python
def divide(a: float, b: float) -> float:
    """计算两个数的商。

    Args:
        a: 被除数。
        b: 除数，不能为 0。

    Returns:
        两数相除的结果。

    Raises:
        ZeroDivisionError: 当 b 为 0 时抛出。
    """
    if b == 0:
        raise ZeroDivisionError("b must not be zero")
    return a / b
```

## 12.1 README 与 CHANGELOG

- **〖强制〗** 项目根目录必须有 `README.md`。
- **〖推荐〗** README 包含：项目简介、安装、使用、配置、开发、测试、许可证。
- **〖推荐〗** 使用 `CHANGELOG.md` 记录版本变更。
- **〖参考〗** 使用 `commitizen` 自动生成 CHANGELOG。

---

# 13. 单元测试

- **〖强制〗** 新代码必须包含单元测试，核心逻辑覆盖率不低于 80%。
- **〖强制〗** 测试必须独立、可重复、无外部依赖，遵循 AIR 原则。
- **〖强制〗** 禁止测试之间相互依赖执行顺序。
- **〖强制〗** 禁止在测试中使用固定 `sleep`，使用超时或事件等待。
- **〖推荐〗** 使用 `pytest`，遵循 AAA 模式：Arrange、Act、Assert。
- **〖推荐〗** 使用 `pytest.mark.parametrize` 参数化测试。
- **〖推荐〗** 使用 `fixture` 管理测试资源，使用 `mock` 隔离外部依赖。
- **〖推荐〗** 测试文件放在 `tests/`，与被测模块结构对应。

```python
# 正例
import pytest

@pytest.mark.parametrize(
    ("a", "b", "expected"),
    [(1, 2, 3), (0, 0, 0), (-1, 1, 0)],
)
def test_add(a: int, b: int, expected: int) -> None:
    assert add(a, b) == expected
```

## 13.1 测试命名

- **〖强制〗** 测试文件命名 `test_*.py`。
- **〖强制〗** 测试函数命名 `test_*`。
- **〖推荐〗** 测试名称描述行为，如 `test_login_with_invalid_password_raises_error`。

## 13.2 测试隔离

- **〖强制〗** 测试不得依赖真实数据库、网络、文件系统，必要时使用sqlite。
- **〖推荐〗** 使用 `tmp_path` 管理临时文件。
- **〖推荐〗** 使用 `respx`、`responses` 模拟 HTTP。

---

# 14. 安全规约

- **〖强制〗** 禁止硬编码密码、密钥、Token，使用环境变量或密钥管理服务。
- **〖强制〗** 禁止使用 `eval`、`exec` 执行不可信输入。
- **〖强制〗** 禁止使用 `pickle` 反序列化不可信数据。
- **〖强制〗** YAML 解析必须使用 `yaml.safe_load`。
- **〖强制〗** SQL 必须参数化，禁止字符串拼接。
- **〖强制〗** 用户输入必须校验、过滤、转义。
- **〖强制〗** 文件上传必须校验类型、大小、路径，防止路径穿越。
- **〖强制〗** 对外接口必须做权限校验、频率限制、防重放。
- **〖推荐〗** 使用 `bandit`、`pip-audit`、`gitleaks` 扫描安全风险。
- **〖推荐〗** 密码使用 `bcrypt`、`argon2` 哈希，禁止明文或 MD5。

```python
# 正例
import yaml

data = yaml.safe_load(stream)
```

```python
# 反例
import pickle

obj = pickle.loads(untrusted_data)  # 危险
```

## 14.1 密钥管理

- **〖强制〗** 密钥不得出现在代码、配置、日志、Git 历史中。
- **〖推荐〗** 使用 Vault、AWS Secrets Manager、KMS 等管理密钥。
- **〖推荐〗** 使用 `.env.example` 提供配置模板，不提交 `.env`。

## 14.2 依赖安全

- **〖强制〗** CI 必须执行依赖漏洞扫描。
- **〖推荐〗** 定期升级依赖，修复高危漏洞。
- **〖推荐〗** 锁定依赖版本，避免供应链攻击。

---

# 15. 并发与异步

- **〖强制〗** 禁止手动创建大量线程，必须使用线程池或进程池。
- **〖强制〗** 线程池必须指定有意义的线程名前缀。
- **〖强制〗** 多线程共享可变状态必须加锁，锁顺序必须一致，避免死锁。
- **〖强制〗** 异步函数中禁止调用阻塞 I/O，必要时使用 `asyncio.to_thread`。
- **〖推荐〗** I/O 密集型使用 `ThreadPoolExecutor` 或 `asyncio`。
- **〖推荐〗** CPU 密集型使用 `ProcessPoolExecutor` 或 `multiprocessing`。
- **〖推荐〗** 使用 `asyncio.TaskGroup` 管理并发任务，避免任务泄漏。
- **〖参考〗** 高并发场景使用 `uvloop`、`httpx.AsyncClient`。

```python
# 正例
from concurrent.futures import ThreadPoolExecutor

with ThreadPoolExecutor(max_workers=8, thread_name_prefix="fetch") as executor:
    results = list(executor.map(fetch_url, urls))
```

## 15.1 异步规范

- **〖强制〗** 异步函数使用 `async def`，调用时使用 `await`。
- **〖强制〗** 禁止在异步函数中使用 `time.sleep`，应使用 `asyncio.sleep`。
- **〖推荐〗** 使用 `asyncio.timeout` 控制超时。
- **〖推荐〗** 使用 `asyncio.create_task` 后必须保存引用，避免任务被垃圾回收。

---

# 16. 数据库与 ORM

- **〖强制〗** 禁止在循环中逐条查询，避免 N+1。
- **〖强制〗** 事务必须明确边界，异常时必须回滚。
- **〖强制〗** 禁止使用 `SELECT *`，必须明确字段。
- **〖强制〗** 分页查询必须使用 limit/offset 或游标，避免全表扫描。
- **〖推荐〗** 使用 SQLAlchemy 2.0 风格或 Django ORM，参数化查询。
- **〖推荐〗** 高频查询字段建立索引，联合索引遵循最左前缀。
- **〖推荐〗** 软删除字段使用 `is_deleted`，并建立索引。
- **〖参考〗** 复杂查询使用 CTE、窗口函数，避免多层嵌套子查询。

```python
# 正例
stmt = select(User).where(User.id == user_id)
user = session.execute(stmt).scalar_one_or_none()

# 反例
cursor.execute(f"SELECT * FROM user WHERE id = {user_id}")  # SQL 注入风险
```

## 16.1 连接池

- **〖强制〗** 必须使用连接池，禁止每次请求新建连接。
- **〖推荐〗** 配置合理的连接池大小、超时、回收策略。
- **〖推荐〗** 监控连接池使用率与慢查询。

---


# 17. 配置管理

- **〖强制〗** 配置与代码分离，禁止硬编码配置。
- **〖强制〗** 敏感配置使用环境变量或密钥管理服务。
- **〖推荐〗** 使用 `pydantic-settings` 加载与校验配置。
- **〖推荐〗** 提供 `.env.example`，不提交 `.env`。
- **〖推荐〗** 配置分层：默认配置、环境配置、本地覆盖。

```python
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    database_url: str
    debug: bool = False

settings = Settings()
```

---

# 18. 性能与优化

- **〖强制〗** 禁止过早优化，必须先测量再优化。
- **〖强制〗** 禁止在循环内做重复计算、重复 I/O、重复查询。
- **〖推荐〗** 使用 `cProfile`、`py-spy`、`line_profiler` 定位瓶颈。
- **〖推荐〗** 使用生成器、迭代器处理大数据。
- **〖推荐〗** 使用缓存：`functools.lru_cache`、Redis、本地缓存。
- **〖推荐〗** 字符串拼接使用 `"".join()`，避免循环 `+=`。
- **〖参考〗** CPU 密集型使用 C 扩展、Cython、Rust、NumPy。

```python
# 正例
result = "".join(str(i) for i in range(10000))

# 反例
result = ""
for i in range(10000):
    result += str(i)  # O(n²)
```

---

# 19. Git 与提交规约

- **〖强制〗** 提交信息使用 Conventional Commits：`feat:`、`fix:`、`docs:`、`refactor:`、`test:`、`chore:`。
- **〖强制〗** 禁止提交密钥、密码、Token、大文件。
- **〖强制〗** 提交前必须通过 pre-commit 检查。
- **〖推荐〗** 一个提交只做一件事，提交信息清晰描述变更。
- **〖推荐〗** 分支命名：`feature/xxx`、`bugfix/xxx`、`hotfix/xxx`。
- **〖参考〗** 使用 `commitizen` 自动生成 CHANGELOG。

```text
feat(user): add user login API
fix(order): correct total price calculation
docs(readme): update installation guide
```

## 192.1 分支策略

- **〖推荐〗** 主分支保护，禁止直接 push。
- **〖推荐〗** 功能分支从主分支切出，合并前 rebase。
- **〖推荐〗** 发布使用 tag，如 `v1.0.0`。
