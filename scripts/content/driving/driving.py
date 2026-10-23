"""Build review-required mainland-China driving study material from pinned law snapshots.

Not an official examination bank. No commercial driving-app questions or pictures
are copied. Pillow is needed only to regenerate the original teaching diagrams.
"""
from pathlib import Path
import base64, hashlib, io, json, math, re
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[3]
DATE = '2026-10-22T00:00:00Z'
laws = json.loads((ROOT / 'data/content-sources/driving-laws.json').read_text(encoding='utf-8'))
standard = 'https://openstd.samr.gov.cn/bzgk/gb/newGbInfo?hcno=15B1FC09EE1AE92F1A9EC97BA3C9E451'
domain = {'id':'driving','name':'驾驶与道路交通','description':'中国大陆驾驶理论、现行法规条款学习与原创模拟题；不是官方完整考试题库。','sortOrder':4}
categories = [{'id':'drv-root','domainId':'driving','parentId':None,'name':'中国大陆驾驶理论','description':'按法规、科目和车型交叉组织。','sortOrder':0}]
for i, (key, name) in enumerate([('law','道路交通安全法'),('regulations','道路交通安全法实施条例'),('license','驾驶证申领与使用'),('points','违法记分'),('signals','交通标志与图形'),('safety','安全文明驾驶')]):
    categories.append({'id':'drv-'+key,'domainId':'driving','parentId':'drv-root','name':name,'description':'核验日期2026-10-22；自编学习材料，使用前复核最新规则。','sortOrder':i})
models = [('A1','大型客车'),('A2','重型牵引挂车'),('A3','城市公交车'),('B1','中型客车'),('B2','大型货车'),('C1','小型汽车'),('C2','小型自动挡汽车'),('C3','低速载货汽车'),('C4','三轮汽车'),('C5','残疾人专用小型自动挡载客汽车'),('C6','轻型牵引挂车'),('D','普通三轮摩托车'),('E','普通二轮摩托车'),('F','轻便摩托车'),('M','轮式专用机械车'),('N','无轨电车'),('P','有轨电车')]
tags = [{'id':f'drv-{key}','name':name,'domainId':'driving','kind':'topic','color':'#b36925','description':description} for key,name,description in [('subject1','科目一','道路交通安全法律、法规及相关知识学习。'),('subject4','安全文明驾驶理论','俗称科目四，正式归属科目三安全文明驾驶常识。'),('common','车型通用规则','不表示覆盖每一车型的完整专用题库。'),('legal-reading','法规条款学习','基于公开规范性文本，不是考试原题。'),('original-simulation','原创模拟题','用于理解规则，不冒称官方真题。'),('diagram','原创教学示意图','简化绘图，不用于道路工程设计或标志生产。')]]
tags += [{'id':'drv-model-'+code.lower(),'name':code+' '+name,'domainId':'driving','kind':'topic','color':'#b36925','description':'车型学习筛选；车型通用知识另用“车型通用规则”标签。'} for code,name in models]
questions, assets = [], []

def question(title, stem, answer, explanation, category, refs, typ='short_answer', options=None, correct=None, extra=None, difficulty=1):
    q = dict(id=f'DRV-{len(questions)+1:06d}',title=title,type=typ,stemMarkdown=stem,answerMarkdown=answer,explanationMarkdown=explanation,options=options or [],correctAnswers=correct or [],difficulty=difficulty,depth=2 if typ=='short_answer' else 1,frequency=0,frequencyScope='驾驶理论学习；非面试频率',frequencyBasis='未统计出题频次，不代表官方考点比例',collection='general',status='pending',categoryIds=['drv-'+category],tagIds=['drv-subject1']+(extra or []),sourceRefs=refs,sourceDocument=None,sourceAnchor=None)
    questions.append(q)
    return q

digits = {'零':0,'〇':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9}
def number(s):
    total, value = 0, 0
    for c in s:
        if c in digits: value=digits[c]
        elif c=='十': total+=(value or 1)*10;value=0
        elif c=='百': total+=(value or 1)*100;value=0
    return total+value

