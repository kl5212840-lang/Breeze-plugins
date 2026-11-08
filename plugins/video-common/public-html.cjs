'use strict';

function htmlText(value) {
  const named={amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' ',hellip:'…',middot:'·',mdash:'—',ndash:'–'};
  return String(value||'').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(raw,name)=>{
    if(name[0]!=='#')return named[name.toLowerCase()]??raw;
    const number=name[1].toLowerCase()==='x'?parseInt(name.slice(2),16):Number(name.slice(1));
    return number>0 && number<=0x10ffff && !(number>=0xd800&&number<=0xdfff)?String.fromCodePoint(number):'';
  }).replace(/\s+/g,' ').trim();
}
function parsePublicHtml(input) {
  if(typeof input!=='string'||input.length>2500000)throw new Error('网页内容过大或格式已变化');
  // Controllers and styles are never evaluated and do not enter visible text.
  const source=input.replace(/<!--[^]*?-->/g,'').replace(/<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi,'');
  const root={tag:'root',attrs:{},children:[],parent:null};let current=root,count=0;
  const voids=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
  for(const token of source.matchAll(/<[^>]+>|[^<]+/g)) {
    const text=token[0];
    if(text[0]!=='<'){current.children.push(htmlText(text));continue;}
    if(/^<!|^<\?/.test(text))continue;
    const end=text.match(/^<\/\s*([\w-]+)/);
    if(end){let node=current;while(node.parent){if(node.tag===end[1].toLowerCase()){current=node.parent;break;}node=node.parent;}continue;}
    const start=text.match(/^<\s*([\w-]+)/);if(!start)continue;
    if(++count>50000)throw new Error('网页结构过大');
    const attrs={};
    for(const a of text.slice(start[0].length,-1).matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))attrs[a[1].toLowerCase()]=htmlText(a[2]??a[3]??a[4]??'');
    const node={tag:start[1].toLowerCase(),attrs,children:[],parent:current};current.children.push(node);
    if(!voids.has(node.tag)&&!text.endsWith('/>'))current=node;
  }
  return root;
}
function nodes(root,predicate) {
  const out=[],stack=[root];
  while(stack.length){const node=stack.pop();if(!node||typeof node==='string')continue;
    if(predicate(node))out.push(node);for(let i=node.children.length-1;i>=0;i--)stack.push(node.children[i]);}
  return out;
}
function nodeText(node) {return htmlText(node?.children.map(n=>typeof n==='string'?n:nodeText(n)).join(' ')||'');}
function hasClass(node,name){return (node.attrs.class||'').split(/\s+/).includes(name);}
function jsonAssignment(source,name) {
  const marker=new RegExp('\\b'+name+'\\s*=\\s*').exec(source);
  if(!marker)throw new Error('网页缺少播放数据');
  const start=marker.index+marker[0].length;
  if(source[start]!=='{')throw new Error('播放数据格式已变化');
  let level=0,string=false,escape=false;
  for(let p=start;p<Math.min(source.length,start+1000000);p++){
    const c=source[p];
    if(string){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')string=false;continue;}
    if(c==='"')string=true;else if(c==='{')level++;else if(c==='}'&&--level===0)return JSON.parse(source.slice(start,p+1));
  }
  throw new Error('播放数据不完整');
}
module.exports={htmlText,parsePublicHtml,nodes,nodeText,hasClass,jsonAssignment};
