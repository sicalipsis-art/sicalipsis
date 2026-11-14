# Sicalipsis

Static site for *Sicalipsis — A Virtual Wunderkammer: Early Twentieth Century
Erotica in Spain*, replacing the Omeka site.

The site is built with [Canopy IIIF](https://github.com/nulib-ds/canopy) (started
from [canopy-template](https://github.com/nulib-ds/canopy-template), MIT).

**This repository holds code and pages only.** The collection itself — the
master spreadsheet, the Omeka harvest, the Box inventory, PDFs, images and IIIF
manifests — is kept out of GitHub and lives in the Cloudflare R2 bucket
`sicalipsis-files`. The site reads its works from IIIF manifests in that bucket
when it is built.

## Status (14 November 2026)

- The site is live at https://sicalipsis-art.github.io/sicalipsis/ with 1,366 of
  the collection's 1,368 objects. The two not shown are an item that never had
  a file and one file on the Omeka server that does not match its checksum.
- It follows the original site's arrangement: six sections, each with its
  introduction and its pages by magazine title, series or author, with the
  items in the original order.
- What a visitor can do:
  - browse the collections, each with a search box (keyword, artist, title,
    theme) and tags to tick;
  - open any item in a page-turning viewer, read its text where OCR has been
    done, and see items that look like it or read like it;
  - search the catalogue (**Search**) or the words on the pages (**Texts**);
  - explore the collection as a network of items that look alike and read alike
    (**Network**);
  - walk through the collection as a building (**Gallery walk**).
- Images and manifests are served from the bucket's public development address,
  `https://pub-86bc04aba3b948f081b236797ce9d2a6.r2.dev/web`. Cloudflare
  rate-limits that address and does not intend it for production; a custom
  domain should replace it before the site is announced (then run the
  publishing steps below again with the new address).
- The bucket's CORS policy allows `https://sicalipsis-art.github.io` only, so in
  a local preview the viewer cannot load manifests unless
  `http://localhost:5001` is added to the policy.
- The viewer shows one image per page, 1,600 pixels on its long side; the
  original scans are about that size, so deep-zoom tiles would add little.
- OCR has read part of the collection and is still running; see "Known gaps".

## Layout

| Path | What it is |
|---|---|
| `canopy.yml` | Canopy configuration: IIIF collection address, search filters, featured works, theme. Generated. |
| `content/` | Pages. `index.mdx`, `_app.mdx`, `walk/`, `texts/`, `navigation.yml` and the layouts are hand-written. `collections/<section>.mdx`, `collections/<section>/*.mdx` and `collections/tree.mdx` are generated. `about/index.mdx` holds the original site's About text. |
| `content/works/_layout.mdx` | The item page: viewer, text, similar items, catalogue record. |
| `app/styles/custom.css` | The site's look. |
| `app/components/mdx.tsx` | Registers the components below so pages can use them by name. |
| `app/components/SectionCards.tsx`, `PageCards.tsx` | Cards for the sections and for the pages inside a section; the collection tree. |
| `app/components/CollectionSearch.client.tsx` | The search box and tags on the collection pages. |
| `app/components/ViewerZoom.client.tsx` | In the item viewer, a double-click at full zoom returns to the whole page. |
| `app/components/ItemText.client.tsx` | "Read the text" on item pages: the OCR text, page by page. |
| `app/components/RelatedByContent.client.tsx` | "Looks like" and "Reads like" on item pages. |
| `app/components/TextSearch.client.tsx` | The Texts page: search inside the words on the pages. |
| `app/components/ContentMap.client.tsx` | The Network page: every item as a point, placed by visual similarity, with its "looks like" and "reads like" links. |
| `app/components/GalleryWalk.client.tsx` | The walk-through gallery (three.js): a building the visitor enters from a forecourt. Its entrance hall is the map: each section of the collection is a gallery, shown on the hall's walls by three of its own works, and a click on one goes in. Inside a gallery the works hang in a few large rooms by series or author and then by date. The visitor roams freely (drag or mouse look, keys or a click on the floor to walk), can open a map of the building at any time, and can look at any work up close in a viewer inside the gallery (zoom, pages). A list view is the accessible alternative. Reads `web/walk/works.json` from the bucket. |
| `app/data/gallery_periods.json` | Gallery settings: the order of the galleries and how many works a room holds. |
| `app/data/sections.json` | Section cards for the home page. Generated. |
| `app/data/site.json` | The bucket's public `web/` address, for components. Generated. |
| `tools/` | Python scripts, listed below. |
| `.github/workflows/deploy-pages.yml` | Builds and publishes to GitHub Pages on every push to `main`. |

### Tools

| Script | What it does |
|---|---|
| `harvest_omeka.py`, `harvest_exhibits.py` | Read the Omeka site's item records, and its exhibits (sections, pages, order). |
| `reconcile.py`, `match_titles.py`, `make_rescue_list.py`, `fetch_omeka_files.py` | Compare Omeka with Box; fetch files that only Omeka has, checking each against Omeka's checksum. |
| `build_master.py`, `dates.py` | Build the master spreadsheet; standardise and work out dates. |
| `publish_from_r2.py`, `make_iiif.py`, `refresh_manifests.py` | Make page images and IIIF manifests from the originals in the bucket; update manifests when the spreadsheet changes. |
| `make_site_content.py` | Generate `canopy.yml` and the collection pages. |
| `make_walk.py` | Write the gallery's data file. |
| `ocr_from_r2.py`, `make_annotations.py` | OCR the documents; attach the text to the manifests. |
| `make_related.py`, `make_text_index.py` | Similar items; the index for searching inside the texts. |
| `tag_images.py`, `contact_sheets.py`, `tag_vocabulary.json` | Image tags. |
| `serve_cors.py`, `pilot_select.py`, `peek_xlsx.py` | Small helpers. |

`site/`, `.cache/`, `node_modules/` and `data/` are never committed.

## Collection data (not in this repository)

The working copy sits next to this repository in `../data`, and is mirrored to
`r2:sicalipsis-files/project-data/`:

| Folder | What it is |
|---|---|
| `master/sicalipsis.csv` | **The master spreadsheet**: one row per object, CollectionBuilder-CSV columns plus provenance columns. |
| `omeka/` | Metadata harvested from the Omeka site (raw XML and CSVs), with Omeka's MD5 for every file. |
| `box/` | Listing of the Box folder with SHA-1 and MD5 checksums, and the Box inventory spreadsheets. |
| `reconciliation/` | Omeka-versus-Box comparison: identical files, title matches, unresolved files, rescue list. |
| `published/` | What has been published, OCR'd and annotated so far (state files the tools keep). |
| `tags/` | Image-tag labels, the classifier's check of them, and embeddings. |
| `related/` | Image embeddings used for "Looks like". |

In the bucket, `originals/` mirrors the Box folder, `originals-omeka/` holds
files that came from the Omeka site (directly or through the Internet
Archive), and `web/` holds what the site serves: `images/`, `iiif/` (manifests
and text annotations), `text/` and `ocr/` (plain text), `walk/` (gallery data),
`related/` (similar items) and `search/` (the text index).

To fetch the data on another computer, or to send local changes back:

```sh
rclone copy r2:sicalipsis-files/project-data ../data
rclone copy ../data r2:sicalipsis-files/project-data
```

## Preview the site

Needs Node 24.

```sh
npm install
npm run dev        # http://localhost:5001
```

Restart `npm run dev` after changing `canopy.yml` or `content/navigation.yml`;
those two files are read once at start-up. Stop it before `npm run build`: both
write to `site/`.

## Publishing on GitHub Pages

1. Give the bucket a public address (R2 > bucket > Settings > Public Development
   URL, or a custom domain) and a CORS policy that allows `GET` from
   `https://sicalipsis-art.github.io`.
2. Regenerate the manifests and pages with that address (steps 6 and 7 below)
   and upload the manifests to `web/iiif/` in the bucket.
3. On GitHub: Settings > Pages > Source: **GitHub Actions**. A free account can
   only publish Pages from a public repository.
4. Push to `main`. The workflow builds the site and publishes it at
   `https://sicalipsis-art.github.io/sicalipsis/`.

The workflow stops with an error, and publishes nothing, if the site contains
`localhost` addresses.

## Updating the collection

Python 3 with the packages in `tools/requirements.txt`, and `rclone` with two
remotes: `box` (the "sicalipsis data" Box folder) and `r2` (the
`sicalipsis-files` bucket). Credentials live in rclone's own configuration,
never in this repository.

Run the steps in order from the repository root. Every script can be re-run.

1. **Harvest Omeka metadata** (only when Omeka has changed). It fetches 134 small
   pages, slowly; the server went down during the first harvest, so agree a time
   with the server's administrators first.

   ```sh
   python tools/harvest_omeka.py https://sicalipsis.humanities.ucla.edu ../data/omeka
   ```

   Add `--no-sizes` to rebuild the CSVs from the saved XML without contacting
   the server.

2. **List Box and compute checksums.** The listing downloads nothing; the MD5
   pass reads every file as a stream (about 38 GB of network traffic, no disk).
   Run the second command once per top-level folder, naming the output file
   after the folder with spaces and commas replaced by underscores.

   ```sh
   rclone lsjson -R --hash --files-only "box:sicalipsis data" > ../data/box/box_listing.json
   rclone hashsum md5 --download "box:sicalipsis data/1. IMAGE GALLERY" --output-file "../data/box/md5/1._IMAGE_GALLERY.md5"
   ```

3. **Reconcile Omeka with Box.**

   ```sh
   python tools/reconcile.py ../data
   python tools/match_titles.py ../data
   python tools/make_rescue_list.py ../data
   ```

   `title_matches.csv` rows marked `check` need a person to confirm them.

4. **Copy Box to R2** (new and changed files only).

   ```sh
   rclone copy "box:sicalipsis data" r2:sicalipsis-files/originals --s3-upload-cutoff 1G
   ```

5. **Build the master spreadsheet.** Dates are standardised here, and missing
   ones worked out (`tools/dates.py`): from the record's date field, then the
   title, file name and publisher line, then a date printed in the document
   itself, and last an estimate from dated items of the same series. Each date
   carries its certainty (`recorded`, `derived`, `estimated`) and the evidence
   it rests on. Fetch the documents' text first so printed dates can be read:

   ```sh
   rclone copy r2:sicalipsis-files/web/text ../work/texts/text
   rclone copy r2:sicalipsis-files/web/ocr ../work/texts/ocr --include "*.txt"
   python tools/build_master.py ../data ../data/master/sicalipsis.csv --texts ../work/texts
   python tools/refresh_manifests.py ../data ../work     # update manifests already published
   ```

6. **Publish what is in the bucket.** For every object whose original has
   arrived in `originals/` and is not yet published, this downloads the file
   from R2, makes page images, thumbnail, text and the IIIF manifest, uploads
   them to `web/`, rebuilds `web/iiif/collection.json`, and writes
   `../data/published/rows.csv`. Run it again whenever more originals have
   arrived; finished objects are skipped.

   ```sh
   python tools/publish_from_r2.py ../data ../work <public bucket address>
   ```

   Files that exist only on the Omeka server (and were not recovered from the
   Internet Archive), unconfirmed title matches and the novelette page images
   are not published. Omeka files recovered from the Internet Archive are in
   `originals-omeka/` and are published like the rest. (`tools/make_iiif.py` does the same work for a
   hand-picked rows file and a local folder of originals; the pilot used it.)

7. **Regenerate the site's data-driven pages, then build.**

   ```sh
   python tools/make_site_content.py ../data/published/rows.csv ../data/master/sicalipsis.csv . <public bucket address>/web --exhibits ../data/omeka/exhibits
   npm run build      # output in site/
   ```

8. **Refresh the walk-through gallery's data.** This rewrites
   `web/walk/works.json` in the bucket from everything published; the gallery
   page picks it up without a new build.

   ```sh
   python tools/make_walk.py ../data ../work <public bucket address>
   ```

9. **Attach OCR text to the items.** After OCR (`tools/ocr_from_r2.py`, see
   `tools/requirements-ocr.txt`) has read more documents, this writes one IIIF
   annotation page per page image (each line of text pointing at its place on
   the page) and links them, and the plain text file, from the manifest. Item
   pages then show a "Read the text" section. Objects already done are skipped.

   ```sh
   python tools/make_annotations.py ../data ../work <public bucket address>
   ```

10. **Refresh "Looks like" and "Reads like".** Compares every object's first
    page image (SigLIP 2 embeddings) and every object's text (word weights),
    and writes each object's nearest neighbours to `web/related/related.json`
    and the layout of the Network page to `web/related/map.json` in the bucket;
    the item pages and the Network page read them without a new build.

    ```sh
    python tools/make_related.py ../data ../work <public bucket address>
    ```

11. **Refresh the index for searching inside the texts.** Fetch the texts
    first (as in step 5), then:

    ```sh
    python tools/make_text_index.py ../data ../work
    ```

12. **Mirror the data folder to the bucket** (see above), then commit and push the
   regenerated pages.

## The original site's arrangement

`tools/harvest_exhibits.py ../data` reads the Omeka site's exhibits (its menu
sections), their introductions, their pages and the items on each page in
order, one request at a time, into `../data/omeka/exhibits/`. From that:

- `tools/build_master.py` takes each item's section from the exhibit it stood in;
- `tools/make_site_content.py --exhibits` writes each section's page with the
  original introduction and one page per magazine title, series or author, with
  the items in the original order (continuation pages are joined to their
  parent; the Image Gallery, which was only numbered pages, is one page in the
  same order), and a collection tree;
- `tools/make_walk.py` gives each work its series or author, so the gallery's
  rooms follow the same order.

## Image tags

Pictures in the Image Gallery carry tags from a fixed vocabulary
(`tools/tag_vocabulary.json`): one **Image type**, one **Figures** tag, one
**Dress** tag, up to three **Themes**, and **Colour**. They appear in each
item's metadata and as search filters.

- `../data/tags/labels.csv` holds the labels, given picture by picture from
  contact sheets following the definitions in the vocabulary; rows the
  labeller was unsure of are marked, with a note. Corrections go in this file,
  with a name in the `reviewed` column.
- `tools/contact_sheets.py` makes the numbered contact sheets used for
  labelling and review.
- `tools/tag_images.py` turns every picture into an embedding with the SigLIP 2
  model and trains a small classifier per facet on the labels. It reports how
  often the classifier agrees with labels it was not shown
  (`../data/tags/accuracy.csv`), lists in the `check` column of
  `../data/tags/image_tags.csv` the labels it confidently disagrees with, and
  tags pictures that have no label yet. Colour is measured from the pixels.
- `tools/build_master.py` copies the tags into the master spreadsheet
  (`tag_*` columns); `tools/refresh_manifests.py` then writes them into the
  published manifests.

```sh
rclone copy r2:sicalipsis-files/web/images ../work/tags/thumbs --include "*/thumb.jpg"   # or only the gallery's
python tools/contact_sheets.py ../work/tags/thumbs ../work/tags/sheets
python tools/tag_images.py ../data ../work/tags/thumbs
```

A row in `labels.csv` with every tag left empty means "do not tag this
picture"; one item is held back this way for the team to decide on.

## Known gaps in the data

- **Two objects are not shown.** One item never had a file; one file on the
  Omeka server (item 913) does not match the checksum Omeka recorded for it.
- **Files that were already damaged on Omeka.** Eight PDFs were cut short when
  they were uploaded to Omeka (`../data/reconciliation/damaged_on_omeka.csv`):
  seven novelettes and one issue of Pentalfa. The pages that survive are
  published and each item carries a note; complete copies would have to come
  from the original scans.
- **210 files are linked to their record by title only** (a later version of
  the file in Box), not by checksum; `file_status` in the master says which.
- **Dates.** About 400 objects have no date yet; estimated dates are marked as
  such (`date_certainty`).
- **OCR is incomplete.** Part of the collection has been read; the rest needs
  further runs of `ocr_from_r2.py` (about 15 seconds a page on a laptop GPU),
  then steps 9 to 11. Where there is no OCR yet, "Reads like" and the text
  search use the PDF's own text layer, which is often poor. About a quarter of
  OCR pages are flagged for proofreading (`../data/published/ocr_pages.csv`).
- **Image tags and the titles added to untitled items** have not yet been
  reviewed by the project team (`../data/tags/labels.csv`,
  `../data/master/enrichment.csv`).
- **170 gallery items have only a generic title** ("Postcard", "Photograph").
- 278 of the 2,648 novelette page images are not yet attached to a novelette.
- The URL columns of the master spreadsheet (`object_location`, `image_small`,
  `image_thumb`) are empty; `r2_key` says where each file is in the bucket.
- The home page's featured works, the three works that stand for each gallery
  in the entrance hall, and the section cover images are chosen automatically
  and should be picked by the project team.
- The original site's Contact page was a form and has not been carried over.

## Build speed

Canopy fetches the manifests one at a time (`CANOPY_FETCH_CONCURRENCY: "1"` in
the deploy workflow). Leave it at 1: with a higher number its manifest cache
loses entries and the build becomes slower, not faster.
