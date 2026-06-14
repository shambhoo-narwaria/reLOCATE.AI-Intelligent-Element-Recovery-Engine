export interface OriginalElement {
  Action: string;
  ObjectName?: string;
  LocXpath?: string;
  LocCssSelector?: string;
  LocId?: string;
  LocName?: string;
  /** HTML tag name — treated as a stable identity signal */
  LocTagName?: string;
  /** CSS class of the recorded element (inside shadow DOM) */
  LocClassName?: string;
  /** ARIA / inferred role — stable secondary filter */
  role?: string;
  /** input[type] e.g. "text", "password", "checkbox" — stable for INPUT elements */
  inputType?: string;
  /** Interaction type: click | fill | check | select */
  interactionType?: string;
  accessibleName?: string;
  labelText?: string;
  NearByText?: string[];
  parentTag?: string;
  parentId?: string;
  indexInParent?: number;
  domDepth?: number;
  /**
   * Shadow DOM host chain — CSS selectors for each host from outermost → innermost.
   * Recorded by the test recorder when the target element lives inside shadow roots.
   * Example: ["zui-menubar-nav-item-v3:nth-child(1)"]
   */
  ShadowDomHostArray?: string[];
  /** Full XPath for each shadow host in the chain (for debug / fallback) */
  ShadowDomXpathArray?: string[];
  [key: string]: any;
}

