"""Long-memory truncation check against fixed 256-token, 32-overlap chunks."""
import json,os,time,re
from pathlib import Path
os.environ['HF_HUB_OFFLINE']='1';os.environ['TOKENIZERS_PARALLELISM']='false'
import torch
import numpy as np
from transformers import AutoModel,AutoTokenizer
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'data/reports/memory-lab'
data=json.loads((ROOT/'scripts/memory-lab/dataset.json').read_text())
facts=data['facts'][:12];queries=[next(q['query'] for q in data['queries'] if q['id']==f['id']+'-natural') for f in facts]
path=Path.home()/'.cache/huggingface/hub/models--intfloat--multilingual-e5-small/snapshots/614241f622f53c4eeff9890bdc4f31cfecc418b3'
device='mps' if torch.backends.mps.is_available() else 'cpu';torch.set_num_threads(4)
tok=AutoTokenizer.from_pretrained(path,local_files_only=True,trust_remote_code=False)
model=AutoModel.from_pretrained(path,local_files_only=True,trust_remote_code=False,attn_implementation='sdpa').to(device).eval()
def embed(texts,query=False):
 parts=[]
 for i in range(0,len(texts),8):
  batch=tok([('query: ' if query else 'passage: ')+t for t in texts[i:i+8]],padding=True,truncation=True,max_length=512,return_tensors='pt').to(device)
  with torch.inference_mode():
   hidden=model(**batch).last_hidden_state;mask=batch['attention_mask'].unsqueeze(-1);v=(hidden*mask).sum(1)/mask.sum(1)
   parts.append(torch.nn.functional.normalize(v,p=2,dim=1).cpu().numpy())
 return np.concatenate(parts)
filler=('当天整理了桌面上的纸张和文具，把物品放回原来的位置。窗外天气晴朗，室内光线柔和。'*80)[:3000]
qv=embed(queries,True);report={}
for position in ['head','tail']:
 docs=[(f['text']+'\n'+filler if position=='head' else filler+'\n'+f['text']) for f in facts]
 full=embed(docs);fullsim=qv@full.T
 chunks=[];parents=[]
 for i,text in enumerate(docs):
  ids=tok.encode(text,add_special_tokens=False)
  for start in range(0,len(ids),224):chunks.append(tok.decode(ids[start:start+256],skip_special_tokens=True));parents.append(i)
 begin=time.perf_counter();cv=embed(chunks);cs=qv@cv.T
 byparent=np.stack([cs[:,np.array(parents)==i].max(1) for i in range(len(docs))],axis=1)
 def metric(scores):
  ranks=[next(j+1 for j,k in enumerate(np.argsort(-scores[i])) if k==i) for i in range(len(docs))]
  return dict(n=len(ranks),hitsAt5=sum(r<=5 for r in ranks),mrrAt5=sum(1/r if r<=5 else 0 for r in ranks)/len(ranks))
 # Preserve sentence/paragraph boundaries: don't bury a complete short fact in filler.
 unique={};members=[]
 for i,text in enumerate(docs):
  for sentence in re.split(r'(?<=[。！？\n])',text):
   if not sentence.strip():continue
   ids=tok.encode(sentence,add_special_tokens=False)
   for start in range(0,len(ids),224):
    chunk=tok.decode(ids[start:start+256],skip_special_tokens=True)
    if chunk not in unique:unique[chunk]=len(unique)
    members.append((unique[chunk],i))
 sv=embed(list(unique));ss=qv@sv.T
 sentence_sim=np.stack([ss[:,sorted(set(j for j,parent in members if parent==i))].max(1) for i in range(len(docs))],axis=1)
 report[position]=dict(full512=metric(fullsim),chunks256Overlap32=metric(byparent),sentencePreservingChunks=metric(sentence_sim),uniqueSentenceChunks=len(unique),chunks=len(chunks),maxDocumentCharacters=max(map(len,docs)),maxDocumentTokens=max(len(tok.encode(t)) for t in docs),chunkEncodingMs=(time.perf_counter()-begin)*1000)
(OUT/'long-memory-results.json').write_text(json.dumps(dict(scope='synthetic 12 long records, repeated neutral filler, no production-chat quality claim',parameters=dict(chunkTokens=256,overlapTokens=32,maxModelTokens=512,aggregation='maximum chunk score per canonical memory'),results=report),indent=2))
print(json.dumps(report))
