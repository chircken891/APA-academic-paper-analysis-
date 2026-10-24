import {createHash} from 'node:crypto';
import {canonicalizeV3Json} from './semantic-package-validator.mjs';
import {deriveParserRunIdentity} from './parser-adapter.mjs';
import {reviewedTableRows} from './grouped-source-comparison.mjs';

const hash=x=>'sha256:'+createHash('sha256').update(canonicalizeV3Json(x)).digest('hex');
const bytes=x=>'sha256:'+createHash('sha256').update(x).digest('hex');
const same=(a,b)=>hash(a)===hash(b),need=(ok,why)=>{if(!ok)throw Error('SNF_REVIEW_INVALID:'+why);};
const at=(o,p)=>p.split('/').slice(1).reduce((v,k)=>v?.[k.replaceAll('~1','/').replaceAll('~0','~')],o);
export const SNF_UNRESOLVED='ref_bc3e6b80bf84b03cb7b736b0d692f392';
export const SNF_EXTRA='known-transition-kernel-R2133-05';
const PARTIAL='ref_87f9b96fdbef5785c58e55bfeabfed43',IDH='ref_4d61c0150c3b675215a99e3bfd068d51',COX='ref_457775bd498d36251ff4b849396376b4';
export const SNF_PROFILES=Object.freeze({
 ref_b7c733f786f2edce1aa284147a85b582:'text',ref_f8fc504178b4023f0afdc519c34dd1b9:'text',ref_4d61c0150c3b675215a99e3bfd068d51:'text',ref_1e660a3ef6ee668372be9ce0c2da3fc0:'table1',ref_6f49ab874974a6676d0c93e35bfe0f8a:'text',ref_c8565da3d90b48387c4ee6f94eb083ff:'table2',
 ref_f0be2c1fe5cc0e731259136b14507b0d:'kernel',ref_2b4b6344624d15aa5bf8669e11cc729b:'branches',ref_bc3e6b80bf84b03cb7b736b0d692f392:'unresolved',ref_457775bd498d36251ff4b849396376b4:'penalty',ref_618c9851251f155cb569b36bb144f52a:'stopping',ref_87f9b96fdbef5785c58e55bfeabfed43:'propagation',ref_43e58d5c19c0e0a3f6a99824579a3276:'text',ref_0345d03b2eddcb2026b7f2db1a1f2b41:'text',ref_919b0a1ad58ca97babcbfe4286feb8dd:'text',
 ref_52c1d0c5ad9f7109845488c19762e622:'text',ref_c3e5a9a3380b942bfb4761a71d1b7983:'text',ref_8d3f9af69f59e48df342eb7d37603800:'text',ref_fcd0967d054d26cf9332116b254ac241:'text',ref_2b9759784869017c241f80f19b3098e8:'text',ref_1f39c6756d242723368c07fd38679276:'text',ref_4f0be53149ba53793c7f58c400ea5618:'text',ref_5a267a77a30bf491a4bcf9f4e0ecf8ca:'text',ref_f2d5d8274c039bcbf0903d080a7302fe:'equation',ref_386566391ffa648b29befc8ddd6861d6:'text',ref_6bf705dbda2bbc040d18d5d36b7f5bd2:'text',ref_6c9cd6be71e0405b9484a43a64072e5f:'text',ref_f3bd69f6c77920218666fc1cd5c3071a:'standardization',ref_01b4094e7b5118a66cc6a368ad602905:'text',ref_f26f34fa3bd85ee928ed25b1d05a03c0:'text',ref_632d247719efa4a19a601f7c9b045130:'text',ref_5d4cad40871663f31873527da5ceaa4c:'text'
});
const REF_EDITS={
 [COX]:[['Σ_i δ_i','Σ_(i=1)^n δ_i',1],['Σ_(i,j)','Σ_iΣ_j',1]],
 ref_c3e5a9a3380b942bfb4761a71d1b7983:[['δ_i is an indicator','δ_i(·) is an indicator',1]]
};
const PATCHES={native:[['native-0082','ref_f3bd69f6c77920218666fc1cd5c3071a',[['f̂','f̃',1]]],['native-0083','ref_f3bd69f6c77920218666fc1cd5c3071a',[['f̂','f̃',1]]],['native-0210',SNF_EXTRA,[['W̃','Ŵ',3]]]],hybrid:[['hybrid-0146',COX,[['l p ( z )','l _ { p } ( z )',1]]],['hybrid-0234',SNF_EXTRA,[['∑_j Ŵ_{ij}','∑_i Ŵ_{ij}',1]]]]};
function edit(text,changes){for(const[from,to,n]of changes){need(text.split(from).length-1===n,'replacement-count');text=text.split(from).join(to);}return text;}
const sub=Object.fromEntries([...'₀₁₂₃₄₅₆₇₈₉ᵢⱼₖₗₘₙₜ₊₋ₚ₌'].map((x,i)=>[x,[...'0123456789ijklmnt+-p='][i]]));
const sup={'⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9','⁻':'-','⁺':'+','ᵀ':'T','⁽':'(','⁾':')','ᶜ':'c','ᵛ':'v','ⁿ':'n'};

