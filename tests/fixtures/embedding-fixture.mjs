import {createInterface} from 'node:readline';
console.log(JSON.stringify({ready:true,dimension:384}));
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);if(r.text==='hang')return;if(r.text==='crash')process.exit(1);
 const send=()=>console.log(JSON.stringify({id:r.text==='wrong-id'?'invalid':r.id,scope:r.text==='wrong-scope'?'foreign':r.scope,modelKey:r.text==='wrong-model'?'other':r.modelKey,vector:Array.from({length:r.text==='bad-dimension'?383:384},(_,i)=>r.text==='bad-norm'?0:i===0?1:0)}));
 if(r.text==='slow')setTimeout(send,100);else send();
});
