import {trueFalseRows as T,singleChoiceRows as S,fillRows as F,refs} from './existing-builder.mjs';
const perfect=refs('British Council：现在完成时','https://learnenglish.britishcouncil.org/grammar/english-grammar-reference/present-perfect');
const condition=refs('British Council：零类、第一与第二条件句','https://learnenglish.britishcouncil.org/free-resources/grammar/b1-b2/conditionals-zero-first-second');
const passive=refs('British Council：被动语态','https://learnenglish.britishcouncil.org/free-resources/grammar/b1-b2/passives');
export default {key:'english',domainId:'english',title:'英语：时态、条件句与语态基础巩固',groups:{perfect:{name:'完成时与过去时间',sources:perfect},condition:{name:'条件与假设语义',sources:condition},passive:{name:'被动语态与信息焦点',sources:passive}},concepts:[],questions:[
...T('perfect',`
标准英语中，明确结束的过去时间状语通常与一般过去时搭配，而不是直接套用现在完成时。|true|yesterday或特定过去年份把事件放在已结束时段；现在完成时通常从当前视角连接过去与现在。
现在完成时只表示动作仍持续，不能表示截至现在的经历或当前结果。|false|持续、经历和与现在相关的结果都是常见用法，应依上下文判读。
现在完成时基本结构是have或has加过去分词，不能仅把动词原形接在has后。|true|助动词体现主语一致关系，主要动词用过去分词；规则与不规则形式都需区分。
have been to常可表达去过且已返回，have gone to常表示已经去了且尚未返回。|true|这是表达去向和经历的常见区分，具体判断还需语境，不能仅机械套中文“去过”。
for后常接持续时长，since后常接起点；两者不能因中文都含时间就随意互换。|true|持续三年与自某年开始提供的信息不同，时间表达和谓语形式需要协调。
“I have repaired the lamp.”通常可以强调修理完成对当前状态的影响，而不是必须回答确切哪一天。|true|现在完成时可强调当前结果；若叙述具体已结束时间，通常改用一般过去时。
`,perfect),
...S('perfect',`
填入最合适形式：Yesterday, Mina ____ the report before lunch.|finished|has finished|have finished|finishes|Yesterday明确给出已结束的过去时间；此独立叙述用一般过去时，不把当前完成结构直接放入。
填入助动词：The technician ____ checked the sensor, so we can start now.|has|have|is|does|单数主语用has加过去分词；后句说明当前可开始，与完成结果相关。
表示“从2020年起一直到现在”的起点，选哪一词：Leo has worked here ____ 2020.|since|for|during|until|since标起点，for通常标时长，until强调截至某时的终点关系而非这里的起点。
同事目前不在办公室且已去仓库，最合适的是哪一句？|She has gone to the warehouse.|She has been to the warehouse and is here now.|She go to the warehouse.|She going to the warehouse.|gone在此说明已离开且未返回；been通常表达曾去并已返回的经历。
`,perfect),
...F('perfect',`
填入have的正确形式：Our team members ____ completed the safety checklist.|have|复数主语members对应have，后接过去分词completed，team members不是单数team。
填入read的过去分词：I have ____ the short notice twice.|read|read的原形与过去分词拼写相同，语音可不同；此处由have提示需要过去分词形式。
`,perfect),
...T('condition',`
常见第一条件句谈现实可能的将来情形时，if从句通常用一般现在时，主句可用will加原形。|true|这是一种常用结构，不意味着英语中所有含if的句子都禁止任何形式的will。
第二条件句的过去形式通常表达与当前现实的距离或假设性，不必一定指过去时间。|true|形式上的过去不总等于时间过去，要结合would等结构与语义。
零类条件句常用于一般规律或习惯关系，而不专门预测某一次将来的事件。|true|它把条件和结果表达为普遍或反复关系，常见结构是两部分都用一般现在时。
if从句放在句首或句末，条件关系必然变成相反含义。|false|顺序可因信息安排变化，基本条件关系通常不因此反转；标点和语境仍需调整。
`,condition),
...S('condition',`
预测明天可能下雨后的安排，填入：If it rains tomorrow, we ____ indoors.|will practise|practised|had practised|are practised|现实可能的将来条件常以if加现在时、主句will加原形表达，时间由tomorrow与整体结构确定。
表示与目前条件不同的假设：If I had a quieter room, I ____ more easily.|would study|will studied|have study|am studied|第二条件句用过去形式表示假设距离，结果常用would加动词原形。
哪句最符合描述一般规则的零类条件结构？|If the indicator turns red, the machine stops automatically.|If it turned red yesterday, it will stopped.|If the machine stopped, it have stops.|If red the indicator, stopping machine.|条件与结果都用一般现在时，表达设定的一般运行规则，而非某次已经结束事件。
“If I were you, I would ask for clarification.”最贴近哪种含义？|从假设对方处境出发给出建议|我过去确实就是对方|证明双方身份相同|陈述一条机械定律|这是常见假设性建议表达，were在该结构中不表示真实身份转换。
`,condition),
...F('condition',`
填入will后的动词原形：If the file arrives tonight, I will ____ it tomorrow.（检查：check）|check|情态助动词will后用原形，不加第三人称-s或过去式后缀。
在“If the alarm rings, we leave the room.”中，条件从句由____引导。|if|此句以if引导条件，两个一般现在时形式可表达规定或习惯性应对关系。
`,condition),
...T('passive',`
英语被动语态常用be的适当形式加过去分词，时态通常体现在助动词结构中。|true|过去分词本身不负责表达全部时态信息，is checked与was checked的时间不同。
使用被动语态时，每一句都必须写出by加动作执行者。|false|执行者未知、不重要或语境明确时常可省略，选择与信息焦点有关。
把主动句改成被动句时，应保留原有时间关系，而不总是把谓语改为一般过去时。|true|时态和语态是不同维度，进行、完成和情态等结构也可与被动结合。
被动语态能够改变句子的信息焦点，但不能单凭语态断定事实真假或责任是否不存在。|true|形式安排与证据、责任判断不同，写作中还需保留必要的执行者信息。
`,passive),
...S('passive',`
“The team checks the valves daily.”的常见被动表达是哪句？|The valves are checked daily.|The valves is checked daily.|The valves checked daily by be.|The valves have check daily.|复数主语valves配are，checked为过去分词；daily保持日常重复语义。
选出表示过去已完成动作的被动句：The damaged panel ____ yesterday.|was replaced|is replace|has replacing|replaces|yesterday对应一般过去时间，单数主语用was加过去分词。
将要求表达为被动：The identity document must ____ before entry.|be checked|checked|be check|checking|情态动词后用be原形加过去分词构成被动，不能省略be或使用原形check。
报告需要突出实验样品而执行者并不重要，哪种表达更自然地达到这一焦点？|The samples were stored at a stable temperature.|Someone samples stable stored.|The samples was store.|The temperature were samples.|被动以samples为主语，复数对应were，执行者可在语境允许时省略。
`,passive)]};
