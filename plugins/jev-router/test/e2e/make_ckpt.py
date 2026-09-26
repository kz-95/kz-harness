"""A checkpoint with the architecture of Laya's English checkpoint and random weights (docs/laya-auto.md 9.4 step 2).

The cloud cannot download Laya's weights, so the end-to-end test runs the real laya.serve on this:

    <Laya's venv python> make_ckpt.py <out> [--tokenizer <file>] [--tiny]

<out> gets what Laya's Agent loads from the English checkpoint (laya/agent.py):

    rl_agent_config.json  the English config with its real temperatures, choice:11+ 0.1006 included
    encoder/config.json   ModernBERT-large: hidden 1024, 28 layers, intermediate 2624, 16 heads, vocab 50368
    tokenizer/            OLMo's GPT-NeoX BPE, the tokenizer ModernBERT's own is built from, as a proxy, with
                          ModernBERT's special tokens at ModernBERT's ids
    model.safetensors     laya.common.build_model's weights at seed 0, in fp16: 421.29M parameters, 842,609,220 bytes

Every answer it gives is meaningless; the process, protocol, latency, memory and supervision are
real. plant_hf_cache.py then lays it out as a download of convaiinnovations/laya.

The tokenizer is fetched from GitHub raw and checked against its SHA-256, or read from --tokenizer, a
copy of the same file, checked against the same hash. --tiny builds 2 layers of width 64 instead, a
few MB, to try this script and plant_hf_cache.py on a small disk: nothing measured on it means
anything, the protocol included. The last line on stdout is JSON: {"out", "parameters", "bytes"}.
"""
import argparse
import hashlib
import json
import os
import sys
import urllib.request

TOKENIZER_URL = "https://raw.githubusercontent.com/allenai/OLMo/main/olmo_data/tokenizers/allenai_gpt-neox-olmo-dolma-v1_5.json"
TOKENIZER_SHA256 = "9ad33b4b39a9f83973c3f8c42a01948dd5b877a28ac9a5356956c4ff4ed0b714"

# The English checkpoint's rl_agent_config.json, as Laya 0.3.20 ships it.
CONFIG = {
    "encoder": "answerdotai/ModernBERT-large", "head_layers": 2, "max_len": 512, "head_max_len": 192,
    "act_costs": {"escalate": 0.5}, "temperature": [1.6369, 1.2514, 1.9834],
    "temperature_by_options": {"choice:2": 1.9064, "choice:3-5": 1.7602, "choice:6-10": 1.00002, "choice:11+": 0.1006, "score:3-5": 1.2514, "noul:2": 1.9834},
}
# ModernBERT-large, with the ids of the special tokens the tokenizer below gets.
ENCODER = dict(
    vocab_size=50368, hidden_size=1024, intermediate_size=2624, num_hidden_layers=28, num_attention_heads=16,
    global_attn_every_n_layers=3, local_attention=128, max_position_embeddings=8192,
    pad_token_id=50283, bos_token_id=50281, eos_token_id=50282, cls_token_id=50281, sep_token_id=50282,
)
TINY = dict(hidden_size=64, intermediate_size=128, num_hidden_layers=2, num_attention_heads=4)
# Added in this order, they take ModernBERT's own ids: [UNK] 50280, [CLS] 50281, [SEP] 50282, [PAD] 50283, [MASK] 50284.
SPECIAL = {"unk_token": "[UNK]", "cls_token": "[CLS]", "sep_token": "[SEP]", "pad_token": "[PAD]", "mask_token": "[MASK]"}
SPECIAL_IDS = [50280, 50281, 50282, 50283, 50284]


def fail(why):
    sys.stderr.write("make_ckpt: %s\n" % why)
    sys.exit(1)


def tokenizer_bytes(path):
    """The proxy tokenizer's bytes, from `path` or GitHub raw, refused unless they hash to the pin."""
    if path:
        with open(path, "rb") as f:
            data = f.read()
    else:
        with urllib.request.urlopen(TOKENIZER_URL, timeout=60) as r:
            data = r.read()
    got = hashlib.sha256(data).hexdigest()
    if got != TOKENIZER_SHA256:
        fail("the tokenizer hashes to %s, not the pinned %s" % (got, TOKENIZER_SHA256))
    return data


def main():
    ap = argparse.ArgumentParser(description="Build a random-weight checkpoint at the architecture of Laya's English checkpoint.")
    ap.add_argument("out")
    ap.add_argument("--tokenizer", help="a copy of the pinned tokenizer file, instead of fetching it")
    ap.add_argument("--tiny", action="store_true", help="2 layers of width 64, to try the scripts on a small disk")
    args = ap.parse_args()
    try:
        import torch
        from safetensors.torch import save_file
        from transformers import ModernBertConfig, PreTrainedTokenizerFast
        from laya.common import build_model
    except Exception as e:  # noqa: BLE001 - one line, not a traceback
        fail("run it with Laya's venv: %s" % e)

    out = os.path.abspath(args.out)
    for d in ("encoder", "tokenizer"):
        os.makedirs(os.path.join(out, d), exist_ok=True)
    ModernBertConfig(**{**ENCODER, **(TINY if args.tiny else {})}).save_pretrained(os.path.join(out, "encoder"))
    with open(os.path.join(out, "rl_agent_config.json"), "w") as f:
        json.dump(CONFIG, f, indent=1)

    raw = os.path.join(out, "tokenizer", "tokenizer.json")
    with open(raw, "wb") as f:
        f.write(tokenizer_bytes(args.tokenizer))
    tok = PreTrainedTokenizerFast(tokenizer_file=raw)
    tok.add_special_tokens(SPECIAL)
    tok.save_pretrained(os.path.join(out, "tokenizer"))
    ids = [tok.unk_token_id, tok.cls_token_id, tok.sep_token_id, tok.pad_token_id, tok.mask_token_id]
    if ids != SPECIAL_IDS:
        fail("the tokenizer gave [UNK], [CLS], [SEP], [PAD] and [MASK] the ids %s, not ModernBERT's %s" % (ids, SPECIAL_IDS))

    torch.manual_seed(0)
    model = build_model(CONFIG, encoder_dir=os.path.join(out, "encoder"), pretrained=False)
    weights = os.path.join(out, "model.safetensors")
    save_file({k: v.detach().half().contiguous() for k, v in model.state_dict().items()}, weights)
    print(json.dumps({"out": out, "parameters": sum(p.numel() for p in model.parameters()), "bytes": os.path.getsize(weights)}))


if __name__ == "__main__":
    main()
