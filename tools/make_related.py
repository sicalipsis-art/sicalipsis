"""Work out, for every published object, which other objects look like it and which read like it.

Usage: python make_related.py <data_dir> <work_dir> <public_root_url> [--no-upload]

Two independent comparisons, both made on this computer:

  looks like   each object's first page image is turned into an embedding by the
               SigLIP 2 image model (the same one tag_images.py uses); the
               nearest objects in that space are the ones that look alike.
  reads like   each object's text (OCR text where there is some, otherwise the
               text layer of its PDF) is weighed by its words (TF-IDF, reduced
               to 200 dimensions); the nearest objects use similar vocabulary.

For each object the six nearest are kept, at most three of them from its own
series, so that an issue of a magazine is not answered only with its other
issues. Similarity is a suggestion, not a statement about the works.

Texts and pictures are also connected to each other, in two cautious ways:

  same publication  a picture in the Image Gallery whose title names a
                    publication in the collection, or which is catalogued with
                    its source and issue number, is linked to that publication.
  strong match      each text's most telling general words (names are left out)
                    are compared with the gallery pictures through SigLIP 2's
                    shared text and image space; only matches at or above
                    STRONG are kept. Weaker matches were tried and are not
                    reliable enough to show.

Writes <work_dir>/web/related/related.json ({objectid: {"looks": [...], "reads": [...],
"pictures": [...], "texts": [...]}})
and uploads it to web/related/related.json in the bucket, where the item pages
read it. Embeddings are kept in <data_dir>/related/ so pictures are read once.
"""
import csv
import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tag_images import embed  # noqa: E402

BUCKET = "r2:sicalipsis-files"
KEEP, SAME_SERIES = 6, 3
MIN_TEXT = 1500          # characters: shorter texts say too little to compare
STRONG = 0.17            # a text and a picture are linked by content only at or above this similarity
GENERIC = {"postcard", "photograph", "vida galante", "erotic postcard series", "untitled"}
STOP = set("""a al algo algunas algunos ante antes como con contra cual cuando de del desde donde durante e el ella ellas
ellos en entre era eran es esa esas ese eso esos esta estaba estas este esto estos fue fueron ha habia han hasta hay
la las le les lo los mas me mi mis mucho muy ni no nos o os otra otras otro otros para pero poco por porque que quien
se sea ser si sido sin sobre son su sus tambien te tiene todo todos tu un una uno unos y ya yo the of and to in""".split())


def core(title):
    """A title reduced to its words, for comparing a picture's title with a publication's."""
    text = unicodedata.normalize("NFD", re.sub(r"\(.*?\)|\[.*?\]", " ", title).lower())
    text = re.sub(r"[^a-z0-9 ]+", " ", "".join(ch for ch in text if not unicodedata.combining(ch)))
    return " ".join(w for w in text.split() if w not in {"cover", "numero", "num", "no", "n"})


def issue_number(text):
    m = re.search(r"\bn(?:u|ú)m(?:ero)?\.?\s*(\d+)", text.lower())
    return m.group(1) if m else ""


def same_publication(rows):
    """(picture, publication) pairs that the catalogue itself supports."""
    gallery = [r for r in rows if r["section"] == "Image Gallery"]
    others = [(core(r["title"]), r) for r in rows if r["section"] != "Image Gallery"]
    pairs = []
    for g in gallery:
        named = core(g["title"])
        source = core(g["source"])
        number = g["description"].strip() if g["description"].strip().isdigit() else issue_number(g["identifier"])
        for title, other in others:
            if len(named) >= 9 and named not in GENERIC and (len(named) >= 14 or len(named.split()) >= 3) and named in title:
                pairs.append((g["objectid"], other["objectid"]))
            elif source and number and len(source) >= 4 and source in title and issue_number(other["title"]) == number:
                pairs.append((g["objectid"], other["objectid"]))
    return pairs


def strong_matches(texts, text_ids, store, gallery_ids, model_name):
    """(picture, text, score) where a text's general vocabulary matches a picture strongly."""
    import torch
    from sklearn.feature_extraction.text import TfidfVectorizer
    from transformers import AutoModel, AutoProcessor
    # Words used in many documents but not most: themes, not the names of characters.
    vectorizer = TfidfVectorizer(lowercase=True, stop_words=sorted(STOP), sublinear_tf=True, min_df=12, max_df=0.25,
                                 token_pattern=r"(?u)\b[^\W\d_]{4,}\b")
    weights = vectorizer.fit_transform([texts[i] for i in text_ids])
    terms = np.array(vectorizer.get_feature_names_out())
    queries = [" ".join(terms[np.argsort(-weights[n].toarray()[0])[:10]]) for n in range(len(text_ids))]
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = AutoModel.from_pretrained(model_name, dtype=torch.float16 if device == "cuda" else torch.float32).to(device).eval()
    processor = AutoProcessor.from_pretrained(model_name)
    parts = []
    with torch.no_grad():
        for start in range(0, len(queries), 32):
            inputs = processor(text=queries[start:start + 32], padding="max_length", max_length=64, truncation=True,
                               return_tensors="pt").to(device)
            out = model.get_text_features(**inputs)
            out = out if torch.is_tensor(out) else out.pooler_output
            parts.append(torch.nn.functional.normalize(out.float(), dim=-1).cpu().numpy())
    scores = np.concatenate(parts) @ np.stack([store[i] for i in gallery_ids]).T
    return [(gallery_ids[j], text_ids[i], float(scores[i, j])) for i, j in zip(*np.where(scores >= STRONG))]


