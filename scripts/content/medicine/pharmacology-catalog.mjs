// Original Chinese learning notes, not dosage or treatment instructions.
// Fields: English identity | Chinese name | group | pharmaceutical identity note |
// class | mechanism | uses | structure/property concept | warnings | interactions.
export const rows = `
acetaminophen|对乙酰氨基酚（扑热息痛）|pain|分子式指对乙酰氨基酚本体，不代表含其他成分的复方感冒药|解热镇痛药|主要在中枢影响前列腺素相关信号，精确作用机制仍未完全阐明|发热及轻中度疼痛的对症缓解；抗炎作用有限|含酚羟基与酰胺；部分肝代谢产物有反应活性，超量时可损伤肝脏|超量或重复摄入含同一成分的复方药可造成严重肝损伤；肝病、长期饮酒及妊娠情况需专业评估|长期同时使用华法林等药物需要核对；饮酒和重复成分尤其需要警惕
ibuprofen|布洛芬|pain|本体为羧酸；制剂可采用不同盐型，不把盐的分子式当成本体|非甾体抗炎药（NSAID）|抑制环氧合酶，减少前列腺素生成|疼痛、发热及某些炎症性疾病的对症治疗|羧酸可解离，成盐可改变溶解行为；不意味着不同制剂可直接替换|消化道出血、肾损伤和心血管事件风险；妊娠及NSAID过敏需核对禁忌|其他NSAID、抗凝药、部分降压药和利尿剂可增加出血或肾损伤风险；可能影响阿司匹林抗血小板效果
aspirin|阿司匹林（乙酰水杨酸）|pain|分子式为乙酰水杨酸本体；区别于水杨酸及其盐|NSAID兼抗血小板药|不可逆乙酰化环氧合酶；血小板作用与镇痛抗炎用途应分别理解|某些疼痛、发热及经医生评估的血栓性事件预防|同时含羧酸和酯键；酯键可水解，水杨酸与阿司匹林不是同一物质|出血、胃肠损伤及过敏；儿童青少年病毒感染相关使用涉及瑞氏综合征风险|与抗凝或其他抗血小板药合用增加出血；布洛芬可能干扰其抗血小板作用
naproxen|萘普生|pain|分子式为萘普生游离酸；萘普生钠的组成不同|NSAID|抑制环氧合酶并降低前列腺素生成|肌肉骨骼等疼痛及炎症的对症缓解|含羧酸、芳环与醚基；具有立体化学，不能仅凭分子式辨认活性构型|消化道出血、肾损伤及心血管风险；NSAID过敏者需专业评估|其他NSAID、抗凝药、锂盐及某些利尿降压药需核对
diclofenac|双氯芬酸|pain|分子式为游离酸；钠盐、钾盐及不同外用/口服制剂不能混为同一配方|NSAID|抑制环氧合酶相关前列腺素合成|关节、软组织等疼痛或炎症；用途随剂型而异|含氯代芳环、仲胺与羧酸；成盐影响制剂性质|口服和外用风险暴露不同，但均需核对NSAID过敏；全身用药涉及出血、心血管、肾及肝损伤风险|抗凝药及其他NSAID增加出血风险；部分降压利尿药合用需关注肾功能
celecoxib|塞来昔布|pain|分子式指塞来昔布本体；不据此推断其他磺酰胺药可互换|选择性COX-2抑制型NSAID|主要抑制COX-2介导的前列腺素生成|某些关节炎和疼痛的对症治疗|含磺酰胺与含氟芳环；选择性来自整体结构，不是只看某一官能团|仍有心血管事件、消化道出血和肾损伤风险；磺酰胺相关过敏史需告知医生|抗凝药、其他NSAID及影响CYP2C9的药物需核对
cetirizine|西替利嗪|allergy|分子式为本体；常见盐酸盐组成另计，且不是左西替利嗪的同名写法|第二代H1抗组胺药|阻断组胺H1受体相关作用|过敏性鼻炎症状和荨麻疹|兼有羧酸与胺基，可形成不同电离状态；对映体身份不能仅由分子式区分|可能嗜睡；肾功能影响用药评估；长期使用后停药可能出现严重瘙痒，应咨询专业人员|酒精和镇静药可能加重困倦；同时使用其他抗过敏复方药应核对重复成分
loratadine|氯雷他定|allergy|分子式为氯雷他定；其活性代谢物地氯雷他定是另一物质|第二代H1抗组胺药|抑制H1受体相关过敏信号|过敏性鼻炎和荨麻疹等症状|含含氮杂环及氨基甲酸酯结构；体内代谢并不等于制剂保存中的普通化学变化|部分人仍可能嗜睡；肝肾情况及过敏史需核对|部分抑制肝药酶的抗感染药可能改变暴露；避免重复使用含抗组胺药的复方产品
fexofenadine|非索非那定|allergy|分子式为本体；常见盐酸盐另含氯化氢组成|第二代H1抗组胺药|阻断外周H1受体相关组胺作用|过敏性鼻炎症状和慢性荨麻疹|含羧酸、羟基和胺，具有两性电离特征|肾功能异常及药物过敏需评估；低镇静倾向不等于人人不会困倦|苹果、橙和葡萄柚汁可影响吸收；含铝镁抗酸药也需核对相互作用
diphenhydramine|苯海拉明|allergy|分子式为本体，盐酸盐等剂型组成另计|第一代H1抗组胺药|抑制H1受体并有明显中枢及抗胆碱作用|部分过敏症状；某些制剂另有特定用途，不应据药名自行扩展|含叔胺和醚键，可成盐；脂溶性与中枢作用相关但不能单凭分子式预测|嗜睡、口干、尿潴留；青光眼、前列腺问题及老年人使用需特别评估|酒精、镇静药和其他抗胆碱药可加重中枢抑制或不良反应
chlorpheniramine|氯苯那敏（扑尔敏）|allergy|分子式为本体；常见马来酸盐含另外的酸组分|第一代H1抗组胺药|阻断H1受体并有抗胆碱及镇静作用|过敏性鼻炎、眼鼻瘙痒等过敏症状|含叔胺、吡啶环及氯代芳环；成盐是酸碱作用，不是药效相同的充分条件|可能困倦、视物模糊和尿潴留；驾驶及老年人用药需核对|单胺氧化酶抑制剂、酒精及其他镇静或抗胆碱药可能增加风险
montelukast|孟鲁司特|allergy|分子式为游离酸；常见孟鲁司特钠另计钠元素|白三烯受体拮抗药|阻断半胱氨酰白三烯受体介导的气道炎症信号|哮喘长期控制等；过敏性鼻炎用途需严格衡量替代方案|含羧酸、硫醚和芳杂环；氧化或光照稳定性应以具体制剂资料为准|有严重神经精神不良反应警示；不能替代哮喘急性发作的救急治疗|与改变药物代谢的药物合用需核对；任何情绪、睡眠和行为异常应及时寻求专业帮助
omeprazole|奥美拉唑|gastro|分子式为本体；肠溶和不同盐型属于制剂/化学形态差异|质子泵抑制剂（PPI）|在酸性环境活化后抑制胃壁细胞H+/K+-ATP酶|胃食管反流及部分溃疡相关疾病；幽门螺杆菌治疗是组合方案|含苯并咪唑和亚砜；酸不稳定解释了部分制剂采用肠溶设计|不能用症状缓解代替对消化道出血等警示症状的评估；长期使用风险需复核|可影响氯吡格雷活化及某些依赖胃酸吸收药物；甲氨蝶呤等合用需核对
esomeprazole|埃索美拉唑|gastro|为奥美拉唑的特定对映体；镁盐/钠盐及水合形式不与游离体混用|PPI|抑制胃壁细胞质子泵，降低胃酸分泌|胃食管反流及部分溃疡相关疾病|亚砜具有手性；与奥美拉唑可有相同分子式但构型不同，分子式不能证明等同|持续或反复症状、吞咽困难及出血需就医；长期使用需定期评估|氯吡格雷、某些抗病毒药以及受胃酸环境影响的药物需核对
pantoprazole|泮托拉唑|gastro|分子式为本体；钠盐及水合物组成不同|PPI|在分泌小管酸性环境活化并抑制质子泵|胃食管反流相关疾病及病理性胃酸分泌增多等|含亚砜、杂环及含氟基团；酸敏感性与肠溶制剂设计有关|长期治疗需复核低镁、维生素B12不足等相关风险；症状消失不等于病因已确诊|甲氨蝶呤、华法林及受胃酸影响的药物需专业核对
famotidine|法莫替丁|gastro|分子式为法莫替丁本体|组胺H2受体拮抗药|阻断胃壁细胞H2受体相关胃酸分泌|部分反流、烧心和溃疡相关疾病|含含氮杂环与含硫基团；与PPI不是同一结构或机制|肾功能异常可能改变暴露；老年人及出现意识变化者需评估|可改变需酸性环境吸收药物的暴露；不能将所有抗酸药视为同一种药
mesalamine|美沙拉嗪（5-氨基水杨酸）|gastro|分子式为5-氨基水杨酸；不同释药制剂并非自动等效|肠道局部抗炎药|在肠黏膜发挥抗炎作用，完整机制尚未完全明确|特定炎症性肠病的治疗或维持缓解；适用部位随剂型而异|含酚羟基、氨基及羧酸；位置异构与释药设计均影响身份或用途|肾损伤及过敏/不耐受反应需监测；不能凭腹泻症状自行诊断适用疾病|肾毒性药物及硫唑嘌呤/巯嘌呤等合用需核对
ondansetron|昂丹司琼|gastro|分子式为本体；盐酸盐二水合物另有盐和结晶水|5-HT3受体拮抗型止吐药|阻断外周及中枢5-HT3相关呕吐信号|部分化疗、放疗或手术相关恶心呕吐|含含氮杂环和酮基；受体选择性取决于整体结构|QT间期延长和心律失常风险，尤其需关注电解质异常；并非所有呕吐病因均适用|与延长QT药及增加血清素作用的药物合用需核对；阿扑吗啡合用存在重要禁忌
metoclopramide|甲氧氯普胺（胃复安）|gastro|分子式为本体；盐酸盐及水合物另计|多巴胺受体拮抗型促胃动力/止吐药|阻断多巴胺D2等受体并影响胃肠运动|某些胃排空障碍和特定恶心呕吐情境|含苯甲酰胺及叔胺；中枢受体作用与外周促动力作用需同时理解|迟发性运动障碍可严重且持续；帕金森病、消化道机械性梗阻等情形需核对禁忌|抗精神病药、左旋多巴及增加血清素作用药物可能出现重要相互作用
lactulose|乳果糖|gastro|分子式为乳果糖分子；糖浆可含其他糖与水，不能把整瓶视为纯物质|渗透性泻药；特定肝性脑病治疗药|在结肠经菌群代谢形成酸性产物并改变渗透环境|便秘；在医生管理下用于某些肝性脑病情境|为二糖，含多个羟基；肠道发酵是生物代谢过程，不是直接化学中和|腹胀、腹泻和电解质紊乱；糖代谢疾病和肠梗阻风险需核对|其他泻药可加重腹泻；糖浆杂糖含量及合并药物需由专业人员核对
amoxicillin|阿莫西林|infection|分子式为无水阿莫西林本体；常见三水合物、钠盐或复方组成不同|青霉素类β-内酰胺抗菌药|干扰细菌细胞壁交联合成|对敏感细菌引起的特定感染；不治疗病毒性感冒|β-内酰胺环是关键结构，可被β-内酰胺酶破坏；有酚羟基、氨基和羧酸|青霉素严重过敏史必须核对；有抗菌药相关腹泻与耐药风险|甲氨蝶呤、华法林及别嘌醇等合用需核对；是否需要复方须依据处方和病原评估
azithromycin|阿奇霉素|infection|分子式为无水本体；二水合物等另含结晶水|大环内酯类抗菌药|作用于细菌核糖体，抑制蛋白质合成|部分敏感细菌感染；不是通用抗病毒药|含大环内酯与多羟基、胺基；水合形态不等于不同活性成分|QT延长、肝损伤及抗菌药相关腹泻；心律失常风险需评估|延长QT药及某些抗凝药需核对；含铝镁抗酸药可能影响制剂吸收
doxycycline|多西环素|infection|分子式为本体；盐酸盐、海克酸盐和一水合物有不同组成|四环素类抗菌药|作用于细菌30S核糖体并抑制蛋白合成|某些敏感细菌、立克次体等感染及部分痤疮情境|多氧官能团可与多价金属离子络合；络合作用可影响吸收|光敏反应、食管刺激；妊娠和儿童使用需按具体适应证专业评估|铁、钙、镁、铝制剂可影响吸收；维A酸类等合用需核对
cephalexin|头孢氨苄|infection|分子式为无水本体；一水合物另计水|第一代头孢菌素类β-内酰胺抗菌药|抑制细菌细胞壁合成|部分敏感细菌引起的皮肤、泌尿或呼吸道等感染|含β-内酰胺环与羧酸；不能按“头孢”二字推断所有成员的抗菌谱|严重β-内酰胺过敏史、肾功能异常及抗菌药相关腹泻需评估|华法林、二甲双胍及丙磺舒等合用需核对
ciprofloxacin|环丙沙星|infection|分子式为本体；盐酸盐及水合物另计|氟喹诺酮类抗菌药|抑制细菌DNA旋转酶及拓扑异构酶IV|某些敏感细菌感染；部分常见轻症应优先评估替代药|含喹诺酮、羧酸和含氮环；可与多价金属络合|有肌腱损伤、周围神经和中枢不良反应等严重警示；重症肌无力患者尤其需核对|替扎尼定有重要禁忌；铁钙镁铝、华法林及延长QT药等需核对
metronidazole|甲硝唑|infection|分子式为甲硝唑本体；部分衍生酯并非本体|硝基咪唑类抗厌氧菌/抗原虫药|在敏感微生物内被还原活化，损伤核酸等靶点|特定厌氧菌与原虫感染|硝基咪唑结构参与微生物内还原反应；不提供人工还原或制备操作|周围神经症状、肝病及妊娠等情境需评估；不能治疗所有腹泻|华法林、锂盐和双硫仑等需核对；饮酒及含丙二醇产品应遵循具体标签警示
nitrofurantoin|呋喃妥因|infection|分子式为本体；不同晶型和复方制剂释药特点可能不同|硝基呋喃类尿路抗菌药|在细菌内产生反应性中间体，影响多个细胞过程|特定下尿路感染；不能据此视为肾盂肾炎或全身感染通用药|含硝基呋喃与杂环酰亚胺；药物在尿中的分布是用途限定的重要背景|肺、肝和周围神经不良反应；肾功能及G6PD缺乏相关风险需核对|含三硅酸镁抗酸药和丙磺舒等可能改变吸收或排泄
fluconazole|氟康唑|infection|分子式为氟康唑本体|三唑类抗真菌药|抑制真菌甾醇合成相关酶|特定敏感真菌感染；不是抗细菌或抗病毒药|含三唑环、含氟芳环和羟基；对真菌与人体酶作用的差异并非绝对|肝损伤、QT延长及妊娠相关风险需评估|可影响多种肝药酶；华法林、部分他汀、降糖药及延长QT药需核对
acyclovir|阿昔洛韦|infection|分子式为无水本体；钠盐等另计|抗疱疹病毒核苷类似物|在感染细胞内活化后干扰病毒DNA聚合酶|特定单纯疱疹与水痘带状疱疹病毒感染|含嘌呤样杂环与侧链羟基；需细胞内磷酸化活化，不是直接消毒剂|肾损伤和神经不良反应风险，尤其需关注肾功能及制剂途径|其他肾毒性药物、丙磺舒等需核对；不能消除潜伏病毒或保证不再传播
oseltamivir|奥司他韦|infection|分子式为奥司他韦游离体；常见磷酸盐另计磷酸组成，活性代谢物又是另一物质|流感病毒神经氨酸酶抑制剂的前药|经酯键水解为活性代谢物，抑制流感病毒释放相关过程|特定流感治疗或预防情境；不能替代疫苗或治疗所有呼吸道病毒|含酯键与胺基；前药水解属于体内代谢概念|肾功能、严重过敏及异常行为症状需专业评估；适用性取决于流感风险和时机等因素|鼻喷减毒活流感疫苗可能受影响；疫苗类型和用药安排须由专业人员核对
amlodipine|氨氯地平|cardio|分子式为本体；常见苯磺酸盐含另一酸组分|二氢吡啶类钙通道阻滞药|抑制血管平滑肌L型钙通道，降低外周阻力|高血压和部分心绞痛|含二氢吡啶环、酯基与胺；盐型改变制剂性质，不改变其基础药理分类|外周水肿、低血压等；严重心脏疾病及肝功能问题需评估|CYP3A4抑制/诱导药及辛伐他汀等需核对
losartan|氯沙坦|cardio|分子式为本体；常见氯沙坦钾另计钾|血管紧张素II受体阻滞药（ARB）|阻断AT1受体相关血管收缩及醛固酮信号|高血压；部分肾脏或心血管风险情境需依据具体标签|含四唑环、咪唑与羟基；体内活性代谢物不等于同一化学身份|妊娠相关胎儿毒性、高钾及肾功能改变需核对|补钾、保钾利尿剂、NSAID及其他肾素-血管紧张素系统药物可增加风险
valsartan|缬沙坦|cardio|分子式为缬沙坦本体；不同复方不可按本体卡片直接替换|ARB|阻断血管紧张素II的AT1受体作用|高血压及某些心力衰竭或心肌梗死后情境|含羧酸、四唑与酰胺；酸性基团的电离影响物化性质|妊娠禁忌相关风险、高钾及肾功能问题；不能自行与其他同通路药叠加|钾补充剂、保钾利尿剂、NSAID、锂盐等需核对
lisinopril|赖诺普利|cardio|分子式为无水本体；二水合物另含结晶水|血管紧张素转换酶抑制剂（ACEI）|抑制ACE，减少血管紧张素II生成并影响缓激肽代谢|高血压、部分心力衰竭及心肌梗死相关情境|含羧酸、胺与酰胺，电离基团较多；不是需要酯水解活化的同类前药|血管性水肿、咳嗽、高钾、肾功能改变和妊娠风险|补钾、保钾利尿剂、NSAID及沙库巴曲相关制剂有重要相互作用或间隔要求
enalapril|依那普利|cardio|分子式为本体；常见马来酸盐另计；依那普利拉是活性代谢物|ACEI前药|经体内水解形成依那普利拉后抑制ACE|高血压及部分心力衰竭相关情境|酯键可代谢水解；前药与活性代谢物分子式和药代不同|血管性水肿、咳嗽、高钾、肾功能及妊娠风险需评估|补钾、保钾利尿剂、NSAID及沙库巴曲相关制剂需核对
metoprolol|美托洛尔|cardio|分子式为本体；酒石酸盐、琥珀酸盐和缓释制剂不能简单混同|主要选择性β1受体阻滞药|降低心脏β1受体相关交感作用；选择性并非绝对|高血压、心绞痛及某些心力衰竭或心肌梗死相关情境，取决于制剂|含醇羟基、醚和胺；不同盐型及释药方式会改变制剂特征|心动过缓、传导阻滞；突然停用存在风险；呼吸道疾病和低血糖识别需评估|维拉帕米、地尔硫䓬、其他减慢心率药及部分CYP2D6抑制药需核对
bisoprolol|比索洛尔|cardio|分子式为本体；常见富马酸盐另计酸组分|主要选择性β1受体阻滞药|降低β1受体相关心率、收缩力及肾素释放|高血压和某些心力衰竭情境；适应证存在地区差异|含醚链、醇羟基与胺，具有立体化学；不能仅凭分子式推断制剂等效|心动过缓、传导阻滞和停药反跳风险；β1选择性不等于对哮喘完全无风险|其他减慢心率药及部分降压药需核对；可能掩盖低血糖的心悸表现
hydrochlorothiazide|氢氯噻嗪|cardio|分子式为氢氯噻嗪本体|噻嗪类利尿药|抑制肾远曲小管钠氯重吸收|高血压及特定水肿情境|含磺酰胺及含硫杂环；与其他利尿药作用部位不同|低钠、低钾、脱水及尿酸升高等；长期光敏及皮肤风险应核对标签|锂盐、NSAID、其他降压药及影响电解质的药物需核对
furosemide|呋塞米|cardio|分子式为游离酸；注射剂等可能采用相应盐或pH调整|袢利尿药|抑制髓袢升支粗段钠钾氯协同转运|心、肾、肝相关特定水肿及部分高血压情境|含羧酸、磺酰胺和呋喃环；利尿不是一般“排毒”概念|脱水、电解质失衡、低血压及耳毒性风险；肾功能需专业监测|氨基糖苷类等耳毒性药、锂盐、NSAID和其他降压药需核对
spironolactone|螺内酯|cardio|分子式为螺内酯本体；活性代谢物不等于本体|醛固酮受体拮抗型保钾利尿药|拮抗矿物皮质激素受体，影响远端肾单位钠钾处理|部分心力衰竭、水肿、醛固酮增多或高血压情境|含甾体骨架、内酯和含硫取代基；保钾与一般利尿药不同|高钾、肾功能问题及内分泌相关不良反应；不能据“保钾”理解为适合人人|钾补充剂、ACEI/ARB、其他保钾药及NSAID可能增加高钾或肾损伤风险
atorvastatin|阿托伐他汀|cardio|分子式为游离酸；钙盐及水合物另计，不能将钙盐式写成本体|HMG-CoA还原酶抑制剂（他汀）|抑制胆固醇合成关键酶并增加肝脏LDL清除|血脂管理及部分心血管事件风险降低|含羟基羧酸、酰胺与芳杂环；羟基酸结构与酶结合有关|肌病/横纹肌溶解及肝损伤风险；妊娠、哺乳相关安排须专业评估|强CYP3A4抑制药、部分抗感染药和其他增加肌病风险药物需核对
rosuvastatin|瑞舒伐他汀|cardio|分子式为游离酸；常见钙盐另计；非商品名区分题|他汀类调脂药|抑制HMG-CoA还原酶并促进LDL清除|血脂管理及特定心血管风险降低|含二羟基羧酸和含氮杂环；与阿托伐他汀不是同一分子|肌病、肝功能及肾功能相关风险；妊娠哺乳与特殊人群需个别评估|环孢素、部分抗病毒药、吉非贝齐及华法林等需核对
clopidogrel|氯吡格雷|cardio|分子式为本体；常见硫酸氢盐另计；活性代谢物与本体有别|P2Y12受体抑制型抗血小板前药|经代谢活化后不可逆抑制血小板ADP受体相关聚集|部分动脉粥样硬化血栓事件预防及冠脉治疗相关情境|含酯与噻吩环；药酶活化和遗传差异会影响反应|出血及少见血栓性血小板减少性紫癜等；不能擅自停用处方抗血小板药|奥美拉唑/埃索美拉唑可影响活化；NSAID及抗凝药增加出血风险
apixaban|阿哌沙班|cardio|分子式为阿哌沙班本体|直接Xa因子抑制型抗凝药|直接抑制凝血Xa因子，降低凝血酶生成|部分房颤卒中预防及静脉血栓栓塞治疗/预防情境|含多处酰胺及含氮杂环；抗凝与抗血小板机制不同|严重出血；突然停用可能增加血栓风险；肾肝功能及手术/穿刺需专业管理|强CYP3A4和P-gp抑制/诱导药、NSAID及其他抗栓药有重要相互作用
metformin|二甲双胍|endocrine|分子式为游离碱；常见盐酸盐另含氯化氢|双胍类降糖药|主要减少肝糖输出并改善胰岛素相关代谢反应，机制涉及多个通路|2型糖尿病的血糖管理|多氮双胍结构使其具有明显碱性和电离特征|严重肾功能问题等可增加罕见但严重乳酸性酸中毒风险；胃肠反应及B12不足需关注|含碘造影剂、饮酒及影响肾功能/酸碱状态的药物需按具体情境专业核对
empagliflozin|恩格列净|endocrine|分子式为恩格列净本体|SGLT2抑制剂|抑制肾近端小管葡萄糖重吸收，增加尿糖排出|2型糖尿病及特定心力衰竭、慢性肾病情境，依地区标签|含多羟基糖样部分与芳环；尿糖增多不等于泌尿道没有风险|酮症酸中毒可在血糖不很高时发生；脱水、生殖器感染及罕见严重会阴感染需警惕|利尿药增加容量不足风险；胰岛素或促泌剂可增加低血糖；手术和急性病需专业评估
dapagliflozin|达格列净|endocrine|分子式为本体；部分制剂使用丙二醇水合物，不能把溶剂化物式混为本体|SGLT2抑制剂|降低肾脏葡萄糖重吸收并增加尿糖排出|2型糖尿病以及特定心衰、慢性肾病情境|含多羟基与芳醚结构；溶剂化物属于固态/制剂化学身份信息|酮症酸中毒、脱水、感染及肾功能相关评估；急性不适不能只看血糖是否很高|胰岛素/促泌剂及利尿药合用风险需核对；手术、禁食和急性病安排须专业管理
sitagliptin|西格列汀|endocrine|分子式为本体；常见磷酸盐一水合物另计酸和结晶水|DPP-4抑制剂|减少肠促胰素降解，增强葡萄糖依赖的胰岛素相关反应|2型糖尿病血糖管理；不等同于胰岛素|含含氟芳环、胺和酰胺；酶抑制选择性来自完整分子|胰腺炎、严重关节痛、大疱性类天疱疮及肾功能相关评估|与胰岛素或磺脲类合用低血糖风险增加；其他药物及肾功能情况需专业核对
gliclazide|格列齐特|endocrine|分子式为格列齐特本体；普通和缓释剂型不据同式直接互换|磺脲类促胰岛素分泌药|关闭胰岛β细胞ATP敏感钾通道，促进胰岛素释放|2型糖尿病；具体地区批准情况应查当地标签|含磺酰脲结构；分泌促进作用与低血糖风险同时存在|低血糖可能严重；进食情况、肝肾功能及老年人风险需评估|其他降糖药、部分抗感染药及酒精等可能影响血糖；部分降压药也有相互作用，具体组合需核对
levothyroxine|左甲状腺素|endocrine|分子式为左甲状腺素游离体；常见钠盐水合物另计；仅写分子式不能区分立体构型|甲状腺激素替代药|提供T4并在组织转化为T3，参与核受体介导的代谢调节|甲状腺功能减退等特定激素替代情境|含碘代芳环、酚羟基和氨基酸样结构；盐型、吸收和制剂一致性均重要|不是减肥药；过度暴露可致心律失常等；需按甲状腺功能监测而非凭感觉调整|铁钙制剂、某些抗酸药会影响吸收；抗凝药等也需核对
albuterol|沙丁胺醇（美国通用名Albuterol）|respiratory|分子式为游离碱；常见硫酸盐组成另计，吸入/口服制剂不混用|短效β2受体激动型支气管扩张药|激动β2受体，松弛支气管平滑肌|特定可逆性气道阻塞的支气管扩张；不能代替长期抗炎控制|含酚羟基、醇羟基和胺；不同异构体制剂另有身份差异|心悸、震颤、低钾及反常支气管痉挛；需求增加提示需评估控制状况|非选择性β阻滞药可拮抗作用；部分利尿药和心律相关药需核对
budesonide|布地奈德|respiratory|分子式为布地奈德；存在立体异构组成；本卡呼吸系统为主，不把不同给药途径互换|糖皮质激素抗炎药|通过糖皮质激素受体调节炎症相关基因表达|吸入哮喘控制等；鼻用和肠道等其他制剂用途须另查标签|甾体骨架含羟基、酮与缩醛结构；给药途径显著影响局部及全身暴露|吸入制剂可有口咽真菌感染；长期全身效应与肾上腺抑制需评估；不是单独救急扩张药|强CYP3A4抑制剂可增加暴露；其他激素合用需专业核对
fluticasone propionate|丙酸氟替卡松|respiratory|特指丙酸酯；不是糠酸氟替卡松，后者分子式不同|糖皮质激素抗炎药|经糖皮质激素受体调节局部炎症反应|特定吸入哮喘控制或鼻用过敏性鼻炎制剂；用途取决于剂型|含卤代甾体骨架和丙酸酯；不同酯不是可凭“氟替卡松”互换的同一化学身份|口咽真菌感染、鼻出血或全身激素效应随剂型而异；吸入激素并非急救药|利托那韦等强CYP3A4抑制剂可显著增加全身激素风险
clotrimazole|克霉唑|skin|分子式为克霉唑本体；皮肤、阴道与口腔制剂适用部位不同|咪唑类抗真菌药|干扰真菌细胞膜甾醇合成|特定浅表真菌感染；不能把所有皮疹都归因于真菌|含咪唑及氯代芳环，整体较疏水；不是一般消毒剂|局部刺激和过敏；给药部位和复方激素成分需核对|口腔等制剂与他克莫司等药物的相互作用需评估；外用低暴露不等于所有剂型都没有相互作用
mupirocin|莫匹罗星|skin|分子式为莫匹罗星本体；莫匹罗星钙及不同软膏基质另计|局部抗细菌药|抑制细菌异亮氨酰-tRNA合成酶|特定细菌性皮肤感染；鼻用制剂的用途另查标签|含酯键、环氧结构和羧酸；不同基质并非可随意用于眼鼻黏膜|局部刺激、过敏和耐药；大面积皮损及肾功能问题需考虑软膏基质暴露|避免将不同外用药任意混合；是否存在配伍影响及鼻用/皮肤用转换需专业核对
adapalene|阿达帕林|skin|分子式为阿达帕林本体；不同浓度与复方不是同一产品说明|外用维A酸样抗痤疮药|通过维A酸受体相关作用调节毛囊角化并减轻炎症|寻常痤疮的特定外用治疗|含稠芳环、甲氧基和羧酸；对光/氧化稳定性应按本品资料而非其他维A酸泛化|局部刺激及光敏相关防护；妊娠计划、湿疹或破损皮肤需专业评估|其他刺激性角质剥脱或维A酸类外用药叠加可加重刺激
hydrocortisone|氢化可的松|skin|分子式为氢化可的松本体；醋酸酯、琥珀酸盐等另有化学组成和剂型|糖皮质激素|激动糖皮质激素受体，调节炎症及免疫反应|本卡以某些炎症性皮肤病外用为主；全身替代或急救用途须查专门制剂|甾体骨架含羟基及酮基；酯化/成盐会改变制剂特性|可掩盖感染、导致皮肤萎缩；部位、覆盖情况与长期使用需专业判断|其他激素或刺激性外用药需核对；不应将激素外用药直接作为抗真菌药
sertraline|舍曲林|neuro|分子式为舍曲林本体；盐酸盐另含氯化氢；构型是身份的一部分|选择性血清素再摄取抑制剂（SSRI）|抑制血清素再摄取，调节神经突触信号|抑郁及某些焦虑、强迫相关障碍；不能仅凭情绪自行诊断|含二氯代芳环与胺，可成盐；不是即时起效的镇静剂|有年轻人自杀想法/行为风险警示；血清素综合征、低钠和突然停药反应需关注|MAOI、其他增强血清素药、NSAID和抗凝药有重要相互作用
melatonin|褪黑素|neuro|分子式为褪黑素本体；保健品/药品身份及配方依地区而异|参与昼夜节律调节的激素类物质|作用于褪黑素受体，影响睡眠-觉醒节律信号|某些睡眠/节律相关情境；是否作为药品及适应证依地区管理|含吲哚、甲氧基与酰胺；天然存在不意味着补充剂对所有人均安全|嗜睡、驾驶安全、儿童和妊娠使用需专业评估；产品质量与有效成分含量可能不同|酒精、镇静药、氟伏沙明及部分抗凝药等需核对
lidocaine|利多卡因|neuro|分子式为本体；常见盐酸盐及水合形式另计；局麻、外用与心律制剂不能混用|酰胺类局部麻醉药；特定制剂亦用于心律失常|阻断电压门控钠通道，抑制神经冲动传导|经专业管理的局部麻醉；部分外用疼痛制剂及特定心律失常制剂各有标签|含酰胺与叔胺；酰胺型与酯型局麻药的代谢特点不同|过度吸收可造成严重中枢与心脏毒性；破损皮肤、大面积暴露及肝病需评估|其他局麻药、抗心律失常药及影响代谢药物可能产生叠加风险
`.trim().split('\n').map(line => {
  const [en, name, group, identity, kind, mechanism, uses, chemistry, warning, interactions] = line.split('|');
  if (!interactions) throw new Error('Incomplete pharmacology row: '+line);
  return {en,name,group,identity,kind,mechanism,uses,chemistry,warning,interactions};
});

