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

- The site builds and runs locally with a **45-item pilot**.
- The pilot's images and manifests are still served from the local computer
  (`http://localhost:5002`), so `canopy.yml`, `content/collections/*.mdx` and
  `app/data/sections.json` contain `localhost` addresses. They must be
  regenerated (step 7 below) once the bucket has a public address.
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
| `app/data/sections.json` | Section cards for the home page. Generated. |
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

While the site still points at `localhost:5002`, the pilot's images must also
be served locally, from the folder that `tools/make_iiif.py` wrote:

```sh
python tools/serve_cors.py ../pilot/web 5002
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

The workflow stops with an error, and publishes nothing, while the site still
contains `localhost` addresses.

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

5. **Build the master spreadsheet.**

   ```sh
   python tools/build_master.py ../data ../data/master/sicalipsis.csv
   ```

6. **Make web images and IIIF manifests** for the rows to publish, then upload
   them. The rows file is any subset of the master spreadsheet (the pilot's was
   chosen with `tools/pilot_select.py`); the originals folder must hold those
   files at their Box paths; the base address is where `web/` is served from,
   for example `https://<public bucket address>/web`.

   ```sh
   python tools/make_iiif.py <rows.csv> <originals_dir> <web_out_dir> <base_url>
   rclone copy <web_out_dir> r2:sicalipsis-files/web
   ```

7. **Regenerate the site's data-driven pages, then build.**

   ```sh
   python tools/make_site_content.py <rows.csv> ../data/master/sicalipsis.csv . <base_url>
   npm run build      # output in site/
   ```

8. **Mirror the data folder to the bucket** (see above), then commit and push the
   regenerated pages.

## Known gaps in the data

- 569 Omeka items have no date; 39 have ranges such as "1924/1999" that were
  left unparsed.
- 278 of the 2,648 novelette page images are not yet attached to a novelette.
- The URL columns of the master spreadsheet (`object_location`, `image_small`,
  `image_thumb`) are empty until the bucket has a public address; `r2_key` says
  where each file is in the bucket.
- The home page's featured works and the section cover images are chosen
  automatically and should be picked by the project team.
