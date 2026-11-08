import MiniSearch from 'minisearch';

/** Small, editable spelling equivalences; no external stemmer or dictionary. */
export const spellingPairs = [
  ['tumour', 'tumor'], ['haemat', 'hemat'], ['oesophag', 'esophag'], ['oestrogen', 'estrogen'],
  ['leukaem', 'leukem'], ['anaem', 'anem'], ['paediatr', 'pediatr'], ['foetal', 'fetal'],
  ['behaviour', 'behavior'], ['colour', 'color'], ['favour', 'favor'], ['analyse', 'analyze'],
];
const irregular = new Map(Object.entries({ studies: 'study', studied: 'study', studying: 'study', mice: 'mouse', men: 'man', women: 'woman', children: 'child',
  analyses: 'analysis', hypotheses: 'hypothesis', indices: 'index', used: 'use', uses: 'use', using: 'use',
  analysed: 'analyze', analyzed: 'analyze', analysing: 'analyze', analyzing: 'analyze', analyzes: 'analyze' }));
export function normalizeQueryTerm(value) {
  let term = String(value).normalize('NFKC').toLowerCase();
  if (!/^[a-z]+$/.test(term)) return term;
  if (irregular.has(term)) return irregular.get(term);
  for (const [british, american] of spellingPairs) term = term.replaceAll(british, american);
  term = term.replace(/isation/g, 'ization').replace(/ising$/, 'izing').replace(/ised$/, 'ized');
  if (irregular.has(term)) return irregular.get(term);
  if (/ies$/.test(term) && term.length > 4) return term.slice(0, -3) + 'y';
  if (/(?:ches|shes|xes|zes|sses)$/.test(term)) term = term.slice(0, -2);
  else if (/s$/.test(term) && !/(?:ss|us|is)$/.test(term) && term.length > 3) term = term.slice(0, -1);
  if (/ing$/.test(term) && term.length > 5) {
    term = term.slice(0, -3).replace(/([bdglmnprt])\1$/, '$1');
    if (/(?:iz|at)$/.test(term)) term += 'e';
  } else if (/ied$/.test(term) && term.length > 4) term = term.slice(0, -3) + 'y';
  else if (/ed$/.test(term) && term.length > 4) {
    term = term.slice(0, -2).replace(/([bdglmnprt])\1$/, '$1');
    if (/(?:iz|at)$/.test(term)) term += 'e';
  }
  return term;
}
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
/** Only explicit uppercase acronym definitions with matching word initials are aliases. */
export function definedAcronymNodes(documents) {
  const definitions = new Map();
  for (const document of documents) {
    for (const match of String(document.content ?? '').matchAll(/((?:[A-Za-z]+[ -]+){1,7}[A-Za-z]+)\s*\(([A-Z]{2,8})\)/g)) {
      const words = match[1].split(/[ -]+/), acronym = match[2];
      const phrase = words.slice(-acronym.length);
      if (phrase.length !== acronym.length || phrase.map(word => word[0]).join('').toUpperCase() !== acronym) continue;
      const longForm = phrase.join(' ').toLowerCase();
      const aliases = definitions.get(acronym) ?? new Set([acronym]);
      aliases.add(longForm); definitions.set(acronym, aliases);
    }
  }
  return [...definitions].map(([acronym, aliases]) => {
    const fullForms = [...aliases].slice(1);
    const ambiguous = new Set(fullForms.map(form => form.split(' ').map(normalizeQueryTerm).join(' '))).size > 1;
    return { entity_id: 'defined-acronym:' + acronym, aliases: [...aliases], ...(ambiguous ? { ambiguous_acronym: acronym, full_forms: fullForms } : {}) };
  });
}
export function tokenizeQueryText(value, { supplemental = false } = {}) {
  const words = [];
  for (const part of segmenter.segment(String(value ?? '').normalize('NFKC'))) {
    if (!part.isWordLike) continue;
    const term = normalizeQueryTerm(part.segment);
    words.push(term);
    if (supplemental && /\p{Script=Han}/u.test(term) && [...term].length > 1) words.push(...term);
  }
  return [...new Set(words)];
}

