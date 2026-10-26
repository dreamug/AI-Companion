"""Publish transparent rubric corrections; preserve raw model outputs/scores."""
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'data/reports/memory-lab'
audits={}
for name,sub,dataset in [('initial',OUT,ROOT/'scripts/memory-lab/dataset.json'),('challenge',OUT/'challenge',ROOT/'scripts/memory-lab/dataset-challenge.json')]:
 p=json.loads((sub/'reader-results.json').read_text());data=json.loads(dataset.read_text());queries={q['id']:q for q in data['queries']}
 corrected=[]
 for row in p['rows']:
  q=queries[row['id']];expected=q['expected'];text=row['answer'];correct=row['correct'];reason=None
  if row['id']=='trip-unknown':
   # "Not yet departed" entails no nights spent there on this planned trip.
   expected=['trip'];correct=not row['abstain'] and 'trip' in row['memoryIds'] and any(t in text for t in ['未出发','尚未出发','还没出发','未在','0','零'])
   reason='Gold-label correction: the saved not-yet-departed plan supports zero nights; this question is answerable, not an unknown attribute.'
  if row['id']=='boundary-indirect' and not row['abstain'] and 'boundary' in row['memoryIds'] and any(t in text for t in ['倾听','先听','听你说']):
   correct=True;reason='Equivalent wording accepted: 先听你说 means 倾听; substring-only scoring was too strict.'
  if row['id']=='water-natural' and not row['abstain'] and 'water' in row['memoryIds'] and any(t in text for t in ['暖一点','温热','温水']):
   correct=True;reason='Equivalent wording accepted: 暖一点的水 expresses the saved 温热 preference.'
  if row['id']=='outdoor-exact' and not row['abstain'] and 'outdoor' in row['memoryIds'] and any(t in text for t in ['当天往返','不过夜','不喜欢']):
   correct=True;reason='Literal fragment asks about 当天往返; a supported positive restatement is correct without requiring the separate 不喜欢 wording.'
  corrected.append({**row,'correct':correct,'answerable':bool(expected),'auditReason':reason})
 methods=sorted(set(r['method'] for r in corrected));summary={}
 for method in methods:
  rows=[r for r in corrected if r['method']==method];known=[r for r in rows if r['answerable']];unknown=[r for r in rows if not r['answerable']]
  summary[method]=dict(n=len(rows),correct=sum(r['correct'] for r in rows),accuracy=sum(r['correct'] for r in rows)/len(rows),knownN=len(known),knownCorrect=sum(r['correct'] for r in known),unknownN=len(unknown),unknownAbstained=sum(r['abstain'] for r in unknown),unknownInvented=sum(not r['abstain'] for r in unknown))
 audits[name]=dict(summary=summary,rows=corrected,rawResults='reader-results.json',notes='Deterministic exact/alias answer matching plus expected source citation; this is a controlled reader benchmark, not a production-chat accuracy claim.')
(OUT/'audited-reader-results.json').write_text(json.dumps(audits,ensure_ascii=False,indent=2))
print(json.dumps({k:v['summary'] for k,v in audits.items()},ensure_ascii=False))
