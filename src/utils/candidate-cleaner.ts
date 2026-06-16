import { Candidate } from '../interfaces/candidate.interface';

export function cleanObject(val: any): any {
  if (val === null || val === undefined) {
    return undefined;
  }
  if (typeof val === 'string') {
    return val.trim() === '' ? undefined : val;
  }
  if (typeof val === 'boolean') {
    return val === false ? undefined : val;
  }
  if (Array.isArray(val)) {
    const cleanedArr = val
      .map(item => cleanObject(item))
      .filter(item => item !== undefined && item !== null && item !== '');
    return cleanedArr.length === 0 ? undefined : cleanedArr;
  }
  if (typeof val === 'object') {
    const cleanedObj: Record<string, any> = {};
    let hasKeys = false;
    for (const key of Object.keys(val)) {
      const cleanedVal = cleanObject(val[key]);
      if (cleanedVal !== undefined && cleanedVal !== null) {
        cleanedObj[key] = cleanedVal;
        hasKeys = true;
      }
    }
    return hasKeys ? cleanedObj : undefined;
  }
  return val;
}

export function cleanCandidate(c: Candidate | any): any {
  if (!c.semantic) return c; // Already cleaned or wrong type
  const rawCandidate: Record<string, any> = {
    candidateId:     c.candidateId,
    tagName:         c.functional.tagName,
    className:       c.functional.className || undefined,
    id:              c.functional.id,
    name:            c.functional.name,
    role:            c.functional.role || c.semantic.role,
    inputType:       c.functional.inputType,
    interactionType: c.behavior.interactionType,
    accessibleName:  c.semantic.accessibleName || c.semantic.text,
    value:           c.functional.value,
    labelText:       c.neighborhood?.closestLabel || c.neighborhood?.associatedLabel,
    parentTag:       c.structure.parentTag,
    parentId:        c.structure.parentId,
    indexInParent:   c.structure.indexInParent,
    domDepth:        c.structure.domDepth,
    shadowHostChain: c.ancestorContext.shadowHostChain?.length ? c.ancestorContext.shadowHostChain : undefined,
    ancestorTagNames: c.ancestorContext.ancestorTagNames,
    landmarkRole:    c.ancestorContext.landmarkRole || undefined,
    headingContext:  c.ancestorContext.headingContext || undefined,
  };
  if (c.tableContext) {
    rawCandidate.tableContext = c.tableContext;
  }
  return cleanObject(rawCandidate) || { candidateId: c.candidateId };
}
