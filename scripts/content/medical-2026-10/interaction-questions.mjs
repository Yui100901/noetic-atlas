/** Independently authored factual questions. Traditional terminology does not
 * replace clinical interaction evidence; no dose or self-treatment procedure. */
const source = (label, url) => ({ label, url });
const refs = {
  digest: source('NIH NCCIH：Herb-Drug Interactions（2024-12）', 'https://www.nccih.nih.gov/health/providers/digest/herb-drug-interactions'),
  science: source('NIH NCCIH：Herb-Drug Interactions—What the Science Says', 'https://www.nccih.nih.gov/health/providers/digest/herb-drug-interactions-science'),
  ginseng: source('NIH NCCIH：Asian Ginseng', 'https://www.nccih.nih.gov/health/asian-ginseng'),
  ginkgo: source('NIH NCCIH：Ginkgo', 'https://www.nccih.nih.gov/health/ginkgo'),
  licorice: source('NIH NCCIH：Licorice Root', 'https://www.nccih.nih.gov/health/licorice-root'),
  wort: source('NIH NCCIH：St. John’s Wort', 'https://www.nccih.nih.gov/health/st-johns-wort'),
  tea: source('NIH NCCIH：Green Tea', 'https://www.nccih.nih.gov/health/green-tea'),
  goldenseal: source('NIH NCCIH：Goldenseal', 'https://www.nccih.nih.gov/health/goldenseal'),
  tips: source('NIH NCCIH：How Herbs Can Interact With Medicines', 'https://www.nccih.nih.gov/health/tips/tips-how-herbs-can-interact-with-medicines'),
  cmro: source('香港卫生署中医药规管办公室：中药不良反应', 'https://www.cmro.gov.hk/html/eng/useful_information/public_health/pamphlet/Adverse_Reactions_of_CM.html'),
  glp: source('英国MHRA：GLP-1 medicines，2026-02-05更新', 'https://www.gov.uk/government/publications/glp-1-medicines-for-weight-loss-and-diabetes-what-you-need-to-know/glp-1-medicines-for-weight-loss-and-diabetes-what-you-need-to-know'),
  allopurinol: source('NHS：Allopurinol，2026-09复核', 'https://www.nhs.uk/medicines/allopurinol/'),
  isotretinoin: source('NHS：Isotretinoin，2026-06复核', 'https://www.nhs.uk/medicines/isotretinoin-roaccutane/'),
  methotrexate: source('NHS：Methotrexate与其他药物及草药', 'https://www.nhs.uk/medicines/methotrexate/taking-methotrexate-with-other-medicines-and-herbal-supplements/'),
};
const options = values => values.map((text, index) => ({ key: String.fromCharCode(65 + index), text }));
const single = (key, stem, values, correct, answer, explanation, sources, difficulty = 2) => ({ key, type: 'single_choice', stem, options: options(values), correctAnswers: [correct], answer, explanation, sources, difficulty });
const multi = (key, stem, values, correctAnswers, answer, explanation, sources, difficulty = 2) => ({ key, type: 'multiple_choice', stem, options: options(values), correctAnswers, answer, explanation, sources, difficulty });
const judge = (key, stem, correct, explanation, sources, difficulty = 2) => ({ key, type: 'true_false', stem, correctAnswers: [String(correct)], answer: correct ? '正确。' : '错误。', explanation, sources, difficulty });

