import { Page } from 'playwright';
import {
  Candidate,
  CandidateSemantic,
  CandidateFunctional,
  CandidateBehavior,
  CandidateAncestorContext,
  CandidateNeighborhood,
  CandidateStructure,
  CandidateVisual,
  CandidateTableContext,
} from '../interfaces/candidate.interface';

export class CandidateFinder {
  async findCandidates(page: Page, targetTagName?: string): Promise<Candidate[]> {
    return await page.evaluate((tag: string | undefined) => {

      // ── Helpers ──────────────────────────────────────────────────────────
      const attr = (el: Element, name: string) => el.getAttribute(name) || '';
      const trimws = (s: string) => s.trim().replace(/\s+/g, ' ');

      // ── Shadow & Slot Aware Text Content Scraper ──────────────────────────
      const getElementText = (node: Node): string => {
        if (node.nodeType === Node.TEXT_NODE) {
          return node.textContent || '';
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
          return '';
        }
        const el = node as Element;

        // If the element has too many descendant elements, it is a high-level container layout.
        // We avoid recursing into it to prevent page-wide text pollution on wrapper elements.
        const descendantCount = el.querySelectorAll('*').length;
        if (descendantCount > 20) {
          return Array.from(el.childNodes)
            .filter(n => n.nodeType === Node.TEXT_NODE)
            .map(n => n.textContent || '')
            .join(' ');
        }

        const tag = el.tagName.toLowerCase();
        if (tag === 'slot' && typeof (el as any).assignedNodes === 'function') {
          return Array.from((el as HTMLSlotElement).assignedNodes({ flatten: true }))
            .map(n => getElementText(n))
            .join('');
        }
        if (el.shadowRoot) {
          return Array.from(el.shadowRoot.childNodes)
            .map(n => getElementText(n))
            .join(' ');
        }
        return Array.from(el.childNodes)
          .map(n => getElementText(n))
          .join(' ');
      };

      // ── Build CSS selector ────────────────────────────────────────────────
      const buildCss = (el: Element): string => {
        const id = attr(el, 'id');
        if (id) return `#${id}`;
        const t = el.tagName.toLowerCase();
        for (const a of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'value', 'tile-title', 'name', 'type', 'role']) {
          const v = attr(el, a);
          if (v) return `${t}[${a}="${v}"]`;
        }
        const cls = (typeof el.className === 'string')
          ? el.className.split(/\s+/).filter(c => c && !c.includes(':') && !c.includes('['))
          : [];
        return cls.length ? `${t}.${cls.join('.')}` : t;
      };

      // ── Compute accessible name ───────────────────────────────────────────
      const computeAccessibleName = (el: Element): string => {
        const t = el.tagName.toLowerCase();
        if (attr(el, 'aria-label')) return attr(el, 'aria-label');
        if (attr(el, 'placeholder')) return attr(el, 'placeholder');
        if (attr(el, 'title')) return attr(el, 'title');
        const lbId = attr(el, 'aria-labelledby');
        if (lbId) {
          const lbEl = document.getElementById(lbId);
          if (lbEl) return trimws(getElementText(lbEl));
        }
        if (['input', 'select', 'textarea'].includes(t)) {
          const val = (el as HTMLInputElement).value;
          if (val && val.trim()) return val.trim();
        }
        if (attr(el, 'alt')) return attr(el, 'alt');

        // Slot-aware text extraction
        let slotText = '';
        try {
          const getSlotText = (slot: any): string => {
            if (typeof slot.assignedNodes === 'function') {
              return Array.from(slot.assignedNodes({ flatten: true }))
                .map((n: any) => n.textContent || '')
                .join('');
            }
            return slot.textContent || '';
          };

          const slots: any[] = [];
          if (t === 'slot') {
            slots.push(el);
          }
          slots.push(...Array.from(el.querySelectorAll('slot')));
          if (el.shadowRoot) {
            slots.push(...Array.from(el.shadowRoot.querySelectorAll('slot')));
          }

          if (slots.length > 0) {
            slotText = trimws(slots.map(getSlotText).join(' '));
          }
        } catch (e) {
          // ignore
        }

        if (slotText) {
          return slotText.substring(0, 100);
        }

        return trimws(getElementText(el)).substring(0, 100);
      };

      // ── Resolve aria-labelledby / aria-describedby ────────────────────────
      const resolveIds = (el: Element, attrName: string): string => {
        const ids = attr(el, attrName).split(/\s+/).filter(Boolean);
        return ids.map(id => {
          const e = document.getElementById(id);
          return e ? trimws(e.textContent || '') : '';
        }).join(' ').trim();
      };

      // ── Selector for interactive / custom elements ────────────────────────
      const baseSelector = 'input,button,select,textarea,a,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[tabindex]';
      const extraTag = tag ? tag.toLowerCase().trim() : '';

      // ── NESTED SHADOW DOM: recursive element collector ────────────────────
      // Each collected item carries its shadow-host ancestry so we can compute
      // true DOM depth and proper ancestor context even across shadow boundaries.
      interface CollectedEl {
        el: Element;
        /** ordered list of shadow-host elements from outermost → innermost */
        hostChain: Element[];
        /** true depth = light-DOM depth inside current shadow root + each host's own depth */
        absoluteDepth: number;
      }

      /**
       * Recursively walk every element and every shadow root.
       * @param root       - The ParentNode to walk (document | ShadowRoot)
       * @param hostChain  - Shadow host ancestry up to this root
       * @param baseDepth  - DOM depth offset at entry to this shadow root
       */
      const collectAll = (root: ParentNode, hostChain: Element[], baseDepth: number): CollectedEl[] => {
        const results: CollectedEl[] = [];

        // Walk every direct child recursively within this root
        const walk = (node: Element, depthInRoot: number) => {
          const isInteractive = (() => {
            try { return node.matches(baseSelector); } catch { return false; }
          })();
          const isCustom = node.tagName.includes('-');
          const isTargetTag = extraTag && node.tagName.toLowerCase() === extraTag;

          if (isInteractive || isCustom || isTargetTag) {
            results.push({
              el: node,
              hostChain,
              absoluteDepth: baseDepth + depthInRoot,
            });
          }

          // Recurse into shadow root if present — increment depth by 1 for the host element itself
          const shadow = (node as any).shadowRoot as ShadowRoot | null;
          if (shadow) {
            // The shadow host counts as one level; baseDepth for inner root = current absolute depth
            results.push(...collectAll(shadow, [...hostChain, node], baseDepth + depthInRoot));
          }

          // Walk light-DOM children
          for (const child of Array.from(node.children)) {
            walk(child as Element, depthInRoot + 1);
          }
        };

        for (const child of Array.from(root.children)) {
          walk(child as Element, 1);
        }
        return results;
      };

      const collected = collectAll(document, [], 0);

      // ── Build candidates ──────────────────────────────────────────────────
      return collected.map(({ el, hostChain, absoluteDepth }: CollectedEl, index: number) => {
        // Inject a unique temporary ID into the DOM element for locator healing
        el.setAttribute('data-ai-healed-id', String(index));
        const tagName: string = el.tagName || '';
        const tagLower = tagName.toLowerCase();
        const rect: DOMRect = el.getBoundingClientRect();
        const style = window.getComputedStyle ? window.getComputedStyle(el) : null;

        // ── Semantic ─────────────────────────────────────────────────────
        const accessibleName = computeAccessibleName(el);
        const semantic: CandidateSemantic = {
          text: trimws(getElementText(el)).substring(0, 120),
          role: attr(el, 'role') || (el as any).role || '',
          accessibleName,
          ariaLabel: attr(el, 'aria-label'),
          title: attr(el, 'title'),
          placeholder: attr(el, 'placeholder'),
        };

        // ── Functional ───────────────────────────────────────────────────
        const functional: CandidateFunctional = {
          className: (typeof el.className === 'string') ? el.className.trim() : '',
          normalizedText: accessibleName.toLowerCase(),
          tagName,
          role: attr(el, 'role') || '',
          ariaLabel: attr(el, 'aria-label'),
          ariaDescription: resolveIds(el, 'aria-describedby'),
          ariaLabelledBy: resolveIds(el, 'aria-labelledby'),
          title: attr(el, 'title'),
          placeholder: attr(el, 'placeholder'),
          name: attr(el, 'name'),
          value: attr(el, 'value'),
          href: attr(el, 'href'),
          inputType: attr(el, 'type'),
          dataTestId: attr(el, 'data-testid') || attr(el, 'data-test-id') || attr(el, 'data-test'),
          dataQa: attr(el, 'data-qa'),
          dataCy: attr(el, 'data-cy'),
          id: attr(el, 'id'),
          alt: attr(el, 'alt'),
          cssSelector: buildCss(el),
          xpath: '',   // XPath cannot pierce shadow roots; cssSelector is the primary locator
        };

        // ── Behavior ─────────────────────────────────────────────────────
        const isEditable = ['input', 'textarea'].includes(tagLower) || attr(el, 'contenteditable') === 'true';
        const isClickable = ['button', 'a', 'select'].includes(tagLower) || !!attr(el, 'role') || tagName.includes('-') || attr(el, 'tabindex') !== '';
        const isCheckable = ['checkbox', 'radio'].includes(attr(el, 'type')) || ['checkbox', 'radio', 'switch'].includes(attr(el, 'role'));
        const isSelectable = ['option', 'select'].includes(tagLower) || attr(el, 'role') === 'option';
        const interactionType = isEditable ? 'fill' : isCheckable ? 'check' : isSelectable ? 'select' : 'click';

        const behavior: CandidateBehavior = {
          clickable: isClickable,
          editable: isEditable,
          selectable: isSelectable,
          checkable: isCheckable,
          focusable: typeof (el as any).focus === 'function' && attr(el, 'tabindex') !== '-1',
          disabled: !!(el as any).disabled || attr(el, 'aria-disabled') === 'true',
          readonly: !!(el as any).readOnly || attr(el, 'aria-readonly') === 'true',
          required: !!(el as any).required || attr(el, 'aria-required') === 'true',
          interactionType,
          checked: !!(el as any).checked || attr(el, 'aria-checked') === 'true',
          selected: !!(el as any).selected || attr(el, 'aria-selected') === 'true',
          expanded: attr(el, 'aria-expanded') === 'true',
          draggable: attr(el, 'draggable') === 'true',
        };

        // ── Ancestor context (shadow-root aware) ─────────────────────────
        // Walk parentElement and cross shadow DOM boundaries via hostChain (innermost first)
        // to collect up to 15 levels of actual ancestor elements.
        const ancestors: Element[] = [];
        let cur: Element | null = el.parentElement;
        let hostIdx = hostChain.length - 1;
        while (cur || hostIdx >= 0) {
          if (ancestors.length >= 20) {
            break;
          }
          if (cur) {
            ancestors.push(cur);
            cur = cur.parentElement;
          } else {
            const host = hostChain[hostIdx];
            hostIdx--;
            ancestors.push(host);
            cur = host.parentElement;
          }
        }

        const closestForm = el.closest('form');
        const closestDialog = el.closest('[role="dialog"], dialog');
        const closestSection = el.closest('section,[role="region"],[role="main"],main,aside');
        const parentEl = el.parentElement;

        // ── Shadow host chain (FULL custom element path, outermost → innermost) ─
        // Walk ALL ancestors — unlimited, not capped at 6 — and collect every
        // custom element (tagName contains '-') in the path. This captures hosts
        // like ZUI-SCROLLABLE-DIRECTIVE-V3-17 even when their table content is in
        // light DOM (slotted), which the hostChain misses because it only tracks
        // shadow roots that were directly entered by the walker.
        const fullShadowHostChain: string[] = [];
        {
          let shWalker: Element | null = el.parentElement;
          let shHostIdx = hostChain.length - 1;
          while (shWalker || shHostIdx >= 0) {
            if (shWalker) {
              if (shWalker.tagName.includes('-')) {
                fullShadowHostChain.push(shWalker.tagName);
              }
              shWalker = shWalker.parentElement;
            } else if (shHostIdx >= 0) {
              const host = hostChain[shHostIdx];
              shHostIdx--;
              fullShadowHostChain.push(host.tagName);
              shWalker = host.parentElement;
            } else {
              break;
            }
          }
          fullShadowHostChain.reverse(); // outermost → innermost
        }

        // ── Landmark role (shadow-aware) ─────────────────────────────────
        // Walk ancestors (already collected across shadow boundaries) to
        // find the nearest HTML5 landmark element.
        const LANDMARK_TAGS = new Set(['NAV', 'MAIN', 'ASIDE', 'HEADER', 'FOOTER']);
        const LANDMARK_ROLES = new Set(['navigation', 'main', 'complementary', 'banner', 'contentinfo', 'region']);
        let landmarkRole = '';
        for (const anc of ancestors) {
          if (LANDMARK_TAGS.has(anc.tagName)) {
            landmarkRole = anc.tagName.toLowerCase();
            break;
          }
          const ancRole = attr(anc, 'role');
          if (LANDMARK_ROLES.has(ancRole)) {
            landmarkRole = ancRole;
            break;
          }
        }

        // ── Heading context (shadow-aware) ───────────────────────────────
        // Walk preceding siblings and ancestors to find the nearest h1-h6.
        const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
        let headingContext = '';
        // Check preceding siblings in the current parent
        if (parentEl) {
          const sibs = Array.from(parentEl.children);
          const myPos = sibs.indexOf(el);
          for (let i = myPos - 1; i >= 0; i--) {
            if (HEADING_TAGS.has(sibs[i].tagName)) {
              headingContext = trimws(sibs[i].textContent || '').substring(0, 80);
              break;
            }
          }
        }
        // If not found, check ancestors for heading children before our branch
        if (!headingContext) {
          for (const anc of ancestors) {
            const headings = anc.querySelectorAll('h1,h2,h3,h4,h5,h6');
            if (headings.length > 0) {
              // Use the last heading before our element in document order
              headingContext = trimws(headings[headings.length - 1].textContent || '').substring(0, 80);
              break;
            }
          }
        }

        // ── Table context (shadow-aware) ─────────────────────────────────
        // Walk from element up through ancestors and host chain to find
        // the nearest <td>/<th> and extract column header, row/col indices.
        let tableContext: CandidateTableContext | undefined;
        try {
          // First try within current tree (el.closest works within same root)
          let closestTd: Element | null = el.closest('td, th');
          // If not found and element is inside a shadow root, check the host's tree
          if (!closestTd) {
            for (let hi = hostChain.length - 1; hi >= 0; hi--) {
              closestTd = hostChain[hi].closest('td, th');
              if (closestTd) break;
            }
          }
          if (closestTd) {
            const closestTr = closestTd.closest('tr');
            const closestTable = closestTd.closest('table');
            if (closestTr && closestTable) {
              const colIndex = Array.from(closestTr.children).indexOf(closestTd);
              const tbody = closestTable.querySelector('tbody');
              const allRows = tbody ? Array.from(tbody.querySelectorAll(':scope > tr')) : Array.from(closestTable.querySelectorAll('tr'));
              const rowIndex = allRows.indexOf(closestTr);
              // Find column header text
              const thead = closestTable.querySelector('thead');
              let columnHeader = '';
              if (thead) {
                const headerRow = thead.querySelector('tr');
                if (headerRow) {
                  const ths = Array.from(headerRow.children);
                  if (colIndex >= 0 && colIndex < ths.length) {
                    columnHeader = trimws(ths[colIndex].textContent || '').substring(0, 80);
                  }
                }
              }
              if (colIndex >= 0) {
                tableContext = { columnHeader, rowIndex, colIndex };
              }
            }
          }
        } catch (_e) {
          // Table context is optional; swallow errors
        }

        const ancestorContext: CandidateAncestorContext = {
          parentText: parentEl ? trimws(parentEl.textContent || '').substring(0, 120) : '',
          parentRole: parentEl ? (attr(parentEl, 'role') || parentEl.tagName.toLowerCase()) : '',
          ancestorText: ancestors.map(a => trimws(a.textContent || '').substring(0, 80)).filter(Boolean),
          ancestorRoles: ancestors.map(a => attr(a, 'role') || a.tagName.toLowerCase()),
          ancestorTagNames: ancestors.map(a => a.tagName),
          containerText: closestSection ? trimws(closestSection.textContent || '').substring(0, 120) : '',
          containerRole: closestSection ? (attr(closestSection, 'role') || closestSection.tagName.toLowerCase()) : '',
          sectionName: closestSection ? (attr(closestSection, 'aria-label') || attr(closestSection, 'aria-labelledby') || '') : '',
          formName: closestForm ? (attr(closestForm, 'name') || attr(closestForm, 'id') || attr(closestForm, 'aria-label') || '') : '',
          dialogName: closestDialog ? (attr(closestDialog, 'aria-label') || attr(closestDialog, 'aria-labelledby') || '') : '',
          // Innermost shadow host name — most specific shadow boundary context
          shadowHostName: hostChain.length > 0 ? hostChain[hostChain.length - 1].tagName : '',
          shadowHostChain: fullShadowHostChain,
          landmarkRole,
          headingContext,
        };

        // ── Neighborhood ─────────────────────────────────────────────────
        const siblings = parentEl ? Array.from(parentEl.children) : [];
        const myIdx = siblings.indexOf(el);
        const prevSib = myIdx > 0 ? siblings[myIdx - 1] : null;
        const nextSib = myIdx < siblings.length - 1 ? siblings[myIdx + 1] : null;
        const labelFor = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
        const closestLabel = el.closest('label') || labelFor;
        const labelText = closestLabel ? trimws(closestLabel.textContent || '') : '';
        const nearbyLines = parentEl ? ((parentEl as HTMLElement).innerText || '').split('\n').map(l => l.trim()).filter(l => l && l !== semantic.text && l !== labelText) : [];

        const neighborhood: CandidateNeighborhood = {
          previousText: prevSib ? trimws((prevSib as HTMLElement).innerText || prevSib.textContent || '').substring(0, 80) : '',
          nextText: nextSib ? trimws((nextSib as HTMLElement).innerText || nextSib.textContent || '').substring(0, 80) : '',
          leftText: '',
          rightText: '',
          siblings: siblings.filter(s => s !== el).map(s => trimws((s as HTMLElement).innerText || s.textContent || '').substring(0, 60)).filter(Boolean).slice(0, 5),
          nearbyText: nearbyLines.slice(0, 6),
          nearbyRoles: siblings.filter(s => s !== el).map(s => attr(s, 'role') || s.tagName.toLowerCase()).filter(Boolean).slice(0, 5),
          closestLabel: labelText,
          associatedLabel: resolveIds(el, 'aria-labelledby'),
        };

        // ── Structure (uses absoluteDepth across shadow boundaries) ──────
        const children = Array.from(el.children);
        const sameRoleIndex = parentEl ? Array.from(parentEl.children).filter((s, si) => (attr(s, 'role') === attr(el, 'role') || s.tagName === el.tagName) && si < myIdx).length : 0;

        const subtreeTagSet = new Set<string>();
        (Array.from(el.querySelectorAll('*')) as Element[]).forEach((d: Element) => subtreeTagSet.add(d.tagName));
        // Also collect tags from shadow subtrees (one level deep for perf)
        for (const child of Array.from(el.children)) {
          const childShadow = (child as any).shadowRoot as ShadowRoot | null;
          if (childShadow) {
            (Array.from(childShadow.querySelectorAll('*')) as Element[]).forEach((d: Element) => subtreeTagSet.add(d.tagName));
          }
        }

        const structure: CandidateStructure = {
          domDepth: absoluteDepth,   // ← true cross-shadow depth
          childCount: children.length,
          siblingCount: siblings.length,
          containsText: !!(el.textContent && el.textContent.trim()),
          containsSvg: !!el.querySelector('svg'),
          containsImage: !!el.querySelector('img'),
          containsInput: !!el.querySelector('input,textarea,select'),
          subtreeTags: Array.from(subtreeTagSet).slice(0, 15),
          parentTag: parentEl ? parentEl.tagName : (hostChain.length > 0 ? hostChain[hostChain.length - 1].tagName : ''),
          parentId: parentEl ? attr(parentEl, 'id') : '',
          indexInParent: myIdx,
          positionAmongSameRole: sameRoleIndex,
        };

        // ── Visual ────────────────────────────────────────────────────────
        const isDisplayContents = style ? style.display === 'contents' : false;
        const visible = (rect.width > 0 && rect.height > 0) || isDisplayContents;
        const visual: CandidateVisual = {
          visible,
          display: style ? style.display : '',
          boundingWidth: rect.width,
          boundingHeight: rect.height,
          fontWeight: style ? style.fontWeight : '',
          fontSize: style ? style.fontSize : '',
        };

        return {
          candidateId: index,
          semantic,
          functional,
          behavior,
          ancestorContext,
          neighborhood,
          structure,
          visual,
          tableContext,
        } as Candidate;
      }).filter((cand: Candidate) => {
        const t = cand.functional.tagName.toLowerCase();

        // ── Invisible elements: never valid action targets ─────────────────
        // Elements with zero width or height are hidden (tooltips, collapsed
        // sections, off-screen elements). ZUI-TOOLTIP-V3, etc. have zero size
        // when not hovered, making them invisible and non-actionable.
        if (!cand.visual.visible) return false;

        // ── Hard tag exclusions ────────────────────────────────────────────
        const ALWAYS_EXCLUDE = ['slot', 'style', 'template', 'link', 'script', 'meta'];
        if (ALWAYS_EXCLUDE.includes(t)) return false;

        // ── Inclusion rules ────────────────────────────────────────────────
        if (['input', 'button', 'select', 'textarea', 'a'].includes(t)) return true;
        if (t.includes('-')) return true;           // custom elements (ZUI-*, etc.)
        if (cand.functional.role) return true;
        if (cand.functional.id || cand.functional.dataTestId || cand.functional.dataQa) return true;
        if (cand.semantic.accessibleName || cand.semantic.text) return true;
        if (cand.behavior.focusable) return true;
        if (cand.structure.containsSvg || cand.structure.containsImage) return true;
        if (extraTag && t === extraTag) return true;
        return false;
      });
    }, targetTagName);
  }
}
