"""Tag images with a fixed vocabulary, using the SigLIP 2 image-text model.

Usage:
  python tag_images.py <data_dir> <work_dir> <public_web_url> [--section NAME] [--local DIR] [--only id,id]

Tags come only from tools/tag_vocabulary.json. For every published object in the
chosen section (default "Image Gallery") the first page image is fetched from
<public_web_url>/images/<objectid>/0001.jpg (or read from --local DIR, laid out
the same way), turned into an embedding, and compared with the vocabulary's
phrases:

  single facets  the tag whose phrases match best; its share of the match is the
                 confidence
  multi facets   each tag is weighed against its own "no" phrases; it is assigned
                 at or above assign_threshold, and listed for review between
                 review_threshold and assign_threshold
  Colour         measured from the pixels, not guessed by the model

Writes <data_dir>/tags/image_tags.csv (one row per object, with confidences and
a review column) and <data_dir>/tags/embeddings.npz (kept so a classifier can
later be trained on corrected tags without re-reading the images).

Needs PyTorch and transformers; uses the GPU when there is one. Nothing leaves
this computer except the model download from Hugging Face on first use.
"""
import csv
import json
import sys
import urllib.request
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from transformers import AutoModel, AutoProcessor

BATCH = 8
TEMPLATE = "{}"


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def colour_of(image):
    """Black and white, Tinted (one hue, e.g. sepia) or Colour, from pixel statistics."""
    small = np.asarray(image.convert("RGB").resize((96, 96)), dtype=np.float32) / 255
    mx, mn = small.max(axis=2), small.min(axis=2)
    chroma = mx - mn
    if np.percentile(chroma, 90) < 0.08:
        return "Black and white"
    hsv = np.asarray(image.convert("HSV").resize((96, 96)), dtype=np.float32)
    strong = chroma > 0.10
    if strong.sum() < 50:
        return "Black and white"
    angles = hsv[..., 0][strong] / 255 * 2 * np.pi
    spread = 1 - np.hypot(np.cos(angles).mean(), np.sin(angles).mean())  # 0 = one hue
    return "Tinted" if spread < 0.12 else "Colour"


def features(output):
    tensor = output if torch.is_tensor(output) else output.pooler_output
    return torch.nn.functional.normalize(tensor.float(), dim=-1)


def main():
    data, work, web = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3].rstrip("/")
    section, local = arg("--section", "Image Gallery"), arg("--local")
    only = set(arg("--only").split(",")) if arg("--only") else None
    vocab = json.loads((Path(__file__).resolve().parent / "tag_vocabulary.json").read_text(encoding="utf-8"))
    out_dir = data / "tags"
    out_dir.mkdir(parents=True, exist_ok=True)

    with open(data / "published" / "rows.csv", encoding="utf-8-sig", newline="") as fh:
        rows = [r for r in csv.DictReader(fh)
                if (section == "all" or r["section"] == section) and (only is None or r["objectid"] in only)]
    cache = work / "tag-images"
    cache.mkdir(parents=True, exist_ok=True)
    paths = {}
    for r in rows:
        oid = r["objectid"]
        path = Path(local) / oid / "0001.jpg" if local else cache / f"{oid}.jpg"
        if not path.exists() and not local:
            req = urllib.request.Request(f"{web}/images/{oid}/0001.jpg", headers={"User-Agent": "Mozilla/5.0"})
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    path.write_bytes(resp.read())
            except Exception as exc:
                print(f"  {oid}: image not available ({exc})", flush=True)
        if path.exists():
            paths[oid] = path
    rows = [r for r in rows if r["objectid"] in paths]
    print(f"{len(rows)} images to tag in section {section!r}", flush=True)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32
    model = AutoModel.from_pretrained(vocab["model"], dtype=dtype).to(device).eval()
    processor = AutoProcessor.from_pretrained(vocab["model"])
    scale = float(model.logit_scale.exp())

    def embed_text(phrases):
        inputs = processor(text=[TEMPLATE.format(p) for p in phrases], padding="max_length",
                           max_length=64, truncation=True, return_tensors="pt").to(device)
        with torch.no_grad():
            emb = features(model.get_text_features(**inputs))
        return torch.nn.functional.normalize(emb.mean(dim=0), dim=-1)  # one vector per tag

    for facet in vocab["facets"]:
        for tag in facet["tags"]:
            tag["_yes"] = embed_text(tag["yes"])
            if facet["kind"] == "multi":
                tag["_no"] = embed_text(tag["no"])

    old = dict(np.load(out_dir / "embeddings.npz")) if (out_dir / "embeddings.npz").exists() else {}
    store = {k: v for k, v in old.items()}
    todo = [r["objectid"] for r in rows if r["objectid"] not in store]
    for start in range(0, len(todo), BATCH):
        ids = todo[start:start + BATCH]
        images = [Image.open(paths[i]).convert("RGB") for i in ids]
        inputs = processor(images=images, return_tensors="pt").to(device)
        inputs = {k: (v.to(dtype) if v.is_floating_point() else v) for k, v in inputs.items()}
        with torch.no_grad():
            emb = features(model.get_image_features(**inputs)).cpu().numpy()
        for i, e in zip(ids, emb):
            store[i] = e.astype(np.float32)
        print(f"  embedded {min(start + BATCH, len(todo))}/{len(todo)}", flush=True)
    np.savez_compressed(out_dir / "embeddings.npz", **store)

    assign, review = vocab["assign_threshold"], vocab["review_threshold"]
    out_rows = []
    for r in rows:
        oid = r["objectid"]
        e = torch.from_numpy(store[oid]).to(device)
        result = {"objectid": oid, "title": r["title"], "tag_colour": colour_of(Image.open(paths[oid]))}
        to_review = []
        for facet in vocab["facets"]:
            col = facet["column"]
            if facet["kind"] == "single":
                sims = torch.stack([e @ t["_yes"] for t in facet["tags"]])
                probs = torch.softmax(scale * sims, dim=0).cpu().numpy()
                best = int(probs.argmax())
                result[col] = facet["tags"][best]["label"]
                result[col + "_confidence"] = round(float(probs[best]), 2)
                if probs[best] < review:
                    second = int(np.argsort(probs)[-2])
                    to_review.append(f"{facet['name']}: {facet['tags'][best]['label']} or {facet['tags'][second]['label']}?")
            else:
                chosen, scores = [], []
                for t in facet["tags"]:
                    p = float(torch.softmax(scale * torch.stack([e @ t["_yes"], e @ t["_no"]]), dim=0)[0])
                    if p >= assign:
                        chosen.append(t["label"])
                        scores.append(f"{t['label']} {p:.2f}")
                    elif p >= review:
                        to_review.append(f"{t['label']}? ({p:.2f})")
                result[col] = "; ".join(chosen)
                result[col + "_confidence"] = "; ".join(scores)
        result["review"] = " | ".join(to_review)
        out_rows.append(result)

    columns = ["objectid", "title", "tag_type", "tag_type_confidence", "tag_figures",
               "tag_figures_confidence", "tag_colour", "tag_depicts", "tag_depicts_confidence", "review"]
    with open(out_dir / "image_tags.csv", "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=columns)
        w.writeheader()
        w.writerows(out_rows)
    print(f"tagged {len(out_rows)} images -> {out_dir / 'image_tags.csv'}; "
          f"{sum(1 for r in out_rows if r['review'])} have something to review")


if __name__ == "__main__":
    main()
