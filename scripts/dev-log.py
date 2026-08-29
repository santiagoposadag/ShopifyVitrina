#!/usr/bin/env python3
"""
Vitrina's server log, made readable.

    tail -f data/dev/server.log | python3 scripts/dev-log.py

The server logs one JSON object per line (pino). Three things make that hard to
follow live, and this fixes each: the /health polling buries everything, the
per-turn summary is the densest and most useful line in the file, and a tool
call is the one event you actually want to watch scroll by.
"""
import sys, json, datetime

LVL = {10: "trace", 20: "debug", 30: "INFO", 40: "WARN", 50: "ERROR", 60: "FATAL"}
COL = {30: "\033[36m", 40: "\033[33m", 50: "\033[31m", 60: "\033[1;31m"}
OFF, DIM, BOLD = "\033[0m", "\033[2m", "\033[1m"
NOISE = {"incoming request", "request completed"}
FIELDS = ("phone", "role", "inboxId", "tool", "subtype", "recipient",
          "code", "attempts", "final", "decision")


def stamp(entry):
    return datetime.datetime.fromtimestamp(entry.get("time", 0) / 1000).strftime("%H:%M:%S")


def render(entry):
    level, msg = entry.get("level", 30), entry.get("msg", "")

    # HTTP noise. Only the webhook is worth seeing, plus anything that failed —
    # without this the /health poll scrolls a real message off the screen.
    if msg in NOISE:
        req, res = entry.get("req", {}), entry.get("res", {})
        url, code = req.get("url", ""), res.get("statusCode")
        if msg == "incoming request" and url.startswith("/webhook"):
            msg = f"{BOLD}→ {req.get('method')} {url[:70]}{OFF}"
        elif msg == "request completed" and (code or 0) >= 400:
            msg = f"← http {code}"
        else:
            return None

    # The turn summary carries every field that answers "why did that take a
    # minute" or "did it actually do anything". Unfolded onto two lines.
    if msg == "agent turn complete":
        seconds = (entry.get("durationMs") or 0) / 1000
        head = (f"{BOLD}TURN{OFF}  {seconds:.1f}s  numTurns={entry.get('numTurns')}  "
                f"in={entry.get('inputTokens')} out={entry.get('outputTokens')}  "
                f"model={entry.get('servedModel')}  end={entry.get('resultSubtype')}")
        return (f"{COL.get(level,'')}{stamp(entry)} {LVL.get(level,level):5}{OFF} {head}\n"
                f"{' ' * 15}{DIM}tools:{OFF} {entry.get('tools') or '(none)'}")

    extra = [f"{f}={entry[f]}" for f in FIELDS if entry.get(f) not in (None, "")]
    if entry.get("input"):
        extra.append(f"input={str(entry['input'])[:160]}")
    err = entry.get("err")
    if isinstance(err, dict) and err.get("message"):
        extra.append(f"err={err['message'][:220]}")
    elif isinstance(err, str):
        extra.append(f"err={err[:220]}")
    tail = ("  " + " ".join(extra)) if extra else ""
    return f"{COL.get(level,'')}{stamp(entry)} {LVL.get(level,level):5}{OFF} {msg}{tail}"


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        entry = json.loads(line)
    except Exception:
        # Startup banner and stack traces are not JSON, and a crash is exactly
        # when you need them — dim, but never dropped.
        print(f"{DIM}{line[:200]}{OFF}", flush=True)
        continue
    out = render(entry)
    if out is not None:
        print(out, flush=True)
