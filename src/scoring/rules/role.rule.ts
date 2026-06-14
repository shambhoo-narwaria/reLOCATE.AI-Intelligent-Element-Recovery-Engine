import { ScoringRule } from '../scoring-rule.interface';
import { OriginalElement } from '../../interfaces/original-element.interface';
import { Candidate } from '../../interfaces/candidate.interface';

/**
 * Scores based on element role / tag name match.
 * Weight: 15 – role is a strong structural signal but not unique enough alone.
 */
export class RoleRule implements ScoringRule {
  readonly name = 'RoleRule';
  readonly weight = 15;

  calculate(original: OriginalElement, candidate: Candidate): number {
    const origRole = (original.LocTagName || original.role || '').toLowerCase().trim();
    const candRole = (candidate.functional.tagName || candidate.functional.role || '').toLowerCase().trim();
    const candAriaRole = candidate.functional.role.toLowerCase().trim();

    if (!origRole) return 0;

    // Exact tag match
    if (origRole === candRole) return this.weight;

    // ARIA role match
    if (origRole === candAriaRole) return this.weight;

    // Shadow Host tag match
    const shadowHosts = (original.ShadowDomHostArray || []).flatMap(sh => {
      const parts = sh.match(/[a-zA-Z0-9-]+/g) || [];
      return parts.filter(p => !/^(nth-of-type|nth-child|first-child|last-child|\d+)$/i.test(p));
    }).map(s => s.toLowerCase().trim()).filter(Boolean);

    if (shadowHosts.includes(candRole.toLowerCase())) {
      return this.weight * 0.8;
    }

    // Partial / semantic equivalence
    if (origRole.includes(candRole) || candRole.includes(origRole)) return this.weight * 0.5;

    // Interaction type match (e.g. original is a button, candidate behaves like one)
    const actionEquiv: Record<string, string[]> = {
      button: ['button', 'a', 'input', 'zui-menubar-nav-item-v3'],
      input:  ['input', 'textarea', 'select'],
      link:   ['a'],
    };
    for (const [key, equivTags] of Object.entries(actionEquiv)) {
      if (origRole.includes(key) && equivTags.some(t => candRole.includes(t))) return this.weight * 0.4;
    }

    return 0;
  }
}