article_counts={}
for source in laws:
    text=re.sub(r'【\d+†([^】]+)】',r'\1',source['text'])
    text=re.sub(r'(第[一二三四五六七八九十]+节[^\n]*?)(第[零〇一二三四五六七八九十百]+条)',r'\1\n\2',text)
    matches=list(re.finditer(r'(?m)^[\s　]*第([零〇一二三四五六七八九十百]+)条[ 　]*',text))
    articles={}
    for i,m in enumerate(matches):
        body=text[m.end():matches[i+1].start() if i+1<len(matches) else len(text)].strip()
        articles[number(m[1])]=(m[1],body)
    article_counts[source['key']]=len(articles)
    lower,upper={'law':(8,91),'regulations':(4,91),'license':(8,74),'points':(1,28)}[source['key']]
    for n,(cn,body) in articles.items():
        if not lower<=n<=upper: continue
        body=re.split(r'\n\s*第[一二三四五六七八九十]+[章节]',body)[0].strip()
        # A heading or source truncation must not become a purported full article.
        if len(body)<12 or len(body)>7000: continue
        lead=re.sub(r'\s+','',body).split('。')[0][:35]
        refs=[{'label':source['title']+' 第'+cn+'条；'+source['version'],'url':source['url']}]
        q=question(f'{source["title"]}·第{cn}条',f'本条围绕“{lead}”作出了哪些规定？请结合适用对象、行为条件与例外进行复述。',body,f'**原文定位**：{source["title"]}第{cn}条（{source["version"]}）。\n\n这是法规原文阅读卡，不是官方考试原题，也没有人为补写立法解释。先提取“谁、在何种条件下、必须或不得做什么”，再检查但书和并列条件。\n\n**易错点**：不能省略车型、道路、比例、年龄和“以上/以下”等限定后套用到其他情境。具体法律适用和最新修订应回到来源核对。\n\n核验日期：2026-10-22。',source['key'],refs,extra=['drv-common','drv-legal-reading'])
        if source['key']=='regulations' and (37<=n<=65 or 78<=n<=84):q['tagIds'].append('drv-subject4')
        if source['key']=='points' and n in [8,9,10,11,12]:
            score={8:12,9:9,10:6,11:3,12:1}[n]
            clauses=re.split(r'[（(][一二三四五六七八九十]+[)）]',body)[1:]
            for clause in clauses:
                clause=clause.strip().rstrip('；。\n ')
                if not clause: continue
                correct=str(score)
                question(f'违法记分：{clause[:38]}',f'依据163号令，在以下完整条件下，一次记多少分？\n\n{clause}。',f'一次记{score}分。',f'**依据**：163号令第{cn}条。本题保留车型、道路类型和百分比等条件。\n\n**辨析**：记分不是罚款金额；事故后果、道路种类、超限比例不同，可能适用不同条款，不能只根据“超速”“超员”两个字记分。核验日期2026-10-22。','points',refs,'single_choice',[{'key':str(v),'text':f'{v}分'} for v in [1,3,6,9,12]],[correct],['drv-original-simulation'],2)