def nearest(vectors, ids, series):
    """For each row, the KEEP most similar other rows, at most SAME_SERIES of them from its own series."""
    unit = vectors / np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-9)
    out = {}
    for i, oid in enumerate(ids):
        scores = unit @ unit[i]
        scores[i] = -1
        picked, own = [], 0
        for j in np.argsort(-scores)[:60]:
            if scores[j] <= 0.15:
                break
            same = bool(series[oid]) and series[ids[j]] == series[oid]
            if same and own >= SAME_SERIES:
                continue
            own += same
            picked.append(ids[j])
            if len(picked) == KEEP:
                break
        out[oid] = picked
    return out


def main():
    data, work, root = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3].rstrip("/")
    with open(data / "published" / "rows.csv", encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh))
    series = {r["objectid"]: (r["series"] or r["section"]) for r in rows}
    store_dir = data / "related"
    store_dir.mkdir(parents=True, exist_ok=True)

    # ----- looks like -----
    thumbs = work / "related" / "thumbs"
    listing = work / "related" / "thumbs.txt"
    thumbs.mkdir(parents=True, exist_ok=True)
    listing.write_text("\n".join(f"{r['objectid']}/thumb.jpg" for r in rows), encoding="utf-8")
    subprocess.run(["rclone", "copy", f"{BUCKET}/web/images", str(thumbs), "--files-from", str(listing),
                    "--transfers", "32"], check=True)
    paths = {r["objectid"]: thumbs / r["objectid"] / "thumb.jpg" for r in rows
             if (thumbs / r["objectid"] / "thumb.jpg").exists()}
    store_path = store_dir / "image_embeddings.npz"
    store = dict(np.load(store_path)) if store_path.exists() else {}
    vocabulary = json.loads((Path(__file__).resolve().parent / "tag_vocabulary.json").read_text(encoding="utf-8"))
    embed(paths, store, vocabulary["model"])
    np.savez_compressed(store_path, **store)
    ids = [oid for oid in paths if oid in store]
    looks = nearest(np.stack([store[i] for i in ids]), ids, series)
    print(f"looks like: {len(ids)} objects compared", flush=True)

    # ----- reads like -----
    from sklearn.decomposition import TruncatedSVD
    from sklearn.feature_extraction.text import TfidfVectorizer
    texts = {}
    for kind in ("text", "ocr"):                      # OCR text, where there is some, replaces the PDF's text layer
        for path in (work / "texts" / kind).glob("*.txt"):
            content = re.sub(r"=== page \d+ ===", " ", path.read_text(encoding="utf-8", errors="replace"))
            if len(content) >= MIN_TEXT and path.stem in series:
                texts[path.stem] = content
    text_ids = sorted(texts)
    weights = TfidfVectorizer(lowercase=True, strip_accents="unicode", stop_words=sorted(STOP), sublinear_tf=True,
                              min_df=3, max_df=0.5, token_pattern=r"(?u)\b[^\W\d_]{3,}\b").fit_transform(
        [texts[i] for i in text_ids])
    reduced = TruncatedSVD(n_components=min(200, weights.shape[1] - 1), random_state=0).fit_transform(weights)
    reads = nearest(reduced, text_ids, series)
    print(f"reads like: {len(text_ids)} objects with enough text compared", flush=True)

    # ----- a map: every object placed so that objects that look alike sit near each other -----
    from sklearn.manifold import TSNE
    flat = TSNE(n_components=2, perplexity=30, init="pca", random_state=0).fit_transform(np.stack([store[i] for i in ids]))
    flat = (flat - flat.min(axis=0)) / (flat.max(axis=0) - flat.min(axis=0))
    sections = sorted({r["section"] for r in rows})
    section_of = {r["objectid"]: sections.index(r["section"]) for r in rows}
    chart = {"sections": sections,
             "items": [[oid, round(float(x), 4), round(float(y), 4), section_of[oid]] for oid, (x, y) in zip(ids, flat)]}
    (work / "web" / "related").mkdir(parents=True, exist_ok=True)
    (work / "web" / "related" / "map.json").write_text(json.dumps(chart, ensure_ascii=False, separators=(",", ":")),
                                                         encoding="utf-8")

    # ----- texts and pictures -----
    gallery_ids = [r["objectid"] for r in rows if r["section"] == "Image Gallery" and r["objectid"] in store]
    pictures, with_text = {}, {}                      # text -> pictures, picture -> texts
    known = same_publication(rows)
    for picture, text in known:
        pictures.setdefault(text, []).append(picture)
        with_text.setdefault(picture, []).append(text)
    matched = sorted(strong_matches(texts, text_ids, store, gallery_ids, vocabulary["model"]), key=lambda m: -m[2])
    for picture, text, _ in matched:
        if picture not in pictures.setdefault(text, []):
            pictures[text].append(picture)
        if text not in with_text.setdefault(picture, []):
            with_text[picture].append(text)
    print(f"texts and pictures: {len(known)} links from the same publication, {len(matched)} strong matches; "
          f"{len(pictures)} texts and {len(with_text)} pictures connected", flush=True)

    related = {r["objectid"]: {"looks": looks.get(r["objectid"], []), "reads": reads.get(r["objectid"], []),
                               "pictures": pictures.get(r["objectid"], [])[:KEEP],
                               "texts": with_text.get(r["objectid"], [])[:KEEP]}
               for r in rows}
    out = work / "web" / "related" / "related.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(related, ensure_ascii=False), encoding="utf-8")
    print(f"{len(related)} objects -> {out} ({out.stat().st_size // 1024} KB)")
    if "--no-upload" not in sys.argv:
        result = subprocess.run(["rclone", "copy", str(out.parent), f"{BUCKET}/web/related"],
                                capture_output=True, text=True)
        print("uploaded to the bucket" if result.returncode == 0 else f"upload failed: {result.stderr[-200:]}")


if __name__ == "__main__":
    main()
