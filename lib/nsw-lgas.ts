// Every LGA the pager feed has ever named, so the alert picker can offer areas
// that aren't on the currently-loaded board.
//
// Harvested from the full PagerMon history at PAGERMON_URL — 71,100 messages
// (99.6% of the archive), of which 40,157 carried an address. Names are kept
// exactly as the pages spell them, which is what makes them safe to match
// against: this is not an official council list, it's what comes over the air.
// A few VIC border councils appear because the feed covers the Murray.
//
// `pages` is how many messages named that area — used to sort the picker so the
// areas this feed actually covers float to the top. It's a snapshot, not a live
// count; the board contributes live counts on top of this.
//
// To refresh: sweep /api/messages (limit=100, page=N — `since` only walks
// forward from the newest) and run each message through lgaFromLocation().

export interface KnownLga {
  name: string;
  pages: number;
}

export const KNOWN_LGAS: KnownLga[] = [
  { name: "GOULBURN MULWAREE", pages: 7188 },
  { name: "YASS VALLEY", pages: 5672 },
  { name: "UPPER LACHLAN", pages: 5196 },
  { name: "QUEANBEYAN PALERANG", pages: 2119 },
  { name: "THE HILLS", pages: 1869 },
  { name: "HORNSBY", pages: 1466 },
  { name: "CENTRAL COAST", pages: 1295 },
  { name: "SNOWY VALLEYS", pages: 1258 },
  { name: "LIVERPOOL CITY", pages: 1018 },
  { name: "CAMDEN", pages: 863 },
  { name: "SINGLETON", pages: 844 },
  { name: "PENRITH CITY", pages: 788 },
  { name: "HILLTOPS", pages: 772 },
  { name: "CESSNOCK CITY", pages: 712 },
  { name: "WOLLONDILLY", pages: 631 },
  { name: "LAKE MACQUARIE CITY", pages: 613 },
  { name: "HAWKESBURY CITY", pages: 611 },
  { name: "PORT STEPHENS", pages: 596 },
  { name: "BLACKTOWN CITY", pages: 593 },
  { name: "COOTAMUNDRA GUNDAGAI", pages: 571 },
  { name: "MID COAST", pages: 522 },
  { name: "SNOWY MONARO", pages: 521 },
  { name: "CAMPBELLTOWN CITY", pages: 453 },
  { name: "WINGECARRIBEE", pages: 391 },
  { name: "WOLLONGONG CITY", pages: 360 },
  { name: "BLUE MOUNTAINS CITY", pages: 349 },
  { name: "NORTHERN BEACHES", pages: 313 },
  { name: "MAITLAND CITY", pages: 231 },
  { name: "PORT MACQUARIE HASTINGS", pages: 221 },
  { name: "MUSWELLBROOK", pages: 209 },
  { name: "DUNGOG", pages: 180 },
  { name: "GREATER HUME", pages: 172 },
  { name: "BERRIGAN", pages: 150 },
  { name: "FAIRFIELD CITY", pages: 148 },
  { name: "KU RING GAI", pages: 139 },
  { name: "SUTHERLAND", pages: 131 },
  { name: "WAGGA WAGGA CITY", pages: 115 },
  { name: "FEDERATION", pages: 113 },
  { name: "BATHURST", pages: 107 },
  { name: "KIAMA", pages: 106 },
  { name: "SHELLHARBOUR CITY", pages: 102 },
  { name: "ALBURY CITY", pages: 73 },
  { name: "MOIRA SHIRE COUNCIL", pages: 70 },
  { name: "SHOALHAVEN CITY", pages: 49 },
  { name: "CITY OF PARRAMATTA", pages: 27 },
  { name: "KEMPSEY", pages: 24 },
  { name: "TOWONG SHIRE COUNCIL", pages: 23 },
  { name: "JUNEE", pages: 18 },
  { name: "LOCKHART COUNCIL", pages: 17 },
  { name: "UPPER HUNTER COUNCIL", pages: 16 },
  { name: "EUROBODALLA", pages: 15 },
  { name: "LITHGOW COUNCIL", pages: 14 },
  { name: "LACHLAN", pages: 10 },
  { name: "COOLAMON COUNCIL", pages: 8 },
  { name: "COWRA", pages: 8 },
  { name: "GRIFFITH CITY", pages: 8 },
  { name: "TEMORA", pages: 8 },
  { name: "CABONNE", pages: 6 },
  { name: "MURRUMBIDGEE", pages: 6 },
  { name: "NARRANDERA", pages: 6 },
  { name: "NEWCASTLE CITY", pages: 6 },
  { name: "BLAYNEY", pages: 4 },
  { name: "OBERON", pages: 4 },
  { name: "WODONGA CITY COUNCIL", pages: 4 },
  { name: "WEDDIN", pages: 3 },
  { name: "BEGA VALLEY", pages: 2 },
  { name: "LEETON", pages: 2 },
  { name: "RICHMOND VALLEY", pages: 1 },
  { name: "TAMWORTH COUNCIL", pages: 1 },
  { name: "TENTERFIELD", pages: 1 },
  { name: "TWEED COUNCIL", pages: 1 },
];

// Spellings the feed actually emits that aren't the canonical name. Keys and
// values are both normalised keys (as produced by lgaKey), so picking the real
// area still matches the mangled pages. Only recurring, unambiguous variants
// are listed — one-off decode truncations ("ERANG", "WAREE") are left alone
// rather than guessed at.
//
// Counts at harvest: PORT MACQUARIE 144 pages, CAMPELLTOWN 37, UPER LACHLAN 1.
export const LGA_ALIASES: Record<string, string> = {
  "PORT MACQUARIE": "PORT MACQUARIE HASTINGS",
  CAMPELLTOWN: "CAMPBELLTOWN",
  "UPER LACHLAN": "UPPER LACHLAN",
};
