"""Process Documentation Agent - desktop capture agent.

Usage:
    python -m pda_agent --server https://processdocs.contoso.com --code 123456

The pairing code is shown on the recording screen of the web app. The agent then captures desktop
activity (foreground application, clicked UI elements, field entry without the typed text, keyboard
shortcuts, screenshots of the active screen on click) until the recording is paused or stopped in
the web app. A small always-on-top indicator shows that recording is active.
"""
from __future__ import annotations

import argparse
import base64
import io
import platform
import queue
import sys
import threading
import time
from pathlib import Path

from .core import ApiClient, DurableQueue, EventBuilder, Policy, Uploader
from .platforms import detect_provider


def grab_screenshot(max_width: int = 1600) -> str | None:
    """Captures the monitor under the pointer as a JPEG data URL (mss + Pillow)."""
    try:
        import mss
        from PIL import Image
        with mss.mss() as sct:
            shot = sct.grab(sct.monitors[0] if len(sct.monitors) == 1 else sct.monitors[1])
            img = Image.frombytes("RGB", shot.size, shot.rgb)
        if img.width > max_width:
            img = img.resize((max_width, int(img.height * max_width / img.width)))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=70)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return None


class Indicator:
    """Always-on-top 'RECORDING' badge (Tkinter). Falls back to console output without a display."""

    def __init__(self, title: str):
        self.title = title
        self.root = None

    def run(self, status_getter, stop_event: threading.Event):
        try:
            import tkinter as tk
        except Exception:
            return self._console(status_getter, stop_event)
        try:
            self.root = tk.Tk()
        except Exception:
            return self._console(status_getter, stop_event)
        r = self.root
        r.overrideredirect(True)
        r.attributes("-topmost", True)
        r.geometry(f"+{r.winfo_screenwidth() - 330}+20")
        lbl = tk.Label(r, font=("Segoe UI", 10, "bold"), padx=12, pady=6, fg="white")
        lbl.pack()

        def tick():
            st = status_getter()
            lbl.config(text=f"● RECORDING – {self.title[:30]}" if st == "recording" else f"❚❚ PAUSED – {self.title[:30]}", bg="#C92A2A" if st == "recording" else "#E67700")
            if stop_event.is_set():
                r.destroy()
                return
            r.after(500, tick)

        tick()
        r.mainloop()

    def _console(self, status_getter, stop_event):
        last = None
        while not stop_event.is_set():
            st = status_getter()
            if st != last:
                print(f"[{time.strftime('%H:%M:%S')}] Recording status: {st.upper()} – {self.title}", flush=True)
                last = st
            time.sleep(1)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="pda_agent", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", required=True, help="Base URL of the Process Documentation Agent")
    ap.add_argument("--code", required=True, help="6-digit pairing code from the recording screen")
    ap.add_argument("--queue", default=str(Path.home() / ".pda_agent" / "queue.jsonl"))
    args = ap.parse_args(argv)

    try:
        from pynput import keyboard, mouse
    except Exception as e:  # pragma: no cover - depends on the desktop session
        print(f"pynput could not attach to the desktop session: {e}", file=sys.stderr)
        return 2

    client = ApiClient(args.server)
    info = client.pair(args.code, platform.node())
    policy = Policy.from_server(info.get("policy", {}))
    q = DurableQueue(Path(args.queue))
    uploader = Uploader(client, q)
    uploader.status = info.get("status", "recording")
    provider = detect_provider()
    shots: "queue.Queue[dict]" = queue.Queue()
    print(f"Paired with recording '{info['title']}' using {provider.name}. Capture is active while the web app shows RECORDING.")

    def emit(ev: dict):
        if uploader.status != "recording":
            return
        if ev.pop("_wantScreenshot", False):
            shots.put(ev)  # screenshot is taken and uploaded off the input thread
        else:
            q.push(ev)

    builder = EventBuilder(policy, emit)
    stop = threading.Event()

    def screenshot_worker():
        last = 0.0
        while not stop.is_set():
            try:
                ev = shots.get(timeout=0.5)
            except queue.Empty:
                continue
            if time.time() - last > 0.7:
                data = grab_screenshot()
                if data:
                    try:
                        ev["screenshotId"] = client.upload_screenshot(data)
                        last = time.time()
                    except Exception:
                        pass
            q.push(ev)

    def sync_worker():
        while not stop.is_set():
            uploader.flush_all()
            try:
                st = client.state().get("status")
                if st:
                    uploader.status = st
            except Exception:
                pass
            if uploader.status in {"stopped", "discarded", "generated", "unpaired"}:
                builder.flush_typing()
                uploader.flush_all()
                stop.set()
            time.sleep(2)

    def on_click(x, y, button, pressed):
        if pressed and uploader.status == "recording" and str(button).endswith("left"):
            builder.on_click(provider.at_point(int(x), int(y)))

    def keyname(k):
        return k.char if getattr(k, "char", None) else str(k).replace("Key.", "")

    def on_press(k):
        if uploader.status == "recording":
            builder.on_key(keyname(k) or "", provider.foreground())

    def on_release(k):
        builder.on_key_release(keyname(k) or "")

    def focus_worker():
        while not stop.is_set():
            if uploader.status == "recording":
                builder.on_focus(provider.foreground())
            time.sleep(0.7)

    for fn in (screenshot_worker, sync_worker, focus_worker):
        threading.Thread(target=fn, daemon=True).start()
    ml = mouse.Listener(on_click=on_click)
    kl = keyboard.Listener(on_press=on_press, on_release=on_release)
    ml.start()
    kl.start()
    try:
        Indicator(info["title"]).run(lambda: uploader.status, stop)
        stop.wait()
    except KeyboardInterrupt:
        stop.set()
    ml.stop()
    kl.stop()
    builder.flush_typing()
    uploader.flush_all()
    print("Recording finished – the agent has stopped capturing.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