font_path=ROOT/'web/assets/fonts/NotoSansSC-Regular.ttf'
font=lambda n:ImageFont.truetype(str(font_path),n)
def diagram(kind, value=None):
    im=Image.new('RGB',(480,360),'white');d=ImageDraw.Draw(im);red='#c62c36';blue='#1858b1'
    if kind in ['stop','yield']:
        if kind=='stop':
            pts=[(240+135*math.cos(math.pi/8+k*math.pi/4),175+135*math.sin(math.pi/8+k*math.pi/4)) for k in range(8)]
            d.polygon(pts,fill=red);d.text((240,175),'停',font=font(110),fill='white',anchor='mm')
        else:
            d.polygon([(90,65),(390,65),(240,310)],fill=red);d.polygon([(124,85),(356,85),(240,274)],fill='white');d.text((240,156),'让',font=font(80),fill='black',anchor='mm')
    else:
        d.ellipse((100,35,380,315),fill=blue if kind in ['minimum','no-park','no-temp-park'] else red)
        if kind in ['maximum','no-pass']:
            d.ellipse((125,60,355,290),fill='white')
        if kind=='no-entry':d.rectangle((138,149,342,201),fill='white')
        if kind in ['maximum','minimum']:d.text((240,166),str(value),font=font(110),fill='white' if kind=='minimum' else 'black',anchor='mm')
        if kind in ['no-park','no-temp-park']:
            d.ellipse((100,35,380,315),outline=red,width=22);d.line((145,267,335,82),fill=red,width=20)
            if kind=='no-temp-park':d.line((145,82,335,267),fill=red,width=20)
    d.text((240,342),'原创教学示意 · 非官方考试原图',font=font(15),fill='#777777',anchor='mm')
    b=io.BytesIO();im.save(b,format='PNG');data=b.getvalue();aid=f'drv-sign-{kind}'+(f'-{value}' if value else '')
    assets.append(dict(id=aid,filename=aid+'.png',mimeType='image/png',dataBase64=base64.b64encode(data).decode(),sizeBytes=len(data),createdAt=DATE,width=480,height=360))
    return '/api/assets/'+aid+'/content'

signs=[('stop',None,'停车让行','必须先停车观察，让优先通行的车辆和行人通行，确认安全后再起步。'),('yield',None,'减速让行','应慢行或停车，观察相交道路，让有优先权的道路使用者先行，确认安全后通行。'),('no-entry',None,'禁止驶入','禁止车辆从设置标志的一端驶入；应与白底红圈的禁止通行标志区别。'),('no-pass',None,'禁止通行','表示禁止一切车辆和行人通行，需识别标志的设置位置与辅助说明。'),('no-park',None,'禁止长时停车','斜杠禁停标志限制长时间停车；允许的临时停靠也不能妨碍通行或违反其他禁停规则。'),('no-temp-park',None,'禁止停车','红色交叉标志禁止车辆停放，临时停车也不例外。')]
signs += [('maximum',v,f'限制速度{v}公里/小时',f'最高速度不得超过{v}公里/小时；还应服从更低的现场限速及安全条件。') for v in [20,30,40,50,60,80,100,120]]
signs += [('minimum',v,f'最低限速{v}公里/小时',f'在正常条件下应达到规定最低速度，但事故、拥堵、气象和安全原因下不能为了达到最低速度而冒险。') for v in [50,60,80]]
for index,(kind,value,name,meaning) in enumerate(signs):
    url=diagram(kind,value)
    if value:others=[('最低限速' if kind=='maximum' else '限制速度')+str(value)+'公里/小时','解除限制速度'+str(value)+'公里/小时','建议速度'+str(value)+'公里/小时']
    else:others=[candidate[2] for candidate in signs[:6] if candidate[2]!=name][:3]
    alternatives=[name]+others;shift=index%4;alternatives=alternatives[shift:]+alternatives[:shift]
    question(f'交通标志图形辨识{index+1:02d}',f'识别下列教学示意图的含义，并结合现场道路情况理解其约束。\n\n![交通标志教学示意]({url})',name+'。'+meaning,'**图形辨析**：'+meaning+'\n\n本图由项目代码独立绘制，仅示意形状与颜色，不是从驾考应用抓取的考试原图；不提供道路设施制造尺寸。请结合GB 5768.2-2022及现场辅助标志复核。','signals',[{'label':'GB 5768.2-2022 道路交通标志和标线 第2部分','url':standard}],'single_choice',[{'key':chr(65+i),'text':text} for i,text in enumerate(alternatives)],[chr(65+alternatives.index(name))],['drv-diagram','drv-common','drv-original-simulation'])

