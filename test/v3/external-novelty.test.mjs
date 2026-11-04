import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareExternalNovelty, executeExternalNovelty, assessExternalNovelty, createNoveltyHttpAdapter, parsePubmedArticle } from '../../scripts/v3/external-novelty.mjs';

const input = () => ({ intent: 'check-external-novelty', idea: { id: 'idea-one', statement: 'Test one bounded research idea' },
  sources: ['pubmed', 'openalex'], budget: { max_calls: 30, search_rounds: 3 },
  claims: ['A', 'B', 'C'].map(id => ({ id, text: 'Claim ' + id, queries: ['one ' + id, 'two ' + id, 'three ' + id] })), date: '2026-11-04' });
const article = { title: 'Recorded study', doi: '10.1000/one', pmid: '123', year: 2025, journal: 'Recorded journal', abstract: 'We demonstrate claim A in a cohort.' };
const recorded = rows => ({ offline: true, search: async () => rows, lookup: async () => article });

test('preparation requires one explicit idea, sources, distinct queries and stated budget without calls', () => {
  assert.equal(prepareExternalNovelty(input()).queries.length, 18);
  assert.throws(() => prepareExternalNovelty({ ...input(), intent: undefined }), { code: 'WQ_NOVELTY_EXPLICIT_IDEA_REQUIRED' });
  assert.throws(() => prepareExternalNovelty({ ...input(), budget: { max_calls: 20, search_rounds: 2 } }), { code: 'WQ_NOVELTY_BUDGET_REQUIRED' });
  const bad = input(); bad.claims[0].queries = ['a', 'a', null];
  assert.throws(() => prepareExternalNovelty(bad), { code: 'WQ_NOVELTY_CLAIMS_REQUIRED' });
});
test('recorded empty searches complete as PROCEED with actual scope and no paper writes', async () => {
  const result = await executeExternalNovelty({ ...input(), adapter: recorded([]) });
  assert.equal(result.conclusion, 'PROCEED'); assert.equal(result.calls, 18);
  assert.equal(result.scope.queries.length, 18); assert.equal(result.reading_leads.length, 0);
  assert.match(result.content_hash, /^sha256:/);
});
test('real adapters require explicit network authorization and budget failures stay incomplete', async () => {
  await assert.rejects(executeExternalNovelty(input()), { code: 'WQ_NOVELTY_NETWORK_AUTHORIZATION_REQUIRED' });
  const result = await executeExternalNovelty({ ...input(), budget: { max_calls: 2, search_rounds: 3 }, adapter: recorded([]) });
  assert.equal(result.conclusion, '核对未完成'); assert.equal(result.calls, 2);
  assert.equal(result.missing_steps.length, 16);
});
test('recorded duplicate studies merge across DOI and PMID after lookup', async () => {
  const result = await executeExternalNovelty({ ...input(), adapter: recorded([{ pmid: '123' }, { doi: '10.1000/one' }]),
    assessments: [{ paper: 'pmid:123', claim_id: 'A', overlap: 'related', difference: 'Different intervention' }] });
  assert.equal(result.closest_work.length, 1); assert.equal(result.conclusion, 'PROCEED');
  assert.equal(result.reading_leads[0].status, '待读线索');
});
test('DOI lookup failure preserves UNVERIFIED candidate and missing step', async () => {
  const result = await executeExternalNovelty({ ...input(), adapter: { ...recorded([article]), lookup: async () => { throw new Error('recorded failure'); } },
    assessments: [{ paper: 'doi:10.1000/one', claim_id: 'A', overlap: 'related', difference: 'Different intervention' }] });
  assert.equal(result.conclusion, '核对未完成'); assert.equal(result.closest_work[0].verification, '[UNVERIFIED]');
  assert.ok(result.missing_steps.some(row => row.step === 'lookup'));
});
test('ABANDON requires confirmed published paper, core claim and exact abstract evidence', async () => {
  const assessment = { paper: 'doi:10.1000/one', claim_id: 'A', overlap: 'complete', difference: 'Core contribution already completed', evidence_quote: article.abstract };
  const result = await executeExternalNovelty({ ...input(), adapter: recorded([article]), assessments: [assessment] });
  assert.equal(result.conclusion, 'ABANDON'); assert.equal(result.closest_work[0].evidence_confirmed, true);
  const invalid = await executeExternalNovelty({ ...input(), adapter: recorded([article]), assessments: [{ ...assessment, evidence_quote: 'invented quote' }] });
  assert.equal(invalid.conclusion, '核对未完成');
});
test('CAUTION requires a concrete weak point with verified evidence; related work permits PROCEED', async () => {
  const assessment = { paper: 'doi:10.1000/one', claim_id: 'A', overlap: 'partial', difference: 'Different scale', evidence_quote: article.abstract, weakness: 'Study already validates one component' };
  assert.equal((await executeExternalNovelty({ ...input(), adapter: recorded([article]), assessments: [assessment] })).conclusion, 'PROCEED WITH CAUTION');
  assert.equal((await executeExternalNovelty({ ...input(), adapter: recorded([article]), assessments: [{ ...assessment, weakness: '' }] })).conclusion, 'PROCEED');
});
test('HTTP adapter parses recorded PubMed lookup and OpenAlex abstract positions offline', async () => {
  const adapter = createNoveltyHttpAdapter({ fetchImpl: async url => ({ ok: true, json: async () => url.includes('esearch') ? { esearchresult: { idlist: ['123'] } } : { results: [{ id: 'W1', title: 'Title', abstract_inverted_index: { b: [1], a: [0] } }] },
    text: async () => '<PMID>123</PMID><ArticleTitle>Test</ArticleTitle><Year>2025</Year><Title>Journal</Title><AbstractText>First &amp; second.</AbstractText><ArticleId IdType="doi">10.1000/one</ArticleId>' }) });
  assert.equal((await adapter.search({ source: 'pubmed', query: 'test' }))[0].pmid, '123');
  assert.equal((await adapter.lookup({ source: 'pubmed', paper: { pmid: '123' } })).abstract, 'First & second.');
  assert.equal((await adapter.search({ source: 'openalex', query: 'test' }))[0].abstract, 'a b');
});

