"""Lay a checkpoint out as the Hugging Face cache holds a download of convaiinnovations/laya (docs/laya-auto.md 9.4 step 2).

    python plant_hf_cache.py <checkpoint> <HF_HOME> [--commit <40 hex>] [--link]

<checkpoint> is a folder make_ckpt.py wrote. It writes

    <HF_HOME>/hub/models--convaiinnovations--laya/snapshots/<commit>/   the files Laya's Agent loads
    <HF_HOME>/hub/models--convaiinnovations--laya/refs/main             <commit>

which is what huggingface_hub reads offline, so fetch_weights.py (run with HF_HOME=<HF_HOME> and
HF_HUB_OFFLINE=1) loads it through Laya and writes weights.json after that load, as it does for the
owner's download, and laya.serve starts on it. <HF_HOME> is the harness's models/laya/hf.

The commit defaults to the SHA-1 of the checkpoint's files, so one checkpoint always plants one
snapshot. --link hard-links the weights rather than copying them, where both folders are on one disk.
The last line on stdout is JSON: {"snapshot", "commit", "files": {path: bytes}}.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sys

REPO_DIR = "models--convaiinnovations--laya"
# What Laya's Agent loads from the English checkpoint (laya/agent.py, allow_patterns).
FILES = ("rl_agent_config.json", "model.safetensors", "encoder", "tokenizer")


def fail(why):
    sys.stderr.write("plant_hf_cache: %s\n" % why)
    sys.exit(1)


def files_of(ckpt):
    """Every file Laya loads from `ckpt`, as paths relative to it, in a fixed order."""
    out = []
    for name in FILES:
        path = os.path.join(ckpt, name)
        if os.path.isdir(path):
            out += sorted(os.path.relpath(os.path.join(d, f), ckpt).replace(os.sep, "/") for d, _, fs in os.walk(path) for f in fs)
        elif os.path.isfile(path):
            out.append(name)
        else:
            fail("%s has no %s: build it with make_ckpt.py" % (ckpt, name))
    return out


def main():
    ap = argparse.ArgumentParser(description="Plant a checkpoint as a Hugging Face cache download of convaiinnovations/laya.")
    ap.add_argument("checkpoint")
    ap.add_argument("hf_home")
    ap.add_argument("--commit", help="the snapshot's commit, 40 hex; defaults to the SHA-1 of the files")
    ap.add_argument("--link", action="store_true", help="hard-link the files instead of copying them")
    args = ap.parse_args()
    ckpt = os.path.abspath(args.checkpoint)
    files = files_of(ckpt)
    commit = args.commit
    if commit is None:
        h = hashlib.sha1()
        for rel in files:
            h.update(rel.encode())
            with open(os.path.join(ckpt, rel), "rb") as f:
                for block in iter(lambda: f.read(1 << 20), b""):
                    h.update(block)
        commit = h.hexdigest()
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        fail("a commit is 40 lowercase hex digits, not %r" % commit)

    repo = os.path.join(os.path.abspath(args.hf_home), "hub", REPO_DIR)
    snapshot = os.path.join(repo, "snapshots", commit)
    if os.path.exists(snapshot):
        shutil.rmtree(snapshot)
    for rel in files:
        dest = os.path.join(snapshot, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if args.link:
            os.link(os.path.join(ckpt, rel), dest)
        else:
            shutil.copyfile(os.path.join(ckpt, rel), dest)
    os.makedirs(os.path.join(repo, "refs"), exist_ok=True)
    with open(os.path.join(repo, "refs", "main"), "w") as f:
        f.write(commit)
    print(json.dumps({"snapshot": snapshot, "commit": commit, "files": {rel: os.path.getsize(os.path.join(snapshot, rel)) for rel in files}}))


if __name__ == "__main__":
    main()