scenarios=[
('环形路口先行权','准备进入有信号灯控制的环形路口时，原则上应让哪方先行？','已在路口内的机动车','准备进入环岛的机动车','车身较大的机动车','按到达路口的先后顺序绝对先行',51,'不要把“入口”理解为对环内车辆享有优先权。'),
('右转等待','同车道前车正在等待放行信号，后车要右转，应当怎样做？','依次停车等候','借道绕过前车强行右转','连续鸣喇叭催促前车','越过停止线到人行横道等候',51,'这里限定同车道前车等待信号，不能仅凭自己的转弯方向越队。'),
('无方向信号灯让行','在没有方向指示信号灯的路口，转弯车辆应让哪方先行？','直行车辆和行人','仅直行机动车','仅右侧来车','所有转弯车辆优先',51,'转弯让直行的规则同时保护行人，不能遗漏。'),
('相向转弯让行','在没有方向指示信号灯的交叉路口，相向的右转与左转机动车发生冲突时，谁应让行？','右转机动车让左转车辆','左转机动车让右转车辆','车速慢的一方一律优先','右转车辆只需鸣笛即可先行',51,'本题限定无方向指示信号灯，不能脱离控制信号套用。'),
('摩托车后座','普通摩托车后座能否乘坐未满12周岁的未成年人？','不得乘坐','戴好头盔即可','有成年人陪同即可','短途可以',55,'头盔要求不能替代年龄限制。'),
('轻便摩托车载人','轻便摩托车能否载人？','不得载人','最多载一名成年人','只要低速即可载人','后座系安全带即可',55,'应先区分轻便摩托车与普通二轮摩托车。'),
('起步转向灯','汽车从停车地点驶离，应提前开启哪种转向灯？','左转向灯','右转向灯','危险报警闪光灯代替转向灯','无需使用转向灯',57,'本题问驶离停车地点，不是靠路边停车。'),
('靠边停车信号','准备靠道路右侧停车，应提前开启哪种转向灯？','右转向灯','左转向灯','远光灯','雾灯',57,'转向信号表达车辆即将进行的横向动作。'),
('超车回原车道','超车完毕驶回原车道前，应提前使用什么信号？','右转向灯','左转向灯一直保持','雾灯','只连续鸣笛',57,'开始超车与超车后回原车道的灯光动作不同。'),
('夜间近距离跟车','夜间同方向后车与前车近距离行驶时，能否使用远光灯？','不得使用远光灯','始终使用远光灯更安全','只有跟货车时可以使用','开危险报警闪光灯即可使用远光灯',58,'远光可能妨碍前车驾驶人观察，不以能照得远为唯一判断。'),
('雾天灯光','机动车雾天行驶，除按规定使用其他灯光外，应开启什么？','雾灯和危险报警闪光灯','只开远光灯','只开车内灯','关闭全部灯光避免反射',58,'能见度降低时灯光组合有要求，不能用单一远光代替。'),
('夜间无信号灯路口','夜间通过没有交通信号灯控制的路口时，应如何示意？','交替使用远近光灯','持续使用远光灯不切换','只开雾灯','关闭前照灯后鸣笛',59,'交替示意并不免除减速观察和让行。'),
('普通道路故障警告','普通道路上故障妨碍交通且难以移动，警告标志应设置在车后何处？','50至100米','5至10米','10至20米','一律150米以外',60,'普通道路与高速公路的警告距离不是同一条规定。'),
('软连接牵引间距','使用软连接牵引装置时，两车之间的距离应如何控制？','大于4米且小于10米','不超过2米','一律15米','不作任何限制',61,'注意两个边界都是严格条件，不能记为含端点的闭区间。'),
('制动失效牵引','制动失效的被牵引车应使用何种牵引装置？','硬连接牵引装置','任意绳索','驾驶人自行踩刹车即可','挂空挡后推行代替连接',61,'此题仅比较牵引装置，转向或灯光信号失效还另需专用清障车。'),
('牵引车灯光','牵引故障车时，两车应如何使用危险报警闪光灯？','牵引车和被牵引车均开启','仅后车开启','仅前车开启','两车均不能开启',61,'两车的异常运行状态都需要向其他道路使用者提示。'),
('下陡坡操作','机动车下陡坡能否熄火或者空挡滑行？','不得这样操作','只要车少就可以','自动挡汽车可以熄火滑行','雨天更适合空挡滑行',62,'不能用节油理由替代车辆控制要求。'),
('手持电话','驾驶过程中能否拨打接听手持电话？','不得进行这种妨碍安全驾驶的行为','车速低即可','等红灯时一律可以','熟练驾驶人不受限制',62,'通话是否方便不是允许手持电话驾驶的依据。'),
('连续驾驶休息','连续驾驶机动车超过4小时，停车休息至少应达到多少时间？','20分钟','5分钟','10分钟','15分钟',62,'应同时记住连续驾驶时长和休息时长，单记一个数字不够。'),
('路口附近临停','一般机动车距离交叉路口多近的路段不得停车？','50米以内','5米以内','10米以内','20米以内',63,'不能把路口50米规则与公交站等设施30米规则混淆。'),
('加油站附近临停','除使用该设施外，加油站及其附近多近的路段不得停车？','30米以内','5米以内','10米以内','15米以内',63,'使用设施的例外条件应一并理解，不是任何车辆都能例外。'),
('开关车门','机动车未停稳，能否开车门上下人员？','不得这样做','可以先开门再停车','仅驾驶人可以','只要后车距离远就可以',63,'停车后开关门也不得妨碍其他车辆和行人通行。'),
('高速车辆上限','没有另设限速且条件正常时，高速上小型载客汽车最高速度为多少？','120公里/小时','100公里/小时','140公里/小时','不设上限',78,'限速标志与法定车道速度不一致时，应按标志；安全条件还可能要求更低速度。'),
('高速摩托车速度','在允许摩托车通行且没有另设更低限速的高速上，摩托车最高速度为多少？','80公里/小时','100公里/小时','120公里/小时','不受汽车限速约束',78,'先确认当地道路是否允许摩托车通行；法定速度不等于通行许可。'),
('高速高速段车距','高速行驶车速超过100公里/小时，跟同车道前车至少保持怎样的距离？','100米以上','10米以上','20米以上','随驾驶经验自行决定',80,'本题条件是超过100公里/小时，不适用于任意车速。'),
('高速低速段车距','高速车速低于100公里/小时，法定最小跟车距离不得少于多少？','50米','10米','20米','30米',80,'不应机械把最小值当作所有天气和路况的最佳距离。'),
('高速低能见度200','高速能见度小于200米且未达到更低档时，速度上限是多少？','60公里/小时','80公里/小时','100公里/小时','120公里/小时',81,'还应按规定组合用灯，并与同车道前车保持100米以上距离。'),
('高速低能见度100','高速能见度小于100米且未达到更低档时，速度上限是多少？','40公里/小时','60公里/小时','80公里/小时','100公里/小时',81,'还应开启危险报警闪光灯等规定灯光，并保持50米以上距离。'),
('高速极低能见度','高速能见度小于50米，除车速不超过20公里/小时外还应怎样做？','从最近出口尽快驶离高速','继续行驶到原定目的地','原地占用行车道等待','开启远光后恢复正常速度',81,'低能见度要求不仅是减速，还包括尽快驶离。'),
('高速错过出口','在高速公路上错过出口，能否倒车返回？','不得倒车返回','应急车道可以倒车','后方没有车可以倒车','开启双闪即可倒车',82,'错过出口不能成为倒车、逆行或横穿中央分隔带掉头的理由。'),
('高速匝道超车','能否在高速匝道、加速车道或减速车道超车？','不得超车','只要速度低就可以','只有小型车可以','按喇叭后可以',82,'这些车道承担进出和速度过渡功能，不是普通超车车道。'),
('应急车道使用','非紧急情况下，能否在高速应急车道行驶或停车？','不得这样做','拥堵时可以','临近出口时可以','开危险报警闪光灯即可',82,'开启双闪不自动构成紧急情况，也不能制造占用应急车道的许可。')]
regulation_source=next(s for s in laws if s['key']=='regulations')
for i,(title,stem,right,b,c,d,article,note) in enumerate(scenarios):
    opts=[right,b,c,d];shift=i%4;opts=opts[shift:]+opts[:shift]
    question(title,stem,right,f'**依据**：《道路交通安全法实施条例》第{article}条。\n\n**条件辨析**：{note}\n\n本题为按条文独立编写的学习模拟题，不是官方真题。核验日期2026-10-22。','safety',[{'label':f'道路交通安全法实施条例第{article}条（2017年修订）','url':regulation_source['url']}],'single_choice',[{'key':chr(65+j),'text':x} for j,x in enumerate(opts)],[chr(65+opts.index(right))],['drv-subject4','drv-common','drv-original-simulation'],2)

