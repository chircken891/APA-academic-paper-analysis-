import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReadingFirstEditor, readingFirstViewsFingerprint } from '../../scripts/v3/reading-first-editor.mjs';
const views=['en','zh-CN'].map(language=>({language,sections:[{id:'abstract',module_id:'abstract',paragraphs:['Original abstract.']},{id:'design',module_id:'design',paragraphs:['The design supports the main finding.']}]}));
const editor=()=>({schema_version:'reading-editor-1.0',views_fingerprint:readingFirstViewsFingerprint(views),languages:Object.fromEntries(['en','zh-CN'].map(language=>[language,{overview:[{text:'Main finding',section_ids:['design']}],sections:[{section_id:'design',takeaway:'The design supports inference.',emphasis:[{paragraph_index:0,text:'main finding'}],subheadings:[{before_paragraph:0,heading:'Design'}]}],methods:[{id:'method',title:'Method',explanation:'Known method.',application:'Used for the design.',section_ids:['design'],knowledge_id:'method'}]}]))});
const validate=value=>validateReadingFirstEditor({editor:value,views,presentation:{knowledge:[{id:'method'}]}});
test('reading editor binds accepted bilingual views and preserves prose via metadata',()=>{
  const value=editor(); assert.equal(validate(value),value);
  assert.equal(readingFirstViewsFingerprint([...views].reverse()),value.views_fingerprint);
  assert.throws(()=>validate({...value,views_fingerprint:'stale'}),/FINGERPRINT_INVALID/);
});
test('reading editor rejects invented emphasis, changed abstract and unresolved method references',()=>{
  const changed=editor();changed.languages.en.sections[0].emphasis[0].text='invented';assert.throws(()=>validate(changed),/EMPHASIS_INVALID/);
  const abstract=editor();abstract.languages.en.sections[0].section_id='abstract';assert.throws(()=>validate(abstract),/SECTION_INVALID/);
  const method=editor();method.languages.en.methods[0].knowledge_id='missing';assert.throws(()=>validate(method),/METHOD_INVALID/);
  const bilingual=editor();bilingual.languages.en.methods[0].id='other';assert.throws(()=>validate(bilingual),/BILINGUAL_METHODS_INVALID/);
});
test('shared bilingual inventory validates nonempty knowledge links and matching association sets',()=>{
  const presentation={knowledge_layout:'shared-bilingual-1.0',knowledge:[{id:'method'},{id:'measure'}]};
  const check=value=>validateReadingFirstEditor({editor:value,views,presentation});
  const value=editor();
  for (const language of ['en','zh-CN']) {
    delete value.languages[language].methods[0].knowledge_id;
    value.languages[language].methods[0].knowledge_ids=['method','measure'];
  }
  assert.equal(check(value),value);
  value.languages.en.methods[0].knowledge_ids.reverse();
  assert.equal(check(value),value);
  value.languages.en.methods[0].knowledge_ids=['method'];
  assert.throws(()=>check(value),/BILINGUAL_METHODS_INVALID/);
  value.languages.en.methods[0].knowledge_ids=['unknown'];
  assert.throws(()=>check(value),/METHOD_INVALID/);
  value.languages.en.methods[0].knowledge_ids=[];
  assert.throws(()=>check(value),/BILINGUAL_METHODS_INVALID/);
  delete value.languages.en.methods[0].knowledge_ids;
  value.languages['zh-CN'].methods[0].knowledge_ids=[];
  assert.equal(check(value),value);
  value.languages.en.methods[0].explanation='';
  assert.throws(()=>check(value),/METHOD_INVALID/);
});
test('legacy inventory supports optional links and rejects malformed knowledge arrays',()=>{
  const value=editor(); delete value.languages.en.methods[0].knowledge_id;
  assert.equal(validate(value),value);
  value.languages.en.methods[0].knowledge_ids=['method','method'];
  assert.throws(()=>validate(value),/METHOD_INVALID/);
  value.languages.en.methods[0].knowledge_ids='method';
  assert.throws(()=>validate(value),/METHOD_INVALID/);
});
