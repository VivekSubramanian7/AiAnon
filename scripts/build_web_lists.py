"""
Build web/data/lists.json: the word lists behind the browser TMI's quick frisk (no model).

    python scripts/build_web_lists.py --cache /some/dir     # downloads sources into --cache once

Sources
  First names and surnames: US Census Bureau 1990 name files (public domain)
      https://www2.census.gov/topics/genealogy/1990surnames/
  Places: GeoNames cities with over 15,000 people, first-level regions and countries (CC BY 4.0, credit
      "GeoNames, geonames.org" on the page)   https://download.geonames.org/export/dump/
  Ordinary English words: /usr/share/dict/words (Webster's Second International, public domain; ships with macOS)
  Stop words: spaCy's English stop words (MIT)

The sets are computed here, once, so the JavaScript only does lookups:
  ordinary   lowercase dictionary words the dictionary never lists capitalised, plus stop words and calendar words
  ambiguous  common words that are also first names ("will", "may", "grace"), never a person on their own
  places     place names minus ordinary words, ambiguous names and calendar words, at most 4 words long
"""

import argparse
import json
import os
import sys
import urllib.request
import zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, "web", "data", "lists.json")

CENSUS = "https://www2.census.gov/topics/genealogy/1990surnames/"
GEONAMES = "https://download.geonames.org/export/dump/"
SOURCES = {
    "census1990.dist.female.first": CENSUS + "dist.female.first",
    "census1990.dist.male.first": CENSUS + "dist.male.first",
    "census1990.dist.all.last": CENSUS + "dist.all.last",
    "cities15000.zip": GEONAMES + "cities15000.zip",
    "admin1CodesASCII.txt": GEONAMES + "admin1CodesASCII.txt",
    "countryInfo.txt": GEONAMES + "countryInfo.txt",
}
WORDS = "/usr/share/dict/words"
MAX_PLACE_WORDS = 4

# Common English words that are also first names: never a person on their own.
AMBIGUOUS_NAMES = set("""will may mark grace hope joy june april august bill art rose faith summer chase frank grant
    rich penny dawn ivy lane ray jack pat sue sky sunny rob guy gene sterling major king young long page cash star
    crystal amber ruby pearl jade holly iris lily daisy heather olive autumn winter river brook dale glen wade cliff
    drew miles max bob don ted chuck sandy misty candy honey angel precious harmony destiny trinity justice christian
    bishop carter baker cook hunter mason taylor parker porter cooper fisher marshal miller sharon kay ed al""".split())
CALENDAR = set("""january february march april may june july august september october november december
    monday tuesday wednesday thursday friday saturday sunday christmas easter""".split())


def fetch(cache: str) -> None:
    os.makedirs(cache, exist_ok=True)
    for name, url in SOURCES.items():
        path = os.path.join(cache, name)
        if not os.path.exists(path):
            print(f"downloading {url}")
            urllib.request.urlretrieve(url, path)


def census(path: str) -> set:
    with open(path) as f:
        return {line.split()[0].lower() for line in f if line.strip()}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", required=True, help="folder for the downloaded source files")
    args = ap.parse_args()
    fetch(args.cache)
    src = args.cache

    sys.path.insert(0, REPO)
    from spacy.lang.en.stop_words import STOP_WORDS

    with open(WORDS) as f:
        words = [w.strip() for w in f if w.strip()]
    lower_only = {w for w in words if w[:1].islower()}
    dictionary_caps = {w.lower() for w in words if w[:1].isupper()}
    ordinary = {w for w in lower_only if w not in dictionary_caps} | set(STOP_WORDS) | CALENDAR
    ambiguous = AMBIGUOUS_NAMES | {w for w in lower_only if w in dictionary_caps and len(w) <= 3}

    first = census(f"{src}/census1990.dist.female.first") | census(f"{src}/census1990.dist.male.first")
    surnames = census(f"{src}/census1990.dist.all.last")

    places = set()
    with zipfile.ZipFile(f"{src}/cities15000.zip") as z, z.open("cities15000.txt") as f:
        for line in f:
            cols = line.decode("utf-8").split("\t")
            places.update({cols[1], cols[2]})
    with open(f"{src}/admin1CodesASCII.txt", encoding="utf-8") as f:
        for line in f:
            cols = line.rstrip("\n").split("\t")
            places.update({cols[1], cols[2]})
    with open(f"{src}/countryInfo.txt", encoding="utf-8") as f:
        for line in f:
            if not line.startswith("#"):
                places.add(line.split("\t")[4])
    places = {p.lower() for p in places if p and len(p) >= 3 and len(p.split()) <= MAX_PLACE_WORDS}
    places -= ordinary | AMBIGUOUS_NAMES | CALENDAR

    lists = {
        "about": "Word lists for TMI's quick frisk. Names: US Census Bureau 1990 (public domain). "
                 "Places: GeoNames, geonames.org (CC BY 4.0). Ordinary words: Webster's Second International "
                 "(public domain) and spaCy stop words (MIT). Built by scripts/build_web_lists.py.",
        "firstNames": sorted(first),
        "surnames": sorted(surnames),
        "places": sorted(places),
        "ordinary": sorted(ordinary),
        "ambiguous": sorted(ambiguous),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(lists, f, separators=(",", ":"), ensure_ascii=False)
    for key in ("firstNames", "surnames", "places", "ordinary", "ambiguous"):
        print(f"{key}: {len(lists[key]):,}")
    print(f"wrote {OUT} ({os.path.getsize(OUT) / 2**20:.1f} MB)")


if __name__ == "__main__":
    main()
