"""Unit tests for the desktop agent core (no desktop session needed)."""
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.error import URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pda_agent.core import ApiClient, DurableQueue, EventBuilder, Policy, UiContext, Uploader  # noqa: E402

POLICY = Policy.from_server({"excludedApps": ["KeePass"], "excludedUrlPatterns": ["*bank*"], "sensitiveFieldPatterns": ["password", "pin"]})


class BuilderTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.b = EventBuilder(POLICY, self.events.append, clock=lambda: 1000.0)

    def test_typing_is_aggregated_and_text_never_recorded(self):
        ctx = UiContext(app="mmc", window_title="Active Directory Users and Computers", element_name="User logon name", element_role="Edit")
        for ch in "jdoe":
            self.b.on_key(ch, ctx)
        self.b.on_key("tab", ctx)
        types = [e["type"] for e in self.events]
        self.assertEqual(types, ["input", "key"])
        self.assertEqual(self.events[0]["value"], "[VALUE_ENTERED]")
        self.assertNotIn("jdoe", json.dumps(self.events))

    def test_password_field_is_marked_sensitive_and_not_screenshotted(self):
        ctx = UiContext(app="mmc", window_title="Reset Password", element_name="New password", element_role="Edit", is_password=True)
        ev = self.b.on_click(ctx)
        self.assertFalse(ev["_wantScreenshot"])
        for ch in "S3cret!":
            self.b.on_key(ch, ctx)
        self.b.flush_typing()
        self.assertEqual(self.events[-1]["value"], "[REDACTED:SENSITIVE_FIELD]")
        self.assertNotIn("S3cret", json.dumps(self.events))

    def test_excluded_application_produces_no_events(self):
        ctx = UiContext(app="KeePass", window_title="Database.kdbx - KeePass", element_name="Copy password")
        self.b.on_click(ctx)
        self.b.on_key("a", ctx)
        self.b.flush_typing()
        self.assertEqual(self.events, [])

    def test_shortcuts_recorded_but_clipboard_ignored(self):
        ctx = UiContext(app="notepad", window_title="config.txt")
        self.b.on_focus(ctx)
        self.b.on_key("ctrl_l", ctx)
        self.b.on_key("c", ctx)
        self.b.on_key("s", ctx)
        self.b.on_key_release("ctrl_l")
        self.assertEqual([e.get("text") for e in self.events if e["type"] == "key"], ["Ctrl+S"])

    def test_window_focus_emitted_once_per_window(self):
        ctx = UiContext(app="mmc", window_title="DNS Manager")
        self.b.on_focus(ctx)
        self.b.on_focus(ctx)
        self.b.on_click(UiContext(app="mmc", window_title="DNS Manager", element_name="Forward Lookup Zones", element_role="TreeItem"))
        self.assertEqual([e["type"] for e in self.events], ["window_focus", "click"])
        self.assertEqual(self.events[1]["element"]["name"], "Forward Lookup Zones")


class QueueAndUploadTests(unittest.TestCase):
    def test_queue_survives_restart_and_offline_upload(self):
        with tempfile.TemporaryDirectory() as d:
            q = DurableQueue(Path(d) / "q.jsonl")
            q.push({"type": "click"})
            q.push({"type": "input", "_internal": 1})
            self.assertEqual(len(DurableQueue(Path(d) / "q.jsonl")), 2)

            class Offline(ApiClient):
                def send_events(self, events):
                    raise URLError("network down")

            up = Uploader(Offline("http://x"), q, sleep=lambda s: None)
            up.flush_all()
            self.assertEqual(len(q), 2, "events must be kept while offline")

            sent = []

            class Online(ApiClient):
                def send_events(self, events):
                    sent.extend(events)
                    return {"status": "paused"}

            up2 = Uploader(Online("http://x"), q, sleep=lambda s: None)
            up2.flush_all()
            self.assertEqual(len(q), 0)
            self.assertEqual(up2.status, "paused")
            self.assertNotIn("_internal", sent[1], "internal fields are not uploaded")

    def test_api_client_pairs_with_server(self):
        calls = []

        class Res(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def opener(req, timeout):
            calls.append((req.get_method(), req.full_url, json.loads(req.data)))
            return Res(json.dumps({"sessionId": "ses_1", "captureToken": "tok", "title": "T", "status": "recording", "policy": {}}).encode())

        c = ApiClient("http://srv/", opener=opener)
        c.pair("123456", "host")
        self.assertEqual(calls[0][1], "http://srv/api/capture/pair")
        self.assertEqual((c.session_id, c.token), ("ses_1", "tok"))


if __name__ == "__main__":
    unittest.main()


class MachinePolicyTests(unittest.TestCase):
    def test_allowlist_and_https(self):
        import json, tempfile
        from pda_agent import machine_policy as mp
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "policy.json"
            f.write_text(json.dumps({"serverUrl": "https://pda.contoso.com", "allowedServers": "https://PDA.contoso.com/;https://pda2.contoso.com"}))
            pol = mp.load([f])
        self.assertEqual(pol["serverUrl"], "https://pda.contoso.com")
        self.assertEqual(pol["allowedServers"], ["https://pda.contoso.com", "https://pda2.contoso.com"])
        mp.check_server("https://pda.contoso.com/", pol)
        with self.assertRaises(ValueError):
            mp.check_server("https://evil.example.com", pol)
        with self.assertRaises(ValueError):
            mp.check_server("http://pda.contoso.com", {"allowedServers": []})
        mp.check_server("http://localhost:3000", {"allowedServers": []})