test('abstract comparison completes the saved result without repeating network calls', async () => {
  const record = await executeExternalNovelty({ ...input(), adapter: recorded([article]) });
  assert.equal(record.conclusion, '核对未完成');
  const result = assessExternalNovelty({ record, assessments: [{ paper: 'doi:10.1000/one', claim_id: 'A', overlap: 'complete', difference: 'Core contribution completed', evidence_quote: article.abstract }] });
  assert.equal(result.conclusion, 'ABANDON');
  assert.equal(result.calls, record.calls);
  assert.throws(() => assessExternalNovelty({ record: { ...record, calls: 0 }, assessments: [] }), { code: 'WQ_NOVELTY_RECORD_CHANGED' });
});

// Date and title excerpt from recorded external-http/21-response.txt, PMID 27314333.
test('PubMed publication year ignores indexing dates and decodes numeric XML entities', () => {
  const xml = '<MedlineCitation><PMID>27314333</PMID><DateCompleted><Year>2017</Year></DateCompleted><Article><Journal><JournalIssue><PubDate><Year>2016</Year></PubDate></JournalIssue><Title>International journal of molecular sciences</Title></Journal><ArticleTitle>N-Glycosylation of Human R-Spondin 1 Is Required for Efficient Secretion and Stability but Not for Its Heparin Binding Ability.</ArticleTitle><AbstractText>Wnt&#xa0;/&#x3b2;-catenin &#946;</AbstractText><ArticleDate><Year>2015</Year></ArticleDate></Article></MedlineCitation>';
  assert.equal(parsePubmedArticle(xml).year, '2016');
  assert.equal(parsePubmedArticle(xml).abstract, 'Wnt\u00a0/β-catenin β');
  assert.equal(parsePubmedArticle('<DateCompleted><Year>2020</Year></DateCompleted><ArticleDate><Year>2018</Year></ArticleDate>').year, '2018');
  assert.equal(parsePubmedArticle('<Journal><JournalIssue><PubDate><MedlineDate>2016 Jun-Jul</MedlineDate></PubDate></JournalIssue></Journal>').year, '2016');
  assert.equal(parsePubmedArticle('<DateCompleted><Year>2020</Year></DateCompleted>').year, '');
});

