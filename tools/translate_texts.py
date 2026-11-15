"""Translate the collection's texts into English with a translation model on this computer.

Usage: python translate_texts.py <data_dir> <work_dir> [--model NAME] [--limit N] [--only id,id,...] [--no-upload]

Run it with the OCR environment's Python (it needs torch, transformers and sentencepiece).

For each published object that has text (the OCR text where there is some,
otherwise the text layer of its PDF; fetch them first as in README step 5):
  1. the lines of each page are joined into paragraphs (words broken at a line
     end are put back together) and the paragraphs cut into sentences;
  2. the sentences are translated from Spanish into English;
  3. <work_dir>/web/translation/<objectid>.json is written and uploaded to
     web/translation/ in the bucket: for every page, the Spanish sentences
     ("es"), their English translations in the same order ("en"), and the
     number of sentences in each paragraph ("p").

Progress is kept in <data_dir>/published/translations.json. An object is done
again when its text has changed (for instance when OCR has replaced a PDF's
text layer), so it is safe to run this after every OCR batch.

The translation is a reading aid: the model works sentence by sentence, knows
nothing of the period's slang, and translates the reading errors of OCR along
with the text. The site says so wherever the English is shown.
"""
import hashlib
import json
import re
import subprocess
import sys
import time
from pathlib import Path

BUCKET = "r2:sicalipsis-files"
MODEL = "Helsinki-NLP/opus-mt-es-en"
MIN_TEXT = 300          # characters: less than this is not a text
MAX_PIECE = 380         # characters: longer sentences are cut at a comma or semicolon
BATCH = 128
PAGE = re.compile(r"=== page (\d+) ===")
END = re.compile(r"(?<=[.!?…»”\"])\s+(?=[A-ZÁÉÍÓÚÑÜ¿¡—–\-«“\"(])")


def paragraphs(page_text):
    """The page's lines joined into paragraphs; a word broken at a line end is mended."""
    blocks = re.split(r"\n\s*\n", page_text) if "\n\n" in page_text.strip() else [page_text]
    out = []
    for block in blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        text = ""
        for line in lines:
            if text.endswith("-") and line[:1].islower():
                text = text[:-1] + line
            else:
                text = f"{text} {line}" if text else line
        if not text:
            continue
        text = " ".join(text.split())
        # A paragraph that the page layout cut in two: the first part stops in mid-sentence
        # and the next begins with a small letter.
        if out and text[:1].islower() and out[-1][-1:] not in ".!?…:»”\"" and not out[-1].isupper():
            out[-1] = out[-1][:-1] + text if out[-1].endswith("-") else f"{out[-1]} {text}"
        else:
            out.append(text)
    return out


def sentences(paragraph):
    pieces = []
    for sentence in END.split(paragraph):
        sentence = sentence.strip()
        while len(sentence) > MAX_PIECE:
            cut = max(sentence.rfind(mark, 0, MAX_PIECE) for mark in ("; ", ", ", " "))
            cut = cut + 1 if cut > 60 else MAX_PIECE
            pieces.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        if sentence:
            pieces.append(sentence)
    return pieces


def readable(piece):
    """Worth giving to the model: mostly letters, and not a line the OCR gave up on."""
    letters = sum(ch.isalpha() for ch in piece)
    return letters >= 2 and letters / max(1, len(piece.replace(" ", ""))) >= 0.4 and "[illegible]" not in piece


def for_model(piece):
    """Headings set in capitals are given to the model in ordinary case, which it translates far better."""
    piece = piece.strip("*•·~_=|<>#^ ") or piece          # printers' ornaments around a heading
    letters = [ch for ch in piece if ch.isalpha()]
    return piece.capitalize() if len(letters) >= 4 and all(ch.isupper() for ch in letters) else piece


