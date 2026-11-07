"""Platform-independent core of the desktop capture agent.

The agent turns low-level OS input (mouse clicks, key presses, foreground-window changes) into the
same semantic events the browser extension produces:

  window_focus  - the user switched to another application/window
  click         - the user clicked a UI element (name/role from UI Automation where available)
  input         - the user typed into a field (the typed text itself is NEVER recorded)
  key           - a shortcut or Enter/Tab/Escape (no character keys)

Everything here is pure Python so it can be unit-tested without a desktop session.
"""
from __future__ import annotations

import fnmatch
import json
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError


@dataclass
class UiContext:
    """What was under the pointer / in focus, as reported by the platform layer."""

    app: str = ""
    window_title: str = ""
    element_name: str = ""
    element_role: str = ""
    element_label: str = ""
    is_password: bool = False
    url: str = ""  # browsers expose the address bar via UI Automation on Windows


@dataclass
class Policy:
    excluded_apps: list = field(default_factory=list)
    excluded_url_patterns: list = field(default_factory=list)
    sensitive_field_patterns: list = field(default_factory=list)
    screenshot_on_click: bool = True

    @classmethod
    def from_server(cls, p: dict) -> "Policy":
        return cls(
            excluded_apps=[a.lower() for a in p.get("excludedApps", [])],
            excluded_url_patterns=[u.lower() for u in p.get("excludedUrlPatterns", [])],
            sensitive_field_patterns=[s.lower() for s in p.get("sensitiveFieldPatterns", [])],
            screenshot_on_click=bool(p.get("screenshotOnClick", True)),
        )

    def is_excluded(self, ctx: UiContext) -> bool:
        hay = f"{ctx.app} {ctx.window_title}".lower()
        if any(a and a in hay for a in self.excluded_apps):
            return True
        if ctx.url:
            host = re.sub(r"^[a-z]+://", "", ctx.url.lower()).split("/")[0]
            if any(fnmatch.fnmatch(host, p) or fnmatch.fnmatch(ctx.url.lower(), p) for p in self.excluded_url_patterns):
                return True
        return False

    def is_sensitive(self, ctx: UiContext) -> bool:
        if ctx.is_password:
            return True
        text = f"{ctx.element_name} {ctx.element_label}".lower()
        return any(re.search(rf"(^|[^a-z]){re.escape(p)}([^a-z]|$)", text) for p in self.sensitive_field_patterns)


TEXT_ROLES = {"edit", "textbox", "document", "combobox", "searchbox", "text", "entry", "textfield"}
NAMED_KEYS = {"enter", "tab", "esc", "escape", "f2", "f5", "delete"}


class EventBuilder:
    """Converts raw input callbacks into semantic, privacy-safe events."""

    def __init__(self, policy: Policy, emit: Callable[[dict], None], clock: Callable[[], float] = time.time):
        self.policy = policy
        self.emit = emit
        self.clock = clock
        self.last_window: Optional[tuple] = None
        self.typing_ctx: Optional[UiContext] = None
        self.typing_chars = 0
        self.modifiers: set = set()

    def _base(self, ctx: UiContext, etype: str) -> dict:
        ev = {"type": etype, "ts": int(self.clock() * 1000), "app": ctx.app, "windowTitle": ctx.window_title, "clientId": uuid.uuid4().hex}
        if ctx.url:
            ev["url"] = ctx.url
        return ev

    def _element(self, ctx: UiContext) -> dict:
        return {"role": (ctx.element_role or "").lower(), "name": ctx.element_name, "label": ctx.element_label or ctx.element_name, "isPassword": self.policy.is_sensitive(ctx) or None}

    def on_focus(self, ctx: UiContext) -> None:
        key = (ctx.app, ctx.window_title)
        if key == self.last_window:
            return
        self.flush_typing()
        self.last_window = key
        if self.policy.is_excluded(ctx):
            return
        self.emit(self._base(ctx, "window_focus"))

    def on_click(self, ctx: UiContext) -> Optional[dict]:
        self.on_focus(ctx)
        self.flush_typing()
        if self.policy.is_excluded(ctx):
            return None
        ev = self._base(ctx, "click")
        ev["element"] = self._element(ctx)
        ev["_wantScreenshot"] = self.policy.screenshot_on_click and not self.policy.is_sensitive(ctx)
        self.emit(ev)
        return ev

    def on_key(self, key: str, ctx: UiContext) -> None:
        """key: a single character for printable keys, otherwise a lowercase key name."""
        k = key.lower()
        if k in {"ctrl", "ctrl_l", "ctrl_r", "alt", "alt_l", "alt_r", "cmd", "shift", "shift_l", "shift_r"}:
            self.modifiers.add(k.split("_")[0])
            return
        if self.policy.is_excluded(ctx):
            return
        if self.modifiers - {"shift"} and len(k) == 1:
            combo = "+".join(sorted(m.capitalize() for m in self.modifiers - {"shift"})) + "+" + k.upper()
            if combo not in {"Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+A", "Cmd+C", "Cmd+V"}:  # clipboard keys are noise
                self.flush_typing()
                ev = self._base(ctx, "key")
                ev["text"] = combo
                self.emit(ev)
            return
        if len(k) == 1 or k in {"space", "backspace"}:
            # Count characters only. The characters themselves are never stored or sent.
            if self.typing_ctx is None or (self.typing_ctx.element_name, self.typing_ctx.window_title) != (ctx.element_name, ctx.window_title):
                self.flush_typing()
                self.typing_ctx = ctx
            self.typing_chars += 1
            return
        if k in NAMED_KEYS:
            self.flush_typing()
            ev = self._base(ctx, "key")
            ev["text"] = {"esc": "Escape"}.get(k, k.capitalize())
            ev["element"] = self._element(ctx)
            self.emit(ev)

    def on_key_release(self, key: str) -> None:
        self.modifiers.discard(key.lower().split("_")[0])

    def flush_typing(self) -> None:
        if self.typing_ctx and self.typing_chars:
            ctx = self.typing_ctx
            ev = self._base(ctx, "input")
            ev["element"] = self._element(ctx)
            ev["element"]["role"] = ev["element"]["role"] or "textbox"
            ev["value"] = "[REDACTED:SENSITIVE_FIELD]" if self.policy.is_sensitive(ctx) else "[VALUE_ENTERED]"
            self.emit(ev)
        self.typing_ctx = None
        self.typing_chars = 0


