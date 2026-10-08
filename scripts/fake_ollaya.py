#!/usr/bin/env python3
"""A tiny stand-in for the Ollaya daemon, for tests and offline development.

It speaks the subset of Ollaya's HTTP API that ClassifAI uses (/, /api/version, /api/tags,
/api/presets, /api/decide, /api/pull, /api/delete) with deterministic fake answers: a choice
question picks the label whose name appears in the state, else the first label.

    python3 scripts/fake_ollaya.py            # listens on 127.0.0.1:11435
    python3 scripts/fake_ollaya.py 11999      # another port
"""

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODELS = {"laya:latest": 11862, "laya:en": 845897529}


def answer(question, state):
    text = json.dumps(state).lower() if not isinstance(state, str) else state.lower()
    t = question.get("type")
    if t == "choice":
        crit = question["criteria"]
        labels = list(crit) if isinstance(crit, dict) else list(crit)
        hit = next((l for l in labels if l.lower() in text), labels[0])
        k = len(labels)
        probs = {l: (0.7 if l == hit else 0.3 / (k - 1)) for l in labels}
        return {"type": "choice", "choice": hit, "confidence": round((k * 0.7 - 1) / (k - 1), 4), "probabilities": probs}
    if t == "score":
        n = len(question["criteria"])
        probs = {str(i): round(1 / n, 4) for i in range(n)}
        return {"type": "score", "score": (n - 1) / 2, "confidence": 0.0,
                "legend": {str(i): c for i, c in enumerate(question["criteria"])}, "probabilities": probs}
    return {"type": "noul", "noul": 0.9 if "spam" in text or "win" in text else 0.1}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_HEAD(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        if self.path == "/":
            data = b"Ollaya is running"
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        elif self.path == "/api/version":
            self._json(200, {"version": "0.0.0-fake"})
        elif self.path == "/api/tags":
            self._json(200, {"models": [{"name": n, "model": n, "modified_at": "2026-10-08T00:00:00Z", "size": s, "digest": "0" * 64,
                                         "details": {"parent_model": "", "format": "onnx", "family": "laya", "families": ["laya"],
                                                     "parameter_size": "421M", "quantization_level": "F32"}} for n, s in MODELS.items()]})
        elif self.path == "/api/presets":
            self._json(200, {"presets": [{"name": "triage", "builtin": True, "description": "fake", "questions": ["intent"]}]})
        else:
            self._json(404, {"error": "not found", "code": "NOT_FOUND"})

    def do_POST(self):
        b = self._body()
        if self.path == "/api/decide":
            model = b.get("model", "")
            name = model if ":" in model else model + ":latest"
            if name not in MODELS:
                return self._json(404, {"error": f'model "{name}" not found, try pulling it first', "code": "MODEL_NOT_FOUND"})
            if b.get("state") is None:
                return self._json(200, {"model": name, "answers": {}, "usage": {"input_tokens": 0, "output_tokens": 0}, "routing": None,
                                        "state_truncated": False, "done_reason": "load", "created_at": "", "total_duration": 1, "load_duration": 1, "eval_duration": 0})
            answers = {qid: answer(q, b["state"]) for qid, q in (b.get("questions") or {}).items()}
            self._json(200, {"model": name, "answers": answers, "usage": {"input_tokens": 10, "output_tokens": 0}, "routing": None,
                             "state_truncated": False, "done_reason": "decide", "created_at": "", "total_duration": 2_000_000,
                             "load_duration": 0, "eval_duration": 1_500_000})
        elif self.path == "/api/pull":
            name = b["model"] if ":" in b["model"] else b["model"] + ":latest"
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.end_headers()
            lines = [{"status": "pulling manifest"}] + [
                {"status": "pulling 8d32a80bb199", "digest": "sha256:" + "8" * 64, "total": 1000, "completed": c} for c in (0, 500, 1000)
            ] + [{"status": "verifying sha256 digest"}, {"status": "writing manifest"}, {"status": "success"}]
            for l in lines:
                self.wfile.write((json.dumps(l) + "\n").encode())
                self.wfile.flush()
                time.sleep(0.02)
            MODELS[name] = 1000
        else:
            self._json(404, {"error": "not found", "code": "NOT_FOUND"})

    def do_DELETE(self):
        b = self._body()
        MODELS.pop(b.get("model", ""), None)
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 11435
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
