/**
 * Build a geography quiz list from Wikidata.
 *
 *   bun run scripts/build-geoquiz.ts [--out path]
 *
 * Fetches live country data (population, area, capitals, continents,
 * landlocked status, borders) and the world's longest rivers from the
 * Wikidata SPARQL endpoint, then expands deterministic quiz-show-style
 * templates over it — capitals, top-N population/area/density lists,
 * "which is bigger" pairs, landlocked trivia, name-letter trivia, rivers —
 * and writes scripts/data/geography.quizzes.json for import-quizzes.ts.
 *
 * No LLM anywhere: every question and answer is computed from the fetched
 * snapshot, so an answer can only be as wrong as Wikidata itself (which the
 * payload's `source` field credits). Re-running refreshes the numbers.
 */

const OUT =
  process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]!
    : new URL("./data/geography.quizzes.json", import.meta.url).pathname;

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT = "GrandTourGeoQuizBuilder/0.1 (dev import script; bun)";

interface Binding {
  [key: string]: { value: string } | undefined;
}

async function sparql(query: string): Promise<Binding[]> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}`, {
      headers: { Accept: "application/sparql-results+json", "User-Agent": USER_AGENT },
    });
    if (res.ok) {
      const json = (await res.json()) as { results: { bindings: Binding[] } };
      return json.results.bindings;
    }
    if (attempt >= 3) throw new Error(`SPARQL failed after ${attempt} tries: ${res.status}`);
    console.warn(`  sparql ${res.status}, retrying…`);
    await new Promise((r) => setTimeout(r, 5000 * attempt));
  }
}

const qid = (uri: string) => uri.slice(uri.lastIndexOf("/") + 1);
const num = (b: Binding, k: string) => {
  const v = b[k]?.value;
  return v ? Number(v) : undefined;
};
/** The label service echoes the QID when no English label exists. */
const realLabel = (s: string | undefined) => (s && !/^Q\d+$/.test(s) ? s : undefined);

// ─── Fetch: countries ────────────────────────────────────────────────────────

interface Country {
  qid: string;
  name: string;
  population?: number;
  areaKm2?: number;
  capitals: string[];
  continents: string[];
  landlocked: boolean;
}

const CANONICAL_CONTINENTS = new Set([
  "Africa",
  "Asia",
  "Europe",
  "North America",
  "South America",
  "Oceania",
]);
const CONTINENT_ALIASES: Record<string, string> = {
  "Australian continent": "Oceania",
  "Insular Oceania": "Oceania",
};

/** Everyday quiz names for entities whose English label is the formal one. */
const NAME_OVERRIDES: Record<string, string> = {
  "People's Republic of China": "China",
};

/** English names that read wrong without a leading "the" in a sentence. */
const NEEDS_THE = new Set([
  "United States",
  "United States of America",
  "United Kingdom",
  "United Arab Emirates",
  "Netherlands",
  "Philippines",
  "Bahamas",
  "Gambia",
  "Maldives",
  "Comoros",
  "Marshall Islands",
  "Solomon Islands",
  "Seychelles",
  "Central African Republic",
  "Democratic Republic of the Congo",
  "Republic of the Congo",
  "Dominican Republic",
  "Federated States of Micronesia",
  "Czech Republic",
]);
const withThe = (name: string) => (NEEDS_THE.has(name) ? `the ${name}` : name);

async function fetchCountries(): Promise<Country[]> {
  console.log("fetching countries…");
  const rows = await sparql(`
    SELECT ?c ?cLabel ?population ?areaM2 ?capitalLabel ?continentLabel WHERE {
      ?c wdt:P31 wd:Q3624078 .
      FILTER NOT EXISTS { ?c wdt:P31 wd:Q3024240 }
      FILTER NOT EXISTS { ?c wdt:P576 ?dissolved }
      OPTIONAL { ?c wdt:P1082 ?population }
      OPTIONAL {
        ?c p:P2046 ?areaSt .
        ?areaSt a wikibase:BestRank ;
                psn:P2046/wikibase:quantityAmount ?areaM2 .
      }
      OPTIONAL { ?c wdt:P36 ?capital }
      OPTIONAL { ?c wdt:P30 ?continent }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
  `);

  const byQid = new Map<string, Country>();
  for (const r of rows) {
    const id = qid(r.c!.value);
    const name = realLabel(r.cLabel?.value);
    if (!name) continue;
    const c =
      byQid.get(id) ??
      ({ qid: id, name, capitals: [], continents: [], landlocked: false } as Country);
    const pop = num(r, "population");
    if (pop) c.population = Math.max(c.population ?? 0, pop);
    // Min of the best-rank statements: several countries also carry a larger
    // claimed/realm area (Taiwan's historical claim, Denmark incl. Greenland)
    // and the smaller figure is the everyday quiz answer.
    const areaM2 = num(r, "areaM2");
    if (areaM2) c.areaKm2 = Math.min(c.areaKm2 ?? Infinity, areaM2 / 1e6);
    const cap = realLabel(r.capitalLabel?.value);
    if (cap && !c.capitals.includes(cap)) c.capitals.push(cap);
    const rawCont = realLabel(r.continentLabel?.value);
    const cont = rawCont ? (CONTINENT_ALIASES[rawCont] ?? rawCont) : undefined;
    if (cont && CANONICAL_CONTINENTS.has(cont) && !c.continents.includes(cont)) {
      c.continents.push(cont);
    }
    byQid.set(id, c);
  }

  // "Kingdom of X" sovereign entities stand in for their everyday country
  // (Denmark, the Netherlands — the constituent country isn't tagged
  // sovereign): use the everyday name, and drop the area — the kingdom's
  // figure covers the whole realm (Denmark's includes Greenland), which is
  // never the quiz answer. Population stays (metropolitan ≈ realm).
  const names = new Set([...byQid.values()].map((c) => c.name));
  const countries = [...byQid.values()].filter((c) => {
    const m = c.name.match(/^Kingdom of (?:the )?(.+)$/);
    if (!m) return true;
    if (names.has(m[1]!)) return false;
    c.name = m[1]!;
    delete c.areaKm2;
    return true;
  });
  for (const c of countries) c.name = NAME_OVERRIDES[c.name] ?? c.name;

  // Under-tagged on Wikidata (Paraguay, Rwanda, Liechtenstein and others are
  // missing even via subclasses), so templates below may only make *positive*
  // claims about tagged countries — never "name all landlocked countries of X".
  const landlockedRows = await sparql(`
    SELECT ?c WHERE { ?c wdt:P31/wdt:P279* wd:Q123480 . }
  `);
  const landlockedQids = new Set(landlockedRows.map((r) => qid(r.c!.value)));
  for (const c of countries) c.landlocked = landlockedQids.has(c.qid);

  console.log(`  ${countries.length} countries (${countries.filter((c) => c.landlocked).length} landlocked)`);
  return countries.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Fetch: rivers ───────────────────────────────────────────────────────────

interface River {
  name: string;
  lengthKm: number;
  countries: string[];
}

async function fetchRivers(): Promise<River[]> {
  console.log("fetching rivers…");
  // The sitelink floor is a vetting step: a river genuinely this long has
  // Wikipedia articles in dozens of languages, while bad length claims tend
  // to sit on obscure entities (a 300 km river once carried a 5,806 km one).
  const rows = await sparql(`
    SELECT ?r ?rLabel ?lengthM ?countryLabel WHERE {
      ?r wdt:P31/wdt:P279* wd:Q4022 ;
         p:P2043/psn:P2043/wikibase:quantityAmount ?lengthM ;
         wikibase:sitelinks ?sitelinks .
      FILTER(?lengthM >= 1800000 && ?sitelinks >= 30)
      OPTIONAL { ?r wdt:P17 ?country }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
  `);
  // A river can carry several length statements (sources disagree) and one
  // row per country; collapse by name keeping the longest claim.
  const byName = new Map<string, River>();
  for (const r of rows) {
    const name = realLabel(r.rLabel?.value);
    const lengthM = num(r, "lengthM");
    if (!name || !lengthM) continue;
    const river = byName.get(name) ?? { name, lengthKm: 0, countries: [] };
    river.lengthKm = Math.max(river.lengthKm, lengthM / 1000);
    const rawCountry = realLabel(r.countryLabel?.value);
    const country = rawCountry ? (NAME_OVERRIDES[rawCountry] ?? rawCountry) : undefined;
    if (country && !river.countries.includes(country)) river.countries.push(country);
    byName.set(name, river);
  }
  const rivers = [...byName.values()].sort((a, b) => b.lengthKm - a.lengthKm);
  console.log(`  ${rivers.length} rivers ≥ 1800 km`);
  return rivers;
}

// ─── Spoken-number formatting ────────────────────────────────────────────────

function fmtPeople(n: number): string {
  if (n >= 1e9) return `about ${(n / 1e9).toFixed(1)} billion people`;
  if (n >= 1e7) return `about ${Math.round(n / 1e6)} million people`;
  if (n >= 1e6) return `about ${(n / 1e6).toFixed(1)} million people`;
  if (n >= 1e4) return `about ${Math.round(n / 1e3)} thousand people`;
  return `about ${n.toLocaleString("en-US")} people`;
}

function fmtArea(km2: number): string {
  if (km2 >= 1e6) return `about ${(km2 / 1e6).toFixed(1)} million square kilometers`;
  if (km2 >= 1e3) return `about ${Math.round(km2 / 1e3)} thousand square kilometers`;
  return `about ${Math.max(1, Math.round(km2))} square kilometers`;
}

const fmtKm = (km: number) => `about ${Math.round(km).toLocaleString("en-US")} kilometers`;
const fmtDensity = (perKm2: number) =>
  `${Math.round(perKm2).toLocaleString("en-US")} people per square kilometer`;

const density = (c: Country) =>
  c.population && c.areaKm2 ? c.population / c.areaKm2 : undefined;

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const spokenCount = (n: number) => NUMBER_WORDS[n] ?? String(n);

// ─── Quiz templates ──────────────────────────────────────────────────────────

interface Quiz {
  question: string;
  answers: string[];
  note?: string;
}

const quizzes: Quiz[] = [];
function add(question: string, answers: string[], note?: string) {
  if (answers.length === 0 || answers.length > 10) return;
  quizzes.push({ question, answers, ...(note ? { note } : {}) });
}

const countries = await fetchCountries();
const rivers = await fetchRivers();

const byPop = countries.filter((c) => c.population).sort((a, b) => b.population! - a.population!);
const byArea = countries.filter((c) => c.areaKm2).sort((a, b) => b.areaKm2! - a.areaKm2!);
const byDensity = countries
  .filter((c) => density(c) !== undefined)
  .sort((a, b) => density(b)! - density(a)!);

// A. Capitals, both directions.
for (const c of countries) {
  if (c.capitals.length === 0) continue;
  add(
    `What is the capital of ${withThe(c.name)}?`,
    c.capitals,
    c.capitals.length > 1 ? `Yes — ${withThe(c.name)} has ${spokenCount(c.capitals.length)} capitals.` : undefined,
  );
  if (c.capitals.length === 1) {
    add(`${c.capitals[0]} is the capital of which country?`, [c.name]);
  }
}

// B. Continents, for the smaller (harder) countries with one clear continent.
for (const c of countries) {
  if (c.continents.length !== 1 || !c.population || c.population >= 10e6) continue;
  add(`On which continent is ${withThe(c.name)}?`, [c.continents[0]!]);
}

// C. Country names by first letter ("name the top most populous starting with M").
const byLetter = new Map<string, Country[]>();
for (const c of byPop) {
  const letter = c.name[0]!.toUpperCase();
  byLetter.set(letter, [...(byLetter.get(letter) ?? []), c]);
}
for (const [letter, list] of [...byLetter.entries()].sort()) {
  if (list.length === 1) {
    add(`Name the only country whose name begins with the letter ${letter}.`, [list[0]!.name]);
  } else if (list.length <= 4) {
    add(
      `Name the ${spokenCount(list.length)} countries whose names begin with the letter ${letter}.`,
      list.map((c) => c.name),
      "In order of population.",
    );
  } else {
    add(
      `Name the five most populous countries whose names begin with the letter ${letter}.`,
      list.slice(0, 5).map((c) => `${c.name}, ${fmtPeople(c.population!)}`),
    );
  }
}

// D. World top-N lists.
add(
  "Name the five most populous countries in the world.",
  byPop.slice(0, 5).map((c) => `${c.name}, ${fmtPeople(c.population!)}`),
);
add(
  "Name the ten most populous countries in the world.",
  byPop.slice(0, 10).map((c) => c.name),
);
add(
  "Name the five largest countries in the world by area.",
  byArea.slice(0, 5).map((c) => `${c.name}, ${fmtArea(c.areaKm2!)}`),
);
add(
  "Name the five smallest countries in the world by area.",
  byArea
    .slice(-5)
    .reverse()
    .map((c) => `${c.name}, ${fmtArea(c.areaKm2!)}`),
);
add(
  "Name the five most densely populated countries in the world.",
  byDensity.slice(0, 5).map((c) => `${c.name}, ${fmtDensity(density(c)!)}`),
);
add(
  "Name the five most sparsely populated countries in the world.",
  byDensity
    .slice(-5)
    .reverse()
    .map((c) => `${c.name}, ${fmtDensity(density(c)!)}`),
);

// E. Per-continent lists.
for (const continent of [...CANONICAL_CONTINENTS].sort()) {
  const inCont = (c: Country) => c.continents.includes(continent);
  const pop = byPop.filter(inCont);
  const area = byArea.filter(inCont);
  const dense = byDensity.filter(inCont);
  if (pop.length >= 3) {
    add(
      `Name the three most populous countries in ${continent}.`,
      pop.slice(0, 3).map((c) => `${c.name}, ${fmtPeople(c.population!)}`),
    );
  }
  if (area.length >= 3) {
    add(
      `Name the three largest countries in ${continent} by area.`,
      area.slice(0, 3).map((c) => `${c.name}, ${fmtArea(c.areaKm2!)}`),
    );
  }
  if (dense.length >= 3) {
    add(`What is the most densely populated country in ${continent}?`, [
      `${dense[0]!.name}, ${fmtDensity(density(dense[0]!)!)}`,
    ]);
  }
}

// F. Landlocked trivia. Positive/superlative claims only — the tag set is
// incomplete (see fetch above), so exhaustive "name them all" questions
// would state wrong facts. The superlative answers hold as long as no
// *larger* landlocked country is missing from the tags, which checks out
// for Kazakhstan (area) and Ethiopia (population).
const landlocked = countries.filter((c) => c.landlocked);
const llByArea = landlocked.filter((c) => c.areaKm2).sort((a, b) => b.areaKm2! - a.areaKm2!);
const llByPop = landlocked.filter((c) => c.population).sort((a, b) => b.population! - a.population!);
if (llByArea.length > 0) {
  add(
    `What is the largest landlocked country in the world?`,
    [`${llByArea[0]!.name}, ${fmtArea(llByArea[0]!.areaKm2!)}`],
    "Landlocked: a country with no coastline.",
  );
}
if (llByPop.length > 0) {
  add(`What is the most populous landlocked country in the world?`, [
    `${llByPop[0]!.name}, ${fmtPeople(llByPop[0]!.population!)}`,
  ]);
}

// G. Head-to-head pairs — close enough to be a real question, far enough to
// have one clear right answer. Deterministic sampling: from every second
// rank, pair with the nearest lower-ranked country at least 25% behind.
function headToHead<T>(
  ranked: T[],
  value: (t: T) => number,
  emit: (winner: T, loser: T) => void,
) {
  for (let i = 0; i < Math.min(ranked.length, 80); i += 2) {
    const a = ranked[i]!;
    const b = ranked
      .slice(i + 1, i + 12)
      .find((x) => value(a) / value(x) >= 1.25 && value(a) / value(x) <= 4);
    if (b) emit(a, b);
  }
}
headToHead(byPop, (c) => c.population!, (a, b) =>
  add(
    `Which country has more people: ${withThe(a.name)} or ${withThe(b.name)}?`,
    [`${a.name}, ${fmtPeople(a.population!)}`],
    `${withThe(b.name)} has ${fmtPeople(b.population!)}.`,
  ),
);
headToHead(byArea, (c) => c.areaKm2!, (a, b) =>
  add(
    `Which country is larger by area: ${withThe(a.name)} or ${withThe(b.name)}?`,
    [`${a.name}, ${fmtArea(a.areaKm2!)}`],
    `${withThe(b.name)} covers ${fmtArea(b.areaKm2!)}.`,
  ),
);

// H. Rivers.
if (rivers.length >= 5) {
  add(
    "Name the three longest rivers in the world.",
    rivers.slice(0, 3).map((r) => `the ${r.name}, ${fmtKm(r.lengthKm)}`),
  );
  add(
    "Name the five longest rivers in the world.",
    rivers.slice(0, 5).map((r) => `the ${r.name}`),
    "Counting each river on its own, not combined river systems.",
  );
}
for (let i = 0; i + 1 < Math.min(rivers.length, 14); i += 2) {
  const a = rivers[i]!;
  const b = rivers[i + 1]!;
  if (a.lengthKm / b.lengthKm < 1.02) continue; // too close to call honestly
  add(
    `Which river is longer: the ${a.name} or the ${b.name}?`,
    [`the ${a.name}, ${fmtKm(a.lengthKm)}`],
    `The ${b.name} runs ${fmtKm(b.lengthKm)}.`,
  );
}
for (const r of rivers.slice(0, 25)) {
  if (r.countries.length === 1) {
    // "mainly": P17 tagging isn't guaranteed exhaustive (a single-country
    // river may graze a neighbor), but the tagged country is the main one.
    add(`The ${r.name} flows mainly through which country?`, r.countries);
  } else if (r.countries.length >= 2 && r.countries.length <= 4) {
    add(`Which countries does the ${r.name} flow through?`, [...r.countries].sort());
  }
}

// ─── Write ───────────────────────────────────────────────────────────────────

// Templates can collide only by producing the same question twice; keep first.
const seen = new Set<string>();
const unique = quizzes.filter((q) => {
  const key = q.question.toLowerCase();
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

const out = {
  track: "geography",
  trackName: "Geography",
  category: "Geography",
  source: {
    title: `Wikidata (fetched ${new Date().toISOString().slice(0, 10)})`,
    url: "https://query.wikidata.org/",
  },
  quizzes: unique,
};

await Bun.write(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${unique.length} quizzes → ${OUT}`);