class DurableQueue:
    """JSONL-backed queue so captured events survive network outages and agent restarts."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.items: list = []
        if self.path.exists():
            for line in self.path.read_text(encoding="utf-8").splitlines():
                try:
                    self.items.append(json.loads(line))
                except ValueError:
                    pass

    def _persist(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text("".join(json.dumps(i) + "\n" for i in self.items), encoding="utf-8")
        os.replace(tmp, self.path)

    def push(self, item: dict) -> None:
        with self.lock:
            self.items.append(item)
            self.items = self.items[-5000:]
            self._persist()

    def peek(self, n: int) -> list:
        with self.lock:
            return list(self.items[:n])

    def drop(self, n: int) -> None:
        with self.lock:
            self.items = self.items[n:]
            self._persist()

    def __len__(self) -> int:
        return len(self.items)


class ApiClient:
    def __init__(self, base_url: str, opener: Callable = urlrequest.urlopen):
        self.base = base_url.rstrip("/")
        self.session_id: Optional[str] = None
        self.token: Optional[str] = None
        self.opener = opener

    def _call(self, method: str, path: str, body: Optional[dict] = None, auth: bool = True) -> dict:
        headers = {"content-type": "application/json"}
        if auth:
            headers.update({"authorization": f"Bearer {self.token}", "x-session-id": self.session_id or ""})
        req = urlrequest.Request(self.base + path, method=method, headers=headers, data=json.dumps(body).encode() if body is not None else None)
        with self.opener(req, timeout=15) as res:
            return json.loads(res.read().decode() or "{}")

    def pair(self, code: str, host: str) -> dict:
        r = self._call("POST", "/api/capture/pair", {"code": code, "client": {"type": "desktop-agent", "version": "0.1.0", "host": host}}, auth=False)
        self.session_id, self.token = r["sessionId"], r["captureToken"]
        return r

    def state(self) -> dict:
        return self._call("GET", "/api/capture/state")

    def send_events(self, events: list) -> dict:
        return self._call("POST", "/api/capture/events", {"events": events, "source": "desktop"})

    def upload_screenshot(self, jpeg_data_url: str) -> str:
        return self._call("POST", "/api/capture/screenshots", {"data": jpeg_data_url})["id"]


class Uploader:
    """Flushes the durable queue; on failure keeps events and retries with backoff."""

    def __init__(self, client: ApiClient, queue: DurableQueue, sleep: Callable[[float], None] = time.sleep):
        self.client, self.queue, self.sleep = client, queue, sleep
        self.status = "recording"
        self.backoff = 1.0

    def flush_once(self) -> bool:
        batch = self.queue.peek(50)
        if not batch:
            return True
        try:
            r = self.client.send_events([{k: v for k, v in e.items() if not k.startswith("_")} for e in batch])
        except HTTPError as e:
            if e.code == 401:
                self.status = "unpaired"
            return False
        except (URLError, OSError, TimeoutError):
            return False
        self.queue.drop(len(batch))
        self.status = r.get("status", self.status)
        self.backoff = 1.0
        return True

    def flush_all(self) -> None:
        while len(self.queue):
            if not self.flush_once():
                self.sleep(self.backoff)
                self.backoff = min(self.backoff * 2, 30)
                return
