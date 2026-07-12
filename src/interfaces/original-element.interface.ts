export interface OriginalElement {
  // =========================================================================
  // 1. JSON Recorded Properties (Present in Recorded Testcase Files)
  // =========================================================================
  Action: string;
  LocCssSelector?: string;
  LocXpath?: string;
  FullLocXpath?: string;
  ShadowDomHostArray?: string[];
  ShadowDomFullXpathArray?: string[] | null;
  ShadowDomXpathArray?: string[];
  ObjectName?: string;
  MousePosition?: string;
  EndMousePosition?: string;
  InputData?: string;
  LocTagName?: string;
  OrigTagName?: string;
  LocType?: string;
  LocId?: string;
  LocName?: string;
  LocTitle?: string;
  LocValue?: string;
  LocClassName?: string;
  FullHTML?: string;
  URL?: string;
  fullUrl?: string;
  sourceUrl?: string;
  ScreenName?: string;
  IFrame?: string;
  IFrameFullXpath?: string;
  IFrameXpathArray?: string[];
  IFrameFullXpathArray?: string[];
  Screenshot?: string;
  tabCount?: number;
  TabNumber?: number;
  OwnInnerText?: string;
  DropParentXpath?: string;
  TableXpath?: string;
  TableRow?: string;
  TableColumn?: string;
  TableRowData?: any;
  waitTime?: number;
  ListItems?: any;
  NextListItems?: any;
  ElementViewportRect?: number[];
  AccumulatedIframeOffset?: number[];
  NearByText?: string[];

  // =========================================================================
  // 2. Internally Computed Properties (Calculated by the Engine at Runtime)
  // =========================================================================
  /** ARIA / inferred role — stable secondary filter */
  role?: string;
  /** input[type] e.g. "text", "password", "checkbox" — stable for INPUT elements */
  inputType?: string;
  /** Interaction type: click | fill | check | select */
  interactionType?: string;
  /** Computed accessibility name / screen-reader text */
  accessibleName?: string;
  /** Associated label element text */
  labelText?: string;
  /** Expected HTML tag name of direct parent node */
  parentTag?: string;
  /** Expected ID attribute of parent node */
  parentId?: string;
  /** Child position index inside parent element */
  indexInParent?: number;
  /** DOM depth levels from root element */
  domDepth?: number;
  /** Index of the execution step */
  index?: number;

  [key: string]: any;
}
