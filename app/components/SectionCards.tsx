import React from "react";
import {withBasePath} from "@canopy-iiif/app/base-path";
import sections from "../data/sections.json";

type Section = {
  name: string;
  label: string;
  href: string;
  count: number;
  preview: number;
  image: string;
};

/**
 * Grid of the collection's sections, each with a cover image and item count.
 * The data comes from app/data/sections.json, which is generated from the
 * master spreadsheet (see tools/make_site_content.py). Links go through
 * withBasePath so they work when the site is served under /<repository>/.
 */
export default function SectionCards() {
  return (
    <div className="sic-sections not-prose">
      {(sections as Section[]).map((s) => (
        <a key={s.href} className="sic-section" href={withBasePath(s.href)}>
            <img src={s.image} alt="" loading="lazy" />
            <span className="sic-section__text">
              <span className="sic-section__name">{s.label}</span>
              <span className="sic-section__count">
                {s.count.toLocaleString("en-US")} items
              </span>
            </span>
        </a>
      ))}
    </div>
  );
}
