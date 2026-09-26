"""Fetch Laya's weights with Laya's own loader, and say what was fetched (docs/laya-auto.md 7.3).

laya-install.js runs this with Laya's venv, from an empty folder, with HF_HOME set to KzH's own
Hugging Face cache (models/laya/hf):

    python -I -u -X utf8 fetch_weights.py --repo convaiinnovations/laya --checkpoint english

`Router.preload` downloads exactly the files Laya's Agent loads, with Laya's own allow-patterns, and
proves they load; loading also lets Laya rewrite the tokenizer config it fixes up in place, so the
files KzH hashes afterwards are the files every later start reads. With HF_HUB_OFFLINE=1 it reads
the cache only, so a cache copied from another PC installs with no network; laya-install.js runs it
that way first and goes online only when that fails.

The last line on stdout is JSON: {"repo", "checkpoint", "commit", "snapshot", "files": {path: bytes}}.
Anything that goes wrong is one line on stderr and exit code 1.
"""
import argparse
import json
import os
import sys

# The files Laya's Agent asks the Hub for (laya/agent.py, `allow_patterns`), under the subfolder of
# a bundled checkpoint.
LAYA_FILES = ("rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*")


def fail(why):
    sys.stderr.write("fetch_weights: %s\n" % why)
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description="Fetch and load Laya's weights into HF_HOME.")
    ap.add_argument("--repo", default="convaiinnovations/laya")
    ap.add_argument("--checkpoint", default="english")
    args = ap.parse_args()
    if not os.environ.get("HF_HOME"):
        fail("HF_HOME is not set; KzH keeps Laya's weights in its own cache")
    try:
        from laya.router import DEFAULT_MODELS, Router
    except Exception as e:  # noqa: BLE001 - one line for the card, not a traceback
        fail("Laya does not import: %s" % e)
    spec = DEFAULT_MODELS.get(args.checkpoint)
    if spec is None:
        fail("Laya has no checkpoint named %r" % args.checkpoint)
    repo, sub = (list(spec) + [None])[:2] if isinstance(spec, (tuple, list)) else (spec, None)
    if repo != args.repo:
        fail("Laya loads %s from %s, not %s" % (args.checkpoint, repo, args.repo))
    try:
        # The CPU is enough to prove the files load, and never competes with a model on the GPU.
        Router(device="cpu").preload([args.checkpoint])
    except Exception as e:  # noqa: BLE001
        fail("Laya could not load %s: %s" % (args.checkpoint, str(e).splitlines()[0] if str(e) else type(e).__name__))
    try:
        from huggingface_hub import snapshot_download

        prefix = "%s/" % sub if sub else ""
        # Resolves refs/main in the local cache to the commit that was just fetched; no network.
        snapshot = snapshot_download(repo, allow_patterns=[prefix + p for p in LAYA_FILES], local_files_only=True)
    except Exception as e:  # noqa: BLE001
        fail("the fetched files are not in the cache: %s" % e)
    files = {}
    for root, _dirs, names in os.walk(snapshot, followlinks=True):
        for name in names:
            path = os.path.join(root, name)
            files[os.path.relpath(path, snapshot).replace(os.sep, "/")] = os.path.getsize(path)
    if "model.safetensors" not in {os.path.basename(p) for p in files}:
        fail("the snapshot has no model.safetensors")
    print(json.dumps({
        "repo": repo,
        "checkpoint": args.checkpoint,
        "commit": os.path.basename(os.path.normpath(snapshot)),
        "snapshot": snapshot,
        "files": files,
    }))


if __name__ == "__main__":
    main()
