// Components available by name in every MDX page.

// Rendered at build time.
export const components = {
  SectionCards: "./SectionCards.tsx",
  PageCards: "./PageCards.tsx",
};

// Browser-only components, bundled separately and started in the browser.
export const clientComponents = {
  GalleryWalk: "./GalleryWalk.client.tsx",
  ViewerZoom: "./ViewerZoom.client.tsx",
  ItemText: "./ItemText.client.tsx",
  RelatedByContent: "./RelatedByContent.client.tsx",
  TextSearch: "./TextSearch.client.tsx",
  CollectionSearch: "./CollectionSearch.client.tsx",
};
