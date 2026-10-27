/** Original teaching layouts; music glyph outlines use licensed Bravura/SMuFL.
 * SVGs contain paths rather than font-dependent PUA text. Exported PNGs work
 * with the existing offline asset, sharing and PDF pipelines. */
const escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const codes={g:0xe050,f:0xe062,c:0xe05c,whole:0xe1d2,half:0xe1d3,quarter:0xe1d5,eighth:0xe1d7,sixteenth:0xe1d9,head:0xe0a4,sharp:0xe262,flat:0xe260,natural:0xe261,doubleSharp:0xe263,doubleFlat:0xe264,restWhole:0xe4e3,restHalf:0xe4e4,restQuarter:0xe4e5,restEighth:0xe4e6,restSixteenth:0xe4e7,fermata:0xe4c0,p:0xe520,fDynamic:0xe522,mp:0xe52c,mf:0xe52d,ff:0xe52f};
export function makeMusicDiagrams(font,labelFont){
 const symbol=(name,x,y,size=64)=>{const glyph=font.glyphForCodePoint(codes[name]);if(!glyph||glyph.id===0||!glyph.path.toSVG())throw Error('Music glyph missing: '+name);return `<path d="${glyph.path.toSVG()}" transform="translate(${x} ${y}) scale(${size/font.unitsPerEm} ${-size/font.unitsPerEm})" fill="#17252b"/>`;};
 const fit=(name,x,y,w=80,h=100)=>{const b=font.glyphForCodePoint(codes[name]).bbox,s=Math.min(w/(b.maxX-b.minX),h/(b.maxY-b.minY));return symbol(name,x+(w-(b.maxX-b.minX)*s)/2-b.minX*s,y+(h-(b.maxY-b.minY)*s)/2+b.maxY*s,s*font.unitsPerEm);};
 const text=(x,y,value,size=15,anchor='middle')=>{const run=labelFont.layout(String(value)),scale=size/labelFont.unitsPerEm,width=run.positions.reduce((n,p)=>n+p.xAdvance,0)*scale;let at=x-(anchor==='middle'?width/2:anchor==='end'?width:0);return '<g fill="#344951">'+run.glyphs.map((g,i)=>{const p=run.positions[i],path=`<path d="${g.path.toSVG()}" transform="translate(${at+p.xOffset*scale} ${y-p.yOffset*scale}) scale(${scale} ${-scale})"/>`;at+=p.xAdvance*scale;return path;}).join('')+'</g>';};
 const line=(x1,y1,x2,y2,width=1.4,color='#81939b')=>`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}"/>`;
 const staff=(x=35,top=65,w=410,gap=16)=>Array.from({length:5},(_,i)=>line(x,top+i*gap,x+w,top+i*gap)).join('');
 const dot=(x,y,r=3)=>`<circle cx="${x}" cy="${y}" r="${r}" fill="#17252b"/>`;
 const note=(x,y,name='quarter')=>symbol(name,x,y,64);
 const arc=(x1,y1,x2,y2,bend=30)=>`<path d="M${x1},${y1} C${x1+20},${y1+bend} ${x2-20},${y2+bend} ${x2},${y2}" fill="none" stroke="#17252b" stroke-width="2.5"/>`;
 const frame=(body,h=190)=>`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="${h}" viewBox="0 0 480 ${h}"><rect x="0.75" y="0.75" width="478.5" height="${h-1.5}" rx="12" fill="#fff" stroke="#d6e1e5"/>${body}</svg>`;
 const out=[];const add=(key,alt,body,height)=>out.push({key,alt,width:480,height:height||190,svg:frame(body,height)});
 for(const [key,name,alt]of [['g-symbol','g','G谱号'],['f-symbol','f','F谱号'],['c-symbol','c','C谱号'],['whole','whole','全音符'],['half','half','二分音符'],['quarter','quarter','四分音符'],['eighth','eighth','八分音符'],['sixteenth','sixteenth','十六分音符'],['sharp','sharp','升号'],['flat','flat','降号'],['natural','natural','还原号'],['double-sharp','doubleSharp','重升号'],['double-flat','doubleFlat','重降号'],['fermata','fermata','延长记号']])add(key,alt+'符号示意',fit(name,200,30,80,115));
 add('staff','五线谱的五条线和四个间示意',staff()+Array.from({length:5},(_,i)=>text(22,133-i*16,String(i+1),12)).join('')+text(240,166,'线从下向上数；线与线之间是“间”'));
 for(const [key,name,y,pitch]of [['treble','g',113,'G4 · 第二线'],['bass','f',81,'F3 · 第四线'],['alto','c',97,'C4 · 第三线'],['tenor','c',81,'C4 · 第四线']])add(key,'谱号及其基准线示意',staff()+symbol(name,65,y,64)+line(145,y,415,y,2,'#bd4153')+text(280,163,pitch));
 add('clefs','常见G谱号、F谱号和C谱号',fit('g',50,20,65,110)+fit('f',210,20,65,110)+fit('c',365,20,65,110)+text(82,161,'G谱号')+text(242,161,'F谱号')+text(397,161,'C谱号'));
 add('grand','高低音谱表与中央C位置',staff(60,35,380,13)+staff(60,113,380,13)+symbol('g',78,74,52)+symbol('f',78,126,52)+line(60,35,60,165,2)+`<path d="M43 35 Q25 55 43 80 Q53 100 30 100 Q53 100 43 120 Q25 145 43 165" fill="none" stroke="#17252b" stroke-width="3"/>`+symbol('whole',250,100,52)+line(240,100,286,100,2)+text(340,106,'中央C（C4）',14),205);
 add('ledger','高音谱号下加一线的中央C',staff()+symbol('g',65,113,64)+note(250,145)+line(239,145,280,145,2)+text(330,164,'C4 · 下加一线'));
 add('note-parts','八分音符的音头、符干与符尾',note(220,132,'eighth')+line(214,133,133,151)+text(110,156,'音头')+line(236,100,330,99)+text(363,103,'符干')+line(249,85,333,52)+text(366,56,'符尾'));
 add('values','全、二分、四分、八分、十六分音符的相对时值', ['whole','half','quarter','eighth','sixteenth'].map((name,i)=>fit(name,24+i*92,25,65,85)+text(57+i*92,137,['全','二分','四分','八分','十六分'][i])+text(57+i*92,162,['1','1/2','1/4','1/8','1/16'][i],13)).join(''));
 add('rests','全、二分、四分、八分、十六分休止符', ['restWhole','restHalf','restQuarter','restEighth','restSixteenth'].map((name,i)=>{const x=26+i*92;return staff(x,55,62,12)+symbol(name,x+20,name==='restWhole'?67:79,48)+text(x+30,153,['全休止','二分休止','四分休止','八分休止','十六分休止'][i],12);}).join(''));
 add('accidentals','升、降、还原、重升和重降记号', ['sharp','flat','natural','doubleSharp','doubleFlat'].map((name,i)=>fit(name,22+i*92,25,65,95)+text(55+i*92,155,['升','降','还原','重升','重降'][i])).join(''));
 add('dotted','附点四分音符等于三个八分音符',note(75,115)+dot(103,110)+text(155,100,'=',25)+[215,290,365].map(x=>note(x,115,'eighth')).join('')+text(240,165,'原时值 + 原时值的 1/2'));
 add('double-dotted','复附点四分音符的时值比例',note(100,115)+dot(127,110)+dot(140,110)+text(305,100,'1 + 1/2 + 1/4 = 7/4',18)+text(240,162,'两个附点依次增加基本时值的一半、四分之一'));
 add('tie','同音高音符之间的延音线',staff()+symbol('g',55,113,64)+note(180,113)+note(310,113)+arc(188,127,320,127,25)+text(240,170,'同音高：连续发音，时值相加'));
 add('slur','不同音高之间的连音线示例',staff()+symbol('g',55,113,64)+note(180,113)+note(310,97)+arc(188,132,320,116,25)+text(240,170,'不同音高示例：连贯演奏，不合成一个音'));
 add('staccato','音符上方的断奏点',staff()+symbol('g',55,113,64)+note(220,113)+dot(228,45)+text(240,171,'断奏点不改变音符的书面时值'));
 add('repeat','反复起点和终点记号示意',staff()+line(75,65,75,129,5,'#17252b')+line(86,65,86,129,1.8,'#17252b')+dot(99,89)+dot(99,105)+line(390,65,390,129,1.8,'#17252b')+line(402,65,402,129,5,'#17252b')+dot(378,89)+dot(378,105)+text(240,168,'反复演奏两组记号之间的材料'));
 add('bars','小节线、双小节线和终止线',staff()+line(130,65,130,129)+line(250,65,250,129)+line(256,65,256,129)+line(378,65,378,129)+line(386,65,386,129,4,'#17252b')+text(130,167,'小节线')+text(253,167,'双小节线')+text(383,167,'终止线'));
 add('meter','2/4、3/4、4/4与6/8拍号', [2,3,4,6].map((n,i)=>{const x=20+i*117;return staff(x,53,92,14)+text(x+43,77,n,30)+text(x+43,106,i===3?8:4,30)+text(x+45,160,`${n}/${i===3?8:4}`,14);}).join(''));
 add('triplet','三个八分音符在一拍内均分的三连音示例',[145,225,305].map(x=>note(x,125,'eighth')).join('')+line(145,47,210,47)+line(257,47,337,47)+line(145,47,145,56)+line(337,47,337,56)+text(234,53,'3',22)+text(240,170,'这里三个八分音符占通常两个八分音符的时间'));
 add('tempo','四分音符与附点四分音符为速度单位的示意',note(90,115)+text(170,99,'= 60',23)+note(300,115)+dot(328,110)+text(401,99,'= 60',23)+text(240,166,'每分钟60个所示单位；两种细分速度不同'));
 add('dynamics','常见力度记号', ['p','mp','mf','fDynamic','ff'].map((name,i)=>fit(name,22+i*92,42,66,63)+text(55+i*92,148,['弱','中弱','中强','强','很强'][i])).join(''));
 add('crescendo','渐强楔形记号',line(100,95,380,65,2,'#17252b')+line(100,95,380,125,2,'#17252b')+text(240,160,'渐强 · 不等于渐快'));
 add('diminuendo','渐弱楔形记号',line(100,65,380,95,2,'#17252b')+line(100,125,380,95,2,'#17252b')+text(240,160,'渐弱 · 不等于渐慢'));
 add('key-signature','一个升号的调号与临时升号示例',staff()+symbol('g',55,113,64)+symbol('sharp',110,65,64)+note(220,113)+symbol('sharp',315,105,64)+note(350,105)+text(120,165,'调号',13)+text(338,165,'临时记号',13));
 add('interval','C4到E4先后发声与同时发声',staff(32,58,190,14)+staff(258,58,190,14)+symbol('g',42,100,56)+symbol('g',268,100,56)+note(112,128,'half')+line(102,128,141,128)+note(175,114,'half')+note(358,128,'half')+line(348,128,387,128)+note(358,114,'half')+text(126,169,'旋律音程：先后')+text(353,169,'和声音程：同时'));
 for(const [key,label,notes,changes]of [['major-triad','C大三和弦',['C4','E4','G4'],[]],['minor-triad','C小三和弦',['C4','Eb4','G4'],[1]],['diminished','C减三和弦',['C4','Eb4','Gb4'],[1,2]],['augmented','C增三和弦',['C4','E4','G#4'],[2]]]){
  const ys=[145,129,113];add(key,label+'谱例',staff()+symbol('g',55,113,64)+ys.map((y,i)=>note(240,y,'whole')+(changes.includes(i)?symbol(key==='augmented'?'sharp':'flat',205-i*14,y,64):'')).join('')+line(230,145,279,145,2)+text(240,173,notes.join(' – ')));
 }
 add('seventh','C7四个构成音的谱例',staff()+symbol('g',55,113,64)+[145,129,113,97].map(y=>note(240,y,'whole')).join('')+line(230,145,279,145,2)+symbol('flat',205,97,64)+text(240,173,'C7示例：C4 – E4 – G4 – Bb4'));
 add('inversions','C大三和弦原位及第一、第二转位',[[['C4','E4','G4'],[145,129,113]],[['E4','G4','C5'],[129,113,89]],[['G4','C5','E5'],[113,89,73]]].map(([names,ys],i)=>{const x=20+i*155;return staff(x,65,140)+symbol('g',x+4,113,64)+ys.map(y=>note(x+75,y,'whole')).join('')+(i===0?line(x+65,145,x+114,145):'')+text(x+74,172,['原位：C低音','第一转位：E低音','第二转位：G低音'][i],12);}).join(''));
 return out;
}

