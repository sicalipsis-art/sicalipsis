"""Build the index for searching the texts by meaning, and put it in the bucket.

Usage: python make_meaning_index.py <data_dir> <work_dir> [--no-upload]

Run it with the OCR environment's Python, after translate_texts.py.

Searching by words finds a passage only if it uses the words typed. This index
lets the Texts page find passages that are about what was typed: every passage
of the English translations is turned into a list of numbers (an embedding) by
a small language model, and the search page does the same to the question, in
the visitor's browser, and shows the passages whose numbers lie closest. There
is no server: the browser fetches the model and this index from the bucket.

  passages  each page's English sentences, taken in runs of up to WORDS words
  model     BAAI/bge-small-en-v1.5 (the browser uses the same model in its
            compact form, web/models/Xenova/bge-small-en-v1.5)
  size      the 384 numbers of each passage are reduced to DIMS by principal
            components and stored as one byte each, so the whole index is a
            few megabytes

Writes <work_dir>/web/meaning/, uploaded to web/meaning/ in the bucket:
  meta.json        model, dimensions, number of passages, the instruction put before a question
  docs.json        the objects, in the order their numbers refer to
  chunks.json      for every passage: object number, page, first sentence, number of sentences
  vectors.bin      passages x DIMS signed bytes
  projection.bin   float32: the mean (384) followed by the components (DIMS x 384)

A resemblance in meaning is a suggestion: the model was trained on modern
English, and it reads a machine translation of machine-read text.
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

BUCKET = "r2:sicalipsis-files"
MODEL = "BAAI/bge-small-en-v1.5"
BROWSER_MODEL = "Xenova/bge-small-en-v1.5"
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
WORDS, MIN_WORDS, DIMS = 150, 12, 256


def passages(pages):
    """(page, first sentence, number of sentences, text) for runs of English sentences on each page."""
    for page in pages:
        run, start, words = [], 0, 0
        for i, sentence in enumerate(page["en"]):
            if not sentence:
                continue
            if not run:
                start = i
            run.append(sentence)
            words += len(sentence.split())
            if words >= WORDS:
                yield page["n"], start, i - start + 1, " ".join(run)
                run, words = [], 0
        if run and words >= MIN_WORDS:
            yield page["n"], start, len(page["en"]) - start, " ".join(run)


def embed(texts):
    import torch
    from transformers import AutoModel, AutoTokenizer
    device = "cuda" if torch.cuda.is_available() else "cpu"
    tokenizer = AutoTokenizer.from_pretrained(MODEL)
    model = AutoModel.from_pretrained(MODEL).to(device).eval()
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
    out = np.zeros((len(texts), model.config.hidden_size), dtype=np.float32)
    with torch.no_grad():
        for at in range(0, len(order), 128):
            batch = order[at:at + 128]
            inputs = tokenizer([texts[i] for i in batch], padding=True, truncation=True, max_length=512,
                               return_tensors="pt").to(device)
            vectors = torch.nn.functional.normalize(model(**inputs).last_hidden_state[:, 0], dim=-1)   # the [CLS] vector
            out[batch] = vectors.float().cpu().numpy()
            if at % (128 * 40) == 0:
                print(f"  {at}/{len(order)} passages", flush=True)
    return out


def main():
    data, work = Path(sys.argv[1]), Path(sys.argv[2])
    state = json.loads((data / "published" / "translations.json").read_text(encoding="utf-8"))
    docs, meta, texts = [], {"doc": [], "page": [], "start": [], "count": []}, []
    for oid in sorted(state):
        path = work / "web" / "translation" / f"{oid}.json"
        if not path.exists():
            continue
        found = list(passages(json.loads(path.read_text(encoding="utf-8"))["pages"]))
        if not found:
            continue
        for page, start, count, text in found:
            meta["doc"].append(len(docs)); meta["page"].append(page); meta["start"].append(start); meta["count"].append(count)
            texts.append(text)
        docs.append(oid)
    print(f"{len(docs)} objects, {len(texts)} passages", flush=True)
    vectors = embed(texts)

    # Principal components, from a sample; every vector is then reduced, made unit length and stored as bytes.
    rng = np.random.default_rng(0)
    sample = vectors[rng.choice(len(vectors), size=min(len(vectors), 20000), replace=False)]
    mean = sample.mean(axis=0)
    _, _, components = np.linalg.svd(sample - mean, full_matrices=False)
    components = components[:DIMS].astype(np.float32)
    reduced = (vectors - mean) @ components.T
    reduced /= np.maximum(np.linalg.norm(reduced, axis=1, keepdims=True), 1e-9)
    small = np.clip(np.round(reduced * 127), -127, 127).astype(np.int8)

    # How much the reduction costs: do the nearest passages stay the same?
    probe = rng.choice(len(vectors), size=min(200, len(vectors)), replace=False)
    full_top = np.argsort(-(vectors[probe] @ vectors.T), axis=1)[:, 1:11]
    small_top = np.argsort(-(small[probe].astype(np.float32) @ small.T.astype(np.float32)), axis=1)[:, 1:11]
    kept = np.mean([len(set(a) & set(b)) / 10 for a, b in zip(full_top, small_top)])
    print(f"of each passage's ten nearest, {kept:.0%} are still among the ten nearest after the reduction")

    out = work / "web" / "meaning"
    out.mkdir(parents=True, exist_ok=True)
    (out / "docs.json").write_text(json.dumps(docs), encoding="utf-8")
    (out / "chunks.json").write_text(json.dumps(meta, separators=(",", ":")), encoding="utf-8")
    small.tofile(out / "vectors.bin")
    np.concatenate([mean.astype(np.float32), components.ravel()]).tofile(out / "projection.bin")
    (out / "meta.json").write_text(json.dumps({"model": BROWSER_MODEL, "source_dims": int(vectors.shape[1]), "dims": DIMS,
                                               "passages": len(texts), "query_prefix": QUERY_PREFIX}), encoding="utf-8")
    print(f"{len(texts)} passages -> {out} ({(out / 'vectors.bin').stat().st_size / 1e6:.1f} MB of vectors)")
    if "--no-upload" not in sys.argv:
        result = subprocess.run(["rclone", "copy", str(out), f"{BUCKET}/web/meaning"], capture_output=True, text=True)
        print("uploaded to the bucket" if result.returncode == 0 else f"upload failed: {result.stderr[-200:]}")


if __name__ == "__main__":
    main()
