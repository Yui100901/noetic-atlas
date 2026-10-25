import { fail } from '../../core/validation.js';

export function addDays(date: string, count: number): string {
  const value=new Date(date+'T12:00:00Z');value.setUTCDate(value.getUTCDate()+count);return value.toISOString().slice(0,10);
}
export function daysBetween(from:string,to:string):number { return Math.round((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000); }
export function monday(date:string):string {const value=new Date(date+'T12:00:00Z');return addDays(date,-((value.getUTCDay()+6)%7));}
export function calendar(timeZone:string) {
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'});
  const date=(instant:number|Date)=>{const parts=formatter.formatToParts(instant);const get=(type:string)=>parts.find(part=>part.type===type)!.value;return `${get('year')}-${get('month')}-${get('day')}`;};
  // Find the first instant of the local date instead of assuming UTC offsets or
  // 24-hour days. This also handles DST shifts at midnight and skipped dates.
  const start=(day:string)=>{const approximate=Date.parse(day+'T00:00:00Z');let low=approximate-36*3600000,high=approximate+36*3600000;while(low<high){const mid=Math.floor((low+high)/2);if(date(mid)<day)low=mid+1;else high=mid;}return low;};
  return {date,start};
}
export function validateRange(from:string,to:string) {
  const count=daysBetween(from,to)+1;
  if(count<1||count>366)fail(400,'ANALYTICS_RANGE_INVALID','统计日期须按先后排列，且一次最多366天');
}
