"""Select using calibration topics, freeze decision, then score held-out topics."""
import hashlib
import json
from pathlib import Path
import time
import numpy as np

ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'data/reports/memory-lab'
datafile=ROOT/'scripts/memory-lab/dataset.json';data=json.loads(datafile.read_text())
sha=hashlib.sha256(datafile.read_bytes()).hexdigest()
lex=json.loads((OUT/'lexical.json').read_text());assert lex['datasetSha256']==sha
facts=data['facts'];queries=data['queries'];byid={f['id']:i for i,f in enumerate(facts)}
def eligible(f,q):
 return f['bot']==q['bot'] and f['status']=='active' and f.get('sourceValid',True) and f.get('validFrom','')<=data['at'] and f.get('validTo','9999')>data['at']
def normalize(a):return a/np.maximum(np.linalg.norm(a,axis=1,keepdims=True),1e-12)
methods={'keyword':lex['hitLists'],'rewrite':lex['rewriteLists']};cosines={};modelstats={}
for key,dims in [('e5',[384]),('qwen',[256,512,1024])]:
 payload=json.loads((OUT/f'{key}-vectors.json').read_text());assert payload['stats']['datasetSha256']==sha
 modelstats[key]=payload['stats'];fv=np.array(payload['facts'],dtype=np.float32);qv=np.array(payload['queries'],dtype=np.float32)
 for dim in dims:
  name=f'{key}-{dim}';sim=normalize(qv[:,:dim])@normalize(fv[:,:dim]).T
  dense={};mixed={}
  for qi,q in enumerate(queries):
   indices=[i for i,f in enumerate(facts) if eligible(f,q)]
   order=sorted(indices,key=lambda i:-float(sim[qi,i]))[:12]
   dense[q['id']]=[facts[i]['id'] for i in order[:5]]
   cosines[(name,q['id'])]={facts[i]['id']:float(sim[qi,i]) for i in indices}
   scores={facts[i]['id']:1/(60+r+1) for r,i in enumerate(order)}
   for r,id in enumerate(lex['hitLists'][q['id']]):scores[id]=scores.get(id,0)+.35/(60+r+1)
   # A literal full match is stronger evidence than vague shared trigrams.
   def rank(id):
    f=facts[byid[id]];return (int(q['query'] in f['text']),scores[id])
   mixed[q['id']]=sorted(scores,key=rank,reverse=True)[:5]
  methods['vector-'+name]=dense;methods['hybrid-'+name]=mixed

def metrics(lists,split):
 result={}
 for kind in ['exact','natural','indirect','unknown','answerable']:
  rows=[q for q in queries if q['split']==split and (q['kind']==kind if kind!='answerable' else bool(q['expected']))]
  if kind=='unknown':
   result[kind]=dict(n=len(rows),candidateRate=sum(bool(lists[q['id']]) for q in rows)/len(rows));continue
  ranks=[next((r+1 for r,id in enumerate(lists[q['id']]) if id in q['expected']),0) for q in rows]
  result[kind]=dict(n=len(rows),hits=sum(r>0 for r in ranks),recallAt5=sum(r>0 for r in ranks)/len(rows),top1=sum(r==1 for r in ranks)/len(rows),mrrAt5=sum(1/r if r else 0 for r in ranks)/len(rows))
 return result

calibration={name:metrics(lists,'calibration') for name,lists in methods.items()}
# Freeze selection without consulting test labels/scores. Ties prefer smaller vectors.
candidates=[name for name in methods if name.startswith('hybrid-')]
winner=max(candidates,key=lambda name:(calibration[name]['answerable']['recallAt5'],calibration[name]['answerable']['mrrAt5'],-int(name.split('-')[-1])))
base=winner.removeprefix('hybrid-')
thresholds=[]
for threshold in [0,.3,.4,.5,.55,.6,.65,.7,.75,.8,.85,.9,.95]:
 lists={q['id']:[id for id in methods[winner][q['id']] if cosines[(base,q['id'])][id]>=threshold] for q in queries}
 thresholds.append(dict(threshold=threshold,**metrics(lists,'calibration')))
# Highest threshold retaining calibration Recall@5 (not tuned on held-out questions).
floor=calibration[winner]['answerable']['recallAt5']
threshold=max(row['threshold'] for row in thresholds if row['answerable']['recallAt5']>=floor)
decision=dict(at=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),datasetSha256=sha,method=winner,threshold=threshold,selection='calibration Recall@5, then MRR@5, then smaller dimensions; threshold retains calibration recall',rrfK=60,lexicalWeight=.35,denseWeight=1,calibration=calibration,thresholdSweep=thresholds)
(OUT/'frozen-selection.json').write_text(json.dumps(decision,ensure_ascii=False,indent=2))
# Only after selection has been serialized is the held-out split evaluated.
methods['selected-hybrid']={q['id']:[id for id in methods[winner][q['id']] if cosines[(base,q['id'])][id]>=threshold] for q in queries}
test={name:metrics(lists,'test') for name,lists in methods.items()}
report=dict(datasetSha256=sha,facts=len(facts),queries=len(queries),calibration=calibration,test=test,selection={k:v for k,v in decision.items() if k not in ['calibration','thresholdSweep']},modelStats=modelstats,keywordMs=lex['keywordMs'],rewriteMeasured=lex['rewriteMeasured'],rankings=methods)
(OUT/'retrieval-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(dict(selection=report['selection'],test=test),ensure_ascii=False))
