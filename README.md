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

## Status (13 November 2026)

- The site is live at https://sicalipsis-art.github.io/sicalipsis/. It started as
  a 45-item pilot and grows as originals arrive in the bucket and are published
  (step 6 below).
- The pilot's images and manifests are served from the bucket's public
  development address, `https://pub-86bc04aba3b948f081b236797ce9d2a6.r2.dev/web`.
  Cloudflare rate-limits that address and does not intend it for production; a
  custom domain should replace it before launch (regenerate with steps 6 and 7).
- The bucket's CORS policy allows `https://sicalipsis-art.github.io` only, so in
  a local preview the viewer cannot load manifests unless
  `http://localhost:5001` is added to the policy.
- The viewer shows one resized image per page; deep-zoom tiles are not made yet.
- The About page is a placeholder.
- 143 files exist only on the Omeka server and still need to be saved
  (`reconciliation/rescue_list.csv` in the data folder).

## Layout

| Path | What it is |
|---|---|
| `canopy.yml` | Canopy configuration: IIIF collection address, facets, featured works, theme. Generated. |
| `content/` | Pages. `index.mdx`, `about/`, `_app.mdx` and the layouts are hand-written; `collections/<section>.mdx` are generated. |
| `app/styles/custom.css` | The site's look. |
| `app/components/` | Custom components (`SectionCards`). |
| `app/components/GalleryWalk.client.tsx` | The walk-through gallery (three.js): the published works staged as an exhibition, in rooms ordered by period and grouped by collection and series, with a marked route, title walls, full screen, and a list view as the accessible alternative. Reads `web/walk/works.json` from the bucket. |
| `app/data/gallery_periods.json` | The gallery's periods (titles and year boundaries) and room size. The period titles are placeholders for the project team to rewrite. |
| `app/data/sections.json` | Section cards for the home page. Generated. |
| `app/data/site.json` | The bucket's public `web/` address, for components. Generated. |
| `tools/` | Python scripts for ingest: harvest, reconciliation, master spreadsheet, web images, manifests, generated pages. |
| `.github/workflows/deploy-pages.yml` | Builds and publishes to GitHub Pages on every push to `main`. |

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

In the bucket, `originals/` mirrors the Box folder and `web/` holds what the
site serves: `images/`, `files/`, `text/` and `iiif/`.

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

   The 104 Omeka-only files, unconfirmed title matches and the novelette page
   images are not published. (`tools/make_iiif.py` does the same work for a
   hand-picked rows file and a local folder of originals; the pilot used it.)

7. **Regenerate the site's data-driven pages, then build.**

   ```sh
   python tools/make_site_content.py ../data/published/rows.csv ../data/master/sicalipsis.csv . <public bucket address>/web
   npm run build      # output in site/
   ```

8. **Refresh the walk-through gallery's data.** This rewrites
   `web/walk/works.json` in the bucket from everything published; the gallery
   page picks it up without a new build.

   ```sh
   python tools/make_walk.py ../data ../work <public bucket address>
   ```

9. **Mirror the data folder to the bucket** (see above), then commit and push the
   regenerated pages.

## Image tags (in progress)

`tools/tag_images.py` assigns tags from the fixed vocabulary in
`tools/tag_vocabulary.json`, using the SigLIP 2 model. On a first test of 24
images it chose the right image type for 23, but over-assigned the "depicts"
tags, so its output is not on the site yet. Hand-checked labels are being
collected in `../data/tags/seed_labels.csv` to train and measure it.

## Known gaps in the data

- 569 Omeka items have no date; 39 have ranges such as "1924/1999" that were
  left unparsed.
- 278 of the 2,648 novelette page images are not yet attached to a novelette.
- The URL columns of the master spreadsheet (`object_location`, `image_small`,
  `image_thumb`) are empty until the bucket has a public address; `r2_key` says
  where each file is in the bucket.
- The home page's featured works and the section cover images are chosen
  automatically and should be picked by the project team.
