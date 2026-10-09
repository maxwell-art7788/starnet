'use strict';
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), os=require('node:os'), crypto=require('node:crypto');
const R=require('../sidecar/station-recovery.js');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-paths-'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function rehash(b){b.manifestSha256=sha(JSON.stringify({files:b.files.map(({path,bytes,sha256})=>({path,bytes,sha256})),browser:[],recoveryPoint:b.recoveryPoint,emptyCategories:b.emptyCategories}));return b;}
function row(p,text){const data=Buffer.from(text);return {path:p,bytes:data.length,sha256:sha(data),data:data.toString('base64'),categories:R.categoriesFor(p)};}
try {
  const source=path.join(root,'source');fs.mkdirSync(source);
  for(const name of ['agent.save.json','agent.notebook.json','agent.todo.json','agent.deliverables.json','transcript.jsonl'])fs.writeFileSync(path.join(source,name),'{}');
  const original=R.capture({workspaceRoot:source,now:1,emptyCategories:['routines','loops','projects','permissions','connector_references']});
  const unsafe=['agent/./report.txt','agent//report.txt','./agent/report.txt','agent/report.txt.','agent/report.txt ','agent/report.txt:stream','C:/report.txt','agent/CON','agent/NUL.txt','agent/NUL .txt','agent/CONOUT$','agent/COM1.log','agent/LPT9','agent/bad\u0000name','agent/question?.txt','agent\\report.txt','../outside'];
  for(const name of unsafe){
    const b=structuredClone(original);b.files.push(row('agent/report.txt','first'),row(name,'second'));rehash(b);
    assert.equal(R.validate(b).ok,false,'reject nonportable/aliased path before writing: '+JSON.stringify(name));
    const target=path.join(root,'target');assert.throws(()=>R.restore({bundle:b,targetRoot:target}),/invalid recovery bundle/);
    assert.equal(fs.existsSync(target),false,'invalid bundle never creates a destination');
  }
  const safe=structuredClone(original);safe.files.push(row('agent/notes version 2.md','kept'));rehash(safe);
  assert.equal(R.validate(safe).ok,true);const target=path.join(root,'valid');R.restore({bundle:safe,targetRoot:target});
  assert.equal(fs.readFileSync(path.join(target,'agent/notes version 2.md'),'utf8'),'kept');
  const collision=structuredClone(safe);collision.files.push(row('agent/second.md','must not overwrite'));rehash(collision);
  const aliasFs=new Proxy(fs,{get(object,key){
    if(key==='writeFileSync')return (file,...args)=>object.writeFileSync(String(file).endsWith(path.join('agent','second.md'))?path.join(path.dirname(file),'notes version 2.md'):file,...args);
    return object[key];
  }});
  const aliasTarget=path.join(root,'alias-target');
  assert.throws(()=>R.restore({bundle:collision,targetRoot:aliasTarget,fs:aliasFs}),/EEXIST/,'filesystem aliases cannot replace an earlier staged payload');
  assert.equal(fs.existsSync(aliasTarget),false,'collision never activates a partial restore');
  console.log('station-recovery-paths: alias/device/ADS/nonportable paths rejected before writes; ordinary paths restore PASS');
}finally{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}
