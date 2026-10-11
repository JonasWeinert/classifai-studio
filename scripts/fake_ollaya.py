#!/usr/bin/env python3
"""A tiny stand-in for the Ollaya daemon, for tests and offline development.

It speaks the subset of Ollaya's HTTP API that ClassifAI uses (/, /api/version, /api/tags,
/api/presets, /api/decide, /api/pull, /api/delete) with deterministic fake answers: a choice
question picks the label whose name appears in the state, else the first label.

It also fakes the cloud providers, so their base URLs can point here:

    POST /v1/systemone                                         TypeSafe System One (typesafe, custom)
    POST /v1/decisions                                         OpenAI Decisions (needs a Bearer key)
    POST /client/v4/accounts/<acct>/ai/run/@cf/cloudflare/<m>  Workers AI, wrapped in {result, success}
    POST /v1/chat/completions                                  an LLM with JSON-schema structured output
    POST /v1/messages                                          an Anthropic LLM (forced tool call, needs x-api-key)
    GET  /v1/models                                            model lists (OpenRouter-style; Anthropic-style with ?limit=)

The LLMs fill the answer schema they are sent: the option named in the input gets 0.8, a
statement 0.9 when the input says "spam" or "win", an open question "Fake answer.". The chat
model "json-only" rejects json_schema (400) to exercise the JSON-mode fallback.

Every cloud request reports usage {input_tokens: 10, output_tokens: 0}. An OpenAI question whose
instructions contain "[refuse]" gets a refusal.

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


USAGE = {"input_tokens": 10, "output_tokens": 0}


def systemone(b):
    return {"model": b.get("model", ""), "answers": {qid: answer(q, b["state"]) for qid, q in (b.get("questions") or {}).items()},
            "usage": USAGE}


def openai_answer(q, state):
    name, t = q["name"], q["type"]
    if "[refuse]" in (q.get("instructions") or ""):
        return {"type": "refusal", "name": name, "refusal": "I can't help with that."}
    if t == "predicate":
        return {"type": "predicate", "name": name, "probability": answer({"type": "noul"}, state)["noul"]}
    if t == "choice":
        a = answer({"type": "choice", "criteria": [c["value"] for c in q["choices"]]}, state)
        return {"type": "choice", "name": name, "choice": a["choice"], "confidence": a["confidence"],
                "probabilities": [{"value": v, "probability": p} for v, p in a["probabilities"].items()]}
    a = answer({"type": "score", "criteria": [l["label"] for l in q["levels"]]}, state)
    return {"type": "score", "name": name, "score": a["score"], "confidence": a["confidence"],
            "probabilities": [{"value": int(i), "label": a["legend"][i], "probability": p} for i, p in a["probabilities"].items()]}


def llm_fill(schema, prompt):
    """Answers for an LLM answer schema, from the <input> of the prompt."""
    raw = prompt.split("<input>", 1)[-1].split("</input>", 1)[0].strip()
    text = raw.lower()
    out = {}
    for qid, q in schema.get("properties", {}).items():
        props = q.get("properties", {})
        if "probabilities" in props:
            keys = props["probabilities"]["required"]
            hit = next((k for k in keys if k.lower() in text), keys[0])
            out[qid] = {"probabilities": {k: (0.8 if k == hit else round(0.2 / max(1, len(keys) - 1), 4)) for k in keys}}
        elif "probability_true" in props:
            out[qid] = {"probability_true": 0.9 if "spam" in text or "win" in text else 0.1}
        else:
            out[qid] = {"answer": "Fake answer."}
        # A verbatim quote: the input's first three words (with different spacing, as models do).
        out[qid]["quote"] = "  ".join(raw.split()[:3]) if "quote" in props else ""
    return out


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
        if self.path.startswith("/v1/models"):
            if "limit=" in self.path:  # Anthropic
                if not self.headers.get("x-api-key"):
                    return self._json(401, {"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}})
                return self._json(200, {"data": [{"id": "claude-haiku-4-5-20251001", "display_name": "Claude Haiku 4.5", "type": "model"}], "has_more": False})
            return self._json(200, {"object": "list", "data": [
                {"id": "fake-llm", "object": "model", "name": "Fake LLM", "context_length": 8192,
                 "pricing": {"prompt": "0.000001", "completion": "0.000002"}, "supported_parameters": ["structured_outputs"]},
                {"id": "json-only", "object": "model"}]})
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
        elif self.path == "/v1/systemone":
            self._json(200, systemone(b))
        elif self.path == "/v1/decisions":
            if not self.headers.get("Authorization", "").startswith("Bearer "):
                return self._json(401, {"error": {"message": "Missing API key", "type": "invalid_request_error", "code": "invalid_api_key"}})
            self._json(200, {"id": "dec_fake", "model": b.get("model", ""),
                             "answers": [openai_answer(q, b["input"]) for q in b.get("questions", [])],
                             "usage": dict(USAGE, total_tokens=USAGE["input_tokens"])})
        elif self.path.startswith("/client/v4/accounts/") and "/ai/run/@cf/cloudflare/" in self.path:
            if not self.headers.get("Authorization", "").startswith("Bearer "):
                return self._json(401, {"result": None, "success": False, "errors": [{"code": 10000, "message": "Authentication error"}], "messages": []})
            model = self.path.rsplit("/", 1)[1]
            if model not in ("clef", "clef-flash") or b.get("model") != model:
                return self._json(400, {"result": None, "success": False, "errors": [{"code": 5007, "message": f"No such model {model}"}], "messages": []})
            self._json(200, {"result": systemone(b), "success": True, "errors": [], "messages": []})
        elif self.path == "/v1/chat/completions":
            fmt = b.get("response_format") or {}
            user = b["messages"][-1]["content"]
            if fmt.get("type") == "json_schema":
                if b.get("model") == "json-only":
                    return self._json(400, {"error": {"message": "response_format json_schema is not supported", "type": "invalid_request_error"}})
                schema = fmt["json_schema"]["schema"]
            else:
                schema = json.loads(user.rsplit("JSON schema, and nothing else:\n", 1)[1])
            content = json.dumps(llm_fill(schema, user))
            if fmt.get("type") != "json_schema":
                content = "```json\n" + content + "\n```"
            self._json(200, {"id": "chat_fake", "model": b.get("model", ""), "choices": [{"index": 0, "message": {"role": "assistant", "content": content}}],
                             "usage": {"prompt_tokens": 100, "completion_tokens": 20}})
        elif self.path == "/v1/messages":
            if not self.headers.get("x-api-key") or not self.headers.get("anthropic-version"):
                return self._json(401, {"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}})
            tool = b["tools"][0]
            self._json(200, {"id": "msg_fake", "model": b.get("model", ""), "type": "message", "role": "assistant", "stop_reason": "tool_use",
                             "content": [{"type": "tool_use", "id": "toolu_fake", "name": tool["name"], "input": llm_fill(tool["input_schema"], b["messages"][-1]["content"])}],
                             "usage": {"input_tokens": 120, "output_tokens": 30}})
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