export const groups = [
  ['pain','解热镇痛与抗炎'],['allergy','过敏与免疫介质'],['gastro','消化系统用药'],
  ['infection','抗感染药物'],['cardio','心血管与血液系统'],['endocrine','内分泌与代谢'],
  ['respiratory','呼吸系统用药'],['skin','皮肤与局部用药'],['neuro','神经与节律相关用药'],
];

// Factual source identity verification snapshot, 2026-10-22.
export const verified = [
  {
    "en": "acetaminophen",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a681004.html",
    "clinicalTitle": "Acetaminophen: MedlinePlus Drug Information",
    "clinicalSha256": "3b8733b29f368dfe9b7aac3934648e0f358c2f87dc666293c4cd732e41bed146",
    "clinicalBytes": 34720,
    "cid": 1983,
    "formula": "C8H9NO2",
    "iupac": "N-(4-hydroxyphenyl)acetamide",
    "smiles": "CC(=O)NC1=CC=C(C=C1)O",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/acetaminophen/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "b23076f8732c2a5ebf766600614d1ec7f4b7ba82b0fd329a9b0c36f024e407a3",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/1983/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "fae2972d3adc2269c153883fbe96613cd292ade8294cc82853a16ad6c08cc266",
    "supplementary": []
  },
  {
    "en": "ibuprofen",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a682159.html",
    "clinicalTitle": "Ibuprofen: MedlinePlus Drug Information",
    "clinicalSha256": "c57b223fbadade035e62148674585f48909a9eaa5c9292b583b38adfa88189e8",
    "clinicalBytes": 39278,
    "cid": 3672,
    "formula": "C13H18O2",
    "iupac": "2-[4-(2-methylpropyl)phenyl]propanoic acid",
    "smiles": "CC(C)CC1=CC=C(C=C1)C(C)C(=O)O",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/ibuprofen/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "d78c88ab7c51207f434972f2838c4375069570ef120d64604697aea1ec6d4732",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/3672/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "b16c454cafa8323288463e6ad22a255e313b0bffedb825696d5d9fdb34ff4208",
    "supplementary": []
  },
  {
    "en": "aspirin",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a682878.html",
    "clinicalTitle": "Aspirin: MedlinePlus Drug Information",
    "clinicalSha256": "a067fb8e479ae9553cc2d17604c2257341ffe12ba1660af24f775cdb59e68a15",
    "clinicalBytes": 37006,
    "cid": 2244,
    "formula": "C9H8O4",
    "iupac": "2-acetyloxybenzoic acid",
    "smiles": "CC(=O)OC1=CC=CC=C1C(=O)O",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/aspirin/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "f15d9e8b9a83af2f74db691fde55f0766cececf7264d2b7c382a4626731e8a11",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/2244/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "aa3121bc8fba1b9bb20c853322e6d532de30467838e073dce9b82bcf96859900",
    "supplementary": []
  },
  {
    "en": "naproxen",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a681029.html",
    "clinicalTitle": "Naproxen: MedlinePlus Drug Information",
    "clinicalSha256": "e424f98298235a54a09f9eeb7d689819dfa49c9f9aa320e0e61e48da8b3fd42a",
    "clinicalBytes": 37030,
    "cid": 156391,
    "formula": "C14H14O3",
    "iupac": "(2S)-2-(6-methoxynaphthalen-2-yl)propanoic acid",
    "smiles": "CC(C1=CC2=C(C=C1)C=C(C=C2)OC)C(=O)O",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/naproxen/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "11ceb4c38b7ef74661d18744f88f7860164100c07b70b36a598ac048c8f4d13f",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/156391/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "1615ce5aa0815c3f08394b84d2c71b0b68bf57882e196ae44f43d45fdbd232a7",
    "supplementary": []
  },
  {
    "en": "diclofenac",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a689002.html",
    "clinicalTitle": "Diclofenac: MedlinePlus Drug Information",
    "clinicalSha256": "81cdf9631f634ed98ad780aa4f22602399c5151d61a1d0849605f251c1847a51",
    "clinicalBytes": 35537,
    "cid": 3033,
    "formula": "C14H11Cl2NO2",
    "iupac": "2-[2-(2,6-dichloroanilino)phenyl]acetic acid",
    "smiles": "C1=CC=C(C(=C1)CC(=O)O)NC2=C(C=CC=C2Cl)Cl",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/diclofenac/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "118f82034703ce4478a3b3c9546194116350b6231bf87cc12cd149bd918c8ed1",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/3033/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "48408f4bad9ae821016b3c118bf3b9c5a670d48cab4aac9d3239b4ee2ed37245",
    "supplementary": [
      {
        "label": "NIH MedlinePlus：双氯芬酸关节痛外用剂",
        "url": "https://medlineplus.gov/druginfo/meds/a611002.html",
        "sha256": "f24468097460b5e48dbcff628da1ba1b54b3593aacab3c91ea9b375d9f31ea17"
      }
    ]
  },
  {
    "en": "celecoxib",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a699022.html",
    "clinicalTitle": "Celecoxib: MedlinePlus Drug Information",
    "clinicalSha256": "3a1db6f848e6c477f9abb875a0ab3b46f6c0a96acfea8cfd6682a8110b903f8f",
    "clinicalBytes": 35065,
    "cid": 2662,
    "formula": "C17H14F3N3O2S",
    "iupac": "4-[5-(4-methylphenyl)-3-(trifluoromethyl)pyrazol-1-yl]benzenesulfonamide",
    "smiles": "CC1=CC=C(C=C1)C2=CC(=NN2C3=CC=C(C=C3)S(=O)(=O)N)C(F)(F)F",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/celecoxib/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "7951f6ce5e955aa824fed6cd0abd31be7cfe499b85c3d745a56f2ad8b140377c",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/2662/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "cd3f8d6d6697e5b9221a2f584263e9c147a3b25f124c44eca953a77090157e57",
    "supplementary": []
  },
  {
    "en": "cetirizine",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a623043.html",
    "clinicalTitle": "Cetirizine: MedlinePlus Drug Information",
    "clinicalSha256": "35b65cb05bead1db160cf5af03b545d49236df2d01867768d6ebfadf6c1028c1",
    "clinicalBytes": 29180,
    "cid": 2678,
    "formula": "C21H25ClN2O3",
    "iupac": "2-[2-[4-[(4-chlorophenyl)-phenylmethyl]piperazin-1-yl]ethoxy]acetic acid",
    "smiles": "C1CN(CCN1CCOCC(=O)O)C(C2=CC=CC=C2)C3=CC=C(C=C3)Cl",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/cetirizine/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "a946b0aafc4de8c23e43aa5ae77bef3a3edc2ce8bf6b35fc2b2933360b98d44a",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/2678/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "ac106133f5b2159987f787e1ed6f272e0aaf927372dd0fd864eaa5fe829f777f",
    "supplementary": []
  },
  {
    "en": "loratadine",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a697038.html",
    "clinicalTitle": "Loratadine: MedlinePlus Drug Information",
    "clinicalSha256": "90b24b58a8926550194ff1ef462ce073aece31109ec15e65278d2c3978a3d05a",
    "clinicalBytes": 26793,
    "cid": 3957,
    "formula": "C22H23ClN2O2",
    "iupac": "ethyl 4-(13-chloro-4-azatricyclo[9.4.0.03,8]pentadeca-1(11),3(8),4,6,12,14-hexaen-2-ylidene)piperidine-1-carboxylate",
    "smiles": "CCOC(=O)N1CCC(=C2C3=C(CCC4=C2N=CC=C4)C=C(C=C3)Cl)CC1",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/loratadine/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "9f0bb9b861fd6b26af99ffeea9a4dff3c9e13a44e3cc4b57dffe03067e3f6358",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/3957/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "1f068bb6873eb2ac3cd4468d3a165bf52ff6df31bd68465201d020138d1ed9b8",
    "supplementary": [
      {
        "label": "NHS：氯雷他定的用途与注意事项",
        "url": "https://www.nhs.uk/medicines/loratadine/",
        "sha256": "79cdc184dffb9e372273884431ad6c29eeff0770bb33ad2efcc4a86baa94f4ae"
      }
    ]
  },
  {
    "en": "fexofenadine",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a697035.html",
    "clinicalTitle": "Fexofenadine: MedlinePlus Drug Information",
    "clinicalSha256": "e8e319b750649075c8df48e073d85af28071f52958458c93ea0b767abb89867c",
    "clinicalBytes": 27172,
    "cid": 3348,
    "formula": "C32H39NO4",
    "iupac": "2-[4-[1-hydroxy-4-[4-[hydroxy(diphenyl)methyl]piperidin-1-yl]butyl]phenyl]-2-methylpropanoic acid",
    "smiles": "CC(C)(C1=CC=C(C=C1)C(CCCN2CCC(CC2)C(C3=CC=CC=C3)(C4=CC=CC=C4)O)O)C(=O)O",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/fexofenadine/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "2116740a7e38d055bd7a2a81553b860c196e8fe04514ecdcf96c422e4a9b9f2e",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/3348/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "8ca57adc78aff266944b754ac240a1755df8880e78acedc4bb8f57f0f4a3bbe9",
    "supplementary": []
  },
  {
    "en": "diphenhydramine",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a682539.html",
    "clinicalTitle": "Diphenhydramine: MedlinePlus Drug Information",
    "clinicalSha256": "c8070ab7c52fd17cd56669c4b4c6f68a26bf30d8836f91df2dc4270a83f0d2ce",
    "clinicalBytes": 32787,
    "cid": 3100,
    "formula": "C17H21NO",
    "iupac": "2-benzhydryloxy-N,N-dimethylethanamine",
    "smiles": "CN(C)CCOC(C1=CC=CC=C1)C2=CC=CC=C2",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/diphenhydramine/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "3cf340614f7fa23eba968c8db8a66daaa56fe7a7bdef44c403f35421af59aae6",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/3100/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "c4e0207d2f8ab42a7a04169b8a4c3e4bde0de4ff917183636f904027a47a3862",
    "supplementary": []
  },
  {
    "en": "chlorpheniramine",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a682543.html",
    "clinicalTitle": "Chlorpheniramine: MedlinePlus Drug Information",
    "clinicalSha256": "775ef46debf7a00fd11b957096994dbb1c3360f8449b42b943f6b35ac4fe157b",
    "clinicalBytes": 28816,
    "cid": 2725,
    "formula": "C16H19ClN2",
    "iupac": "3-(4-chlorophenyl)-N,N-dimethyl-3-pyridin-2-ylpropan-1-amine",
    "smiles": "CN(C)CCC(C1=CC=C(C=C1)Cl)C2=CC=CC=N2",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/chlorpheniramine/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "4a44560ff482c1496472118d283b488bab9da45567a71ed7978efd2381c6b0d7",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/2725/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "cad66e3589e9abcf254f299289ba69866c3d4145f2c40bc471cdda6d2af71bd3",
    "supplementary": []
  },
  {
    "en": "montelukast",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a600014.html",
    "clinicalTitle": "Montelukast: MedlinePlus Drug Information",
    "clinicalSha256": "8487ad3b1db57b955ff75176da95394ab40b28e67bee396e631b4a8193a646dc",
    "clinicalBytes": 31610,
    "cid": 5281040,
    "formula": "C35H36ClNO3S",
    "iupac": "2-[1-[[(1R)-1-[3-[(E)-2-(7-chloroquinolin-2-yl)ethenyl]phenyl]-3-[2-(2-hydroxypropan-2-yl)phenyl]propyl]sulfanylmethyl]cyclopropyl]acetic acid",
    "smiles": "CC(C)(C1=CC=CC=C1CCC(C2=CC=CC(=C2)C=CC3=NC4=C(C=CC(=C4)Cl)C=C3)SCC5(CC5)CC(=O)O)O",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/montelukast/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "0436569a0e37e601b0635d46173c1944f16bc314ac96ecaff915e42b7c5f060e",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/5281040/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "4d9f8e639749380ae53342c5ae1bb9bcdf4490bc7bd635546c6ecf68571888fe",
    "supplementary": []
  },
  {
    "en": "omeprazole",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a693050.html",
    "clinicalTitle": "Omeprazole: MedlinePlus Drug Information",
    "clinicalSha256": "fa9adaed0ef08c321e88d32680fc150dc9547cd0ecc860d883daa487f9756410",
    "clinicalBytes": 34479,
    "cid": 4594,
    "formula": "C17H19N3O3S",
    "iupac": "6-methoxy-2-[(4-methoxy-3,5-dimethyl-2-pyridinyl)methylsulfinyl]-1H-benzimidazole",
    "smiles": "CC1=CN=C(C(=C1OC)C)CS(=O)C2=NC3=C(N2)C=C(C=C3)OC",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/omeprazole/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "4e8083aaf2aa2876fc3bfe8c307d7fc653b0703436d8eea8c46b9ee1eab5da75",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/4594/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "4c68143b8c51aa5a1092d4a44f40a93c3d085d7adb599a1193b6721235cdf9dc",
    "supplementary": []
  },
  {
    "en": "esomeprazole",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a699054.html",
    "clinicalTitle": "Esomeprazole: MedlinePlus Drug Information",
    "clinicalSha256": "328dde11d3750d407e352208a33183f9527744435f0e162bf0108aaee033728c",
    "clinicalBytes": 34794,
    "cid": 9568614,
    "formula": "C17H19N3O3S",
    "iupac": "6-methoxy-2-[(S)-(4-methoxy-3,5-dimethyl-2-pyridinyl)methylsulfinyl]-1H-benzimidazole",
    "smiles": "CC1=CN=C(C(=C1OC)C)CS(=O)C2=NC3=C(N2)C=C(C=C3)OC",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/esomeprazole/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "1b713c9949227ff45ae55a8c0c6f034cf01072a4f91170238dbdf2bf63346faa",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/9568614/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "d285c4a16cd008c30b8d20ee211f433129b2016a01fcc505ee5000dfaaf40046",
    "supplementary": []
  },
  {
    "en": "pantoprazole",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a601246.html",
    "clinicalTitle": "Pantoprazole: MedlinePlus Drug Information",
    "clinicalSha256": "043817c5b1466771a7bb115d50aa8b28db3e00ee6751bad1a745dd2fdbd343e3",
    "clinicalBytes": 30224,
    "cid": 4679,
    "formula": "C16H15F2N3O4S",
    "iupac": "6-(difluoromethoxy)-2-[(3,4-dimethoxy-2-pyridinyl)methylsulfinyl]-1H-benzimidazole",
    "smiles": "COC1=C(C(=NC=C1)CS(=O)C2=NC3=C(N2)C=C(C=C3)OC(F)F)OC",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/pantoprazole/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "ce058fa68e271b53922b5e84bf59df6fceb6da44f8becd7d65b3a379322df384",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/4679/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "04b6d0431b0405849fdc8502a52828c3f4926bbbd28f879549e4de31001c10d3",
    "supplementary": []
  },
  {
    "en": "famotidine",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a687011.html",
    "clinicalTitle": "Famotidine: MedlinePlus Drug Information",
    "clinicalSha256": "be43b5e8e6ff007ce467e65f3f0736d0c5216dd16e626082e84e118246d4f10d",
    "clinicalBytes": 29472,
    "cid": 5702160,
    "formula": "C8H15N7O2S3",
    "iupac": "3-[[2-(diaminomethylideneamino)-1,3-thiazol-4-yl]methylsulfanyl]-N'-sulfamoylpropanimidamide",
    "smiles": "C1=C(N=C(S1)N=C(N)N)CSCCC(=NS(=O)(=O)N)N",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/famotidine/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "8c5f11ad584bf486c8558d1f7d18a25155adfd6d4182215882705a93d11f17e9",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/5702160/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "238cc02ff84eee4a82b1f2c257cf0f5edb03aa90b8af7f6a7c3a2854f9cf7080",
    "supplementary": []
  },
  {
    "en": "mesalamine",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a688021.html",
    "clinicalTitle": "Mesalamine: MedlinePlus Drug Information",
    "clinicalSha256": "0491c2e49e7be399d9731c9568ec09e6436a168f9fc9c90b42aa9ee110e652f9",
    "clinicalBytes": 32484,
    "cid": 4075,
    "formula": "C7H7NO3",
    "iupac": "5-amino-2-hydroxybenzoic acid",
    "smiles": "C1=CC(=C(C=C1N)C(=O)O)O",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/mesalamine/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "0429b1710b6295c04f5c032858d07241de6c5e008926cf882ef84d11b1022020",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/4075/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "bb11e4d3519589b2cddb29ff2e0c15d91eb8b9dea980c577a01e41e808ad0012",
    "supplementary": []
  },
  {
    "en": "ondansetron",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a601209.html",
    "clinicalTitle": "Ondansetron: MedlinePlus Drug Information",
    "clinicalSha256": "bd4a2534ed0952174e28249b4b7688344fafb3ba6469422566c654002eac2d1e",
    "clinicalBytes": 28198,
    "cid": 4595,
    "formula": "C18H19N3O",
    "iupac": "9-methyl-3-[(2-methylimidazol-1-yl)methyl]-2,3-dihydro-1H-carbazol-4-one",
    "smiles": "CC1=NC=CN1CC2CCC3=C(C2=O)C4=CC=CC=C4N3C",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/ondansetron/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "ea517f6ada320df37933eb3a55b206557a71cf5db4c2378ba4e1d34aa4edf10f",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/4595/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "0540cec23779a45db5f2a40d4690a4979e4b9866643831e94adcb308f1c66f0e",
    "supplementary": []
  },
  {
    "en": "metoclopramide",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a684035.html",
    "clinicalTitle": "Metoclopramide: MedlinePlus Drug Information",
    "clinicalSha256": "3c0e08b686d24acb193ee7467442de60c5dc7e34205c319f1d7ad28c45c9bf37",
    "clinicalBytes": 31650,
    "cid": 4168,
    "formula": "C14H22ClN3O2",
    "iupac": "4-amino-5-chloro-N-[2-(diethylamino)ethyl]-2-methoxybenzamide",
    "smiles": "CCN(CC)CCNC(=O)C1=CC(=C(C=C1OC)N)Cl",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/metoclopramide/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "a815fcf29b8f80ae9cd1f48ff55e30a7b20c5bb3d9cc63cbfdaf7cd59522fb40",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/4168/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "26f62c03370762cc14639e5beb87475daa0c129facea0541f8ea8190e6d58845",
    "supplementary": [
      {
        "label": "NIH MedlinePlus：甲氧氯普胺注射剂",
        "url": "https://medlineplus.gov/druginfo/meds/a601158.html",
        "sha256": "1eaa55aaa6d736b8a2f52702226f804c4cd02aa02b825b3d907143b9a019435d"
      }
    ]
  },
  {
    "en": "lactulose",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a682338.html",
    "clinicalTitle": "Lactulose: MedlinePlus Drug Information",
    "clinicalSha256": "6e2a90a6970515424caca25d3ca16f4ccb70861bae19a7392872b19ad1a8436b",
    "clinicalBytes": 24719,
    "cid": 11333,
    "formula": "C12H22O11",
    "iupac": "(2S,3R,4S,5R,6R)-2-[(2R,3S,4S,5R)-4,5-dihydroxy-2,5-bis(hydroxymethyl)oxolan-3-yl]oxy-6-(hydroxymethyl)oxane-3,4,5-triol",
    "smiles": "C(C1C(C(C(C(O1)OC2C(OC(C2O)(CO)O)CO)O)O)O)O",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/lactulose/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "d016e9a75383c0ea85b90a98a449343d731c52eb49725e89171652bf885b8518",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/11333/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "49181e78f9fba8d5f76819d5507e0ffe36d0bb655da45e7f3b44c849dacbaa96",
    "supplementary": []
  },
  {
    "en": "amoxicillin",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a685001.html",
    "clinicalTitle": "Amoxicillin: MedlinePlus Drug Information",
    "clinicalSha256": "2d62fd9d65fa1e3fc4cc95c9d02db44657843cc83b1f727740ddffadd47b58ec",
    "clinicalBytes": 30604,
    "cid": 33613,
    "formula": "C16H19N3O5S",
    "iupac": "(2S,5R,6R)-6-[[(2R)-2-amino-2-(4-hydroxyphenyl)acetyl]amino]-3,3-dimethyl-7-oxo-4-thia-1-azabicyclo[3.2.0]heptane-2-carboxylic acid",
    "smiles": "CC1(C(N2C(S1)C(C2=O)NC(=O)C(C3=CC=C(C=C3)O)N)C(=O)O)C",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/amoxicillin/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "fd5dbe48184dead5ef425990334a548f8df216cd4efc540d9b6340b6c22f29a6",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/33613/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "3929010b95eccc7340f76f00a422c4d5f54b0f2999722c7fcf83f7ef6cd9bb24",
    "supplementary": []
  },
  {
    "en": "azithromycin",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a697037.html",
    "clinicalTitle": "Azithromycin: MedlinePlus Drug Information",
    "clinicalSha256": "c9d5202afb73a11c6b43e4937c8cfa9a0f959085c8be6ae6a278194fda708341",
    "clinicalBytes": 31096,
    "cid": 447043,
    "formula": "C38H72N2O12",
    "iupac": "(2R,3S,4R,5R,8R,10R,11R,12S,13S,14R)-11-[(2S,3R,4S,6R)-4-(dimethylamino)-3-hydroxy-6-methyloxan-2-yl]oxy-2-ethyl-3,4,10-trihydroxy-13-[(2R,4R,5S,6S)-5-hydroxy-4-methoxy-4,6-dimethyloxan-2-yl]oxy-3,5,6,8,10,12,14-heptamethyl-1-oxa-6-azacyclopentadecan-15-one",
    "smiles": "CCC1C(C(C(N(CC(CC(C(C(C(C(C(=O)O1)C)OC2CC(C(C(O2)C)O)(C)OC)C)OC3C(C(CC(O3)C)N(C)C)O)(C)O)C)C)C)O)(C)O",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/azithromycin/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "d926333c0c1c726feab0a748e692425c668a10c11dc51bf0781a447f7fb98822",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/447043/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "8f3ee61d6417522ce9116791541365454dd961c609687f0a9902b6d85cabde73",
    "supplementary": []
  },
  {
    "en": "doxycycline",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a682063.html",
    "clinicalTitle": "Doxycycline: MedlinePlus Drug Information",
    "clinicalSha256": "f750ebb7af3bcd7dc3910786573ea25b68bdeb2823ea2519973db4f711296eb6",
    "clinicalBytes": 32687,
    "cid": 54671203,
    "formula": "C22H24N2O8",
    "iupac": "(4S,4aR,5S,5aR,6R,12aR)-4-(dimethylamino)-1,5,10,11,12a-pentahydroxy-6-methyl-3,12-dioxo-4a,5,5a,6-tetrahydro-4H-tetracene-2-carboxamide",
    "smiles": "CC1C2C(C3C(C(=O)C(=C(C3(C(=O)C2=C(C4=C1C=CC=C4O)O)O)O)C(=O)N)N(C)C)O",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/doxycycline/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "3ce592115e3db1c336257e8e65b232c6f6a863eeb9fd8e8cfd1abeb713ce16a3",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/54671203/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "1368ef23ba65267b64880a63c2af996876cf38dcd59a6da0e7b57dd04687fc1c",
    "supplementary": []
  },
  {
    "en": "cephalexin",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a682733.html",
    "clinicalTitle": "Cephalexin: MedlinePlus Drug Information",
    "clinicalSha256": "ba4d2e687cc45f90250ca277359a2d697a5e54e82ff6f53e027dcb8bd0e5514b",
    "clinicalBytes": 28722,
    "cid": 27447,
    "formula": "C16H17N3O4S",
    "iupac": "(6R,7R)-7-[[(2R)-2-amino-2-phenylacetyl]amino]-3-methyl-8-oxo-5-thia-1-azabicyclo[4.2.0]oct-2-ene-2-carboxylic acid",
    "smiles": "CC1=C(N2C(C(C2=O)NC(=O)C(C3=CC=CC=C3)N)SC1)C(=O)O",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/cephalexin/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "28dcecbff8eff1a6705d009d8b650ec8232a16aa9ce486e286cef421a2ed4539",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/27447/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "3c849bd25a9afc7c0d20323229ee3d285e611e7531114b5c7024a683ddf843ba",
    "supplementary": []
  },
  {
    "en": "ciprofloxacin",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a688016.html",
    "clinicalTitle": "Ciprofloxacin: MedlinePlus Drug Information",
    "clinicalSha256": "f3e0344124342df54002b2f70fac829e8c15255d48f4b3cd3d97142a104e1329",
    "clinicalBytes": 39108,
    "cid": 2764,
    "formula": "C17H18FN3O3",
    "iupac": "1-cyclopropyl-6-fluoro-4-oxo-7-piperazin-1-ylquinoline-3-carboxylic acid",
    "smiles": "C1CC1N2C=C(C(=O)C3=CC(=C(C=C32)N4CCNCC4)F)C(=O)O",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/ciprofloxacin/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "639306f047b4f47a21ae74938e7fbdb4abf59ae74ac9b9c88005990aba19f90a",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/2764/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "163b83352fef44318e3597359f7928f14b772d74fa11c1b6b617b31bb630a94e",
    "supplementary": [
      {
        "label": "NIH DailyMed：环丙沙星美国标签（替扎尼定禁忌与药物相互作用）",
        "url": "https://dailymed.nlm.nih.gov/dailymed/fda/fdaDrugXsl.cfm?setid=3e4402d4-e0d3-9846-3e81-ed46f34137fe",
        "sha256": "3ba3f3d8b9576fa5abf9d417a4664c01f3150d6a2a96c7155179068ca5db9815"
      }
    ]
  },
  {
    "en": "metronidazole",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a689011.html",
    "clinicalTitle": "Metronidazole: MedlinePlus Drug Information",
    "clinicalSha256": "cb865dbc6207bcaafb186cfe99f089e38b68d45c012c17dce773a56aa8cab8f2",
    "clinicalBytes": 29354,
    "cid": 4173,
    "formula": "C6H9N3O3",
    "iupac": "2-(2-methyl-5-nitroimidazol-1-yl)ethanol",
    "smiles": "CC1=NC=C(N1CCO)[N+](=O)[O-]",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/metronidazole/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "132e7b35e6b05022b29371a42e151d6e92b86a45c562a8d620299c9d4e967c06",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/4173/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "8a64329e5e0667d89acbafe02269d3ad7fb3f926a664bd346ad9afcb89cd9c9c",
    "supplementary": []
  },
  {
    "en": "nitrofurantoin",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a682291.html",
    "clinicalTitle": "Nitrofurantoin: MedlinePlus Drug Information",
    "clinicalSha256": "207ddc4bbc7f92b385e8f8e287460661fef2690414264d135b9334ba835a0e32",
    "clinicalBytes": 29099,
    "cid": 6604200,
    "formula": "C8H6N4O5",
    "iupac": "1-[(E)-(5-nitrofuran-2-yl)methylideneamino]imidazolidine-2,4-dione",
    "smiles": "C1C(=O)NC(=O)N1N=CC2=CC=C(O2)[N+](=O)[O-]",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/nitrofurantoin/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "cb5b371ca89770f5199db94183c12634f8af8c05e6bbcfcbfe93cdef9ba85b92",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/6604200/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "cc09e3479af234f9105d9c40dd92e4738653df2969ec7998805179e3da1c924d",
    "supplementary": []
  },
  {
    "en": "fluconazole",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a690002.html",
    "clinicalTitle": "Fluconazole: MedlinePlus Drug Information",
    "clinicalSha256": "5da1c80f394e06e679f874ffa43deb6fd24a35fafbfd8e537d518b868a3251d4",
    "clinicalBytes": 30158,
    "cid": 3365,
    "formula": "C13H12F2N6O",
    "iupac": "2-(2,4-difluorophenyl)-1,3-bis(1,2,4-triazol-1-yl)propan-2-ol",
    "smiles": "C1=CC(=C(C=C1F)F)C(CN2C=NC=N2)(CN3C=NC=N3)O",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/fluconazole/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "4e7ef0a72c9adab0a57e1fcc80f4bf1088e4c6274a9c9b97e3493bc4c70ebdea",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/3365/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "5051dc7aa2c92286acf17f9b719b82741f4b0c16672ae0c7c3b7ac3e094a3863",
    "supplementary": []
  },
  {
    "en": "acyclovir",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a681045.html",
    "clinicalTitle": "Acyclovir: MedlinePlus Drug Information",
    "clinicalSha256": "9a9c46c8678e3a9a9aeae32fb495c6f871a73a194d39916fd6ccaadfeabe7761",
    "clinicalBytes": 28942,
    "cid": 135398513,
    "formula": "C8H11N5O3",
    "iupac": "2-amino-9-(2-hydroxyethoxymethyl)-1H-purin-6-one",
    "smiles": "C1=NC2=C(N1COCCO)N=C(NC2=O)N",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/acyclovir/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "7fbcd9077961716cdb6173b41e1f096d288739c715622174db65b327eb939536",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/135398513/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "40483c3681edbd4f5d4f2a914962c35e7746b4e9986a049b9539a03a4b084873",
    "supplementary": []
  },
  {
    "en": "oseltamivir",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a699040.html",
    "clinicalTitle": "Oseltamivir: MedlinePlus Drug Information",
    "clinicalSha256": "813b6b9d7bb9375483faf9bdf4f62da32b539b467969cc1cdcd665970ec2fbdb",
    "clinicalBytes": 32759,
    "cid": 65028,
    "formula": "C16H28N2O4",
    "iupac": "ethyl (3R,4R,5S)-4-acetamido-5-amino-3-pentan-3-yloxycyclohexene-1-carboxylate",
    "smiles": "CCC(CC)OC1C=C(CC(C1NC(=O)C)N)C(=O)OCC",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/oseltamivir/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "01a474d8117080d1e6b569b627c9cf5f590e0285c2ed1a468adf893abf82b957",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/65028/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "746d357c27bf3a3c8349e9d38acd8d75939867ba34a7aa431b76755c7e4ca167",
    "supplementary": []
  },
  {
    "en": "amlodipine",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a692044.html",
    "clinicalTitle": "Amlodipine: MedlinePlus Drug Information",
    "clinicalSha256": "c16fb31e1325335dace16483c8eab17e0d4ddb7c99e9fc8d415c27305f53a9bc",
    "clinicalBytes": 29409,
    "cid": 2162,
    "formula": "C20H25ClN2O5",
    "iupac": "3-O-ethyl 5-O-methyl 2-(2-aminoethoxymethyl)-4-(2-chlorophenyl)-6-methyl-1,4-dihydropyridine-3,5-dicarboxylate",
    "smiles": "CCOC(=O)C1=C(NC(=C(C1C2=CC=CC=C2Cl)C(=O)OC)C)COCCN",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/amlodipine/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "842cb2780fb522d80c1718ef75c241e3f9ab942aaf390dbdfaeab9f3cfd2ccae",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/2162/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "eba0c2a098e00129b8ee1272af8c589d90edba6117dc734f8f4594d7d16cdd8d",
    "supplementary": []
  },
  {
    "en": "losartan",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a695008.html",
    "clinicalTitle": "Losartan: MedlinePlus Drug Information",
    "clinicalSha256": "ec6ce93916e5483c3a3e7bc05edb1f43ee9b387f9b94d3ff954f86a933534cf0",
    "clinicalBytes": 31129,
    "cid": 3961,
    "formula": "C22H23ClN6O",
    "iupac": "[2-butyl-5-chloro-3-[[4-[2-(2H-tetrazol-5-yl)phenyl]phenyl]methyl]imidazol-4-yl]methanol",
    "smiles": "CCCCC1=NC(=C(N1CC2=CC=C(C=C2)C3=CC=CC=C3C4=NNN=N4)CO)Cl",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/losartan/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "fe99bc474c26f5c515227ca2310533e336488b90e0697a7d4e7717d05930be73",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/3961/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "74b6dab0da6ac4cc9040236fa88f8a9328a94d414e02028a4a263541db26121d",
    "supplementary": []
  },
  {
    "en": "valsartan",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a697015.html",
    "clinicalTitle": "Valsartan: MedlinePlus Drug Information",
    "clinicalSha256": "c3a434a6f6577ed9342438a5d353f36004a7f45117120841c32a84c7727b68fc",
    "clinicalBytes": 32181,
    "cid": 60846,
    "formula": "C24H29N5O3",
    "iupac": "(2S)-3-methyl-2-[pentanoyl-[[4-[2-(2H-tetrazol-5-yl)phenyl]phenyl]methyl]amino]butanoic acid",
    "smiles": "CCCCC(=O)N(CC1=CC=C(C=C1)C2=CC=CC=C2C3=NNN=N3)C(C(C)C)C(=O)O",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/valsartan/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "79083ac403fd8aa97ada9b1d07aa902fdc41a27198497bcf7506cae2d0c1a865",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/60846/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "eb69b8070e7f1229f5023067fa200daefb130e277e7d6904cdac8476c28d725f",
    "supplementary": []
  },
  {
    "en": "lisinopril",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a692051.html",
    "clinicalTitle": "Lisinopril: MedlinePlus Drug Information",
    "clinicalSha256": "c2c951d643905c545f58d819e05344e2964fee9707178792421993ed9666e01b",
    "clinicalBytes": 30497,
    "cid": 5362119,
    "formula": "C21H31N3O5",
    "iupac": "(2S)-1-[(2S)-6-amino-2-[[(1S)-1-carboxy-3-phenylpropyl]amino]hexanoyl]pyrrolidine-2-carboxylic acid",
    "smiles": "C1CC(N(C1)C(=O)C(CCCCN)NC(CCC2=CC=CC=C2)C(=O)O)C(=O)O",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/lisinopril/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "b69ebc0da045d41adb948c2b8f4e6d3b07dd24d092877d950d9251cedfc0a78f",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/5362119/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "cd514a58533417a8176db5426e2e31cc41fe6e3e4e97d26dec3ac3be8c535d7c",
    "supplementary": []
  },
  {
    "en": "enalapril",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a686022.html",
    "clinicalTitle": "Enalapril: MedlinePlus Drug Information",
    "clinicalSha256": "ea2a89b58a354c6f3f8f521aae48813022358f6dc72665aa4ee563df5da56c1f",
    "clinicalBytes": 31052,
    "cid": 5388962,
    "formula": "C20H28N2O5",
    "iupac": "(2S)-1-[(2S)-2-[[(2S)-1-ethoxy-1-oxo-4-phenylbutan-2-yl]amino]propanoyl]pyrrolidine-2-carboxylic acid",
    "smiles": "CCOC(=O)C(CCC1=CC=CC=C1)NC(C)C(=O)N2CCCC2C(=O)O",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/enalapril/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "890306e1113fe4061c7192bdbe581a75401fadaae4c1274e8acf737d14be352b",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/5388962/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "952464835d4874299c582ff5343038e88f013fac3408fa729d2c55ab205007cc",
    "supplementary": []
  },
  {
    "en": "metoprolol",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a682864.html",
    "clinicalTitle": "Metoprolol: MedlinePlus Drug Information",
    "clinicalSha256": "d6c6401a46f5c0a9af2bb52497f0304c0a37732ff0dea200b1b0e787164be065",
    "clinicalBytes": 29975,
    "cid": 4171,
    "formula": "C15H25NO3",
    "iupac": "1-[4-(2-methoxyethyl)phenoxy]-3-(propan-2-ylamino)propan-2-ol",
    "smiles": "CC(C)NCC(COC1=CC=C(C=C1)CCOC)O",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/metoprolol/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "c71826d2f01621b7ceb8996a21bbe056fbd92c495bf624ca72c36ad70591dfba",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/4171/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "7ad24d60f90c563a945de3dec2c9b031fad3dea412f209519347773674f43023",
    "supplementary": []
  },
  {
    "en": "bisoprolol",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a693024.html",
    "clinicalTitle": "Bisoprolol: MedlinePlus Drug Information",
    "clinicalSha256": "219960ff9aa39250f2ba19fc514136cc4d3f6ffed6a1738b1906ad7e5ae939d7",
    "clinicalBytes": 28933,
    "cid": 2405,
    "formula": "C18H31NO4",
    "iupac": "1-(propan-2-ylamino)-3-[4-(2-propan-2-yloxyethoxymethyl)phenoxy]propan-2-ol",
    "smiles": "CC(C)NCC(COC1=CC=C(C=C1)COCCOC(C)C)O",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/bisoprolol/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "7f9755427df0ee446d0c928b32c3ac897a02620bd515e47fd44cbde487cd210f",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/2405/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "58ee7503c9065ac5d6f7ad11dc0590e3e6d0bd7873db8d68118fb558040fbe42",
    "supplementary": [
      {
        "label": "NHS：比索洛尔的用途（英国标签背景）",
        "url": "https://www.nhs.uk/medicines/bisoprolol/",
        "sha256": "2d28666e7c29a0a16c9f9224cb1fe88c35ba544a2508902ad485e6f9de15e329"
      }
    ]
  },
  {
    "en": "hydrochlorothiazide",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a682571.html",
    "clinicalTitle": "Hydrochlorothiazide: MedlinePlus Drug Information",
    "clinicalSha256": "8dba0c84444b92d25d0c74eaa8ff8c49144960357cfd047470e045eb9c4e3a25",
    "clinicalBytes": 34101,
    "cid": 3639,
    "formula": "C7H8ClN3O4S2",
    "iupac": "6-chloro-1,1-dioxo-3,4-dihydro-2H-1lambda6,2,4-benzothiadiazine-7-sulfonamide",
    "smiles": "C1NC2=CC(=C(C=C2S(=O)(=O)N1)S(=O)(=O)N)Cl",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/hydrochlorothiazide/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "96422512aeb40f6367647ad1ae426e8f363e5004aa01eeac9e7dbaf14d823a80",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/3639/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "14784ab3d3cdc788e27fba3eb7b81edeeeb9c7d4c0de03e9e0cc8a3e52ea3668",
    "supplementary": []
  },
  {
    "en": "furosemide",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a682858.html",
    "clinicalTitle": "Furosemide: MedlinePlus Drug Information",
    "clinicalSha256": "eb3bf9af21f9261a7b362aa82d59af71b0b2397d2c9dfc35228986f9a8795e59",
    "clinicalBytes": 28882,
    "cid": 3440,
    "formula": "C12H11ClN2O5S",
    "iupac": "4-chloro-2-(furan-2-ylmethylamino)-5-sulfamoylbenzoic acid",
    "smiles": "C1=COC(=C1)CNC2=CC(=C(C=C2C(=O)O)S(=O)(=O)N)Cl",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/furosemide/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "994210f95fde94df45f72c0520ad0f53acd8fc8220cfca4ec3591c495aaabd82",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/3440/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "dfa39deadfc043d22e14d12cad0047456bf02a33c29be05f8fe340d1a1bdd530",
    "supplementary": []
  },
  {
    "en": "spironolactone",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a682627.html",
    "clinicalTitle": "Spironolactone: MedlinePlus Drug Information",
    "clinicalSha256": "073be38a1596c0db66862175923b8d651dffbeaccaf5a58e116ddd4cbd773d71",
    "clinicalBytes": 32068,
    "cid": 5833,
    "formula": "C24H32O4S",
    "iupac": "S-[(7R,8R,9S,10R,13S,14S,17R)-10,13-dimethyl-3,5'-dioxospiro[2,6,7,8,9,11,12,14,15,16-decahydro-1H-cyclopenta[a]phenanthrene-17,2'-oxolane]-7-yl] ethanethioate",
    "smiles": "CC(=O)SC1CC2=CC(=O)CCC2(C3C1C4CCC5(C4(CC3)C)CCC(=O)O5)C",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/spironolactone/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "1cf4938cc98e0c34047bc834f586a4158007692f49a3dbb15043c7bb51e44b65",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/5833/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "2f5ff240482da5c59432c668400487a4ba74ef752a1fec5f9fbf2a6d9fb2b619",
    "supplementary": []
  },
  {
    "en": "atorvastatin",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a600045.html",
    "clinicalTitle": "Atorvastatin: MedlinePlus Drug Information",
    "clinicalSha256": "e29976d9dde407056fae74b9062de9f229ef0d1064ab89926776442321326dae",
    "clinicalBytes": 30549,
    "cid": 60823,
    "formula": "C33H35FN2O5",
    "iupac": "(3R,5R)-7-[2-(4-fluorophenyl)-3-phenyl-4-(phenylcarbamoyl)-5-propan-2-ylpyrrol-1-yl]-3,5-dihydroxyheptanoic acid",
    "smiles": "CC(C)C1=C(C(=C(N1CCC(CC(CC(=O)O)O)O)C2=CC=C(C=C2)F)C3=CC=CC=C3)C(=O)NC4=CC=CC=C4",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/atorvastatin/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "95f8efb91793e3f135c4c509c816409a1a676ad344d0e723b030822d37a9cfab",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/60823/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "3f2af7a4e3a79f1d03008ae5a349aa00411a424df629f23a8e484c615f059fe2",
    "supplementary": []
  },
  {
    "en": "rosuvastatin",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a603033.html",
    "clinicalTitle": "Rosuvastatin: MedlinePlus Drug Information",
    "clinicalSha256": "e6493a00d9d3ddfe27df040b5a28e51e7c67d386eed905f96c2aafd20e52d35b",
    "clinicalBytes": 29087,
    "cid": 446157,
    "formula": "C22H28FN3O6S",
    "iupac": "(E,3R,5S)-7-[4-(4-fluorophenyl)-2-[methyl(methylsulfonyl)amino]-6-propan-2-ylpyrimidin-5-yl]-3,5-dihydroxyhept-6-enoic acid",
    "smiles": "CC(C)C1=NC(=NC(=C1C=CC(CC(CC(=O)O)O)O)C2=CC=C(C=C2)F)N(C)S(=O)(=O)C",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/rosuvastatin/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "616c6e458d631f9a6b35960bd1865250ac31145d148c7c2d69b65f7b88495745",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/446157/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "94d3cba64f57301c3d7dbdb7926de11d49bc27042912489235f30eed2de54b97",
    "supplementary": []
  },
  {
    "en": "clopidogrel",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a601040.html",
    "clinicalTitle": "Clopidogrel: MedlinePlus Drug Information",
    "clinicalSha256": "75f4d267e624867c08416722430e327300dc340297c207bec97110406f425040",
    "clinicalBytes": 29834,
    "cid": 60606,
    "formula": "C16H16ClNO2S",
    "iupac": "methyl (2S)-2-(2-chlorophenyl)-2-(6,7-dihydro-4H-thieno[3,2-c]pyridin-5-yl)acetate",
    "smiles": "COC(=O)C(C1=CC=CC=C1Cl)N2CCC3=C(C2)C=CS3",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/clopidogrel/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "832462b54664445bcc4986b829fe2cc50708b9e9223ff900387c0d7233da3b2c",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/60606/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "13bdc4a26573a52feeb8425fd0b577ea178843f49f8c4da36fc6eeb89c94a9a7",
    "supplementary": []
  },
  {
    "en": "apixaban",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a613032.html",
    "clinicalTitle": "Apixaban: MedlinePlus Drug Information",
    "clinicalSha256": "201c9bc91d4bc2beade7197c9371fe8cd8c1a4bf403c34bb464954044fa706dc",
    "clinicalBytes": 32079,
    "cid": 10182969,
    "formula": "C25H25N5O4",
    "iupac": "1-(4-methoxyphenyl)-7-oxo-6-[4-(2-oxopiperidin-1-yl)phenyl]-4,5-dihydropyrazolo[5,4-c]pyridine-3-carboxamide",
    "smiles": "COC1=CC=C(C=C1)N2C3=C(CCN(C3=O)C4=CC=C(C=C4)N5CCCCC5=O)C(=N2)C(=O)N",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/apixaban/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "274ee1b4c343b1b7d3cd450280ce6fd7361f8d7918cb7000b26245e07f5ca7c0",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/10182969/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "093606eed2d6695faf5df34e71e6a96224723bc328f0431bd2cde2f5914a5547",
    "supplementary": []
  },
  {
    "en": "metformin",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a696005.html",
    "clinicalTitle": "Metformin: MedlinePlus Drug Information",
    "clinicalSha256": "de97debf7ceefb475778883ba0dd33a8d3e45439b87b1b2308302e5962f0cee5",
    "clinicalBytes": 34865,
    "cid": 4091,
    "formula": "C4H11N5",
    "iupac": "3-(diaminomethylidene)-1,1-dimethylguanidine",
    "smiles": "CN(C)C(=N)N=C(N)N",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/metformin/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "544fdc3ae0254e265549093997c6acbc6ace745be57ba071467502784569f3b2",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/4091/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "5b4098517c84ec9a6351eb511bd12d4f8be566e9e395b0ba16c5d9004e90119b",
    "supplementary": []
  },
  {
    "en": "empagliflozin",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a614043.html",
    "clinicalTitle": "Empagliflozin: MedlinePlus Drug Information",
    "clinicalSha256": "f15e03dc677a1fb1f499fe1a8603348cd290ae60a8eb4b26bcc4c299e24e0625",
    "clinicalBytes": 32962,
    "cid": 11949646,
    "formula": "C23H27ClO7",
    "iupac": "(2S,3R,4R,5S,6R)-2-[4-chloro-3-[[4-[(3S)-oxolan-3-yl]oxyphenyl]methyl]phenyl]-6-(hydroxymethyl)oxane-3,4,5-triol",
    "smiles": "C1COCC1OC2=CC=C(C=C2)CC3=C(C=CC(=C3)C4C(C(C(C(O4)CO)O)O)O)Cl",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/empagliflozin/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "5c74ab8a19a13e23eb5f95c4cd2b24d967797c46f7aa925dd7789106f4d3e9f4",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/11949646/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "d537054ef56a9340fdd86d8155d6d87d615acf4e317e2120d06b1d333a277b88",
    "supplementary": []
  },
  {
    "en": "dapagliflozin",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a614015.html",
    "clinicalTitle": "Dapagliflozin: MedlinePlus Drug Information",
    "clinicalSha256": "e183181d18e9f18803a2366e7bd120a02df5b1cc2e126a2d39ab67c861676e43",
    "clinicalBytes": 31465,
    "cid": 9887712,
    "formula": "C21H25ClO6",
    "iupac": "(2S,3R,4R,5S,6R)-2-[4-chloro-3-[(4-ethoxyphenyl)methyl]phenyl]-6-(hydroxymethyl)oxane-3,4,5-triol",
    "smiles": "CCOC1=CC=C(C=C1)CC2=C(C=CC(=C2)C3C(C(C(C(O3)CO)O)O)O)Cl",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/dapagliflozin/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "4b8d143a314ee1843fdec1bf241e4431423a2aa339cf0dcba8c8ec25c2ef2613",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/9887712/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "a88b868bc42578ff0214c0f475276f39f86f97d0afd5d1f49572ed66c0aed88a",
    "supplementary": []
  },
  {
    "en": "sitagliptin",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a606023.html",
    "clinicalTitle": "Sitagliptin: MedlinePlus Drug Information",
    "clinicalSha256": "ffc4bed2f86edf0c0145f1e410fef1ca6711364056fbdc58dac7d50c7a7710c6",
    "clinicalBytes": 29976,
    "cid": 4369359,
    "formula": "C16H15F6N5O",
    "iupac": "(3R)-3-amino-1-[3-(trifluoromethyl)-6,8-dihydro-5H-[1,2,4]triazolo[4,3-a]pyrazin-7-yl]-4-(2,4,5-trifluorophenyl)butan-1-one",
    "smiles": "C1CN2C(=NN=C2C(F)(F)F)CN1C(=O)CC(CC3=CC(=C(C=C3F)F)F)N",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/sitagliptin/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "5962aacc50f0adba8d889c62410844fbb0d510993ec9e3e15d1975f18c63df33",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/4369359/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "64a5105b7ebb2da9b3f89ea64d9beb635ec19f525da617d9a297ae0b126b327f",
    "supplementary": []
  },
  {
    "en": "gliclazide",
    "clinicalUrl": "https://www.nhs.uk/medicines/gliclazide/",
    "clinicalTitle": "Gliclazide: medicine for type 2 diabetes - NHS",
    "clinicalSha256": "7caf801cb3b5a7a8e46e59f59e353878c67908ce5ab6c46c6fde51efde373ebe",
    "clinicalBytes": 41482,
    "cid": 3475,
    "formula": "C15H21N3O3S",
    "iupac": "1-(3,3a,4,5,6,6a-hexahydro-1H-cyclopenta[c]pyrrol-2-yl)-3-(4-methylphenyl)sulfonylurea",
    "smiles": "CC1=CC=C(C=C1)S(=O)(=O)NC(=O)NN2CC3CCCC3C2",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/gliclazide/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "24e17d3d6b52bd3e42fc308d2e9322fe5f099a474985879171a4fbe1e6df244f",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/3475/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "171778f04b978031decf4d7a8e2e13046c077ba8cf7eee5d32dd32fc67c33605",
    "supplementary": []
  },
  {
    "en": "levothyroxine",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a682461.html",
    "clinicalTitle": "Levothyroxine: MedlinePlus Drug Information",
    "clinicalSha256": "9bb67cd0db8faac1e82f2e5e0cdd81000e17a9f07ea36e5c3abf802c6f9accbc",
    "clinicalBytes": 32032,
    "cid": 5819,
    "formula": "C15H11I4NO4",
    "iupac": "(2S)-2-amino-3-[4-(4-hydroxy-3,5-diiodophenoxy)-3,5-diiodophenyl]propanoic acid",
    "smiles": "C1=C(C=C(C(=C1I)OC2=CC(=C(C(=C2)I)O)I)I)CC(C(=O)O)N",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/levothyroxine/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "4ae4b2dfc231e08937fe77438a4ae38c0ce81f04943ea452a098b4efcfd2ec48",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/5819/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "9e6da6b4bc3467509aebdf9b3548e4cccfeb4d9907562be6324b7ebfd88ff969",
    "supplementary": []
  },
  {
    "en": "albuterol",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a682145.html",
    "clinicalTitle": "Albuterol Oral Inhalation: MedlinePlus Drug Information",
    "clinicalSha256": "42b10b31bf290c10e1d04280ac62edac980df695ab1d6f0f2587f683eca325df",
    "clinicalBytes": 37112,
    "cid": 2083,
    "formula": "C13H21NO3",
    "iupac": "4-[2-(tert-butylamino)-1-hydroxyethyl]-2-(hydroxymethyl)phenol",
    "smiles": "CC(C)(C)NCC(C1=CC(=C(C=C1)O)CO)O",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/albuterol/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "0098c3064b4a15a357209b14828393efc7fab130f7318505457d7e95d1c9ad13",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/2083/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "e1e434fc86f1d04793a953883665dfa663fd6566b3fd77939f7e75eda837c585",
    "supplementary": []
  },
  {
    "en": "budesonide",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a699056.html",
    "clinicalTitle": "Budesonide Oral Inhalation: MedlinePlus Drug Information",
    "clinicalSha256": "564dd04a0ca65b89d4223581b59439f3e2f28e29ad8bee04601afb2c98521c74",
    "clinicalBytes": 36327,
    "cid": 5281004,
    "formula": "C25H34O6",
    "iupac": "(1S,2S,4R,8S,9S,11S,12S,13R)-11-hydroxy-8-(2-hydroxyacetyl)-9,13-dimethyl-6-propyl-5,7-dioxapentacyclo[10.8.0.02,9.04,8.013,18]icosa-14,17-dien-16-one",
    "smiles": "CCCC1OC2CC3C4CCC5=CC(=O)C=CC5(C4C(CC3(C2(O1)C(=O)CO)C)O)C",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/budesonide/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "676dbccd697cc9e16ab5801e6df517a9fc2403641e5ead12ca90a1bb37bcc5ac",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/5281004/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "dfe0fe705f1b3d9c470820840e274179e5b59624c6e689efc8386c9125c495de",
    "supplementary": [
      {
        "label": "NIH MedlinePlus：布地奈德口服制剂",
        "url": "https://medlineplus.gov/druginfo/meds/a608007.html",
        "sha256": "45990e57208776b0b6de221ea56906a6839039817d614dbab414fdf0196c8e21"
      },
      {
        "label": "NIH MedlinePlus：布地奈德鼻喷剂",
        "url": "https://medlineplus.gov/druginfo/meds/a601030.html",
        "sha256": "77ebd5299d9e2303ca4a5a6041a19d57ae8fd5c5d4a8cf5e0b1733e48bf47980"
      }
    ]
  },
  {
    "en": "fluticasone propionate",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a601056.html",
    "clinicalTitle": "Fluticasone Oral Inhalation: MedlinePlus Drug Information",
    "clinicalSha256": "7e8d30edcb131a69efe3a4eba082114891c704d9c259169d9bc1c9a77d8aef53",
    "clinicalBytes": 32313,
    "cid": 444036,
    "formula": "C25H31F3O5S",
    "iupac": "[(6S,8S,9R,10S,11S,13S,14S,16R,17R)-6,9-difluoro-17-(fluoromethylsulfanylcarbonyl)-11-hydroxy-10,13,16-trimethyl-3-oxo-6,7,8,11,12,14,15,16-octahydrocyclopenta[a]phenanthren-17-yl] propanoate",
    "smiles": "CCC(=O)OC1(C(CC2C1(CC(C3(C2CC(C4=CC(=O)C=CC43C)F)F)O)C)C)C(=O)SCF",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/fluticasone%20propionate/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "5fb8e8d9c9507a0585f52181fcdcb87995b9cd6b8fc2869b81727b14fa698799",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/444036/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "3372a1172bc3bb94cbded8d076c9844dd4d3b70e5808bf0cbd5562540c12ccfb",
    "supplementary": [
      {
        "label": "NIH MedlinePlus：氟替卡松鼻喷剂（核对具体酯型）",
        "url": "https://medlineplus.gov/druginfo/meds/a695002.html",
        "sha256": "7f9b79c07b473c8978056be14db3be3570c9d1537e23d044d54b10673ce4d27f"
      }
    ]
  },
  {
    "en": "clotrimazole",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a618059.html",
    "clinicalTitle": "Clotrimazole Topical: MedlinePlus Drug Information",
    "clinicalSha256": "a2ac787e6579ae3d3241ea569bb2c8a05963023d98b7d43d0f3eadf47f8ab038",
    "clinicalBytes": 27934,
    "cid": 2812,
    "formula": "C22H17ClN2",
    "iupac": "1-[(2-chlorophenyl)-diphenylmethyl]imidazole",
    "smiles": "C1=CC=C(C=C1)C(C2=CC=CC=C2)(C3=CC=CC=C3Cl)N4C=CN=C4",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/clotrimazole/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "07d13caca7999b32a683ab259860f51095c4bd448b46e3d73b2141f2a5f6a68d",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/2812/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "91711a5103d21419f31339d006f3b65112861459cf45ac08a63a9c27d6d5f858",
    "supplementary": [
      {
        "label": "NIH MedlinePlus：克霉唑口腔含片",
        "url": "https://medlineplus.gov/druginfo/meds/a618058.html",
        "sha256": "bcf3268aaaa73e30ce82fa36318d0a2d82806bbb83391c788b22a88ba85294a6"
      },
      {
        "label": "NIH DailyMed：他克莫司美国标签（克霉唑抑制CYP3A相关相互作用）",
        "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=ca08d4aa-3de2-4a9d-9554-6288e5d36f29",
        "sha256": "95041678eb72f1a3b022cda78189b99c35fe66708f991dbe289274a91ff4b75f"
      }
    ]
  },
  {
    "en": "mupirocin",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a688004.html",
    "clinicalTitle": "Mupirocin topical: MedlinePlus Drug Information",
    "clinicalSha256": "93a4e3208055818bf451dcc0885d839d33425cba33cf9b13a3214257ec7def89",
    "clinicalBytes": 23402,
    "cid": 446596,
    "formula": "C26H44O9",
    "iupac": "9-[(E)-4-[(2S,3R,4R,5S)-3,4-dihydroxy-5-[[(2S,3S)-3-[(2S,3S)-3-hydroxybutan-2-yl]oxiran-2-yl]methyl]oxan-2-yl]-3-methylbut-2-enoyl]oxynonanoic acid",
    "smiles": "CC(C1C(O1)CC2COC(C(C2O)O)CC(=CC(=O)OCCCCCCCCC(=O)O)C)C(C)O",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/mupirocin/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "e48664ef0cc5400cc7e55705729ec553a4e653bd46ea926ea80457084af6685f",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/446596/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "38be635a99d3e1e09d24cf062cf7e2e53a1cbabfb4107c623b68ce0b4fc0c607",
    "supplementary": []
  },
  {
    "en": "adapalene",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a604001.html",
    "clinicalTitle": "Adapalene: MedlinePlus Drug Information",
    "clinicalSha256": "d8601818a19613d1b613a3ca882bc0b3ccb257527475c0fdeffbfd1f66cb39e6",
    "clinicalBytes": 30327,
    "cid": 60164,
    "formula": "C28H28O3",
    "iupac": "6-[3-(1-adamantyl)-4-methoxyphenyl]naphthalene-2-carboxylic acid",
    "smiles": "COC1=C(C=C(C=C1)C2=CC3=C(C=C2)C=C(C=C3)C(=O)O)C45CC6CC(C4)CC(C6)C5",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/adapalene/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "3b004f88a609c8ac17d56eec2ff20fcc733b3803d110ff96ad4c5c35eb938993",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/60164/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "6fd0a8ea099ac357c0f3e67217260a436a0ee5ab2507ef8b06a1cb058185944f",
    "supplementary": []
  },
  {
    "en": "hydrocortisone",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a682793.html",
    "clinicalTitle": "Hydrocortisone Topical: MedlinePlus Drug Information",
    "clinicalSha256": "1728380354dfe01fd892388a7a500d5c71b911cef5e20dfd3a42afb23f1ce985",
    "clinicalBytes": 29068,
    "cid": 5754,
    "formula": "C21H30O5",
    "iupac": "(8S,9S,10R,11S,13S,14S,17R)-11,17-dihydroxy-17-(2-hydroxyacetyl)-10,13-dimethyl-2,6,7,8,9,11,12,14,15,16-decahydro-1H-cyclopenta[a]phenanthren-3-one",
    "smiles": "CC12CCC(=O)C=C1CCC3C2C(CC4(C3CCC4(C(=O)CO)O)C)O",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/hydrocortisone/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "3574e90ce135d73a5f14f2ef05cf282c14288eb71783e4afb1d6343a3370b487",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/5754/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "01655f7cb7c7d43b53faff64c2d1600d1d64febb550c2286259f58c0b899a137",
    "supplementary": []
  },
  {
    "en": "sertraline",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a697048.html",
    "clinicalTitle": "Sertraline: MedlinePlus Drug Information",
    "clinicalSha256": "3d563b51562485b035e63a025750e584f0c18cbc833d09967c9907d5e146b0e0",
    "clinicalBytes": 32583,
    "cid": 68617,
    "formula": "C17H17Cl2N",
    "iupac": "(1S,4S)-4-(3,4-dichlorophenyl)-N-methyl-1,2,3,4-tetrahydronaphthalen-1-amine",
    "smiles": "CNC1CCC(C2=CC=CC=C12)C3=CC(=C(C=C3)Cl)Cl",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/sertraline/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "1d1bb09273fcae03cd6ac3405f9e377784d7651bd8104a90a0a906a9d18d251f",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/68617/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "b084c67994b7992ad5ddf0f8e332fd329ae04d263b173e11c8ec8e5d643db6f2",
    "supplementary": []
  },
  {
    "en": "melatonin",
    "clinicalUrl": "https://www.nhs.uk/medicines/melatonin/",
    "clinicalTitle": "Melatonin: a hormone used for sleep problems - NHS",
    "clinicalSha256": "2bd5f73bcfc71d9d76f71f42743dfbbdabe0ac651da337ad8d60f356875adf37",
    "clinicalBytes": 40682,
    "cid": 896,
    "formula": "C13H16N2O2",
    "iupac": "N-[2-(5-methoxy-1H-indol-3-yl)ethyl]acetamide",
    "smiles": "CC(=O)NCCC1=CNC2=C1C=C(C=C2)OC",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/melatonin/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "7e2373ae2ff45ce11f3815d4392e012e4972742a32cb8d93131c05a8c552b97e",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/896/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "26f456532c73913f5364e48bc698e2c9e96201704e7bfe096df5917e2df0af1e",
    "supplementary": [
      {
        "label": "NHS：褪黑素的用途",
        "url": "https://www.nhs.uk/medicines/melatonin/about-melatonin/",
        "sha256": "fca5ec6a660d5978320bfa3cb105989420bce27cfaa2d9bd43449f1b5c3e20b3"
      },
      {
        "label": "NHS：褪黑素相互作用",
        "url": "https://www.nhs.uk/medicines/melatonin/taking-melatonin-with-other-medicines-and-herbal-supplements/",
        "sha256": "f5da52e8f937e413b74106c76daf397a424a18c3df814daf210ca5a638b237a6"
      },
      {
        "label": "NHS：褪黑素副作用",
        "url": "https://www.nhs.uk/medicines/melatonin/side-effects-of-melatonin/",
        "sha256": "3b43304c1237ee8baa58b263e9cfa601c8e77ff7b223233eccc0c9931ff0574e"
      }
    ]
  },
  {
    "en": "lidocaine",
    "clinicalUrl": "https://medlineplus.gov/druginfo/meds/a625061.html",
    "clinicalTitle": "Lidocaine Injection (local anesthetic): MedlinePlus Drug Information",
    "clinicalSha256": "68b2bd74f70296da0cff9dd2877728041c33966b80c378083cfa62119b1a41c0",
    "clinicalBytes": 23464,
    "cid": 3676,
    "formula": "C14H22N2O",
    "iupac": "2-(diethylamino)-N-(2,6-dimethylphenyl)acetamide",
    "smiles": "CCN(CC)CC(=O)NC1=C(C=CC=C1C)C",
    "pubchemApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/lidocaine/property/MolecularFormula,IUPACName,CanonicalSMILES/JSON",
    "pubchemSha256": "c3611c2e4bba7d2239f1439e25fb577628b82018fad907cd0ef331a5ecb37e0b",
    "verifiedAt": "2026-10-22",
    "mechanismApi": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/3676/JSON?heading=Mechanism%20of%20Action",
    "mechanismSha256": "3c8c317b43a26c291fe05bd48a1eb337d29b63ef8e7223cb2e008899d7ca22a3",
    "supplementary": [
      {
        "label": "NIH MedlinePlus：利多卡因抗心律失常注射剂",
        "url": "https://medlineplus.gov/druginfo/meds/a625037.html",
        "sha256": "805a1df4ab73d1ce5c38efbd294947c9dd0eaf9d0cb61b3298b73ecb4392a14f"
      },
      {
        "label": "NIH MedlinePlus：利多卡因透皮贴剂",
        "url": "https://medlineplus.gov/druginfo/meds/a603026.html",
        "sha256": "e61e37d16b8a2505c3f3c55a8593fc563ee7213bd475762ee6cf31b975c0aa54"
      }
    ]
  }
];
