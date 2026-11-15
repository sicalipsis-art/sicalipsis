// Give every page in the site's search results its own description as the line under its title.
//
// Usage: node tools/clean_search_summaries.mjs      (run by "npm run build", after the Canopy build)
//
// Canopy works out a page's summary from the page source by taking away its tags.
// Our pages are built from nested elements, and what is left over is a closing
// tag or two ("</header>", "</p> </p>"), which the search page then prints.
// Each page already states what it is in its front matter (description: ...),
// so that sentence is put in the search data instead. Where a page has none,
// any left-over tags are removed and Canopy's plain summary is used.
import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";

const file = join("site", "api", "search-records.json");
if (!existsSync(file)) {
  console.log("clean_search_summaries: no search data to clean");
  process.exit(0);
}
const base = (process.env.CANOPY_BASE_PATH || "").replace(/\/$/, "");
const data = JSON.parse(readFileSync(file, "utf8"));
const records = Array.isArray(data) ? data : data.records || [];

const descriptionOf = (href) => {
  let path = String(href || "").split(/[?#]/)[0];
  if (base && path.startsWith(base)) path = path.slice(base.length);
  const source = join("content", path.replace(/^\//, "").replace(/\.html$/i, ".mdx"));
  if (!existsSync(source)) return "";
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(source, "utf8"));
  const line = front && /^description:\s*(.+?)\s*$/m.exec(front[1]);
  if (!line) return "";
  return line[1].replace(/^(["'])([\s\S]*)\1$/, "$2").replace(/\\"/g, '"');
};

let changed = 0;
for (const record of records) {
  if (record.type === "work") continue;
  const description = descriptionOf(record.href);
  const cleaned = String(record.summaryMarkdown || "").replace(/<\/?[A-Za-z][^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const next = description || cleaned;
  if (description) record.summary = description;
  if (record.summaryMarkdown !== next) {
    record.summaryMarkdown = next;
    changed++;
  }
}
writeFileSync(file, JSON.stringify(data));
console.log(`clean_search_summaries: ${changed} page summaries set`);
