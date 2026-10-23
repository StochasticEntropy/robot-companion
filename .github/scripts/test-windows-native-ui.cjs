const test = require('node:test');
const assert = require('node:assert/strict');
const { requiredVerdict } = require('./windows-native-ui.cjs');
function fixture() {
  return [{required:true,suite:'native-libraries',grep:'',passed:true,reasons:[]},
    {totals:{passes:5,failures:0,pending:0,total:5},suites:{'native-libraries-ui.test.js':{passes:5,failures:0,pending:0,total:5}}},
    {robotCodeInVenv:false,doctor:{robotcodePresent:false},formatter:'robotframework-robocop==9.1.0'},'native-libraries'];
}
test('the complete required native UI verdict passes with positive per-file counts',()=>assert.equal(requiredVerdict(...fixture()).passes,5));
for (const fault of ['zero','skip','failure','empty-file','missing-counts','inconsistent','grep','not-required','other-suite','backend-missing','robotcode','result-failed']) {
  test('native UI refuses '+fault,()=>{
    const f=fixture();
    if(fault==='zero')f[1].totals={passes:0,failures:0,pending:0,total:0};
    if(fault==='skip')f[1].totals.pending=1;
    if(fault==='failure')f[1].totals.failures=1;
    if(fault==='empty-file')f[1].suites.empty={passes:0,failures:0,pending:0,total:0};
    if(fault==='missing-counts')delete f[1].totals;
    if(fault==='inconsistent')f[1].totals.passes=6;
    if(fault==='grep')f[0].grep='single test';
    if(fault==='not-required')f[0].required=false;
    if(fault==='other-suite')f[0].suite='providers';
    if(fault==='backend-missing')f[2].available=false;
    if(fault==='robotcode')f[2].robotCodeInVenv=true;
    if(fault==='result-failed')f[0].passed=false;
    assert.throws(()=>requiredVerdict(...f));
  });
}

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { requiredScreenshots, SHOTS } = require('./windows-native-ui.cjs');
test('every actual native libraries screenshot is required and must be a PNG',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-shots-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const write=name=>fs.writeFileSync(path.join(dir,`native-libraries-${name}.png`),Buffer.from('89504e470d0a1a0a','hex'));
 SHOTS.forEach(write);assert.equal(requiredScreenshots(dir).length,9);
 for(const name of SHOTS){fs.unlinkSync(path.join(dir,`native-libraries-${name}.png`));assert.throws(()=>requiredScreenshots(dir));write(name);}
 fs.writeFileSync(path.join(dir,`native-libraries-${SHOTS[0]}.png`),'not-a-PNG');assert.throws(()=>requiredScreenshots(dir));
});
