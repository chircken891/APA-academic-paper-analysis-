/** Explicit source language takes precedence; legacy bilingual sources retain the Chinese entry. */
export function paperSourcePath(paper) {
  const paths = paper.paths ?? {};
  if (paper.source_language && paths[paper.source_language]) return paths[paper.source_language];
  const sources = Object.values(paths).filter(path => path.startsWith('Wiki/sources/'));
  if (sources.length === 1) return sources[0];
  return paths['zh-CN'] ?? paths.en ?? sources[0];
}
