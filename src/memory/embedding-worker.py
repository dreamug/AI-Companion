"""Offline pinned E5 encoder. JSONL only on stdout; no database access."""
import os,sys,json
os.environ['HF_HUB_OFFLINE']='1'
os.environ['TOKENIZERS_PARALLELISM']='false'
import torch
from transformers import AutoTokenizer,AutoModel
from pathlib import Path
path=Path(sys.argv[1]).resolve()
if path.name!='614241f622f53c4eeff9890bdc4f31cfecc418b3':raise RuntimeError('unpinned_model_path')
# Bound CPU contention with the foreground encoder in another process.
torch.set_num_threads(2)
torch.set_num_interop_threads(1)
tokenizer=AutoTokenizer.from_pretrained(path,local_files_only=True,trust_remote_code=False)
model=AutoModel.from_pretrained(path,local_files_only=True,trust_remote_code=False).eval()
# Loading weights is not inference readiness. Initialize both short-query and
# maximum-length kernels before accepting any deadline-bound user request.
with torch.inference_mode():
 for size in (16,512):
  ids=torch.full((1,size),tokenizer.pad_token_id or 0,dtype=torch.long)
  model(input_ids=ids,attention_mask=torch.ones_like(ids))
print(json.dumps({'ready':True,'dimension':384}),flush=True)
for line in sys.stdin:
 try:
  r=json.loads(line)
  prefix='query: ' if r['kind']=='query' else 'passage: '
  text=prefix+r['text']
  count=len(tokenizer.encode(text,add_special_tokens=True))
  if count>512:raise ValueError('encoder_input_too_long')
  batch=tokenizer([text],padding=True,truncation=False,return_tensors='pt')
  with torch.inference_mode():
   hidden=model(**batch).last_hidden_state
   mask=batch['attention_mask'].unsqueeze(-1)
   vector=torch.nn.functional.normalize(((hidden*mask).sum(1)/mask.sum(1)).float(),p=2,dim=1)[0].tolist()
  print(json.dumps({'id':r['id'],'scope':r['scope'],'modelKey':r['modelKey'],'vector':vector}),flush=True)
 except Exception:
  print(json.dumps({'id':r.get('id','invalid'),'error':'encoder_request_failed'}),flush=True)
