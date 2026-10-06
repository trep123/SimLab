#!/usr/bin/env python3
"""按源码白名单生成可复核的 SimLab 发布包。"""

from __future__ import annotations

import argparse
import hashlib
import tarfile
from datetime import datetime
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_PATHS = (
    "backend",
    "runtime",
    "simulator",
    "assets",
    "schemas",
    "tests",
    "taskbook",
    "ops",
    "docs/adr",
    "docs/models",
    "docs/runbooks",
    "AGENTS.md",
    "3D_NETWORK_SIMLAB_TASKBOOK.md",
    "rule.md",
    "pytest.ini",
    "README.md",
    "DEPLOYMENT_README.md",
    ".env.example",
    "compose.yaml",
)
WEB_PATHS = ("web",)
EXCLUDED_DIRECTORIES = frozenset(
    {
        ".git",
        ".venv",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        "__pycache__",
        "node_modules",
        "dist",
        "dist-single",
        "coverage",
        "runtime-data",
        "release",
    }
)
EXCLUDED_NAMES = frozenset({".env", ".DS_Store", ".coverage"})
EXCLUDED_SUFFIXES = frozenset(
    {".pyc", ".pyo", ".sqlite", ".sqlite3", ".qcow2", ".img", ".iso", ".pcap", ".key", ".pem"}
)


def source_files(paths: tuple[str, ...]) -> list[Path]:
    """仅收集仓库源码；拒绝软链接与运行时产物。"""
    selected: list[Path] = []
    for relative_path in paths:
        source_path = PROJECT_ROOT / relative_path
        if not source_path.exists():
            raise FileNotFoundError(f"PACK_SOURCE_MISSING: 缺少 {relative_path}")
        candidates = source_path.rglob("*") if source_path.is_dir() else (source_path,)
        for candidate in candidates:
            relative_parts = candidate.relative_to(PROJECT_ROOT).parts
            if any(part in EXCLUDED_DIRECTORIES for part in relative_parts):
                continue
            if candidate.is_symlink():
                raise ValueError(f"PACK_SYMLINK_REJECTED: 不打包软链接 {candidate}")
            if not candidate.is_file():
                continue
            if candidate.name in EXCLUDED_NAMES or candidate.suffix.lower() in EXCLUDED_SUFFIXES:
                continue
            if candidate.name.startswith(".env.") and candidate.name != ".env.example":
                continue
            selected.append(candidate)
    return sorted(set(selected), key=lambda path: path.relative_to(PROJECT_ROOT).as_posix())


def create_archive(output: Path, folder: str, paths: tuple[str, ...]) -> None:
    """创建以固定顶层目录开头的 gzip 源码包。"""
    files = source_files(paths)
    with tarfile.open(output, "w:gz") as archive:
        for source in files:
            archive_info = archive.gettarinfo(
                source, arcname=f"{folder}/{source.relative_to(PROJECT_ROOT).as_posix()}"
            )
            archive_info.mode = (
                0o755 if source.suffix == ".sh" or source.name == "package_source.py" else 0o644
            )
            archive_info.uid = 0
            archive_info.gid = 0
            archive_info.uname = "root"
            archive_info.gname = "root"
            with source.open("rb") as source_file:
                archive.addfile(archive_info, source_file)
    print(f"{output.name}: {len(files)} 个源码文件")


def main() -> None:
    """生成独立前后端源码包、整套部署包与 SHA-256 清单。"""
    parser = argparse.ArgumentParser(description="生成 SimLab 源码发布包")
    parser.add_argument("--date", default=datetime.now().strftime("%Y%m%d"))
    parser.add_argument("--output", type=Path, default=PROJECT_ROOT / "release")
    args = parser.parse_args()
    if len(args.date) != 8 or not args.date.isdigit():
        parser.error("--date 必须是 YYYYMMDD")
    output_directory = args.output.resolve()
    output_directory.mkdir(parents=True, exist_ok=True)
    archive_specs = (
        ("simlab-backend-source", BACKEND_PATHS),
        ("simlab-web-source", WEB_PATHS),
        ("simlab-full-source", BACKEND_PATHS + WEB_PATHS),
    )
    archive_paths: list[Path] = []
    for prefix, paths in archive_specs:
        folder = f"{prefix}-{args.date}"
        archive_path = output_directory / f"{folder}.tar.gz"
        create_archive(archive_path, folder, paths)
        archive_paths.append(archive_path)
    checksums = "".join(
        f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n"
        for path in archive_paths
    )
    (output_directory / "SHA256SUMS").write_text(checksums, encoding="utf-8")
    print(f"校验文件：{output_directory / 'SHA256SUMS'}")


if __name__ == "__main__":
    main()
