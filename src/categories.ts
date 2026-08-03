// Service categories.
//
// serviceTag was a bare uint16 with no defined meaning: the dashboard showed
// "service #1" and ERC-8004 feedback carried the string "service-1". Neither says
// anything to anyone outside this repo, and it is the storefront of the whole
// marketplace.
//
// The tag stays a uint16 because it is packed into the 12-byte OCU1 memo blob. This
// table is what the number means. Adding a category is additive; NEVER renumber an
// existing one — the tag is baked into receipts already anchored on chain.
export interface Category {
  tag: number;
  slug: string;
  label: string;
}

export const CATEGORIES: Category[] = [
  { tag: 1, slug: "embedding", label: "Embeddings" },
  { tag: 2, slug: "llm-inference", label: "LLM inference" },
  { tag: 3, slug: "rerank", label: "Reranking" },
  { tag: 4, slug: "ocr", label: "OCR & document parsing" },
  { tag: 5, slug: "data-scrape", label: "Web & data retrieval" },
  { tag: 6, slug: "speech", label: "Speech to text" },
  { tag: 7, slug: "image", label: "Image generation" },
  { tag: 8, slug: "compute", label: "General compute" },
  { tag: 9, slug: "other", label: "Other" },
];

const BY_TAG = new Map(CATEGORIES.map((c) => [c.tag, c]));
const BY_SLUG = new Map(CATEGORIES.map((c) => [c.slug, c]));

export function categoryByTag(tag: number): Category | undefined {
  return BY_TAG.get(tag);
}

export function categoryBySlug(slug: string): Category | undefined {
  return BY_SLUG.get(slug);
}

/** Human label for a tag; unknown tags render honestly rather than as a fake name. */
export function categoryLabel(tag: number): string {
  return BY_TAG.get(tag)?.label ?? `Uncategorised (${tag})`;
}

/**
 * The string that goes in receipt.what.service and ERC-8004 tag1, so a reader
 * filtering the registry by tag1 gets something meaningful instead of "service-1".
 */
export function categorySlug(tag: number): string {
  return BY_TAG.get(tag)?.slug ?? `unknown-${tag}`;
}
