# The render check (docs/laya-auto.md 9.4 step 9, 9.5 step 5): every request KzH sends Laya,
# encoded by Laya's own code with the tokenizer and limits of the checkpoint this harness holds,
# and a count of what that encoding cuts.
#
# Laya reads a question as one row: [CLS] <type> question: <instructions> [SEP] then [MASK] and
# each option's text, [SEP], then the state and a final [SEP], at most `max_len` tokens, with the
# instructions and options sharing `head_max_len`. laya.common.build_sequence cuts an option past
# 48 tokens, cuts every option when they do not fit the head together, drops an option whose
# marker falls past `max_len`, cuts the instructions to what the options leave, and keeps only the
# state tokens that fit the rest of the row. Nothing of that is reported by laya.serve, so this
# encodes each request the way laya.agent.Agent does (its _check_question, _to_internal and
# _encode_state, which calls build_sequence), and compares what was kept with the whole.
#
# Run by scripts/laya-render-check.mjs in Laya's own venv:
#   python check_render.py --model-dir <snapshot> --requests <file.json>
# where the file holds [{ call, key, state, questions }], KzH's requests as renderForLaya makes
# them. It prints one JSON object: the counts, and one entry per cut.
import argparse
import json
import os
import sys
import types


def load(model_dir):
    from laya.agent import Agent
    from laya.common import render_options, serialize_state

    with open(os.path.join(model_dir, "rl_agent_config.json"), encoding="utf-8") as f:
        cfg = json.load(f)
    tok_dir = os.path.join(model_dir, "tokenizer")
    try:
        # Laya's own loader, so the tokenizer is the one laya.serve parses for this checkpoint.
        from laya.agent import _load_tokenizer
        tok = _load_tokenizer(tok_dir, cfg)
    except ImportError:
        from transformers import AutoTokenizer
        tok = AutoTokenizer.from_pretrained(tok_dir)
    return Agent, render_options, serialize_state, cfg, tok


def check(model_dir, requests):
    Agent, render_options, serialize_state, cfg, tok = load(model_dir)
    max_len = cfg.get("max_len", 512)
    head_max = cfg.get("head_max_len", 192)
    mask = tok.mask_token
    sep = tok.sep_token_id
    count = lambda text: len(tok(text, add_special_tokens=False)["input_ids"])
    # _encode_state reads only these two of the agent.
    agent = types.SimpleNamespace(cfg=cfg, tok=tok)

    out = {
        "maxLen": max_len, "headMaxLen": head_max, "requests": 0, "rows": 0,
        "optionsCut": [], "viewsCut": [], "headsCut": [], "refused": [],
        "maxRowTokens": 0, "minStateRoom": None, "maxStateTokens": 0, "minSpareTokens": None,
    }
    for r in requests:
        out["requests"] += 1
        state = r["state"]
        state_tokens = count(serialize_state(state).replace(mask, " "))
        out["maxStateTokens"] = max(out["maxStateTokens"], state_tokens)
        for qid, qdef in r["questions"].items():
            out["rows"] += 1
            where = {"call": r["call"], "request": r["key"], "question": qid}
            try:
                Agent._check_question(qid, qdef)
                q = Agent._to_internal(qdef)
                # Laya's encoding of this one row; it refuses a question whose options lost a marker.
                item = Agent._encode_state(agent, state, [qid], {qid: q})[0]
            except ValueError as e:
                out["refused"].append({**where, "why": str(e)})
                continue
            ids, markers = item["ids"], item["markers"]
            out["maxRowTokens"] = max(out["maxRowTokens"], len(ids))
            opts = render_options(q)
            first_sep = ids.index(sep)
            head_full = count("%s question: %s" % (q["t"], str(q["ins"]).replace(mask, " ")))
            if first_sep - 1 < head_full:
                out["headsCut"].append({**where, "kept": first_sep - 1, "of": head_full})
            opt_end = ids.index(sep, markers[-1]) if markers else first_sep + 1
            for i, text in enumerate(opts):
                full = count(" " + text.replace(mask, " "))
                if i >= len(markers):
                    out["optionsCut"].append({**where, "option": text.split(":")[0], "kept": 0, "of": full})
                    continue
                end = markers[i + 1] if i + 1 < len(markers) else opt_end
                kept = end - markers[i] - 1
                if kept < full:
                    out["optionsCut"].append({**where, "option": text.split(":")[0], "kept": kept, "of": full})
            room = max(0, max_len - (opt_end + 1) - 1)
            out["minStateRoom"] = room if out["minStateRoom"] is None else min(out["minStateRoom"], room)
            # The tightest row: how many tokens of room were left after its state.
            spare = room - state_tokens
            out["minSpareTokens"] = spare if out["minSpareTokens"] is None else min(out["minSpareTokens"], spare)
            if state_tokens > room:
                out["viewsCut"].append({**where, "kept": room, "of": state_tokens})
    return out


def main():
    p = argparse.ArgumentParser(description="Count what Laya's own encoding cuts of KzH's requests.")
    p.add_argument("--model-dir", required=True)
    p.add_argument("--requests", required=True)
    a = p.parse_args()
    with open(a.requests, encoding="utf-8") as f:
        requests = json.load(f)
    json.dump(check(a.model_dir, requests), sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