# Current age requirements, including the 2025 changes. No expired 60-year upper bound.
for code,name in models:
    if code in ['C1','C2','C5','F']:age='18周岁以上，规定中不设置本项申请年龄上限'
    elif code in ['D','E']:age='18周岁以上、70周岁以下'
    elif code=='C6':age='20周岁以上、70周岁以下'
    elif code in ['C3','C4','M']:age='18周岁以上、63周岁以下'
    elif code in ['A3','B1','B2','N','P']:age='20周岁以上、63周岁以下'
    else:age='一般申请为22周岁以上、63周岁以下；全日制驾驶职业教育学生另有19周岁以上等规定'
    question(code+'申请年龄与准驾车型',f'拟申请{code}（{name}）时，172号令第十四条规定的一般年龄条件是什么？年龄条件之外还应注意什么？',age+'。年龄合格不代表免除身体条件、既往驾驶经历、增驾限制、培训和考试等要求。','**易错点**：2025年施行的修改调整了部分年龄条件，不应直接使用旧“60周岁以下”版本。这里问的是申请年龄，不是所有已持证驾驶人的换证、延期与身体证明规则。A1/A2职业教育路径及63周岁以上延期应分别核对第十四条、第六十五条。','license',[{'label':'172号令第十四条、第六十五条（2025-01-01施行）','url':laws[2]['url']}],extra=['drv-model-'+code.lower(),'drv-original-simulation'],difficulty=2)

