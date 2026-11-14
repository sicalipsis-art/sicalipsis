import React from "react";
import {withBasePath} from "@canopy-iiif/app/base-path";

type Item = {title: string; href: string; count?: number; image?: string; note?: string};

/**
 * Links to the pages inside a collection (a magazine title, a series, an
 * author), as the original site arranged them. The lists are written into the
 * collection pages by tools/make_site_content.py.
 *
 *   variant "cards"  a grid of cards with a cover picture and item count
 *   variant "list"   a plain list, used for the collection tree
 *   variant "nav"    previous / next links at the foot of a page
 */
export default function PageCards({items = [], variant = "cards"}: {items?: Item[]; variant?: "cards" | "list" | "nav"}) {
  if (variant === "nav") {
    return (
      <nav className="sic-pagenav not-prose" aria-label="Pages of this collection">
        {items.map((item) => (
          <a key={item.href} href={withBasePath(item.href)}>
            <span>{item.note}</span>
            {item.title}
          </a>
        ))}
      </nav>
    );
  }
  if (variant === "list") {
    return (
      <ul className="sic-pagelist not-prose">
        {items.map((item) => (
          <li key={item.href}>
            <a href={withBasePath(item.href)}>{item.title}</a>
            {item.count != null && <span>{item.count.toLocaleString("en-US")}</span>}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="sic-pages not-prose">
      {items.map((item) => (
        <a key={item.href} className="sic-page" href={withBasePath(item.href)}>
          {item.image ? <img src={item.image} alt="" loading="lazy" /> : <span className="sic-page__blank" />}
          <span className="sic-page__text">
            <span className="sic-page__name">{item.title}</span>
            {item.count != null && (
              <span className="sic-page__count">{item.count === 1 ? "1 item" : `${item.count.toLocaleString("en-US")} items`}</span>
            )}
          </span>
        </a>
      ))}
    </div>
  );
}
