"""
Tests for worker.py, with a fake HTTP layer (no Ollama, no Supabase).
Run: cd workers/ollama && python -m unittest -v
Added for the Diet module, Phase 3.
"""

import json
import unittest

from worker import Config, FoodVision, Worker

ITEM = {"name": "white rice", "local_name": None, "grams": 250, "grams_low": 200, "grams_high": 300, "kcal": 325, "protein_g": 6.8, "carbs_g": 70, "fat_g": 0.8, "hidden": False, "confidence": 0.7, "basis": "half a pack"}
GOOD = {"items": [ITEM], "totals": {"kcal": 325, "protein_g": 6.8, "carbs_g": 70, "fat_g": 0.8}, "image_quality": "good", "question": None}
JOB = {"meal_id": "m1", "image_url": "https://signed.test/p.jpg?token=t", "system": "You estimate the food", "user": "Local time: 13:10", "model": "qwen3-vl:8b"}


class FakeHttp:
    """Answers by URL; records every request."""

    def __init__(self, ollama_answers, tags=None, pending=None):
        self.ollama_answers = list(ollama_answers)
        self.tags = tags if tags is not None else {"models": [{"name": "qwen3-vl:8b", "size": 6_100_000_000}]}
        self.pending = pending if pending is not None else [JOB]
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        sent = json.loads(body) if body else None
        self.calls.append((method, url, headers, sent))
        if url.endswith("/functions/v1/diet-photo"):
            if sent["action"] == "pending":
                return 200, json.dumps({"ok": True, "jobs": self.pending}).encode()
            return 200, json.dumps({"ok": True, "stored": sent["status"], "remerged": "replaced"}).encode()
        if url.endswith("/api/tags"):
            return 200, json.dumps(self.tags).encode()
        if url.endswith("/api/chat"):
            content = self.ollama_answers.pop(0)
            return 200, json.dumps({"message": {"content": content}}).encode()
        if url.startswith("https://signed.test/"):
            return 200, b"\xff\xd8\xff\xe0jpeg"
        return 404, b"{}"

    def posted_estimates(self):
        return [c[3] for c in self.calls if c[1].endswith("/diet-photo") and c[3]["action"] == "estimate"]


def worker(http):
    return Worker(Config(supabase_url="https://p.supabase.co", anon_key="anon", worker_token="tok"), http)


class WorkerTests(unittest.TestCase):
    def test_reads_a_photo_and_posts_the_estimate(self):
        http = FakeHttp([json.dumps(GOOD)])
        self.assertEqual(worker(http).run_once(), 1)
        [posted] = http.posted_estimates()
        self.assertEqual(posted["status"], "ok")
        self.assertEqual(posted["attempts"], 1)
        self.assertEqual(posted["answer"]["items"][0]["grams"], 250)
        self.assertEqual(posted["model_id"], "qwen3-vl:8b")

    def test_unloads_the_model_after_each_job_and_constrains_the_output(self):
        http = FakeHttp([json.dumps(GOOD)])
        worker(http).run_once()
        chat = next(c[3] for c in http.calls if c[1].endswith("/api/chat"))
        self.assertEqual(chat["keep_alive"], 0)
        self.assertEqual(chat["format"], FoodVision.model_json_schema())
        self.assertEqual(chat["messages"][1]["images"], ["/9j/4GpwZWc="])

    def test_sends_the_worker_token_not_a_service_key(self):
        http = FakeHttp([json.dumps(GOOD)])
        worker(http).run_once()
        headers = http.calls[0][2]
        self.assertEqual(headers["x-worker-token"], "tok")
        self.assertEqual(headers["Authorization"], "Bearer anon")

    def test_retries_once_on_an_invalid_answer(self):
        http = FakeHttp(["not json", json.dumps(GOOD)])
        worker(http).run_once()
        [posted] = http.posted_estimates()
        self.assertEqual((posted["status"], posted["attempts"]), ("ok", 2))

    def test_gives_up_after_two_invalid_answers_and_says_why(self):
        bad = dict(GOOD, items=[dict(ITEM, grams="250")])
        http = FakeHttp([json.dumps(bad), "{}"])
        worker(http).run_once()
        [posted] = http.posted_estimates()
        self.assertEqual(posted["status"], "invalid")
        self.assertIn("attempt 2", posted["reason"])

    def test_refuses_a_number_written_as_a_string(self):
        with self.assertRaises(Exception):
            FoodVision.model_validate_json(json.dumps(dict(GOOD, items=[dict(ITEM, kcal="325")])))

    def test_posts_nothing_when_the_model_is_not_pulled(self):
        http = FakeHttp([], tags={"models": []})
        self.assertEqual(worker(http).run_once(), 0)
        self.assertEqual(http.posted_estimates(), [])

    def test_refuses_a_model_too_big_for_the_gpu(self):
        http = FakeHttp([], tags={"models": [{"name": "qwen3-vl:8b", "size": 9_800_000_000}]})
        self.assertEqual(worker(http).run_once(), 0)
        ready, why = worker(http).model_ready("qwen3-vl:8b")
        self.assertFalse(ready)
        self.assertIn("9.8 GB", why)

    def test_does_nothing_when_nothing_is_pending(self):
        http = FakeHttp([], pending=[])
        self.assertEqual(worker(http).run_once(), 0)
        self.assertFalse(any(c[1].endswith("/api/tags") for c in http.calls))


if __name__ == "__main__":
    unittest.main()