bank={'id':'bank-driving-review','name':'驾驶理论·法规与原创模拟（待审核）','description':'按现行公开法规编制，不宣称官方完整题库。含车型标签、法规阅读与原创示意图。','questionIds':[q['id'] for q in questions]}
pack=dict(schemaVersion=1,generatedAt=DATE,domains=[domain],categories=categories,tags=tags,questions=questions,questionBanks=[bank],documents=[],papers=[],assets=assets)
destination=ROOT/'data/content-packs/driving.json';destination.parent.mkdir(parents=True,exist_ok=True);destination.write_text(json.dumps(pack,ensure_ascii=False,indent=2),encoding='utf-8')
manifest=dict(id='driving',title='中国大陆驾驶理论学习扩展',generatedAt=DATE,questions=len(questions),assets=len(assets),articleCounts=article_counts,verifiedAt='2026-10-22',status='pending',officialQuestionBank=False,scope='公开法规阅读、按条款自编模拟与原创图形识别；不覆盖官方全部题库、全部地方题或所有车型专项情境。',sources=[{k:v for k,v in x.items() if k!='text'} for x in laws],standard=standard,rights='政府规范性文本用于学习；题目组织与教学示意图由项目原创。未复制商业驾考题库。',sha256=hashlib.sha256(destination.read_bytes()).hexdigest())
(ROOT/'data/content-sources/driving.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'questions':len(questions),'assets':len(assets),'articles':article_counts},ensure_ascii=False))
