"""
The Ollama worker for the Jare Mainframe Diet module (Phase 3).

Runs on the owner's laptop (an RTX 2070 Super, 8 GB). Every POLL_SECONDS it
asks the diet-photo edge function for photo meals that have no Ollama
estimate yet, downloads each photo through the short-lived signed URL the
function hands out, runs the vision model locally with keep_alive set to 0
(so the model leaves the GPU after every job), validates the answer with
pydantic, and posts it back. The function stores it and re-merges the meal.

It never blocks a log: the cloud models have already logged the meal by the
time this sees it, and when the laptop is off or asleep the meal simply
waits (the function offers photos up to 48 hours old). It opens no ports:
every connection is outbound, to Supabase and to Ollama on localhost.

Its one secret, DIET_WORKER_TOKEN, is read from a local .env. That token
can list photo meals and add estimates through the function, nothing else;
it is not the service role key.

    pip install -r requirements.txt
    cp .env.example .env    # then fill it in
    python worker.py        # runs until stopped
    python worker.py --once # one pass, for a test or a scheduled task

Added for the Diet module, Phase 3 (docs/diet-module.md).
"""

from __future__ import annotations

import argparse
import base64
import json
import logging
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Annotated, Callable, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, ValidationError

log = logging.getLogger("diet-ollama")

DEFAULT_MODEL = "qwen3-vl:8b"

# ── The answer's shape: prompts/food-vision.md, the same as the edge
# function's zod schema (supabase/functions/diet-photo/schema.ts). Strict, so
# a number written as a string is refused rather than coerced. ──────────────

Num = Annotated[float, Field(ge=0, le=100000, strict=True)]


class VisionItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Annotated[str, Field(min_length=1, max_length=120)]
    local_name: Optional[Annotated[str, Field(max_length=120)]]
    grams: Num
    grams_low: Num
    grams_high: Num
    kcal: Num
    protein_g: Num
    carbs_g: Num
    fat_g: Num
    hidden: Annotated[bool, Field(strict=True)]
    confidence: Annotated[float, Field(ge=0, le=1, strict=True)]
    basis: Annotated[str, Field(max_length=300)]


