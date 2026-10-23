import { useEffect, useState } from 'react';

export interface ListPage<T> { items: T[]; total: number; page: number; pageSize: number }
export const PAGE_SIZES = [10,20,50,100] as const;

/** Client pagination for bootstrap-backed trees and local, cross-page selections. */
export function usePagination<T>(items: T[], resetKey: unknown = '', initialSize = 20) {
  const [page,setPage] = useState(1), [pageSize,setSize] = useState(initialSize);
  const pages = Math.max(1,Math.ceil(items.length/pageSize)), safePage=Math.min(page,pages);
  useEffect(()=>setPage(1),[resetKey]);
  useEffect(()=>{if(page>pages)setPage(pages);},[page,pages]);
  const setPageSize=(size:number)=>{setSize(size);setPage(1);};
  return { page:safePage,pageSize,total:items.length,onPage:setPage,onPageSize:setPageSize,items:items.slice((safePage-1)*pageSize,safePage*pageSize) };
}
