import {lazy,type ComponentType} from 'react';

/** Loading a feature is separate from executing it. Keep a recognizable error
 * so a failed chunk can offer an explicit reload, without automatic loops. */
export function lazyPage<Component extends ComponentType<any>>(load:()=>Promise<{default:Component}>){
 return lazy<Component>(async()=>{try{return await load();}catch(reason){const error=new Error('页面功能加载失败，请检查连接或重新加载应用后继续。',{cause:reason});error.name='PageLoadError';throw error;}});
}
