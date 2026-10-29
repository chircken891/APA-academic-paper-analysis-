---
title: "APA 已发布论文"
type: view
tags: [v3, index]
---

# APA 已发布论文

本视图读取 `.apa-v3/phase22/COMMITTED.json` 指向的登记清单，不扫描旧版论文或阅读候选。它用于导航；`npm run index:check` 核验提交记录与历史登记索引的配对，查询入口从已登记笔记当前正文刷新内存索引。

```dataviewjs
try {
  const pointer = '.apa-v3/phase22/COMMITTED.json';
  const before = await app.vault.adapter.read(pointer);
  const marker = JSON.parse(before);
  if (typeof marker.generation_id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(marker.generation_id)) throw new Error('代次标识无效');
  const expected = '.apa-v3/phase22/generations/' + marker.generation_id + '/active.json';
  if (marker.active?.path !== expected) throw new Error('代次路径不匹配');
  const generation = JSON.parse(await app.vault.adapter.read(expected));
  if (generation.generation_id !== marker.generation_id || !Array.isArray(generation.papers) || generation.papers.some(p => p.pipeline_version !== '3.0')) throw new Error('不是当前 V3 代次');
  if (before !== await app.vault.adapter.read(pointer)) throw new Error('代次已更新，请刷新');
  dv.paragraph('当前代次：' + generation.generation_id);
  dv.table(['论文', '中文', 'English'], generation.papers.map(p => [p.paper_id, dv.fileLink(p.paths['zh-CN']), dv.fileLink(p.paths.en)]));
} catch (error) {
  dv.paragraph('尚无可读取的当前 V3 已发布代次：' + error.message);
}
```

运行边界见 [[Ontology/vault-content-policy|APA V3 内容策略]]。
