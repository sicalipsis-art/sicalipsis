"""Tag images with a fixed vocabulary: labels checked and extended by a classifier.

Usage: python tag_images.py <data_dir> <thumb_dir>

<thumb_dir> holds one folder per object with a thumb.jpg inside (the layout of
web/images/ in the bucket); every picture in it is tagged.

How it works
  1. Each picture is turned into an embedding by the SigLIP 2 image model
     (kept in <data_dir>/tags/embeddings.npz, so pictures are read only once).
  2. <data_dir>/tags/labels.csv holds the labels given so far (columns objectid,
     tag_type, tag_figures, tag_dress, tag_themes, labelled_by, reviewed). Only
     tags from tools/tag_vocabulary.json are accepted. A row with every tag
     left empty means the picture is not to be tagged.
  3. For every facet a small classifier (logistic regression) is trained on the
     embeddings of the labelled pictures. It is first tested on pictures it was
     not trained on (five-fold cross-validation); the scores are printed and
     saved in <data_dir>/tags/accuracy.csv.
  4. A labelled picture keeps its labels. Where the classifier, without having
     seen that picture, confidently disagrees, the disagreement is written in
     the "check" column: these are the labels most worth a second look.
  5. A picture without labels gets the classifier's tags. A single-choice tag
     below CONFIDENT is left empty and listed in "check" instead.
  6. Colour is measured from the pixels.

Writes <data_dir>/tags/image_tags.csv, one row per picture. build_master.py
copies these tags into the master spreadsheet.

Needs PyTorch, transformers and scikit-learn; uses the GPU when there is one.
Nothing leaves this computer except the model download on first use.
"""
import csv
import json
import sys
import warnings
from pathlib import Path

import numpy as np
from PIL import Image

BATCH = 8
CONFIDENT = 0.6      # below this a predicted single-choice tag is left empty
DISAGREE = 0.8       # the classifier must be this sure before a label is queried
MIN_EXAMPLES = 8     # a theme needs this many labelled examples to be predicted
STRENGTH = 10.0      # logistic regression C
COLOUR_SPREAD = 4.3   # see colour_spread: monochrome pictures measured 2.0-3.8, colour ones 4.8 and up


def colour_spread(image):
    """How much colour varies among pixels of the same brightness.

    In a one-colour picture (black and white, sepia, any toned print on any
    paper) the colour of a pixel follows from how dark it is. In a colour
    picture, pixels of the same brightness have different colours.
    """
    a = np.asarray(image.convert("YCbCr").resize((96, 96)), dtype=np.float32).reshape(-1, 3)
    band = np.minimum((a[:, 0] / 256 * 12).astype(int), 11)
    total = sum(float((band == b).sum() * a[band == b, 1:].var(axis=0).sum())
                for b in range(12) if (band == b).sum() >= 8)
    return (total / len(a)) ** 0.5


def colour_of(image):
    return "Colour" if colour_spread(image) > COLOUR_SPREAD else "Monochrome"


def embed(paths, store, model_name):
    todo = [i for i in paths if i not in store]
    if not todo:
        return
    import torch
    from transformers import AutoModel, AutoProcessor
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32
    model = AutoModel.from_pretrained(model_name, dtype=dtype).to(device).eval()
    processor = AutoProcessor.from_pretrained(model_name)
    for start in range(0, len(todo), BATCH):
        ids = todo[start:start + BATCH]
        inputs = processor(images=[Image.open(paths[i]).convert("RGB") for i in ids], return_tensors="pt").to(device)
        inputs = {k: (v.to(dtype) if v.is_floating_point() else v) for k, v in inputs.items()}
        with torch.no_grad():
            out = model.get_image_features(**inputs)
        out = out if torch.is_tensor(out) else out.pooler_output
        out = torch.nn.functional.normalize(out.float(), dim=-1).cpu().numpy()
        for i, e in zip(ids, out):
            store[i] = e.astype(np.float32)
        print(f"  embedded {min(start + BATCH, len(todo))}/{len(todo)}", flush=True)


