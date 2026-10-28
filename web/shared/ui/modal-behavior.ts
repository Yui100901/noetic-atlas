const locks=new WeakMap<HTMLElement,{count:number;overflow:string}>();

/** Each dialog releases only its own lock, even if parents unmount first. */
export function lockModalScroll(body:HTMLElement){
 const current=locks.get(body)||{count:0,overflow:body.style.overflow};current.count++;locks.set(body,current);body.style.overflow='hidden';
 let released=false;
 return()=>{if(released)return;released=true;current.count--;if(!current.count){body.style.overflow=current.overflow;locks.delete(body);}};
}

/** Closed details, hidden fields and disabled controls are not keyboard stops. */
export function modalFocusTargets(dialog:HTMLElement){
 return Array.from(dialog.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,summary,[tabindex],[contenteditable="true"]')).filter(control=>{
  if(control.tabIndex<0||control.matches(':disabled')||control.closest('[hidden],[inert]')||!control.getClientRects().length||getComputedStyle(control).visibility==='hidden')return false;
  // Chromium can retain nonzero layout boxes for descendants of closed details.
  // Only the first summary remains a keyboard stop while that details is closed.
  for(let parent=control.parentElement;parent&&parent!==dialog;parent=parent.parentElement)if(parent.tagName==='DETAILS'&&!parent.hasAttribute('open')){
   const summary=Array.from(parent.children).find(child=>child.tagName==='SUMMARY');if(!summary?.contains(control))return false;
  }
  return true;
 });
}