export const musicConceptDiagrams={
 '五线谱':['staff'],'谱号':['clefs'],'高音谱号':['g-symbol','treble'],'低音谱号':['f-symbol','bass'],'中音谱号':['c-symbol','alto'],'次中音谱号':['c-symbol','tenor'],'加线':['ledger'],'大谱表':['grand'],'音头':['note-parts'],'符干':['note-parts'],'符尾':['note-parts'],'休止符':['rests'],'调号':['key-signature'],'临时变音记号':['accidentals'],'升号':['sharp'],'降号':['flat'],'还原号':['natural'],'重升号':['double-sharp'],'重降号':['double-flat'],'延音线':['tie'],'连音线':['slur'],'断奏':['staccato'],'力度':['dynamics'],'渐强':['crescendo'],'渐弱':['diminuendo'],'速度标记':['tempo'],'反复记号':['repeat'],'延长记号':['fermata'],'小节':['bars'],'拍号':['meter'],'全音符':['whole'],'二分音符':['half'],'四分音符':['quarter'],'八分音符':['eighth'],'附点音符':['dotted'],'复附点':['double-dotted'],'三连音':['triplet'],'节拍器速度':['tempo'],'音程':['interval'],'旋律音程':['interval'],'和声音程':['interval'],'三和弦':['major-triad'],'大三和弦':['major-triad'],'小三和弦':['minor-triad'],'减三和弦':['diminished'],'增三和弦':['augmented'],'和弦根音':['inversions'],'和弦低音':['inversions'],'原位和弦':['inversions'],'第一转位':['inversions'],'第二转位':['inversions']};
/** Relation/label-rich figures stay after submission; symbols alone may be
 * displayed beside a named concept without leaking an objective answer. */
export const stemMusicDiagrams=new Set(['g-symbol','f-symbol','c-symbol','whole','half','quarter','eighth','sharp','flat','natural','double-sharp','double-flat','fermata','clefs']);
musicConceptDiagrams['七和弦']=['seventh'];musicConceptDiagrams['属七和弦']=['seventh'];
export const objectiveMusicFigures=[[/谱号/,'clefs'],[/休止符/,'rests'],[/附点四分/,'dotted'],[/复附点/,'double-dotted'],[/弧线|连音线|延音线/,'tie'],[/弧线|连音线|延音线/,'slur'],[/根音|转位/,'inversions'],[/七和弦/,'seventh'],[/三和弦/,'major-triad'],[/forte|力度/,'dynamics'],[/节拍器/,'tempo'],[/全音符/,'values'],[/拍号|6\/8/,'meter']];