test('evidence-backed exclusion removes an irrelevant candidate without changing the original record', async () => {
  const record = await executeExternalNovelty({ ...input(), adapter: { ...recorded([article]), lookup: async () => { throw new Error('offline failure'); } } });
  const before = JSON.stringify(record);
  const exclusions = [{ paper: 'doi:10.1000/one', reason: 'Different research question', evidence_quote: article.title }];
  const result = assessExternalNovelty({ record, assessments: [], exclusions });
  assert.equal(result.conclusion, 'PROCEED');
  assert.equal(result.closest_work.length, 0);
  assert.equal(result.reading_leads.length, 0);
  assert.equal(result.excluded_work[0].paper.identity, 'doi:10.1000/one');
  assert.equal(JSON.stringify(record), before);
  assert.throws(() => assessExternalNovelty({ record, assessments: [], exclusions: [{ ...exclusions[0], evidence_quote: 'fabricated' }] }), { code: 'WQ_NOVELTY_EXCLUSION_INVALID' });
  assert.throws(() => assessExternalNovelty({ record, assessments: [], exclusions: [{ ...exclusions[0], reason: '' }] }), { code: 'WQ_NOVELTY_EXCLUSION_INVALID' });
  assert.throws(() => assessExternalNovelty({ record, assessments: [], exclusions: [{ ...exclusions[0], paper: 'missing' }] }), { code: 'WQ_NOVELTY_EXCLUSION_INVALID' });
  assert.throws(() => assessExternalNovelty({ record, assessments: [{ paper: exclusions[0].paper }], exclusions }), { code: 'WQ_NOVELTY_EXCLUSION_INVALID' });
});

test('exclusions preserve failed searches and unverified relevant candidates', async () => {
  const other = { ...article, doi: '10.1000/other', pmid: '456', title: 'Relevant candidate' };
  let searches = 0;
  const record = await executeExternalNovelty({ ...input(), adapter: { offline: true, search: async () => { if (!searches++) throw new Error('search unavailable'); return [article, other]; }, lookup: async () => { throw new Error('lookup unavailable'); } } });
  const result = assessExternalNovelty({ record, exclusions: [{ paper: 'doi:10.1000/one', reason: 'Unrelated', evidence_quote: article.title }],
    assessments: [{ paper: 'doi:10.1000/other', claim_id: 'A', overlap: 'complete', difference: 'Possible complete overlap', evidence_quote: other.abstract }] });
  assert.equal(result.status, 'incomplete');
  assert.ok(result.missing_steps.some(row => row.step === 'search'));
  assert.ok(result.missing_steps.some(row => row.step === 'lookup' && row.paper === 'doi:10.1000/other'));
  assert.ok(result.missing_steps.some(row => row.step === 'overlap_evidence'));
  assert.equal(result.closest_work.length, 1);
  assert.equal(result.reading_leads.length, 1);
  const allExcluded = assessExternalNovelty({ record, assessments: [], exclusions: [article, other].map(paper => ({
    paper: 'doi:' + paper.doi, reason: 'Different question', evidence_quote: paper.title })) });
  assert.equal(allExcluded.closest_work.length, 0);
  assert.equal(allExcluded.status, 'incomplete');
  assert.ok(allExcluded.missing_steps.every(row => row.step === 'search'));
});
