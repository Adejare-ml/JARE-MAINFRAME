# The Ollama worker (Diet module, Phase 3)

Reads meal photos with a vision model on your laptop and sends the estimate
to the `diet-photo` edge function, which stores it beside Claude's and
NVIDIA's and re-merges the meal. Logging never waits for it: when the laptop
is off, the cloud models have already logged the meal, and the worker picks
up anything from the last 48 hours the next time it runs.

## Set up once

1. Install [Ollama](https://ollama.com) and pull the model (the default in
   Diet settings is `qwen3-vl:8b`, about 6 GB, which fits in the RTX 2070
   Super's 8 GB on its own):

   ```bash
   ollama pull qwen3-vl:8b
   ```

   The worker checks the model's size before every pass and refuses one too
   big for `VRAM_GB`, because a model that spills into system memory is very
   slow. To use another model, set it in Diet → Settings → Photo models.

2. Set a worker token for the function (any long random string), once:

   ```bash
   supabase secrets set DIET_WORKER_TOKEN=$(openssl rand -hex 32)
   ```

   Keep a copy for step 3. This token can list photo meals and add
   estimates, and nothing else; it is not your service role key.

3. Here, in `workers/ollama/`:

   ```bash
   python -m venv .venv && . .venv/bin/activate   # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   cp .env.example .env    # fill in SUPABASE_URL, SUPABASE_ANON_KEY, DIET_WORKER_TOKEN
   ```

   `.env` is git-ignored. Never commit it.

## Run

```bash
python worker.py          # polls every POLL_SECONDS (60) until stopped
python worker.py --once   # one pass, then exit
```

It opens no ports: every connection is outbound, to Supabase and to Ollama
on localhost. Each job runs with `keep_alive: 0`, so the model leaves the GPU
as soon as it is done.

To start it with the laptop, use the system's own scheduler (Task Scheduler
on Windows, a systemd user service or a login item elsewhere) to run
`python worker.py` in this folder with the virtual environment active.

## Tests

```bash
python -m unittest -v
```

No Ollama, GPU or network needed: the HTTP layer is faked. CI runs them.
