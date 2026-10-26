"""Pinned, local-only embedding experiment. Inputs are synthetic benchmark text."""
import gc
import hashlib
import json
import os
from pathlib import Path
import resource
import sys
import time

os.environ['HF_HUB_OFFLINE']='1'
os.environ['TOKENIZERS_PARALLELISM']='false'
import numpy as np
import torch
from transformers import AutoModel, AutoTokenizer

ROOT=Path(__file__).resolve().parents[2]
DATA=Path(sys.argv[2]).resolve() if len(sys.argv)>2 else ROOT/'scripts/memory-lab/dataset.json'
OUT=Path(sys.argv[3]).resolve() if len(sys.argv)>3 else ROOT/'data/reports/memory-lab'
OUT.mkdir(parents=True,exist_ok=True,mode=0o700)
data=json.loads(DATA.read_text())
torch.set_num_threads(4)
device='mps' if torch.backends.mps.is_available() else 'cpu'
models=[
 ('e5','intfloat/multilingual-e5-small','614241f622f53c4eeff9890bdc4f31cfecc418b3'),
 ('qwen','Qwen/Qwen3-Embedding-0.6B','97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3'),
]
def sync():
 if device=='mps': torch.mps.synchronize()
def percentile(values,p): return float(np.percentile(values,p))

for key,name,rev in models:
 if len(sys.argv)>1 and key!=sys.argv[1]:continue
 start=time.perf_counter()
 path=Path.home()/'.cache/huggingface/hub'/('models--'+name.replace('/','--'))/'snapshots'/rev
 if not (path/'model.safetensors').exists():
  print(json.dumps({'model':key,'error':'model_not_downloaded'}),flush=True);continue
 tokenizer=AutoTokenizer.from_pretrained(path,local_files_only=True,trust_remote_code=False,padding_side='left' if key=='qwen' else 'right')
 model=AutoModel.from_pretrained(path,local_files_only=True,trust_remote_code=False,torch_dtype=torch.float16 if key=='qwen' and device=='mps' else torch.float32,attn_implementation='sdpa').to(device).eval()
 sync(); load_ms=(time.perf_counter()-start)*1000
 def embed(texts,query=False):
  if key=='e5': texts=[('query: ' if query else 'passage: ')+t for t in texts]
  elif query: texts=['Instruct: Given a question, retrieve personal memories that directly help answer the question.\nQuery: '+t for t in texts]
  batch=tokenizer(texts,padding=True,truncation=True,max_length=512,return_tensors='pt').to(device)
  with torch.inference_mode():
   hidden=model(**batch).last_hidden_state
   if key=='qwen': pooled=hidden[:,-1]
   else:
    mask=batch['attention_mask'].unsqueeze(-1)
    pooled=(hidden*mask).sum(1)/mask.sum(1)
   values=torch.nn.functional.normalize(pooled.float(),p=2,dim=1).cpu().numpy()
  sync()
  return values
 vectors={}; times={}
 for kind,texts,query in [('facts',[f['text'] for f in data['facts']],False),('queries',[q['query'] for q in data['queries']],True)]:
  begin=time.perf_counter(); parts=[]
  for i in range(0,len(texts),8): parts.append(embed(texts[i:i+8],query))
  vectors[kind]=np.concatenate(parts)
  times[kind+'Ms']=(time.perf_counter()-begin)*1000
 probes=([q['query'] for q in data['queries'] if q['split']=='calibration'] or [q['query'] for q in data['queries']])[:8]
 latency=[]
 for _ in range(3):
  for q in probes:
   begin=time.perf_counter();embed([q],True);latency.append((time.perf_counter()-begin)*1000)
 stats=dict(model=name,revision=rev,device=device,dimensions=int(vectors['facts'].shape[1]),loadMs=load_ms,batchSize=8,
  singleQueryMs=dict(p50=percentile(latency,50),p95=percentile(latency,95),n=len(latency)),
  peakProcessRssMiB=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/2**20,
  mpsAllocatedMiB=torch.mps.current_allocated_memory()/2**20 if device=='mps' else None,
  datasetSha256=hashlib.sha256(DATA.read_bytes()).hexdigest(),**times)
 np.savez(OUT/f'{key}-vectors.npz',**vectors)
 (OUT/f'{key}-vectors.json').write_text(json.dumps(dict(stats=stats,facts=vectors['facts'].tolist(),queries=vectors['queries'].tolist())))
 print(json.dumps(stats),flush=True)
 del model,tokenizer;gc.collect()
 if device=='mps':torch.mps.empty_cache()