def main():
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import StratifiedKFold, cross_val_predict

    data, thumbs = Path(sys.argv[1]), Path(sys.argv[2])
    vocab = json.loads((Path(__file__).resolve().parent / "tag_vocabulary.json").read_text(encoding="utf-8"))
    out_dir = data / "tags"
    out_dir.mkdir(parents=True, exist_ok=True)

    paths = {p.parent.name: p for p in sorted(thumbs.glob("*/thumb.jpg"))}
    ids = list(paths)
    store_path = out_dir / "embeddings.npz"
    store = dict(np.load(store_path)) if store_path.exists() else {}
    embed(paths, store, vocab["model"])
    np.savez_compressed(store_path, **store)
    X = np.stack([store[i] for i in ids])

    labels = {}
    if (out_dir / "labels.csv").exists():
        with open(out_dir / "labels.csv", encoding="utf-8-sig", newline="") as fh:
            labels = {r["objectid"]: r for r in csv.DictReader(fh)}
    allowed = {f["column"]: [t["label"] for t in f["tags"]] for f in vocab["facets"]}
    for oid, row in labels.items():
        for col, tags in allowed.items():
            for value in filter(None, (v.strip() for v in row[col].split(";"))):
                if value not in tags:
                    sys.exit(f"labels.csv: {oid} has {col} = {value!r}, which is not in the vocabulary")
    # A row in labels.csv with no tags at all means "do not tag this picture" (see its note).
    withheld = [i for i in ids if i in labels and not any(labels[i][c].strip() for c in allowed)]
    ids = [i for i in ids if i not in withheld]
    X = np.stack([store[i] for i in ids])
    known = np.array([i in labels for i in ids])
    print(f"{len(ids)} pictures, {known.sum()} labelled", flush=True)
    if known.sum() < 50:
        sys.exit("Embeddings saved. Label at least 50 pictures in labels.csv before tags can be made.")

    def classifier():
        return LogisticRegression(C=STRENGTH, max_iter=3000, class_weight="balanced")

    result = {i: {"objectid": i, "tag_colour": colour_of(Image.open(paths[i])),
                  "source": "labelled" if i in labels else "classifier", "check": []} for i in ids}
    accuracy = []
    warnings.filterwarnings("ignore", message="The least populated class")
    folds = StratifiedKFold(5, shuffle=True, random_state=0)

    for facet in vocab["facets"]:
        col, name = facet["column"], facet["name"]
        if facet["kind"] == "single":
            y = np.array([labels[i][col] if i in labels else "" for i in ids])
            Xk, yk = X[known], y[known]
            common = np.isin(yk, [c for c in set(yk) if (yk == c).sum() >= 5])   # too rare to test
            held_out = cross_val_predict(classifier(), Xk[common], yk[common], cv=folds, method="predict_proba")
            classes = np.array(sorted(set(yk[common])))
            guess = classes[held_out.argmax(axis=1)]
            accuracy.append({"facet": name, "tag": "(all)", "labelled": int(common.sum()),
                             "agreement": round(float((guess == yk[common]).mean()), 3)})
            for c in classes:
                mine, theirs = guess == c, yk[common] == c
                accuracy.append({"facet": name, "tag": c, "labelled": int(theirs.sum()),
                                 "precision": round(float((mine & theirs).sum() / max(mine.sum(), 1)), 2),
                                 "recall": round(float((mine & theirs).sum() / max(theirs.sum(), 1)), 2)})
            for oid, g, p, truth in zip(np.array(ids)[known][common], guess, held_out.max(axis=1), yk[common]):
                result[oid][col] = truth
                if g != truth and p >= DISAGREE:
                    result[oid]["check"].append(f"{name}: labelled {truth}, classifier suggests {g} ({p:.2f})")
            for oid, truth in zip(np.array(ids)[known][~common], yk[~common]):
                result[oid][col] = truth
            if (~known).any():
                model = classifier().fit(Xk, yk)
                probs = model.predict_proba(X[~known])
                for oid, pr in zip(np.array(ids)[~known], probs):
                    best = int(pr.argmax())
                    if pr[best] >= CONFIDENT:
                        result[oid][col] = model.classes_[best]
                    else:
                        second = int(np.argsort(pr)[-2])
                        result[oid][col] = ""
                        result[oid]["check"].append(
                            f"{name}: {model.classes_[best]} ({pr[best]:.2f}) or {model.classes_[second]}?")
        else:
            chosen = {i: ([v.strip() for v in labels[i][col].split(";") if v.strip()] if i in labels else [])
                      for i in ids}
            scores = {i: [] for i in ids}
            for tag in allowed[col]:
                y = np.array([tag in chosen[i] for i in ids])
                yk = y[known]
                if yk.sum() < MIN_EXAMPLES:
                    accuracy.append({"facet": name, "tag": tag, "labelled": int(yk.sum()),
                                     "note": "too few examples: labelled by hand only"})
                    continue
                held_out = cross_val_predict(classifier(), X[known], yk, cv=folds, method="predict_proba")[:, 1]
                mine = held_out >= 0.5
                accuracy.append({"facet": name, "tag": tag, "labelled": int(yk.sum()),
                                 "precision": round(float((mine & yk).sum() / max(mine.sum(), 1)), 2),
                                 "recall": round(float((mine & yk).sum() / max(yk.sum(), 1)), 2)})
                for oid, p, truth in zip(np.array(ids)[known], held_out, yk):
                    if truth and p <= 1 - DISAGREE:
                        result[oid]["check"].append(f"{name}: labelled {tag}, classifier doubts it ({p:.2f})")
                    elif not truth and p >= DISAGREE:
                        result[oid]["check"].append(f"{name}: classifier suggests adding {tag} ({p:.2f})")
                if (~known).any():
                    model = classifier().fit(X[known], yk)
                    for oid, p in zip(np.array(ids)[~known], model.predict_proba(X[~known])[:, 1]):
                        if p >= CONFIDENT:
                            scores[oid].append((p, tag))
            for i in ids:
                if i not in labels:
                    chosen[i] = [t for _, t in sorted(scores[i], reverse=True)[:facet.get("max", 3)]]
                order = allowed[col]
                result[i][col] = "; ".join(sorted(chosen[i], key=order.index))

    columns = ["objectid"] + [f["column"] for f in vocab["facets"]]
    columns[columns.index("tag_themes"):columns.index("tag_themes")] = ["tag_colour"]
    columns += ["source", "check"]
    with open(out_dir / "image_tags.csv", "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=columns, restval="")
        w.writeheader()
        for i in ids:
            w.writerow(dict(result[i], check=" | ".join(result[i]["check"])))
        for i in withheld:
            w.writerow({"objectid": i, "source": "not tagged", "check": labels[i].get("note", "")})
    with open(out_dir / "accuracy.csv", "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["facet", "tag", "labelled", "agreement", "precision", "recall", "note"],
                           restval="")
        w.writeheader()
        w.writerows(accuracy)
    for a in accuracy:
        if a["tag"] == "(all)":
            print(f"  {a['facet']}: classifier agrees with {a['agreement']:.0%} of {a['labelled']} labels "
                  "it was not shown", flush=True)
    queried = sum(1 for i in ids if result[i]["check"])
    print(f"tags for {len(ids)} pictures -> {out_dir / 'image_tags.csv'}; {queried} have something to check")


if __name__ == "__main__":
    main()
