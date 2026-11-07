"""OS-specific inspection of the foreground window and the UI element under the pointer.

Windows : Win32 (foreground window, process name) + Microsoft UI Automation via the `uiautomation`
          package (element name, control type, IsPassword, browser address bar).
macOS   : AppKit / Quartz (frontmost app + window title). Element names need the Accessibility
          permission (System Settings > Privacy & Security > Accessibility) and pyobjc.
Linux   : X11 via xdotool / xprop (window title + process). No element names (AT-SPI not wired up).

Each provider returns a core.UiContext. Every call is best-effort: failures degrade to less detail,
never to a crash, because missing detail is flagged later as a clarification.
"""
from __future__ import annotations

import subprocess
import sys

from .core import UiContext


class BaseProvider:
    name = "generic"

    def foreground(self) -> UiContext:
        return UiContext()

    def at_point(self, x: int, y: int) -> UiContext:
        return self.foreground()


class WindowsProvider(BaseProvider):
    name = "windows-uia"

    def __init__(self):
        import ctypes  # noqa: F401
        import psutil  # noqa: F401
        try:
            import uiautomation  # noqa: F401
            self.uia = True
        except ImportError:
            self.uia = False

    def foreground(self) -> UiContext:
        import ctypes
        from ctypes import wintypes
        import psutil
        user32 = ctypes.windll.user32
        hwnd = user32.GetForegroundWindow()
        length = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        try:
            app = psutil.Process(pid.value).name().removesuffix(".exe")
        except Exception:
            app = ""
        return UiContext(app=app, window_title=buf.value, url=self._browser_url(app))

    def _browser_url(self, app: str) -> str:
        if not self.uia or app.lower() not in {"chrome", "msedge", "firefox"}:
            return ""
        try:
            import uiautomation as auto
            win = auto.GetForegroundControl().GetTopLevelControl()
            bar = win.EditControl(searchDepth=12, Name="Address and search bar") if app.lower() != "firefox" else win.EditControl(searchDepth=12)
            v = bar.GetValuePattern().Value if bar.Exists(0.2, 0) else ""
            return v if v.startswith("http") else (f"https://{v}" if v else "")
        except Exception:
            return ""

    def at_point(self, x: int, y: int) -> UiContext:
        ctx = self.foreground()
        if not self.uia:
            return ctx
        try:
            import uiautomation as auto
            el = auto.ControlFromPoint(x, y)
            if el:
                ctx.element_name = (el.Name or "")[:200]
                ctx.element_role = el.ControlTypeName.replace("Control", "")
                ctx.is_password = bool(getattr(el, "IsPassword", False))
                labeled = getattr(el, "LabeledBy", None)
                ctx.element_label = (labeled.Name if labeled else "") or ctx.element_name
        except Exception:
            pass
        return ctx


class MacProvider(BaseProvider):
    name = "macos"

    def foreground(self) -> UiContext:
        try:
            from AppKit import NSWorkspace
            from Quartz import CGWindowListCopyWindowInfo, kCGNullWindowID, kCGWindowListOptionOnScreenOnly
            app = NSWorkspace.sharedWorkspace().frontmostApplication()
            name, pid = app.localizedName(), app.processIdentifier()
            title = ""
            for w in CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID) or []:
                if w.get("kCGWindowOwnerPID") == pid and w.get("kCGWindowLayer") == 0:
                    title = w.get("kCGWindowName") or ""
                    break
            return UiContext(app=name, window_title=title)
        except Exception:
            return UiContext()


class LinuxX11Provider(BaseProvider):
    name = "linux-x11"

    def foreground(self) -> UiContext:
        try:
            wid = subprocess.run(["xdotool", "getactivewindow"], capture_output=True, text=True, timeout=1).stdout.strip()
            title = subprocess.run(["xdotool", "getwindowname", wid], capture_output=True, text=True, timeout=1).stdout.strip()
            pid = subprocess.run(["xdotool", "getwindowpid", wid], capture_output=True, text=True, timeout=1).stdout.strip()
            app = open(f"/proc/{pid}/comm").read().strip() if pid else ""
            return UiContext(app=app, window_title=title)
        except Exception:
            return UiContext()


def detect_provider() -> BaseProvider:
    if sys.platform == "win32":
        return WindowsProvider()
    if sys.platform == "darwin":
        return MacProvider()
    return LinuxX11Provider()
