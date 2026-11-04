import { createHash } from 'node:crypto';

const fail = (code, details) => { throw Object.assign(new Error(code), { code, details }); };
const hash = value => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = value => typeof value === 'string' && value.trim().length > 0;
const doi = value => String(value ?? '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase();
const key = row => row.doi ? 'doi:' + doi(row.doi) : row.pmid ? 'pmid:' + row.pmid : row.id ?? row.title;

/** Prepare only; no request is made until executeExternalNovelty is explicitly invoked. */
export function prepareExternalNovelty(input = {}) {
  if (input.intent !== 'check-external-novelty' || !text(input.idea?.id) || !text(input.idea?.statement)) fail('WQ_NOVELTY_EXPLICIT_IDEA_REQUIRED');
  const sources = input.sources;
  if (!Array.isArray(sources) || !sources.length || new Set(sources).size !== sources.length || sources.some(source => !['pubmed', 'openalex'].includes(source))) fail('WQ_NOVELTY_SOURCES_REQUIRED');
  if (!Number.isInteger(input.budget?.max_calls) || input.budget.max_calls < 1 || !Number.isInteger(input.budget?.search_rounds) || input.budget.search_rounds < 3) fail('WQ_NOVELTY_BUDGET_REQUIRED');
  const claims = input.claims;
  if (!Array.isArray(claims) || claims.length < 3 || claims.length > 5 || new Set(claims.map(row => row.id)).size !== claims.length
      || claims.some(row => !text(row.id) || !text(row.text) || !Array.isArray(row.queries) || row.queries.some(q => !text(q))
        || row.queries.length > input.budget.search_rounds || new Set(row.queries.map(q => q.trim())).size < 3)) fail('WQ_NOVELTY_CLAIMS_REQUIRED');
  const queries = claims.flatMap(claim => claim.queries.map(query => sources.map(source => ({ claim_id: claim.id, query, source })))).flat();
  return { ok: true, status: 'prepared', idea: structuredClone(input.idea), claims: structuredClone(claims), sources: [...sources], budget: { ...input.budget }, queries,
    generation_id: input.generation_id ?? null, content_hash: hash({ idea: input.idea, claims, sources, budget: input.budget }) };
}

/** A caller may inject recorded responses. Each search/lookup invocation consumes one call. */
export async function executeExternalNovelty(input = {}) {
  const prepared = prepareExternalNovelty(input);
  if (input.network_authorized !== true && !input.adapter?.offline) fail('WQ_NOVELTY_NETWORK_AUTHORIZATION_REQUIRED');
  const adapter = input.adapter ?? createNoveltyHttpAdapter();
  if (typeof adapter.search !== 'function' || typeof adapter.lookup !== 'function') fail('WQ_NOVELTY_ADAPTER_INVALID');
  let calls = 0;
  const missing = [], searches = [], papers = new Map();
  async function call(kind, args) {
    if (calls >= prepared.budget.max_calls) throw Object.assign(new Error('budget exhausted'), { code: 'budget_exhausted' });
    calls++;
    return adapter[kind](args);
  }
  for (const query of prepared.queries) {
    try {
      const rows = await call('search', query);
      if (!Array.isArray(rows)) throw new Error('invalid search response');
      searches.push({ ...query, status: 'complete', matches: rows.length });
      for (const row of rows) {
        const identity = key(row);
        if (!identity) continue;
        const prior = papers.get(identity);
        if (prior) { prior.claim_ids = [...new Set([...prior.claim_ids, query.claim_id])]; continue; }
        papers.set(identity, { ...row, source: query.source, identity, claim_ids: [query.claim_id] });
      }
    } catch (error) {
      searches.push({ ...query, status: 'incomplete', reason: error.code ?? error.message });
      missing.push({ step: 'search', ...query, reason: error.code ?? error.message });
    }
  }
  const closest = [];
  for (const row of papers.values()) {
    let verified = null;
    try {
      verified = await call('lookup', { source: row.source, paper: row });
      const identityMatches = verified && ((row.pmid && String(verified.pmid) === String(row.pmid)) || (row.doi && doi(verified.doi) === doi(row.doi)));
      if (!identityMatches) throw new Error('identifier_not_confirmed');
    } catch (error) {
      missing.push({ step: 'lookup', paper: row.identity, reason: error.code ?? error.message });
    }
    const confirmed = verified && ((row.pmid && String(verified.pmid) === String(row.pmid)) || (row.doi && doi(verified.doi) === doi(row.doi)));
    const paper = { ...row, ...(confirmed ? verified : {}), verification: confirmed ? 'confirmed' : '[UNVERIFIED]' };
    const duplicate = closest.find(other => (paper.doi && doi(other.doi) === doi(paper.doi)) || (paper.pmid && String(other.pmid) === String(paper.pmid)));
    if (duplicate) { duplicate.claim_ids = [...new Set([...duplicate.claim_ids, ...paper.claim_ids])]; continue; }
    const assessment = (input.assessments ?? []).find(item => item.paper === row.identity);
    if (!text(paper.abstract)) missing.push({ step: 'abstract', paper: row.identity, reason: 'abstract_unavailable' });
    if (!assessment || !['related', 'partial', 'complete'].includes(assessment.overlap) || !text(assessment.difference)
      || !prepared.claims.some(claim => claim.id === assessment.claim_id)) {
      missing.push({ step: 'comparison', paper: row.identity, reason: 'claim_comparison_required' });
    }
    const evidenceConfirmed = confirmed && text(assessment?.evidence_quote) && text(paper.abstract) && paper.abstract.includes(assessment.evidence_quote);
    if (assessment?.overlap === 'complete' && (!evidenceConfirmed || !text(paper.year) && !Number.isInteger(paper.year))) {
      missing.push({ step: 'overlap_evidence', paper: row.identity, reason: 'published_paper_and_abstract_location_required' });
    }
    closest.push({ ...paper, assessment: assessment ?? null, evidence_confirmed: Boolean(evidenceConfirmed) });
  }
  const abandon = closest.find(row => row.assessment?.overlap === 'complete' && row.evidence_confirmed && row.verification === 'confirmed');
  const caution = closest.find(row => row.assessment?.overlap === 'partial' && row.evidence_confirmed && text(row.assessment?.weakness));
  const conclusion = missing.length ? '核对未完成' : abandon ? 'ABANDON' : caution ? 'PROCEED WITH CAUTION' : 'PROCEED';
  const result = { ok: true, status: missing.length ? 'incomplete' : 'complete', idea_id: prepared.idea.id, claims: prepared.claims, generation_id: prepared.generation_id,
    scope: { sources: prepared.sources, date: input.date ?? new Date().toISOString().slice(0, 10), queries: searches },
    calls, budget: prepared.budget, conclusion, missing_steps: missing, closest_work: closest,
    positioning: input.positioning ?? (conclusion === 'PROCEED' ? '在本次记录的检索范围内，可继续探索所列核心贡献。' : conclusion === 'ABANDON' ? '已有明确重叠贡献，需重新定位核心主张。' : conclusion === 'PROCEED WITH CAUTION' ? '围绕已记录的具体差异继续探索，并回应近邻工作的重叠。' : '补齐列出的核对步骤后再判断定位。'),
    reading_leads: closest.map(row => ({ title: row.title, year: row.year, journal: row.journal, doi: row.doi ?? null, pmid: row.pmid ?? null, verification: row.verification, status: '待读线索' })),
    scientific_approval: false };
  return { ...result, content_hash: hash(result) };
}

/** Apply same-task abstract comparisons to a saved response without issuing searches again. */
export function assessExternalNovelty({ record, assessments, exclusions = [], positioning } = {}) {
  if (!record || !Array.isArray(record.closest_work) || !Array.isArray(record.claims) || !Array.isArray(assessments)) fail('WQ_NOVELTY_RECORD_REQUIRED');
  const { content_hash: fingerprint, ...original } = record;
  if (fingerprint !== hash(original)) fail('WQ_NOVELTY_RECORD_CHANGED');
  if (!Array.isArray(exclusions)) fail('WQ_NOVELTY_EXCLUSION_INVALID');
  const excluded = new Set();
  const excludedWork = exclusions.map(exclusion => {
    const paper = record.closest_work.find(row => row.identity === exclusion?.paper);
    if (!paper || excluded.has(exclusion.paper) || assessments.some(row => row.paper === exclusion.paper)
      || !text(exclusion.reason) || !text(exclusion.evidence_quote)
      || ![paper.title, paper.abstract].some(value => text(value) && value.includes(exclusion.evidence_quote))) fail('WQ_NOVELTY_EXCLUSION_INVALID');
    excluded.add(exclusion.paper);
    return { paper: structuredClone(paper), reason: exclusion.reason, evidence_quote: exclusion.evidence_quote };
  });
  const missing = (record.missing_steps ?? []).filter(row => !['comparison', 'overlap_evidence'].includes(row.step)
    && !(excluded.has(row.paper) && ['lookup', 'abstract'].includes(row.step)));
  const closest = record.closest_work.filter(paper => !excluded.has(paper.identity)).map(paper => {
    const assessment = assessments.find(row => row.paper === paper.identity);
    const valid = assessment && ['related', 'partial', 'complete'].includes(assessment.overlap) && text(assessment.difference)
      && record.claims.some(claim => claim.id === assessment.claim_id);
    if (!valid) missing.push({ step: 'comparison', paper: paper.identity, reason: 'claim_comparison_required' });
    const confirmed = paper.verification === 'confirmed' && text(assessment?.evidence_quote) && text(paper.abstract) && paper.abstract.includes(assessment.evidence_quote);
    if (assessment?.overlap === 'complete' && (!confirmed || !paper.year)) missing.push({ step: 'overlap_evidence', paper: paper.identity, reason: 'published_paper_and_abstract_location_required' });
    return { ...paper, assessment: valid ? structuredClone(assessment) : null, evidence_confirmed: Boolean(confirmed) };
  });
  const abandon = closest.find(row => row.assessment?.overlap === 'complete' && row.evidence_confirmed);
  const caution = closest.find(row => row.assessment?.overlap === 'partial' && row.evidence_confirmed && text(row.assessment.weakness));
  const conclusion = missing.length ? '核对未完成' : abandon ? 'ABANDON' : caution ? 'PROCEED WITH CAUTION' : 'PROCEED';
  const result = { ...original, status: missing.length ? 'incomplete' : 'complete', missing_steps: missing, closest_work: closest, conclusion,
    ...(exclusions.length ? { excluded_work: [...(record.excluded_work ?? []), ...excludedWork],
      reading_leads: closest.map(row => ({ title: row.title, year: row.year, journal: row.journal, doi: row.doi ?? null, pmid: row.pmid ?? null, verification: row.verification, status: '待读线索' })) } : {}),
    positioning: positioning ?? (conclusion === 'PROCEED' ? '在本次记录的检索范围内，可继续探索所列核心贡献。' : conclusion === 'ABANDON' ? '依据点名近邻论文，重新定位已被覆盖的核心主张。' : conclusion === 'PROCEED WITH CAUTION' ? '针对表内具体薄弱点完善差异和验证设计。' : '补齐记录中的缺失步骤后继续判断。') };
  return { ...result, content_hash: hash(result) };
}

const decode = value => String(value ?? '').replace(/<[^>]+>/g, '').replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (entity, code) => {
  const point = /^x/i.test(code) ? parseInt(code.slice(1), 16) : Number(code);
  return point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
}).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
const tag = (xml, name) => decode(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>').exec(xml)?.[1]);
export function parsePubmedArticle(xml) {
  const journal = /<Journal(?:\s[^>]*)?>([\s\S]*?)<\/Journal>/.exec(xml)?.[1] ?? '';
  const issue = /<JournalIssue(?:\s[^>]*)?>([\s\S]*?)<\/JournalIssue>/.exec(journal)?.[1] ?? '';
  const pubDate = /<PubDate(?:\s[^>]*)?>([\s\S]*?)<\/PubDate>/.exec(issue)?.[1] ?? '';
  const articleDate = /<ArticleDate(?:\s[^>]*)?>([\s\S]*?)<\/ArticleDate>/.exec(xml)?.[1] ?? '';
  const year = tag(pubDate, 'Year') || tag(articleDate, 'Year') || /\b\d{4}\b/.exec(tag(pubDate, 'MedlineDate'))?.[0] || '';
  return { pmid: tag(xml, 'PMID'), title: tag(xml, 'ArticleTitle'), year, journal: tag(journal, 'Title'),
    doi: decode(/<ArticleId IdType="doi">([\s\S]*?)<\/ArticleId>/.exec(xml)?.[1]),
    abstract: [...xml.matchAll(/<AbstractText(?:\s[^>]*)?>([\s\S]*?)<\/AbstractText>/g)].map(match => decode(match[1])).join('\n') };
}
function openAlexPaper(work) {
  const positions = Object.entries(work.abstract_inverted_index ?? {}).flatMap(([word, indexes]) => indexes.map(index => [index, word])).sort((a, b) => a[0] - b[0]);
  return { id: work.id, title: work.title, year: work.publication_year, journal: work.primary_location?.source?.display_name ?? '', doi: doi(work.doi), pmid: work.ids?.pmid?.split('/').at(-1), abstract: positions.map(row => row[1]).join(' ') };
}
export function createNoveltyHttpAdapter({ fetchImpl = globalThis.fetch } = {}) {
  async function get(url, json = true) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Object.assign(new Error('HTTP ' + response.status), { code: 'http_' + response.status });
    return json ? response.json() : response.text();
  }
  return {
    async search({ source, query }) {
      if (source === 'pubmed') {
        const result = await get('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=10&term=' + encodeURIComponent(query));
        return (result.esearchresult?.idlist ?? []).map(pmid => ({ pmid }));
      }
      const result = await get('https://api.openalex.org/works?per-page=10&search=' + encodeURIComponent(query));
      return (result.results ?? []).map(openAlexPaper);
    },
    async lookup({ source, paper }) {
      if (source === 'pubmed') {
        const xml = await get('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&retmode=xml&id=' + encodeURIComponent(paper.pmid), false);
        return parsePubmedArticle(xml);
      }
      const id = paper.doi ? 'https://doi.org/' + doi(paper.doi) : paper.id;
      return openAlexPaper(await get('https://api.openalex.org/works/' + encodeURIComponent(id)));
    }
  };
}
