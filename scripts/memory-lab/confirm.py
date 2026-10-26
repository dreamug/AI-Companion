import hashlib
import json
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'data/reports/memory-lab/challenge'
path=ROOT/'scripts/memory-lab/dataset-challenge.json';data=json.loads(path.read_text());sha=hashlib.sha256(path.read_bytes()).hexdigest()
lex=json.loads((OUT/'lexical.json').read_text());assert lex['datasetSha256']==sha
facts=data['facts'];rankings={'keyword':lex['hitLists']};metrics={}
for key,dim in [('e5',384),('qwen',512)]:
 v=json.loads((OUT/f'{key}-vectors.json').read_text());assert v['stats']['datasetSha256']==sha
 a=np.array(v['facts'],dtype=np.float32)[:,:dim];b=np.array(v['queries'],dtype=np.float32)[:,:dim]
 sim=(b/np.linalg.norm(b,axis=1,keepdims=True))@(a/np.linalg.norm(a,axis=1,keepdims=True)).T
 results={}
 for qi,q in enumerate(data['queries']):
  eligible=[i for i,f in enumerate(facts) if f['bot']==q['bot'] and f['status']=='active' and f.get('sourceValid',True) and f.get('validFrom','')<=data['at'] and f.get('validTo','9999')>data['at']]
  order=sorted(eligible,key=lambda i:-float(sim[qi,i]))[:12];byid={f['id']:f for f in facts}
  scores={facts[i]['id']:1/(60+r+1) for r,i in enumerate(order)}
  for r,id in enumerate(lex['hitLists'][q['id']]):scores[id]=scores.get(id,0)+.35/(60+r+1)
  results[q['id']]=sorted(scores,key=lambda id:(q['query'] in byid[id]['text'],scores[id]),reverse=True)[:5]
 rankings[f'hybrid-{key}-{dim}']=results
for method,results in rankings.items():
 metrics[method]={}
 for kind in ['exact','natural']:
  rows=[q for q in data['queries'] if q['kind']==kind]
  ranks=[next((i+1 for i,id in enumerate(results[q['id']]) if id in q['expected']),0) for q in rows]
  metrics[method][kind]=dict(n=len(rows),hits=sum(r>0 for r in ranks),recallAt5=sum(r>0 for r in ranks)/len(rows),mrrAt5=sum(1/r if r else 0 for r in ranks)/len(rows))
report=dict(datasetSha256=sha,rankings=rankings,metrics=metrics,scope='fresh topics; no threshold or model tuning here')
(OUT/'retrieval-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(metrics))