// A closed notation decoder. Unknown commands fail; no algebra or index renaming.
function expandMath(raw,{text=false}={}){
 let s=String(raw??'').normalize('NFD').replaceAll('≠','≠').replace(/\{\s*\\bf\s+([A-Za-z])\s*\}/g,'$1').replace(/<sup>([^<]+)<\/sup>/g,'^{$1}').replace(/<sub>([^<]+)<\/sub>/g,'_{$1}');
 s=s.replace(/[₀₁₂₃₄₅₆₇₈₉ᵢⱼₖₗₘₙₜ₊₋ₚ₌]+(?:,[₀₁₂₃₄₅₆₇₈₉ᵢⱼₖₗₘₙₜ₊₋ₚ₌]+)?/gu,x=>'_{'+[...x].map(c=>sub[c]??c).join('')+'}').replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺ᵀ⁽⁾ᶜᵛⁿ]+/gu,x=>'^{'+[...x].map(c=>sup[c]).join('')+'}');
 function decode(t){let i=0,out='';const ws=()=>{while(/\s/.test(t[i]??'')&&i<t.length)i++;};const arg=(bare=false)=>{ws();if(t[i]!=='{'){need(bare&&/[A-Za-z]/.test(t[i]??''),'tex-argument');return t[i++];}let start=++i,d=1;while(i<t.length&&d){if(t[i]==='{')d++;if(t[i]==='}')d--;i++;}need(!d,'tex-braces');return decode(t.slice(start,i-1));};
  while(i<t.length){if(t[i]!=='\\'){out+=t[i++];continue;}i++;if(t[i]==='\\'){out+=';';i++;continue;}if(t[i]==='|'){out+='‖';i++;continue;}if([',',';','!',' ','(',')'].includes(t[i])){i++;continue;}if(['{','}'].includes(t[i])){out+=t[i++];continue;}const m=t.slice(i).match(/^[A-Za-z]+/);need(m,'tex-command');const c=m[0];i+=c.length;const symbols={rho:'ρ',mu:'μ',epsilon:'ε',varepsilon:'ε',eta:'η',delta:'δ',lambda:'λ',sum:'Σ',Sigma:'Σ',nu:'ν',in:'∈',ne:'≠',neq:'≠',approx:'≈',times:'*',cdot:'*',prime:'′',mid:'|',lVert:'‖',rVert:'‖',Vert:'‖',ldots:'…',cdots:'…'};
   if(c in symbols)out+=symbols[c];else if(c==='frac'||c==='dfrac')out+='(('+arg()+')/('+arg()+'))';else if(c==='sqrt')out+='sqrt('+arg()+')';else if(['exp','log'].includes(c))out+=c;else if(c==='bf'){}
   else if(['hat','widehat','tilde','widetilde','bar'].includes(c))out+=arg(true)+({hat:'̂',widehat:'̂',tilde:'̃',widetilde:'̃',bar:'̄'}[c]);
   else if(['mathbf','mathrm','text','operatorname','mathit','boldsymbol'].includes(c)){let a=arg(true);if(c==='mathrm'&&['mean','Var','otherwise','if','p','-value','i.e.'].includes(a.replace(/\s/g,'')))a=a.replace(/\s/g,'');out+=a;}else if(['quad','qquad'].includes(c))out+=' ';else if(['left','right','big','Big','bigg','Bigg','Bigl','Bigr'].includes(c)){ws();if(t[i]==='.')i++;}
   else if(c==='tag'){const a=arg();need(/^\d+$/.test(a),'tag');out+='@tag('+a+')';}
   else if(c==='begin'||c==='end'){const a=arg();need(['cases','array','matrix','pmatrix','bmatrix'].includes(a),'environment');out+=c==='begin'?'[':']';if(c==='begin'&&a==='array'){ws();if(t[i]==='{')arg();}}
   else need(false,'tex-command:'+c);
  }return out;
 }
 s=decode(s).replaceAll('$','').replaceAll('−','-').replaceAll('∑','Σ').replaceAll('×','*').replaceAll('∗','*').replaceAll('√','sqrt').replaceAll('’',"'").replaceAll('′',"'");
 s=s.replace(/_\{([a-z]),([a-z])\}/g,'_{$1$2}').replace(/ε_([ij]),([ij])/g,'ε_{$1$2}');
 s=s.replace(/Σ_\{([jk])\}(∈R\(t_\{i\}\)|∈N_\{i\}|≠i)/g,'Σ_{$1$2}');
 s=s.replace(/Σ_\{([jk])\}≠_\{([ij])\}/g,'Σ_{$1≠$2}');
 if(!text)s=s.replace(/\s+/g,'');
 return s;
}
export const snfExpandedNotation=raw=>expandMath(raw,{text:true});
function math(raw){
 let s=expandMath(raw).replace(/@tag\(\d+\)$/,'').replace(/[.,]$/,'');let i=0;
 const take=c=>{need(s.startsWith(c,i),'expected:'+c);i+=c.length;};
 const groupText=()=>{const open=s[i++],close=open==='{'?'}':')';let start=i,d=1;while(i<s.length&&d){if(s[i]===open)d++;if(s[i]===close)d--;i++;}need(!d,'script-group');return s.slice(start,i-1);};
 const script=()=>{if(['{','('].includes(s[i]))return groupText();const m=s.slice(i).match(/^(?:[0-9]+|ij|[A-Za-z])/);need(m,'script');i+=m[0].length;return m[0];};
 const mul=(a,b)=>['mul',...(a[0]==='mul'?a.slice(1):[a]),...(b[0]==='mul'?b.slice(1):[b])];
 const canAtom=()=>Boolean(s[i])&&/[A-Za-zα-ωΑ-Ω0-9({[‖Σ]/u.test(s[i]);
 function atom(){let c=s[i];need(c,'atom');if(c==='-'||c==='+'){i++;return[c==='-'?'neg':'pos',expr(30)];}
  if(c==='‖'||s.startsWith('||',i)){const mark=c==='‖'?'‖':'||';i+=mark.length;const end=s.indexOf(mark,i);need(end>=i,'norm');const a=math(s.slice(i,end));i=end+mark.length;return['norm',a];}
  if(c==='('||c==='['||c==='{'){i++;const v=expr(0);take(c==='('?')':c==='['?']':'}');return v;}
  if(c==='Σ'){i++;take('_');const condition=script().replace(/[{}]/g,'');let upper=null;if(s[i]==='^'){i++;upper=script();}return['sum',condition,upper,expr(20)];}
  const num=s.slice(i).match(/^\d+(?:\.\d+)?/);if(num){i+=num[0].length;return['number',num[0]];}
  const name=s.slice(i).match(/^(sqrt|exp|log|mean|Var|NMI|cs|[A-Za-zα-ωΑ-Ω])/u);need(name,'name:'+s.slice(i));i+=name[0].length;let v=['var',name[0]],last;
  while(['̂','̃','̄'].includes(s[i]))v=['accent',v,s[i++]];
  while(s[i]==='_'||s[i]==='^'){const op=s[i++],a=script();v=op==='_'?['index',v,a.replace(/[{}(),]/g,'')]:['power',v,math(a)];last=op;}
  if(s[i]==="'"){i++;v=['prime',v];}
  const callNames=['sqrt','exp','log','mean','Var','NMI','E','ρ','W','P','S','R','h','l','cs'];
  if(s[i]==='('&&callNames.includes(name[0])){i++;const args=[expr(0)];while(s[i]===','){i++;args.push(expr(0));}take(')');v=['call',v,args];}
  else if(['sqrt','exp','log'].includes(name[0]))v=['call',v,[atom()]];
  return v;
 }
 function expr(min){let a=atom();for(;;){let op,prec,implicit=false,c=s[i];if(c==='^'){if(40<min)break;i++;a=['power',a,math(script())];continue;}if(c==='='){op='eq';prec=1;}else if(c===':'){op='range';prec=2;}else if(c==='+'||c==='-'){op=c==='+'?'add':'sub';prec=10;}else if(c==='*'||c==='/'){op=c==='*'?'mul':'div';prec=20;}else if(canAtom()){op='mul';prec=20;implicit=true;}else break;if(prec<min)break;if(!implicit)i++;const b=expr(prec+1);a=op==='mul'?mul(a,b):[op,a,b];}return a;}
 const result=expr(0);need(i===s.length,'math-tail:'+s.slice(i));return result;
}
function stripLabels(text,allowed=[]){const tags=[...text.matchAll(/@tag\((\d+)\)/g)];need(tags.every(m=>allowed.includes(m[1])),'equation-label');text=text.replace(/@tag\(\d+\)/g,'');if(allowed.length){const tags=[...text.matchAll(/\s+\((\d+)\)(?=\s|$)/g)];need(tags.every(m=>allowed.includes(m[1])),'equation-label');text=text.replace(/\s+\((\d+)\)(?=\s|$)/g,'');}return text;}
function textUnit(raw,id){
 let s=stripLabels(expandMath(raw,{text:true}));
 const replacements={
 ref_b7c733f786f2edce1aa284147a85b582:[['two or more types of data','two or more data types']],
 ref_f8fc504178b4023f0afdc519c34dd1b9:[['fuse three data types','fuse the data types']],
 ref_386566391ffa648b29befc8ddd6861d6:[['about a majority','about majority']],
 ref_919b0a1ad58ca97babcbfe4286feb8dd:[['would be of','would be']],
 ref_6c9cd6be71e0405b9484a43a64072e5f:[['same with K value used','same as used'],['therefore,','therefore']],
 ref_1f39c6756d242723368c07fd38679276:[['data. (CI','data (CI']],
 ref_f26f34fa3bd85ee928ed25b1d05a03c0:[['each data set, and (iii)','each data set; and (iii)']]
 };
 for(const[a,b]of replacements[id]??[])s=s.replace(a,b);
 const cites={ref_0345d03b2eddcb2026b7f2db1a1f2b41:[['subtype','12']],ref_6f49ab874974a6676d0c93e35bfe0f8a:[['subtypes','14'],['score','15']],ref_6c9cd6be71e0405b9484a43a64072e5f:[['imputation','21']],ref_5a267a77a30bf491a4bcf9f4e0ecf8ca:[['Clustering','1'],['data','3']]};
 for(const[word,n]of cites[id]??[])s=s.replace(new RegExp(word+'\\s*\\^\\{'+n+'\\}'),word);
 if(id==='ref_43e58d5c19c0e0a3f6a99824579a3276')s=s.replace(/\bc\s+s(?=\s*_)/g,'cs').replace(/\bN\s+M\s+I(?=\s*\()/g,'NMI');
 if(id==='ref_919b0a1ad58ca97babcbfe4286feb8dd')s=s.replace(/(K\s*≈\s*N\s*\/)\s*1\s+0\b/g,'$1 10');
 if(id==='ref_6bf705dbda2bbc040d18d5d36b7f5bd2')s=s.replace(/\{\s*p\s*\}\s*\{\s*-value\s*\}/g,'p-value').replace(/(p-value\s*=\s*)(\d\s*\.\s*(?:\d\s*)+)\*\s*1\s+0\s*\^\s*\{\s*(-\s*(?:\d\s*)+)\}/g,(_,prefix,n,p)=>prefix+n.replace(/\s/g,'')+'*10^{'+p.replace(/\s/g,'')+'}');
 if(id==='ref_c3e5a9a3380b942bfb4761a71d1b7983')s=s.replace(/δ\s*_\s*\{?\s*i\s*\}?\s*\(\s*\*\s*\)/g,'δ_{i}(·)');
 if([IDH,'ref_6bf705dbda2bbc040d18d5d36b7f5bd2'].includes(id))s=s.replace(/(\d+(?:\.\d+)?)\s*\*\s*10(-\d+)/g,'$1*10^{$2}');
 if(id==='ref_4f0be53149ba53793c7f58c400ea5618'){s=s.toUpperCase().replace(/\s+/g,' ').trim();const m=s.match(/^NATURE METHODS\s*\|\s*VOL\.\s*(\d+)\s+NO\.\s*(\d+)\s*\|\s*([A-Z]+)\s+(\d{4})(?:\s*\|\s*|\s+)(\d+)$/);need(m,'journal-footer');return{journal:'NATURE METHODS',volume:m[1],issue:m[2],month:m[3],year:m[4],printed_page:m[5]};}
 const tokens=[];let i=0;while(i<s.length){if(/\s/.test(s[i])){i++;continue;}if(s[i]==='_'||s[i]==='^'){const op=s[i++];while(/\s/.test(s[i]??'')&&i<s.length)i++;let v;if(s[i]==='{'){const start=++i;let d=1;while(i<s.length&&d){if(s[i]==='{')d++;if(s[i]==='}')d--;i++;}need(!d,'text-script');v=s.slice(start,i-1);}else {const m=s.slice(i).match(/^(?:ij|\d+|[A-Za-z])/);need(m,'text-script');v=m[0];i+=v.length;}tokens.push([op,v.replace(/\s|[{},]/g,'')]);continue;}
  const m=s.slice(i).match(/^(?:\d+(?:\.\d+)?|[A-Za-z]+|[α-ωΑ-Ω])/u);if(m){tokens.push(m[0]);i+=m[0].length;}else tokens.push(s[i++]);}
 if(['ref_6f49ab874974a6676d0c93e35bfe0f8a','ref_43e58d5c19c0e0a3f6a99824579a3276','ref_919b0a1ad58ca97babcbfe4286feb8dd'].includes(id)&&tokens.at(-1)==='.')tokens.pop();
 return tokens;
}
export function snfReviewedUnit(raw,id){try{need(Object.hasOwn(SNF_PROFILES,id),'unit-id');const profile=SNF_PROFILES[id];if(profile==='unresolved')return{ok:false,reason:'unresolved_source_glyph',unit:null};if(profile==='text')return{ok:true,unit:textUnit(raw,id)};
 let t=stripLabels(expandMath(raw,{text:true}),({kernel:['1'],branches:['2'],penalty:['10']})[profile]??[]).trim();
 if(profile==='equation'||profile==='penalty')return{ok:true,unit:math(t)};
 if(profile==='kernel'){const split=t.search(/ε\s*_\s*(?:\{[^}]+\}|[A-Za-z,]+)\s*=/);need(split>0,'kernel-components');const signed=x=>{if(!Array.isArray(x))return x;const a=x.map(signed);if(a[0]==='call'&&same(a[1],['var','exp'])&&a[2].length===1){const v=a[2][0];if(v[0]==='neg'&&v[1][0]==='div')a[2][0]=['signed-ratio','-',v[1][1],v[1][2]];else if(v[0]==='div'&&v[1][0]==='neg')a[2][0]=['signed-ratio','-',v[1][1],v[2]];}return a;};return{ok:true,unit:[signed(math(t.slice(0,split).replace(/[;.]\s*$/,''))),math(t.slice(split))]};}
 if(profile==='standardization'){const split=t.search(/where f is/);need(split>0,'normalization-definition');return{ok:true,unit:[math(t.slice(0,split).replace(/[;,]\s*$/,'')),textUnit(t.slice(split),id)]};}
 if(profile==='stopping'){const m=t.match(/^(We keep track of the relative change in consecutive rounds )(.+?)\. (One simple stopping criteria is that we set a threshold )([εϵ])\s*=\s*(.+?) (and if the relative change is lower than the threshold, we stop the iteration\.)$/s);need(m,'stopping-structure');return{ok:true,unit:[m[1],math(m[2]),m[3],'epsilon',math(m[5]==='10-6'?'10^{-6}':m[5]),m[6]]};}
 if(profile==='branches'){t=t.replace(/\s+/g,'');let lhs,body=t.match(/^(.+?)=\{?\[?(.+)$/);need(body,'branches');lhs=math(body[1]);let rest=body[2].replace(/[}\]]$/,'').replace(/,&(?=j)/g,',').replace(/&(?=ifj)/g,'');let m=rest.match(/^(.+?)(?:,|if)j(?:!=|≠)i[;,]([^,;]+)(?:,|if)j=i[.]?$/);if(!m){m=rest.match(/^(.+?)ifj(?:!=|≠)i;P\(i,i\)=([^;]+)[.]?$/);need(m,'branch-conditions');}return{ok:true,unit:[lhs,['not-equal','j','i',math(m[1])],['equal','j','i',math(m[2])]]};}
 if(profile==='propagation'){t=t.replace(/\s+/g,'');const matrix=t.match(/Ŵ=\[([^\]]+)\]/),vector=t.match(/l=\[([^\]]+)\]/);need(matrix&&vector,'matrix-vector');const rows=matrix[1].split(';');need(rows.length===2&&rows[0].length>=2,'matrix-shape');const cells=rows.map(raw=>{const r=raw.replaceAll('&',',').replace(/\^\{'\}/g,"'");if(r.includes(','))return r.split(',');const values=r.match(/(?:[A-Za-z][̂̃̄]?'?|\d+)/gu);need(values&&values.join('')===r,'matrix-token');return values;});need(cells.every(r=>r.length===2),'matrix-columns');const vec=vector[1].split(';');need(vec.length===2,'vector-shape');let rest=t.replace(matrix[0],'').replace(vector[0],'');rest=rest.replace(/(?=l_(?:\{t\+1\}|\(t\+1\))(?:\(1:n\))?=)/g,';').replace(/(?=[l1]\(n\+1\)[.]?$)/g,';');const remaining=rest.replace(/^[;]+|[;.]+$/g,'').split(';').filter(Boolean);need(remaining.length===3,'propagation-parts');return{ok:true,unit:[cells.map(r=>r.map(math)),vec.map(math),...remaining.map(math)]};}
 need(false,'table-unit-requires-block');
 }catch(e){return{ok:false,unit:null,reason:e.message};}}

function cellNumber(value){let s=expandMath(value,{text:true}).trim().replace(/\.$/,'');s=s.replace(/(\d)\s*\.\s*(\d)/g,'$1.$2').replace(/\*\s*1\s+0(?=\s*\^)/g,'*10').replace(/^(\d+(?:\.\d+)?)\s*\*\s*10(-\d+)$/,'$1*10^{$2}');return math(s);}
const headers2=['PAM50 (5 clusters)','iCluster (10 clusters)','SNF (5 clusters)','SNF (10 clusters)','Network'];
export function snfTableSelection(block,profile){try{need(block.type==='table','table-type');const text=block.text,parts=[],rows=[];let note;
 const add=(start,end)=>{need(start>=0&&end>start,'cell-range');parts.push({start,end});};
 if(profile==='table1'){
  if(text.includes('Scoped cells:')){const h=text.match(/Column headers, in source order: (.+)/);need(h&&h[1].split('|').map(x=>x.trim()).at(-1)==='SNF','table1-header');add(h.index,h.index+h[0].length);for(const m of text.matchAll(/Cancer type: ([^;\n]+); SNF: ([^\n]+)/g)){rows.push([m[1].trim(),cellNumber(m[2])]);add(m.index,m.index+m[0].length);}}
  else {const table=reviewedTableRows(block),hi=table.findIndex(r=>r.cells[0]?.text==='Cancer type'),head=table[hi];need(hi>=0&&head.cells.at(-1).text==='SNF','table1-header');const col=head.cells.length-1;add(head.cells[0].start,head.cells[0].end);add(head.cells[col].start,head.cells[col].end);for(const row of table.slice(hi+1)){if(!/^(GBM|BIC|KRCCC|LSCC|COAD) \(\d+ clusters\)$/.test(row.cells[0]?.text??''))break;need(row.cells.length===head.cells.length,'table1-columns');rows.push([row.cells[0].text,cellNumber(row.cells[col].text)]);for(const c of [row.cells[0],row.cells[col]])add(c.start,c.end);}}
  need(rows.length===5,'table1-row-count');const m=text.match(/Analysis using Cox log-rank test P values\./);need(m,'table1-condition');add(m.index,m.index+m[0].length);note='Cox log-rank P';
 }else{need(profile==='table2','table-profile');let table=reviewedTableRows(block),hi=table.findIndex(r=>r.cells.some(c=>c.text==='PAM50 (5 clusters)'));need(hi>=0,'table2-header');const h=table[hi].cells;need(same(h.slice(-5).map(c=>c.text),headers2),'table2-columns');for(const c of h.slice(-5))add(c.start,c.end);let priorRow=hi;for(const label of ['CI discovery cohort','CI validation cohort']){const index=table.findIndex((r,i)=>i>hi&&r.cells[0]?.text===label),row=table[index];need(index>priorRow&&row?.cells.length===6,'table2-row');priorRow=index;rows.push([label,...row.cells.slice(1).map(c=>cellNumber(c.text))]);for(const c of row.cells)add(c.start,c.end);}note=headers2;}
 return{ok:true,parts,unit:{profile,rows,note}};
 }catch(e){return{ok:false,reason:e.message};}}
function tableReference(text,profile){if(profile==='table1'){const rows=[...text.matchAll(/(GBM|BIC|KRCCC|LSCC|COAD) \((\d+) clusters\) ([^;.]+(?:\.[^;]+)?)(?=;|\.$|$)/g)].map(m=>[m[1]+' ('+m[2]+' clusters)',cellNumber(m[3])]);need(rows.length===5&&text.includes('Cox log-rank P'),'reference-table1');return{profile,rows,note:'Cox log-rank P'};}
 const rows=[];for(const cohort of ['discovery','validation']){const m=text.match(new RegExp('CI '+cohort+' cohort: (.+?)(?:\\. (?=CI)|\\.$)'));need(m,'reference-table2');const cells=m[1].split(';').map(x=>x.trim()),names=['PAM50','iCluster','SNF (5 clusters)','SNF (10 clusters)','Network'];need(cells.length===5&&cells.every((c,i)=>c.startsWith(names[i]+' ')),'reference-table2-columns');rows.push(['CI '+cohort+' cohort',...cells.map((c,i)=>cellNumber(c.slice(names[i].length+1)))]);}return{profile,rows,note:headers2};}

function decode(binding,parent){
 need(binding?.version==='snf-source-binding-1'&&binding.paper_id==='08'&&['native','hybrid'].includes(binding.side),'binding-version');const{version,fingerprint,...payload}=binding;need(hash(payload)===fingerprint&&hash(parent)===binding.parent_fingerprint,'binding-fingerprint');
 const records=new Map(),meta=new Map();for(const r of binding.records){need(!records.has(r.id)&&bytes(r.bytes)===r.sha256,'record-bytes');need(binding.authorized_records[r.path]===r.sha256,'record-authorization');records.set(r.id,JSON.parse(r.bytes));meta.set(r.id,r);}
 const m=records.get('materials'),first=records.get('revision'),review=records.get('review'),legacy=records.get('legacy'),dispositions=records.get('dispositions');need(m?.paper_id==='08'&&first?.paper_id==='08'&&review?.paper_id==='08','paper');
 const original=records.get('original-input');need(same(original.candidateRun,parent)&&same(original.referenceManifest,binding.original_reference)&&hash(original.baselineRun)===binding.baseline_fingerprint,'original-input-binding');
 const sourceInput=records.get('source-input');need(sourceInput?.paper_id==='08'&&sourceInput.images.length===11&&sourceInput.sources.length===2,'source-input');const files=[...sourceInput.sources.map(s=>({document_id:s.document_id,path:s.path,sha256:s.sha256})),...sourceInput.images.map(i=>({...i,sha256:binding.authorized_records[i.path]}))];need(same(files,binding.source_files),'source-file-registration');
 const ids=Object.keys(SNF_PROFILES),all=[...ids,SNF_EXTRA];need(same(m.registered_cases.map(c=>c.case_id).sort(),[...ids].sort())&&m.known_extra_case.case_id===SNF_EXTRA,'materials-case-set');const{fingerprint:mf,...mp}=m;need(hash(mp)===mf,'materials-hash');
 for(const id of ['revision','review']){const r=records.get(id),raw=records.get(id+'-raw'),fix=records.get(id+'-binding'),seal=records.get(id+'-freeze'),completion=records.get(id+'-completion');need(r?.status==='complete'&&r.task_id===id&&same(r.cases.map(c=>c.case_id).sort(),[...(id==='review'?all:ids)].sort()),'case-set');need(Array.isArray(r.actual_viewed_pages)&&Array.isArray(r.global_unresolved),'source-limits');need(r.actual_viewed_pages.length===11&&new Set(r.actual_viewed_pages.map(x=>x.document_id+':'+x.physical_page+':'+x.path)).size===11&&r.actual_viewed_pages.every(x=>sourceInput.images.some(y=>y.document_id===x.document_id&&y.physical_page===x.physical_page&&y.path===x.path)),'source-page-inventory');need(same(r.global_unresolved,records.get('decisions').summary.global_unresolved[id]),'global-limit-record');need(same(JSON.parse(completion.terminal.last_agent_message.trim().replace(/^```json\s*/,'').replace(/\s*```$/,'')),raw),'actual-return');
  need(bytes(meta.get(id+'-raw').bytes)===fix.original_sha256&&fix.original_result===meta.get(id+'-raw').path&&fix.from==='src_1bb460f34b7a78a37faa26f7'&&fix.to==='src_1bb460f34b7a78a37fa616a37faa26f7','identity-binding');const index=Number(fix.pointer.split('/')[2]);need(raw.cases[index]?.case_id===PARTIAL&&fix.pointer==='/cases/'+index+'/source_observation/document_id'&&at(raw,fix.pointer)===fix.from,'identity-pointer');const projected=structuredClone(raw);projected.cases[index].source_observation.document_id=fix.to;projected.controller_metadata_binding={path:meta.get(id+'-binding').path,sha256:meta.get(id+'-binding').sha256,original_result:fix.original_result};need(same(projected,r),'metadata-only-projection');need(seal.result_sha256===meta.get(id).sha256&&seal.completion_sha256===meta.get(id+'-completion').sha256&&seal.agent_id===completion.agent_id,'freeze-completion');
 }
 need(Date.parse(records.get('revision-freeze').frozen_at)<=Date.parse(records.get('review-run').calls.find(c=>c.task_id==='review').started_at),'freeze-order');
 need(same(m.reused_observations.record,legacy)&&m.reused_observations.sha256===meta.get('legacy').sha256,'legacy-record');
 for(const x of m.reviewed_excerpts){const r=[...meta.values()].find(y=>y.path===x.path);need(r?.sha256===x.sha256&&same(JSON.parse(r.bytes),x.record),'excerpt-record');}
 for(const x of m.raw_records){const r=[...meta.values()].find(y=>y.path===x.path);need(r?.sha256===x.sha256,'raw-record');for(const b of x.blocks)need(hash(at(JSON.parse(r.bytes),b.pointer))===b.fingerprint,'raw-field');}
 const assembly=records.get('hybrid-assembly');need(assembly?.kind==='lossless_transport_expansion_not_new_content'&&same(assembly.parts,m.hybrid_main_lineage.parts)&&same(assembly.raw_input,m.hybrid_main_lineage.raw_input)&&meta.get('hybrid-assembly-raw').sha256===assembly.raw_input.sha256,'assembly-origin');
 for(const[p,i]of assembly.parts.map((p,i)=>[p,i])){need(meta.get('hybrid-part-'+i).sha256===p.sha256&&meta.get('hybrid-part-'+i).path.endsWith('/'+p.result_file)&&meta.get('hybrid-part-completion-'+i).path.endsWith('/'+p.completion_file),'assembly-part');const result=JSON.parse(records.get('hybrid-part-completion-'+i).terminal.last_agent_message.trim().replace(/^```json\s*/,'').replace(/\s*```$/,''));need(same(result,records.get('hybrid-part-'+i)),'assembly-actual-return');}
 const assembled=JSON.parse([...meta.values()].find(r=>r.path===review.pointer_aliases.HM).bytes);need(assembly.lineage.length===assembled.blocks.length&&new Set(assembly.lineage.map(x=>x.block_index)).size===assembled.blocks.length,'assembly-lineage');
 for(const line of assembly.lineage){const i=assembly.parts.findIndex(p=>p.result_file===line.result_file),source=at(records.get('hybrid-part-'+i),line.source_pointer),target=assembled.blocks[line.block_index];need(source&&target&&source.physical_page===target.physical_page&&source.local_id===target.local_id,'assembly-block-identity');if(typeof line.transformation==='string')need(same(source,target),'assembly-exact-block');}
 for(const page of Object.values(m.page_context))for(const b of page[binding.side])need(parent.blocks.some(p=>p.id===b.id&&bytes(p.text)===b.text_sha256&&same(p.locator,b.locator)),'original-parent');
 for(const source of parent.sources)need(binding.source_files.some(f=>!f.physical_page&&f.document_id===source.document_id&&f.sha256===source.source_sha256),'source-map');
 const refs=binding.reference.items,old=binding.original_reference.items;need(refs.length===62&&old.length===62&&new Set(refs.map(r=>r.evidence_id)).size===62,'denominator');const stripManifest=x=>{const{items,reference_manifest_id,...rest}=x;return rest;};need(same(stripManifest(binding.reference),stripManifest(binding.original_reference)),'reference-envelope');
 for(const ref of refs){const prev=old.find(x=>x.evidence_id===ref.evidence_id);need(prev,'reference-member');if(REF_EDITS[ref.evidence_id]){need(ref.expected_semantic_unit===edit(prev.expected_semantic_unit,REF_EDITS[ref.evidence_id]),'reference-edit');const omit=x=>{const{expected_semantic_unit,source_record_ref,source_record_revision,source_record_fingerprint,...rest}=x;return rest;};need(same(omit(ref),omit(prev)),'reference-metadata');}else need(same(ref,prev),'non-target-reference');}
 for(const b of review.cases){const material=m.registered_cases.find(x=>x.case_id===b.case_id)??m.known_extra_case,a=first.cases.find(x=>x.case_id===b.case_id),ref=refs.find(x=>x.evidence_id===b.case_id);need(b.source_observation.document_id===(ref?.document_id??m.known_extra_case.document_id)&&b.source_observation.physical_page===(ref?.locator.page_number??29),'source-locator');
  for(const r of b.case_id===SNF_EXTRA?[review]:[first,review]){const obs=r.cases.find(x=>x.case_id===b.case_id).source_observation;need(r.actual_viewed_pages.some(p=>p.document_id===obs.document_id&&p.physical_page===obs.physical_page&&binding.source_files.some(f=>f.document_id===p.document_id&&f.physical_page===p.physical_page&&f.path===p.path)),'source-view');}
  if([IDH,COX].includes(b.case_id)){need(b.review_status==='disagreed'&&dispositions.decisions.some(d=>d.case_id===b.case_id&&d.disposition==='accept_source_supported_followup_proposal_only'),'disagreement-disposition');}
  else if(b.case_id===SNF_UNRESOLVED)need(b.review_status==='unresolved'&&b.reference.status==='unresolved'&&dispositions.decisions.some(d=>d.case_id===b.case_id&&d.disposition==='retain_unresolved_without_inferred_glyph'),'unresolved-disposition');else need(b.review_status==='verified','review-status');
  if(ref)need(b.reference.status===(REF_EDITS[b.case_id]?'needs_correction':b.case_id===SNF_UNRESOLVED?'unresolved':'source_faithful'),'reference-status');
  for(const[side,value]of Object.entries(material.sides??{}))if(value.outcome!=='segmented_match')need(a&&b.candidates[side]&&a.candidates[side].classification===b.candidates[side].classification,'side-classification');
  if(b.case_id===PARTIAL)need(material.first_observation.kind==='partial_reuse_with_new_remainder'&&material.first_observation.case_id==='R2133-05'&&material.first_observation.pointer==='/case_results/0'&&legacy.case_results[0].case_id==='R2133-05'&&b.reused_evidence!==false,'partial-reuse');
  if(b.case_id===SNF_EXTRA)need(material.first_observation.kind==='reuse_2133'&&material.first_observation.case_id==='R2133-05'&&['native','hybrid'].every(s=>b.corrected_excerpt_assessments[s].review_status==='verified'),'extra-source');
  if(![PARTIAL,SNF_EXTRA].includes(b.case_id))need(material.first_observation.kind==='new_revision_required','new-first-scope');
 }
 return{records,meta,materials:m,review};
}
export function deriveSnfReviewedRun(proof){need(proof?.version==='reviewed-derivation-5'&&proof.approval?.scope==='bounded-snf-source-derivation'&&typeof proof.approval.id==='string'&&/^sha256:[a-f0-9]{64}$/.test(proof.implementation_fingerprint),'derivation');const{binding,parent_run:parent}=proof;decode(binding,parent);const run=structuredClone(parent),expected=PATCHES[binding.side],seen=new Set();
 for(const p of proof.patches){const allowed=expected.find(x=>x[0]===p.block_id&&x[1]===p.case_id);need(allowed&&!seen.has(p.block_id),'patch-scope');seen.add(p.block_id);const b=run.blocks.find(b=>b.id===p.block_id);need(b&&bytes(b.text)===p.original_sha256&&p.replacement_text===edit(b.text,allowed[2]),'patch-bytes');b.text=p.replacement_text;}
 for(const[id,caseId]of expected)if(caseId!==SNF_EXTRA)need(seen.has(id),'unapplied-content');
 run.normalization_version+='+snf-source-reviewed-5';run.config_fingerprint=hash({parent:hash(parent),proof:hash(proof)});run.approval_fingerprint=hash(proof.approval);run.parser_run_id=deriveParserRunIdentity(run);return run;
}
export function applySnfReviewedComparison(input,units,baselineObservations,candidateObservations){const spec=input.comparisonPolicy.reviewed_comparison,proof=input.candidateDescriptor.reviewed_derivation,binding=spec.binding;need(spec.version==='reviewed-comparison-5'&&same(proof?.binding,binding),'comparison-policy');const decoded=decode(binding,proof.parent_run);need(same(deriveSnfReviewedRun(proof),input.candidateRun)&&same(binding.reference,input.referenceManifest)&&binding.baseline_fingerprint===hash(input.baselineRun),'comparison-records');need(same(spec.items.map(x=>x.evidence_id).sort(),Object.keys(SNF_PROFILES).sort()),'unit-set');const observations=[],known=[];
 const original=decoded.records.get('original-input');for(const map of original.comparisonPolicy.evidence_unit_maps.items.filter(m=>!Object.hasOwn(SNF_PROFILES,m.evidence_id))){const expected=structuredClone(map);for(const p of expected.candidate.parts){const b=input.candidateRun.blocks.find(b=>b.id===p.locator.source_block_id);p.parent_text_sha256=bytes(b.text);}need(same(expected,input.comparisonPolicy.evidence_unit_maps.items.find(m=>m.evidence_id===map.evidence_id)),'non-target-selection');}
 for(const[id,profile]of Object.entries(SNF_PROFILES)){const ref=binding.reference.items.find(r=>r.evidence_id===id),selected=units.resolved.get(id),review=decoded.review.cases.find(c=>c.case_id===id);need(selected,'mapped-unit');const row={evidence_id:id,version:spec.version,source_case_id:id,reference:{raw_text:ref.expected_semantic_unit},source_disposition:id===SNF_UNRESOLVED?'unresolved_source_glyph':review.review_status};
  for(const[side,values]of [['baseline',baselineObservations],['candidate',candidateObservations]]){const v=selected[side],mapping=selected.mapping[side];let converted,reference,scope=true;
   if(side==='candidate'&&review.candidates[binding.side])need(v.blocks.every(b=>review.candidates[binding.side].parent_ids.includes(b.id)),'selected-parent');
   if(side==='candidate'&&id===SNF_UNRESOLVED)need(same([...new Set(v.blocks.map(b=>b.id))].sort(),[...review.candidates[binding.side].parent_ids].sort()),'unresolved-whole-unit');
   if(profile.startsWith('table')){const b=v.blocks[0],t=b?snfTableSelection(b,profile):{ok:false};scope=t.ok&&v.blocks.every(x=>x.id===b.id)&&same(mapping.parts.map(({start,end})=>({start,end})),t.parts);converted={ok:Boolean(scope),unit:scope?t.unit:null,...(!scope?{reason:t.reason??'table_selection_scope'}:{})};try{reference={ok:true,unit:tableReference(ref.expected_semantic_unit,profile)};}catch(e){reference={ok:false,reason:e.message};}}
   else{converted=snfReviewedUnit(v.selected_text,id);reference=snfReviewedUnit(ref.expected_semantic_unit,id);}
   if(id!==SNF_UNRESOLVED)need(reference.ok,'reference-profile:'+id+':'+reference.reason);
   const match=id!==SNF_UNRESOLVED&&scope&&!['missing','wrong_page'].includes(v.outcome)&&converted.ok&&same(converted.unit,reference.unit),outcome=match?'segmented_match':['missing','wrong_page'].includes(v.outcome)?v.outcome:'wrong_semantic_unit';row[side]={raw_text:v.selected_text,raw_outcome:v.outcome,...converted,outcome};values.set(id,{...v,outcome});
  }observations.push(row);
 }
 for(const[id,caseId,changes]of PATCHES[binding.side].filter(x=>x[1]===SNF_EXTRA)){const old=proof.parent_run.blocks.find(b=>b.id===id),current=input.candidateRun.blocks.find(b=>b.id===id);if(current.text!==edit(old.text,changes))known.push({case_id:caseId,block_id:id,disposition:'unresolved_candidate_content'});}
 return{reviewed_observations:observations,known_content_defects:known,reviewed_source_limits:{revision:decoded.records.get('revision').global_unresolved,review:decoded.review.global_unresolved,cases:decoded.review.cases.map(c=>({case_id:c.case_id,review_status:c.review_status,unresolved:c.unresolved})),unresolved_central_unit:SNF_UNRESOLVED},reviewed_derivation:{disposition:'reviewed_derivative',new_backend_execution:false,parent_run_fingerprint:hash(proof.parent_run),source_review_fingerprint:binding.fingerprint,authority_limit:'Bound actual records andlimited representation contracts;not source/model authentication,independent gold orunchanged backend accuracy.'}};
}
