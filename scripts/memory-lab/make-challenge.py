"""Fresh topics added after the first experiment; original benchmark stays frozen."""
import json
import hashlib
from pathlib import Path
import time
HERE=Path(__file__).resolve().parent
OUT=HERE.parents[1]/'data/reports/memory-lab'
# Cost-aware final candidate locked before new topics are encoded/read.
candidate=dict(at=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),model='intfloat/multilingual-e5-small',revision='614241f622f53c4eeff9890bdc4f31cfecc418b3',dimensions=384,topK=5,rrfK=60,lexicalWeight=.35,denseWeight=1,hardSimilarityCutoff=None,literalFullMatchFirst=True,reason='Initial split: E5 and Qwen-512 both retrieve 47/48 answerable questions; E5 median encoding is 11ms vs 52ms and process peak RSS 894 vs 2336MiB. Favor smaller model, preserve literal matches, leave answerability to grounded reader. This cost-aware decision follows initial held-out results and must be confirmed on fresh topics.')
(OUT/'final-candidate-before-challenge.json').write_text(json.dumps(candidate,ensure_ascii=False,indent=2))
rows=[
 ('commute','测试用户每天坐地铁二号线，在枫林桥站下车。','枫林桥','我平常通勤搭轨道交通，应该在哪一站出站？','我每天几点刷卡进地铁站？','枫林桥','测试用户同事每天坐七号线去公司。'),
 ('breakfast','测试用户早餐喜欢喝热豆浆，配一只咸蛋。','热豆浆','早饭那杯热乎乎的豆制饮品是什么？','我买早餐的店叫什么？','豆浆','测试用户朋友早餐习惯吃麦片喝冰美式。'),
 ('color','测试用户最偏爱的颜色是墨绿色。','墨绿色','给我选衣服时，哪一种深深的绿色最讨喜？','我家沙发是什么颜色？','墨绿色','测试用户朋友最喜欢淡紫色。'),
 ('birthday','测试用户生日是十月七日。','十月七日','每年哪一天是我来到这个世界的纪念日？','我是在哪一年出生的？','十月七日','测试用户弟弟的生日是六月十日。'),
 ('quietphone','测试用户晚上十一点至早上八点把手机调为静音。','静音','夜里我通常把通讯设备的铃声设成什么状态？','我现在用的手机是什么型号？','静音','测试用户同事晚上喜欢把电话铃声开到最大。'),
 ('yoga','测试用户每周四晚六点去练瑜伽。','瑜伽','我固定每个星期做拉伸体式训练，安排在周几？','我上的瑜伽馆叫什么名字？','周四','测试用户朋友每周六上午练普拉提。'),
 ('notes','测试用户用 Obsidian 整理私人读书笔记。','Obsidian','我拿哪个软件归整阅读摘录？','我的读书笔记是否开了云同步？','Obsidian','测试用户同事用 Notion 管理团队项目。'),
 ('collect','测试用户有收集旅行明信片的习惯。','明信片','我出游时常会收藏哪种可以寄回家的纸片？','我已经收藏了多少张明信片？','明信片','测试用户姐姐收藏老邮票。'),
 ('height','测试用户怕高，不愿意坐高空缆车。','高空缆车','旅行安排里哪种悬在空中的交通方式让我抗拒？','我第一次开始怕高是在几岁？','缆车','测试用户朋友喜欢坐热气球看风景。'),
 ('scent','测试用户喜欢檀香味，不喜欢甜腻的香水。','檀香','给我挑香氛时，哪种木质气味合适？','我最爱的香水品牌叫什么？','檀香','测试用户朋友爱用甜甜的花果香水。'),
 ('brother','测试用户弟弟目前在南京读大学。','南京','我家那个比我小的男孩子在哪座城市念书？','我弟弟具体读的是哪所大学？','南京','测试用户朋友的弟弟在武汉工作。'),
 ('water','测试用户喝水喜欢温热的，不喜欢加冰。','温热','我口渴时，你该给我递冰水还是暖一点的水？','我喝水时要求精确到多少摄氏度？','温热','测试用户的同事最喜欢冰苏打水。'),
 ('chores','测试用户每周日晚上整理书桌。','整理书桌','我通常在一周的哪一天收拾桌面？','我书桌的具体长宽是多少？','周日','测试用户朋友每周二给书架除尘。'),
 ('outdoor','测试用户不喜欢露营过夜，户外活动更偏爱当天往返。','当天往返','组织野外活动时，我愿意搭帐篷住一晚吗？','我以前在哪个营地露营过？','不喜欢','测试用户朋友喜欢周末住帐篷看日出。'),
 ('cheer','测试用户取得进展时希望被具体指出哪里做得好，不喜欢空泛夸奖。','具体指出','我完成一点工作后，什么样的肯定最让我受用？','我上次完成的工作具体是什么？','具体','测试用户的同事喜欢只说一句你真棒。'),
 ('snack','测试用户喜欢吃海盐味苏打饼干。','海盐味','给我挑咸口的小点心，记得我爱哪种饼干吗？','我爱吃的苏打饼干属于哪个品牌？','苏打饼干','测试用户朋友爱吃巧克力夹心曲奇。'),
]
data=json.loads((HERE/'dataset.json').read_text());queries=[]
for key,text,exact,natural,unknown,answer,distractor in rows:
 data['facts'] += [dict(id=key,text=text,bot='a',status='active',revision=1),dict(id=key+'-distractor',text=distractor,bot='a',status='active',revision=1)]
 for kind,q in [('exact',exact),('natural',natural),('unknown',unknown)]:
  queries.append(dict(id=f'{key}-{kind}',query=q,expected=[] if kind=='unknown' else [key],answer=None if kind=='unknown' else answer,kind=kind,split='test',bot='a'))
data['queries']=queries;data['protocol']=dict(scope='fresh confirmation after initial split',frozenCandidate='final-candidate-before-challenge.json',noSelectionOnChallenge=True)
path=HERE/'dataset-challenge.json';path.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(dict(facts=len(data['facts']),queries=len(queries),sha256=hashlib.sha256(path.read_bytes()).hexdigest())))
