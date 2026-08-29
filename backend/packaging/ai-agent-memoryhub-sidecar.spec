# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path

from PyInstaller.utils.hooks import copy_metadata


project_root = Path(SPECPATH).resolve().parent
source_root = project_root / "src"
entrypoint = project_root / "packaging" / "sidecar_entry.py"

hidden_imports = [
    "fastapi.exception_handlers",
    "starlette.responses",
    "starlette.staticfiles",
    "uvicorn.lifespan.off",
    "uvicorn.lifespan.on",
    "uvicorn.logging",
    "uvicorn.loops.asyncio",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.flow_control",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
]
metadata = []
for distribution in ("fastapi", "pydantic", "starlette", "uvicorn"):
    metadata += copy_metadata(distribution)

a = Analysis(
    [str(entrypoint)],
    pathex=[str(source_root)],
    binaries=[],
    datas=metadata,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="ai-agent-memoryhub-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
)