class Translator:
    def __init__(self, name):
        import torch
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
        self.torch = torch
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.nllb = "nllb" in name.lower()
        self.tokenizer = AutoTokenizer.from_pretrained(name, **({"src_lang": "spa_Latn"} if self.nllb else {}))
        self.model = AutoModelForSeq2SeqLM.from_pretrained(
            name, dtype=torch.float16 if self.device == "cuda" else torch.float32).to(self.device).eval()
        self.extra = {"forced_bos_token_id": self.tokenizer.convert_tokens_to_ids("eng_Latn")} if self.nllb else {}

    def translate(self, pieces):
        """English for every piece, in the same order; pieces that are not readable come back empty."""
        out = [""] * len(pieces)
        todo = sorted((i for i, p in enumerate(pieces) if readable(p)), key=lambda i: len(pieces[i]))
        for start in range(0, len(todo), BATCH):
            chunk = todo[start:start + BATCH]
            inputs = self.tokenizer([for_model(pieces[i]) for i in chunk], return_tensors="pt", padding=True, truncation=True,
                                    max_length=256).to(self.device)
            with self.torch.no_grad():
                result = self.model.generate(**inputs, num_beams=2, max_new_tokens=256, no_repeat_ngram_size=6,
                                             **self.extra)
            for i, text in zip(chunk, self.tokenizer.batch_decode(result, skip_special_tokens=True)):
                text = " ".join(text.split())
                # A translation several times longer than its source is the model repeating itself.
                out[i] = text if len(text) <= 3 * len(pieces[i]) + 40 else ""
        return out


def read_pages(path):
    """[(page number, [Spanish sentences], [sentences in each paragraph])] for a text file with '=== page N ===' markers."""
    parts = PAGE.split(path.read_text(encoding="utf-8", errors="replace"))
    pages = []
    for number, body in zip(parts[1::2], parts[2::2]):
        split = [sentences(p) for p in paragraphs(body)]
        pages.append((int(number), [s for group in split for s in group], [len(group) for group in split if group]))
    return pages


def source_of(work, oid):
    for kind in ("ocr", "text"):
        path = work / "texts" / kind / f"{oid}.txt"
        if path.exists() and path.stat().st_size >= MIN_TEXT:
            return kind, path
    return None, None


def main():
    data, work = Path(sys.argv[1]), Path(sys.argv[2])
    option = lambda name: sys.argv[sys.argv.index(name) + 1] if name in sys.argv else None
    model_name = option("--model") or MODEL
    limit = int(option("--limit")) if option("--limit") else None
    only = set(option("--only").split(",")) if option("--only") else None
    state_path = data / "published" / "translations.json"
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
    published = json.loads((data / "published" / "published.json").read_text(encoding="utf-8"))
    todo = []
    for oid in published:
        kind, path = source_of(work, oid)
        if not path or (only and oid not in only):
            continue
        digest = hashlib.md5(path.read_bytes()).hexdigest()
        done = state.get(oid)
        if not done or done["text_md5"] != digest or done["model"] != model_name:
            if any(len(pieces) for _, pieces, _ in read_pages(path)):     # an empty text layer is not a text
                todo.append((path.stat().st_size, oid, kind, path, digest))
    todo.sort()                                           # short documents first
    if limit:
        todo = todo[:limit]
    print(f"{len(published)} published objects, {len(state)} already translated, {len(todo)} to do now", flush=True)
    if not todo:
        return
    translator = Translator(model_name)
    out_dir = work / "web" / "translation"
    out_dir.mkdir(parents=True, exist_ok=True)
    for n, (_, oid, kind, path, digest) in enumerate(todo, 1):
        started = time.time()
        try:
            pages = read_pages(path)
            flat = [s for _, pieces, _ in pages for s in pieces]
            english = translator.translate(flat)
            result, at = {"objectid": oid, "model": model_name, "source": kind, "pages": []}, 0
            for number, pieces, sizes in pages:
                result["pages"].append({"n": number, "es": pieces, "en": english[at:at + len(pieces)], "p": sizes})
                at += len(pieces)
            target = out_dir / f"{oid}.json"
            target.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            if "--no-upload" not in sys.argv:
                done = subprocess.run(["rclone", "copyto", str(target), f"{BUCKET}/web/translation/{oid}.json"],
                                      capture_output=True, text=True)
                if done.returncode:
                    raise RuntimeError(f"upload failed: {done.stderr[-160:]}")
            words = sum(len(s.split()) for s in flat)
            state[oid] = {"pages": len(pages), "sentences": len(flat), "words": words, "source": kind,
                          "text_md5": digest, "model": model_name, "seconds": round(time.time() - started)}
            state_path.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
            print(f"[{n}/{len(todo)}] {oid}  {len(pages):4} pages  {words:7} words  "
                  f"{words / max(1.0, time.time() - started):6.0f} words/s  ({kind})", flush=True)
        except Exception as exc:
            print(f"[{n}/{len(todo)}] {oid}  FAILED: {str(exc)[:200]}", flush=True)
            try:
                translator.torch.cuda.empty_cache()
            except Exception:
                pass
    print(f"translated so far: {len(state)} documents, {sum(v['words'] for v in state.values())} words")


if __name__ == "__main__":
    main()