/** One local BM25 configuration serves current library queries and definition comparisons. */
export function createLibraryBm25(documents) {
  const search = new MiniSearch({ fields: ['content', 'aliases', 'title'], tokenize: text => tokenizeQueryText(text, { supplemental: true }),
    processTerm: normalizeQueryTerm, searchOptions: { boost: { content: 2, aliases: 2, title: 1 }, tokenize: text => tokenizeQueryText(text), processTerm: normalizeQueryTerm } });
  search.addAll(documents);
  return search;
}
/** Aliases replace concepts as alternatives, while independent concepts remain separate. */
export function expandQueryGroups(query, nodes) {
  const original = String(query).normalize('NFKC');
  const normalized = original.toLowerCase();
  const diagnostics = [];
  const queryWords = [...normalized.matchAll(/[a-z]+/g)];
  const phraseKey = text => text.split(/[ -]+/).map(normalizeQueryTerm).join(' ');
  const phraseMatches = alias => {
    const words = phraseKey(alias).split(' ');
    return queryWords.flatMap((word, index) => {
      const slice = queryWords.slice(index, index + words.length);
      if (slice.length !== words.length || slice.some((part, i) => normalizeQueryTerm(part[0]) !== words[i])) return [];
      const end = slice.at(-1).index + slice.at(-1)[0].length;
      if (!/^[a-z -]+$/.test(normalized.slice(word.index, end))) return [];
      return [{ start: word.index, end }];
    });
  };
  const eligible = nodes.filter(node => {
    if (!node.ambiguous_acronym) return true;
    const acronym = node.ambiguous_acronym;
    if (new RegExp('\\b' + acronym + '\\b').test(original) || node.full_forms.some(form => phraseMatches(form).length)) {
      diagnostics.push({ code: 'ambiguous_acronym', acronym, full_forms: node.full_forms });
    }
    return false;
  });
  const candidates = eligible.flatMap(node => node.aliases.map(alias => ({ node, alias: String(alias).normalize('NFKC').toLowerCase() })))
    .flatMap(row => {
      if (!row.node.entity_id.startsWith('defined-acronym:')) return [row];
      const acronym = row.node.entity_id.slice('defined-acronym:'.length);
      if (row.alias === acronym.toLowerCase()) return [{ ...row, uppercase: acronym }];
      return phraseMatches(row.alias).map(range => ({ ...row, range }));
    }).filter(row => row.alias.trim()).sort((a, b) => b.alias.length - a.alias.length || a.alias.localeCompare(b.alias));
  let cursor = 0, pending = ''; const groups = [], expandedTerms = [];
  const flush = () => { groups.push(...tokenizeQueryText(pending).map(term => ({ terms: [[term]] }))); pending = ''; };
  while (cursor < normalized.length) {
    const matched = candidates.find(({ alias, uppercase, range }) => (range ? range.start === cursor : normalized.startsWith(alias, cursor))
      && (!uppercase || original.slice(cursor, cursor + alias.length) === uppercase)
      && (!/[a-z0-9]/.test(alias[0]) || cursor === 0 || !/[a-z0-9]/.test(normalized[cursor - 1]))
      && (!/[a-z0-9]/.test(alias.at(-1)) || !/[a-z0-9]/.test(normalized[range?.end ?? cursor + alias.length] ?? '')));
    if (!matched) { pending += normalized[cursor++]; continue; }
    flush();
    const aliases = [...new Set(matched.node.aliases)];
    groups.push({ node_id: matched.node.entity_id, terms: aliases.map(alias => tokenizeQueryText(alias)).filter(terms => terms.length) });
    expandedTerms.push({ node_id: matched.node.entity_id, matched_alias: matched.alias, aliases });
    cursor = matched.range?.end ?? cursor + matched.alias.length;
  }
  flush();
  return { groups, expandedTerms, ...(diagnostics.length ? { diagnostics } : {}) };
}
