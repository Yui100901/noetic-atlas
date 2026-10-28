export type AnalyticsMode='day'|'week'|'month'|'year'|'custom';
export const validAnalyticsDay=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
export function shiftAnalyticsDay(day:string,count:number){const value=new Date(day+'T12:00:00Z');value.setUTCDate(value.getUTCDate()+count);return value.toISOString().slice(0,10);}
export const analyticsMonday=(day:string)=>shiftAnalyticsDay(day,-((new Date(day+'T12:00:00Z').getUTCDay()+6)%7));
export function periodRange(mode:AnalyticsMode,anchor:string,today:string){
 if(mode==='day')return{from:anchor,to:anchor};
 if(mode==='week')return{from:analyticsMonday(anchor),to:shiftAnalyticsDay(analyticsMonday(anchor),6)};
 if(mode==='month'){const start=anchor.slice(0,7)+'-01',value=new Date(start+'T12:00:00Z');value.setUTCMonth(value.getUTCMonth()+1);value.setUTCDate(0);const end=value.toISOString().slice(0,10);return{from:start,to:end>today?today:end};}
 return{from:shiftAnalyticsDay(today,-364),to:today};
}
export function moveAnalyticsPeriod(mode:AnalyticsMode,anchor:string,delta:number){if(mode==='month'){const value=new Date(anchor.slice(0,7)+'-01T12:00:00Z');value.setUTCMonth(value.getUTCMonth()+delta);return value.toISOString().slice(0,10);}return shiftAnalyticsDay(anchor,(mode==='week'?7:1)*delta);}
export function readAnalyticsLocation(hash:string,today:string){const query=new URLSearchParams(hash.split('?')[1]),raw=query.get('mode')||'week',mode:AnalyticsMode=['day','week','month','year','custom'].includes(raw)?raw as AnalyticsMode:'week';const value=query.get('date')||today;const anchor=validAnalyticsDay(value)&&value<=today?value:today;const from=query.get('from')||shiftAnalyticsDay(today,-29),to=query.get('to')||today;return{mode,anchor,custom:validAnalyticsDay(from)&&validAnalyticsDay(to)&&from<=to&&to<=today&&(Date.parse(to)-Date.parse(from))/86400000<366?{from,to}:{from:shiftAnalyticsDay(today,-29),to:today}};}