export const interactionQuestions = [
  single('wort-enzyme', '贯叶连翘（圣约翰草）造成多种药物相互作用的重要机制是什么？', ['诱导部分药物代谢酶与肠道P-糖蛋白', '使所有药物都不能通过肾脏排泄', '仅凭与药物颜色相反产生作用', '只在同一杯中混合才可能有作用'], 'A', 'A。可诱导细胞色素P450相关酶与P-糖蛋白。', '这可降低部分合用药的暴露和疗效。B把作用绝对化；C没有药理依据；D忽略持续的代谢与转运影响。并非每种药都以相同程度受影响。', [refs.science], 3),
  judge('wort-cyclosporine', '圣约翰草可能削弱环孢素的作用，因此移植用药评估不能忽略草药补充剂。', true, 'NCCIH将环孢素列为有临床重要相互作用的例子。免疫抑制不足可能造成严重后果，不能将天然制品当作没有药理作用的食品。', [refs.wort]),
  single('wort-serotonin', '圣约翰草与部分增强血清素作用的抗抑郁药合用，特别需要关注哪类风险？', ['血清素相关严重不良反应', '所有抗抑郁药作用必然完全消失', '必然治愈原有抑郁障碍', '只可能改变药片外观'], 'A', 'A。可能增加血清素相关不良反应。', '这属于效应叠加等因素导致的风险，不能只考虑药物浓度下降。B和C均是没有依据的绝对结论，D与所问药理风险无关。', [refs.wort]),
  multi('wort-relevant-medicines', 'NCCIH列出的可能受圣约翰草影响、需要核查的药物包括哪些？', ['口服避孕药', '环孢素', '地高辛', '上述任何药物都不可能受影响'], ['A', 'B', 'C'], 'A、B、C。', 'A可能涉及避孕作用降低，B涉及移植相关免疫抑制，C涉及心脏用药效果。D错误。各药作用途径与风险不同，不能据同一草药推定同一种处理方法。', [refs.wort]),
  single('ginseng-warfarin-evidence', '如何准确描述亚洲人参与华法林相互作用的研究结论？', ['现有研究存在不一致，不能说总是同方向改变抗凝作用', '已经证明每个人的抗凝作用都一定增强', '已经证明每个人的抗凝作用都一定减弱', '天然来源足以证明绝无相互作用'], 'A', 'A。研究结果混合，仍需具体评估。', 'NCCIH明确指出研究结果不一致。B、C把不确定证据变成普遍规律；D把来源误当安全证明。人参品种、制剂及合用情境也不能混为一谈。', [refs.digest], 3),
  judge('ginseng-glucose', '人参可能影响血糖，因此评估降糖药相关风险时，应记录患者是否同时使用人参制品。', true, '部分证据提示亚洲人参可能降低血糖，但其用于糖尿病控制的总体证据并不一致。这支持核查合用风险，不支持以人参自行替换已验证治疗。', [refs.ginseng]),
  single('ginkgo-warfarin', '银杏制剂与华法林合用时，哪项风险最值得核查？', ['出血风险可能增加', '所有凝血检验都必然完全正常', '天然植物可以直接中和华法林', '只会改变片剂吸湿性'], 'A', 'A。出血风险可能增加。', 'NCCIH提示银杏可能增加服用抗凝药者的出血风险。这是风险判断，不能据此预测每个人必然发生出血。其余选项忽略药理效应或没有依据。', [refs.ginkgo]),
  judge('ginkgo-seed-leaf', '银杏种子与标准化银杏叶提取物可以仅凭植物名称相同就视为相同安全性的产品。', false, '使用部位与加工组成不同。NCCIH指出生银杏种子有毒，熟种子或粗植物材料也曾造成严重不良反应；叶提取物的研究不能自动外推给种子。', [refs.ginkgo]),
  judge('ginkgo-dementia', '银杏已经被可靠证明能普遍预防痴呆，因此可以省略对其相互作用的评估。', false, 'NCCIH认为并无确凿证据表明银杏可预防痴呆或减缓其进展。所谓预防效果不能作为忽视出血等合用风险的理由。', [refs.ginkgo]),
  single('licorice-component', '甘草制品中哪种成分与较大或长期暴露时的严重心律风险有关？', ['甘草酸／甘草甜素（glycyrrhizin）', '处方名称的字数', '包装上的绿色图案', '只与药材价格有关'], 'A', 'A。甘草酸相关成分。', 'NCCIH指出甘草酸可造成严重不良效应，包括心律异常；风险与暴露及个体情况有关。名称、包装和价格不解释这一药理风险。', [refs.licorice]),
  judge('licorice-corticosteroid', '甘草与糖皮质激素之间已有相互作用报告，不能把“调和诸药”的传统描述当作普遍安全保证。', true, 'NCCIH列有甘草与皮质类固醇相互作用的报告。传统性能描述与现代合用风险评估的证据框架不同，不能把传统表述扩展成可任意配伍的结论。', [refs.licorice]),
  multi('licorice-risk-contexts', '在甘草酸相关风险评估中，NCCIH特别提示关注哪些情况？', ['原有高血压', '心脏疾病', '肾脏疾病', '天然原料可以让上述情况全部失去意义'], ['A', 'B', 'C'], 'A、B、C。', '这些情况可使甘草酸暴露更值得警惕，高盐摄入也属于提示因素。D错误，原料天然不能消除心律和其他严重风险。', [refs.licorice]),
  single('tea-extract-beverage', '对绿茶饮用与高浓缩绿茶提取物，哪项比较更准确？', ['提取物的组成及暴露可明显不同，不能直接套用日常饮茶的安全印象', '凡称绿茶就有完全相同浓度', '胶囊形式必然没有肝损伤风险', '不含处方药成分就不会相互作用'], 'A', 'A。应区分饮品与浓缩提取物。', 'NCCIH记录的肝损伤主要涉及某些片剂或胶囊提取物，也提示合用药风险。B忽略组成，C、D是错误的绝对安全断言。', [refs.tea]),
  single('tea-nadolol', '现有研究提示，较高暴露的绿茶与纳多洛尔合用可能产生哪种变化？', ['纳多洛尔血药水平及疗效降低', '保证将所有β受体阻断药药效提高一倍', '消除所有血压相关风险', '只让口服药变成外用药'], 'A', 'A。可能降低纳多洛尔水平及疗效。', '这是NCCIH列举的特定相互作用例子。不能外推为所有绿茶产品、所有暴露或全部β受体阻断药都有同样程度效应。', [refs.tea]),
  single('goldenseal-metformin', 'NCCIH资助的健康成人研究中，白毛茛（goldenseal）提取物与二甲双胍合用时观察到什么？', ['二甲双胍水平下降，提示可能影响降糖控制', '已经证明任何糖尿病患者都一定发生同样变化', '已经证明可以用该草药替代二甲双胍', '证明所有草药都会增加二甲双胍浓度'], 'A', 'A。观察到二甲双胍水平下降。', '该研究提供值得关注的合用信号，但健康受试者结果不能等同每位患者的确定结局。B、C、D均超出了证据支持的范围。', [refs.goldenseal], 3),
  judge('goldenseal-berberine-extrapolation', '仅凭白毛茛含小檗碱，就可以把纯小檗碱研究中的疗效和风险原样套用于整株提取物。', false, '成分存在不等于暴露和制剂一致。NCCIH指出口服白毛茛时小檗碱吸收有限，因此纯成分研究结果未必适用于这种草药制品。', [refs.goldenseal]),
  multi('narrow-therapeutic-index', '哪些药物属于NCCIH提示需特别认真核查草药合用的窄治疗窗例子？', ['地高辛', '华法林', '环孢素', '所有药物的治疗窗都完全相同'], ['A', 'B', 'C'], 'A、B、C。', '这些药物的暴露或效应发生较小变化时也可能产生明显后果。D错误，治疗窗和监测要求因药物而异。核查清单应包含草药、维生素和补充剂。', [refs.tips]),
  judge('uncertain-is-proven', '某份草药相互作用清单列出了体外实验推测的药对，就说明这些药对都已在人体中证实存在严重临床风险。', false, 'NCCIH指出许多相互作用仍来自体外、动物或间接证据。证据提示值得研究或监测，不等于严重人体结局已得到证明；但证据不足也不能反向证明绝对安全。', [refs.digest], 3),
  judge('shared-name-substitution', '两种中药材俗名相同，就可以不鉴别基原而直接替代使用。', false, '同名异物和异名同物均可造成混淆。香港中医药规管办公室以防己等作为误用品种的例子，说明俗名相同并不能保证来源、组成或风险相同。', [refs.cmro]),
  multi('quality-identity-risks', '中药不良反应评估为什么不能只看药材名？', ['可能存在同名误用或基原混淆', '可能存在掺杂或污染', '制剂中可能混入未声明的现代药物', '价格越贵就可排除以上所有问题'], ['A', 'B', 'C'], 'A、B、C。', '身份鉴别与质量缺陷都可能影响实际暴露。D没有科学依据，价格或传统知名度不能替代质量与来源核查。', [refs.cmro]),
  multi('herbal-adverse-contexts', '香港中医药规管办公室列出的中药不良反应相关因素包括哪些？', ['过敏及个体情况', '长期或过量暴露', '不适当配伍或妊娠相关影响', '只要是复方就不可能有风险'], ['A', 'B', 'C'], 'A、B、C。', '这些是不同来源的风险，不能只用单个药物标签概括。D错误，复方可能产生叠加、配伍或身份判断问题。', [refs.cmro]),
  judge('time-gap-does-not-remove', '把圣约翰草和其他药物错开几个小时服用，就一定能消除由代谢酶诱导造成的相互作用。', false, '代谢酶与转运体的改变可能持续存在，不只发生在胃内同一时刻接触。错开服用不构成消除全部相互作用的保证；具体处理需依据药物和机制。', [refs.science], 3),
  single('allopurinol-immunosuppressant', '以下哪一种药物是NHS在别嘌醇合用注意中明确列举的免疫抑制剂？', ['硫唑嘌呤', '口服补液盐', '凡士林', '生理盐水鼻喷剂'], 'A', 'A。硫唑嘌呤。', '这对药物需重点核查，不能作为互不影响的普通合用看待。其余选项并非该来源所列举的免疫抑制剂。', [refs.allopurinol]),
  multi('isotretinoin-coadministration', 'NHS列出的异维A酸合用注意中，包括哪些产品？', ['维生素A补充剂', '四环素或多西环素等部分抗生素', '其他痤疮治疗制剂', '以上产品均可随意叠加而无需核查'], ['A', 'B', 'C'], 'A、B、C。', '这些产品可能与异维A酸不适当合用，需按具体成分和途径核对。D错误，不能把营养补充剂或外用产品一概视为无合用风险。', [refs.isotretinoin]),
  single('methotrexate-supplement', '已在甲氨蝶呤方案中接受处方叶酸的人又准备添加复合维生素，核查重点是什么？', ['检查是否重复含叶酸，不能把处方辅助方案和任意补充混为一谈', '所有维生素与甲氨蝶呤都绝对没有关系', '复合维生素能替代甲氨蝶呤', '只看补充剂是否宣称天然'], 'A', 'A。核查重复成分及原方案。', 'NHS提醒已有处方叶酸时不要自行增加其他含叶酸产品。处方中安排叶酸并不意味着任何含量或用法的补充剂都可任意叠加。', [refs.methotrexate]),
  single('pharmacokinetic-vs-dynamic', '草药诱导代谢酶而改变合用药浓度，主要属于哪一类相互作用思路？', ['药代动力学相关变化', '只是包装配伍', '仅为药名发音相近', '必然证明发生新的共价化学反应'], 'A', 'A。药代动力学相关变化。', '药物体内暴露会受代谢、转运等过程影响；这与不改变暴露也可能发生的效应叠加应区分。不能把所有相互作用归结为两种药在容器内直接反应。', [refs.science], 3),
  multi('tirzepatide-contraception', '依据MHRA现行GLP-1用药资料，以下哪些说法正确？', ['替尔泊肽可能影响口服避孕药的可靠性，存在专门的避孕提醒', '不能把替尔泊肽的具体提醒原样外推为所有同类药完全一致', '有关建议须结合具体成分、制剂和当前说明', '所有GLP-1相关药物均已被证实孕期安全'], ['A', 'B', 'C'], 'A、B、C。', 'MHRA对替尔泊肽有口服避孕药相关的特别提醒；该类药物不应用于妊娠或准备妊娠等规定情境。具体时间安排按当前官方资料核对。', [refs.glp]),
  judge('glp-brand-indication', '只要药物涉及GLP-1通路，就代表所有品牌、剂型和适应证在各地区都完全相同。', false, 'MHRA区分了具体成分、品牌及获批用途，并提示并非所有这些药都获批用于体重管理。机制归类不能替代具体产品的适应证与安全性资料。', [refs.glp]),
];
