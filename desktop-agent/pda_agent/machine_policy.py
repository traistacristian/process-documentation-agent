"""Machine-wide settings deployed by IT (Intune / Group Policy).

Windows: HKLM\\SOFTWARE\\Policies\\ProcessDocumentationAgent
    ServerUrl       REG_SZ        default server address
    AllowedServers  REG_MULTI_SZ  origins the agent may pair with (empty = any)
Other OS / fallback: %ProgramData%/ProcessDocumentationAgent/policy.json or /etc/pda-agent/policy.json
    {"serverUrl": "...", "allowedServers": ["..."]}
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

REG_PATH = r"SOFTWARE\Policies\ProcessDocumentationAgent"


def origin(url: str) -> str:
    p = urlsplit(url.strip())
    return f"{p.scheme.lower()}://{p.netloc.lower()}" if p.scheme and p.netloc else url.strip().rstrip("/")


def _from_registry() -> dict:
    if sys.platform != "win32":
        return {}
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, REG_PATH) as k:
            out = {}
            for name, key in (("ServerUrl", "serverUrl"), ("AllowedServers", "allowedServers")):
                try:
                    out[key] = winreg.QueryValueEx(k, name)[0]
                except FileNotFoundError:
                    pass
            return out
    except OSError:
        return {}


def _from_file(paths=None) -> dict:
    if paths is None:
        paths = [Path(os.environ.get("ProgramData", "C:/ProgramData")) / "ProcessDocumentationAgent" / "policy.json", Path("/etc/pda-agent/policy.json")]
    for p in paths:
        try:
            return json.loads(Path(p).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
    return {}


def load(paths=None) -> dict:
    raw = _from_registry() or _from_file(paths)
    allowed = raw.get("allowedServers") or []
    if isinstance(allowed, str):
        allowed = [a for a in allowed.replace(";", "\n").splitlines() if a.strip()]
    return {"serverUrl": (raw.get("serverUrl") or "").strip(), "allowedServers": [origin(a) for a in allowed]}


def check_server(server: str, policy: dict) -> None:
    if not server.lower().startswith(("https://", "http://localhost", "http://127.0.0.1")):
        raise ValueError("The server address must use https://")
    allowed = policy.get("allowedServers") or []
    if allowed and origin(server) not in allowed:
        raise ValueError(f"Your organisation only allows recording with {', '.join(allowed)}")
