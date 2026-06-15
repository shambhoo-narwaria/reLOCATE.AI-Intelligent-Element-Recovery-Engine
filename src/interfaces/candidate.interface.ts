// ── Candidate Identity Model ──────────────────────────────────────────────────
// Each section isolates a distinct signal category so the AI can reason
// about them independently rather than treating a flat bag of properties.

export interface CandidateSemantic {
  /** Visible display text (trimmed, collapsed whitespace) */
  text: string;
  /** WAI-ARIA role or inferred element role */
  role: string;
  /** Best computed accessible name (aria-label > placeholder > text) */
  accessibleName: string;
  /** Raw aria-label attribute */
  ariaLabel: string;
  /** title attribute */
  title: string;
  /** placeholder attribute */
  placeholder: string;
}

export interface CandidateFunctional {
  /** Normalised lowercase text (for fuzzy matching) */
  normalizedText: string;
  /** HTML tag name (e.g. BUTTON, INPUT, ZUI-MENUBAR-NAV-ITEM-V3) */
  tagName: string;
  /** Explicit WAI-ARIA role attribute */
  role: string;
  /** aria-label attribute */
  ariaLabel: string;
  /** aria-describedby resolved text */
  ariaDescription: string;
  /** aria-labelledby resolved text */
  ariaLabelledBy: string;
  /** title attribute */
  title: string;
  /** placeholder attribute */
  placeholder: string;
  /** name attribute */
  name: string;
  /** value attribute / current value */
  value: string;
  /** href for anchor tags */
  href: string;
  /** input[type] */
  inputType: string;
  /** data-testid / data-test-id attribute */
  dataTestId: string;
  /** data-qa attribute */
  dataQa: string;
  /** data-cy attribute */
  dataCy: string;
  /** id attribute */
  id: string;
  /** img alt attribute */
  alt: string;
  /** CSS selector (unique identifier used for healing) */
  cssSelector: string;
  /** XPath expression */
  xpath: string;
  /** Element class name */
  className: string;
}

export interface CandidateBehavior {
  /** Element is clickable */
  clickable: boolean;
  /** Element accepts text input */
  editable: boolean;
  /** Element can be selected (select/option/listbox) */
  selectable: boolean;
  /** Element can be checked (checkbox/radio) */
  checkable: boolean;
  /** Element is focusable */
  focusable: boolean;
  /** Element is currently disabled */
  disabled: boolean;
  /** Element is readonly */
  readonly: boolean;
  /** Element is required (form validation) */
  required: boolean;
  /** Primary interaction type: click | fill | select | check */
  interactionType: string;
  /** Checked state (checkbox/radio) */
  checked: boolean;
  /** Selected state (option/tab) */
  selected: boolean;
  /** Expanded state (accordion/dropdown) */
  expanded: boolean;
  /** Draggable */
  draggable: boolean;
}

export interface CandidateAncestorContext {
  /** Direct parent's text content */
  parentText: string;
  /** Direct parent's role */
  parentRole: string;
  /** Text content of ancestor elements (up to 6 levels) */
  ancestorText: string[];
  /** Roles of ancestor elements (up to 6 levels) */
  ancestorRoles: string[];
  /** Tag names of ancestor elements (up to 6 levels) */
  ancestorTagNames: string[];
  /** Nearest container/section text */
  containerText: string;
  /** Nearest container/section role */
  containerRole: string;
  /** Enclosing section/region name */
  sectionName: string;
  /** Enclosing form name/id */
  formName: string;
  /** Enclosing dialog name */
  dialogName: string;
  /** Shadow host element name (if in shadow DOM) — innermost host */
  shadowHostName: string;
  /** Full shadow host chain from outermost → innermost (tag names) */
  shadowHostChain: string[];
  /** Nearest HTML5 landmark role: nav, main, aside, header, footer */
  landmarkRole: string;
  /** Text of the nearest heading (h1-h6) above this element */
  headingContext: string;
}

export interface CandidateNeighborhood {
  /** Text of immediately preceding sibling */
  previousText: string;
  /** Text of immediately following sibling */
  nextText: string;
  /** Text of element to the left (visual) */
  leftText: string;
  /** Text of element to the right (visual) */
  rightText: string;
  /** Texts from sibling elements */
  siblings: string[];
  /** Texts of nearby elements (parent's innerText split lines) */
  nearbyText: string[];
  /** Roles of nearby elements */
  nearbyRoles: string[];
  /** Associated label text */
  closestLabel: string;
  /** aria-labelledby resolved text */
  associatedLabel: string;
}

export interface CandidateStructure {
  /** Depth from document root */
  domDepth: number;
  /** Number of direct children */
  childCount: number;
  /** Number of siblings */
  siblingCount: number;
  /** Whether the element contains visible text */
  containsText: boolean;
  /** Whether the element contains an SVG */
  containsSvg: boolean;
  /** Whether the element contains an img */
  containsImage: boolean;
  /** Whether the element contains an input */
  containsInput: boolean;
  /** Tag names of all descendant elements (unique list) */
  subtreeTags: string[];
  /** Direct parent tag name */
  parentTag: string;
  /** Direct parent id */
  parentId: string;
  /** Zero-based index among parent's children */
  indexInParent: number;
  /** Zero-based position among siblings with the same role */
  positionAmongSameRole: number;
}

export interface CandidateVisual {
  /** Whether the element is currently visible */
  visible: boolean;
  /** CSS display value */
  display: string;
  /** Bounding box width in px */
  boundingWidth: number;
  /** Bounding box height in px */
  boundingHeight: number;
  /** font-weight */
  fontWeight: string;
  /** font-size */
  fontSize: string;
  /** Visual similarity index compared to original recorded screenshot [0, 1] */
  similarity?: number;
}

// ── Table Context ─────────────────────────────────────────────────────────────
export interface CandidateTableContext {
  /** Text of the <th> header in the same column */
  columnHeader: string;
  /** Zero-based row index within <tbody> */
  rowIndex: number;
  /** Zero-based column index within the row */
  colIndex: number;
}

// ── Top-level Candidate ───────────────────────────────────────────────────────
export interface Candidate {
  /** Sequential index within the candidate pool */
  candidateId: number;

  /** Semantic signals (human-readable identity) */
  semantic: CandidateSemantic;

  /** Functional/attribute signals */
  functional: CandidateFunctional;

  /** Interaction behaviour signals */
  behavior: CandidateBehavior;

  /** Ancestor/context signals */
  ancestorContext: CandidateAncestorContext;

  /** Neighbourhood/sibling signals */
  neighborhood: CandidateNeighborhood;

  /** DOM structure signals */
  structure: CandidateStructure;

  /** Visual/layout signals */
  visual: CandidateVisual;

  /** Table context — only present when element is inside a table */
  tableContext?: CandidateTableContext;
}