class Totals(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kcal: Num
    protein_g: Num
    carbs_g: Num
    fat_g: Num


class FoodVision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: Annotated[list[VisionItem], Field(max_length=30)]
    totals: Totals
    image_quality: Literal["good", "partial", "poor", "no_food"]
    question: Optional[Annotated[str, Field(max_length=300)]]


# ── Configuration ───────────────────────────────────────────────────────────


@dataclass
class Config:
    supabase_url: str
    anon_key: str
    worker_token: str
    ollama_url: str = "http://127.0.0.1:11434"
    model_override: Optional[str] = None
    poll_seconds: int = 60
    vram_gb: float = 8.0
    ollama_timeout: int = 300

    @staticmethod
    def from_env() -> "Config":
        missing = [k for k in ("SUPABASE_URL", "SUPABASE_ANON_KEY", "DIET_WORKER_TOKEN") if not os.environ.get(k)]
        if missing:
            raise SystemExit(f"missing in .env: {', '.join(missing)} (see .env.example)")
        return Config(
            supabase_url=os.environ["SUPABASE_URL"].rstrip("/"),
            anon_key=os.environ["SUPABASE_ANON_KEY"],
            worker_token=os.environ["DIET_WORKER_TOKEN"],
            ollama_url=os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/"),
            model_override=os.environ.get("OLLAMA_MODEL") or None,
            poll_seconds=int(os.environ.get("POLL_SECONDS", "60")),
            vram_gb=float(os.environ.get("VRAM_GB", "8")),
        )


# ── HTTP, standard library only. `Http` is injected so the tests need no network. ──

Http = Callable[[str, str, dict, Optional[bytes], int], tuple[int, bytes]]


def real_http(method: str, url: str, headers: dict, body: Optional[bytes], timeout: int) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()


class Worker:
    def __init__(self, cfg: Config, http: Http = real_http):
        self.cfg = cfg
        self.http = http

    # The edge function
    def call_function(self, body: dict) -> dict:
        status, raw = self.http(
            "POST",
            f"{self.cfg.supabase_url}/functions/v1/diet-photo",
            {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.cfg.anon_key}",
                "apikey": self.cfg.anon_key,
                "x-worker-token": self.cfg.worker_token,
            },
            json.dumps(body).encode(),
            60,
        )
        data = json.loads(raw or b"{}")
        if status != 200 or not data.get("ok"):
            raise RuntimeError(f"diet-photo {status}: {data.get('reason', raw[:200])}")
        return data

    # Ollama
    def model_ready(self, model: str) -> tuple[bool, str]:
        """Is the model pulled, and small enough to sit in the GPU on its own?"""
        try:
            status, raw = self.http("GET", f"{self.cfg.ollama_url}/api/tags", {}, None, 10)
        except OSError as err:
            return False, f"Ollama is not running at {self.cfg.ollama_url} ({err})"
        if status != 200:
            return False, f"Ollama answered {status}"
        models = json.loads(raw).get("models", [])
        found = next((m for m in models if m.get("name") == model or m.get("model") == model), None)
        if not found:
            return False, f"{model} is not pulled: run `ollama pull {model}`"
        size_gb = found.get("size", 0) / 1e9
        limit = self.cfg.vram_gb * 0.9
        if size_gb > limit:
            return False, f"{model} is {size_gb:.1f} GB, more than {limit:.1f} GB fits in this GPU; choose a smaller model in Diet settings"
        return True, f"{model} ({size_gb:.1f} GB)"

    def ask_ollama(self, model: str, system: str, user: str, image_b64: str) -> str:
        body = {
            "model": model,
            "stream": False,
            # Unload as soon as this job is done: the GPU is the laptop's, not ours.
            "keep_alive": 0,
            # Constrained decoding to the schema, so the answer is JSON in shape.
            "format": FoodVision.model_json_schema(),
            "options": {"temperature": 0},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user, "images": [image_b64]},
            ],
        }
        status, raw = self.http("POST", f"{self.cfg.ollama_url}/api/chat", {"Content-Type": "application/json"}, json.dumps(body).encode(), self.cfg.ollama_timeout)
        if status != 200:
            raise RuntimeError(f"Ollama {status}: {raw[:200]!r}")
        return json.loads(raw).get("message", {}).get("content", "")

    # One meal
    def process(self, job: dict) -> dict:
        model = self.cfg.model_override or job.get("model") or DEFAULT_MODEL
        status, raw = self.http("GET", job["image_url"], {}, None, 60)
        if status != 200:
            raise RuntimeError(f"photo download {status}")
        image_b64 = base64.b64encode(raw).decode()
        started = time.monotonic()
        reasons: list[str] = []
        for attempt in (1, 2):
            try:
                content = self.ask_ollama(model, job["system"], job["user"], image_b64)
                answer = FoodVision.model_validate_json(content)
                return {"status": "ok", "answer": answer.model_dump(), "reason": None, "attempts": attempt, "latency_ms": int((time.monotonic() - started) * 1000), "model_id": model}
            except (ValidationError, json.JSONDecodeError) as err:
                # Retry once on an answer that is not the schema, then give up on this meal.
                reasons.append(f"attempt {attempt}: invalid answer ({str(err).splitlines()[0][:150]})")
        return {"status": "invalid", "answer": None, "reason": "; ".join(reasons), "attempts": 2, "latency_ms": int((time.monotonic() - started) * 1000), "model_id": model}

    def run_once(self) -> int:
        """One pass. Returns the number of meals given an estimate."""
        jobs = self.call_function({"action": "pending"}).get("jobs", [])
        if not jobs:
            return 0
        model = self.cfg.model_override or jobs[0].get("model") or DEFAULT_MODEL
        ready, why = self.model_ready(model)
        if not ready:
            # Nothing is posted: the meals stay pending and are tried again
            # on a later pass, once the model is there.
            log.warning("skipping %d photo(s): %s", len(jobs), why)
            return 0
        log.info("%d photo(s) to read with %s", len(jobs), why)
        done = 0
        for job in jobs:
            try:
                result = self.process(job)
            except (RuntimeError, OSError) as err:
                log.warning("meal %s: %s (will try again next pass)", job.get("meal_id"), err)
                continue
            reply = self.call_function({"action": "estimate", "meal_id": job["meal_id"], **result})
            log.info("meal %s: %s, %s (%d ms)", job["meal_id"], result["status"], reply.get("remerged"), result["latency_ms"])
            done += 1
        return done


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[1])
    parser.add_argument("--once", action="store_true", help="one pass, then exit")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        from dotenv import load_dotenv

        load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
    except ImportError:
        pass
    worker = Worker(Config.from_env())
    while True:
        try:
            worker.run_once()
        except (RuntimeError, OSError, ValueError) as err:
            # The laptop woke up offline, Supabase is unreachable, the token is
            # wrong: say so and try again later rather than crash.
            log.warning("pass failed: %s", err)
        if args.once:
            return 0
        time.sleep(worker.cfg.poll_seconds)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
