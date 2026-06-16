import { OpenAI } from 'openai';
import { AIProvider } from '../interfaces/ai-provider.interface';
import { OriginalElement } from '../interfaces/original-element.interface';
import { Candidate } from '../interfaces/candidate.interface';
import { logger } from '../logger/debug-logger';

function cleanObject(val: any): any {
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

export class VLLMService implements AIProvider {
  private openai: OpenAI;
  private modelName: string;

  constructor() {
    const baseURL = process.env.VLLM_BASE_URL;
    if (!baseURL) {
      console.warn('[VLLMService] Warning: VLLM_BASE_URL is not defined in environment variables. Defaulting to http://localhost:8000/v1');
    }
    this.openai = new OpenAI({
      apiKey: process.env.VLLM_API_KEY || 'dummy-key',
      baseURL: baseURL || 'http://localhost:8000/v1',
    });
    this.modelName = process.env.VLLM_MODEL_NAME || 'Qwen/Qwen2.5-14B-Instruct';
  }

  async askAI(original: OriginalElement, candidates: Candidate[]): Promise<{
    candidateId: number;
    confidence: number;
    reason: string;
  }> {
    // ── Original element signal summary
    const shadowDomHostTags = (original.ShadowDomFullXpathArray || [])
      .flatMap((xpath: string) =>
        xpath.split('/').filter(Boolean)
          .map(seg => seg.replace(/\[\d+\]/g, '').toUpperCase().trim())
          .filter(tag => tag.includes('-'))
      );

    const resolvedName = (original.LocText || original.LocTitle || original.OwnInnerText || '').trim();

    const cleanedOriginal = cleanObject({
      objectName: resolvedName,
      tagName: original.OrigTagName || '',
      id: original.LocId || '',
      name: original.LocName || '',
      className: original.LocClassName || '',
      role: original.role || '',
      inputType: original.LocType || original.inputType || '',
      interactionType: original.interactionType || original.Action || '',
      accessibleName: resolvedName,
      locValue: original.LocValue || '',
      labelText: original.labelText || '',
      parentTag: original.parentTag || '',
      parentId: original.parentId || '',
      indexInParent: original.indexInParent,
      domDepth: original.domDepth,
      nearbyText: (original.NearByText || original.nearbyText || []).slice(0, 4),
      cssSelector: original.LocCssSelector || '',
      fullXpath: original.FullLocXpath || original.fullXpath || original.LocXpath || '',
      shadowDomFullXpathArray: original.ShadowDomFullXpathArray || [],
      shadowDomHostTags: shadowDomHostTags.length > 0 ? [...new Set(shadowDomHostTags)] : undefined,
    }) || {};

    // ── Candidate signal summary
    const cleanedCandidates = candidates.map(c => {
      const rawCandidate: Record<string, any> = {
        candidateId: c.candidateId,
        tagName: c.functional.tagName,
        className: c.functional.className || undefined,
        id: c.functional.id,
        name: c.functional.name,
        role: c.functional.role || c.semantic.role,
        inputType: c.functional.inputType,
        interactionType: c.behavior.interactionType,
        accessibleName: c.semantic.accessibleName || c.semantic.text,
        value: c.functional.value,
        labelText: c.neighborhood.closestLabel || c.neighborhood.associatedLabel,
        parentTag: c.structure.parentTag,
        parentId: c.structure.parentId,
        indexInParent: c.structure.indexInParent,
        domDepth: c.structure.domDepth,
        shadowHostChain: c.ancestorContext.shadowHostChain?.length ? c.ancestorContext.shadowHostChain : undefined,
        ancestorTagNames: c.ancestorContext.ancestorTagNames,
        landmarkRole: c.ancestorContext.landmarkRole || undefined,
        headingContext: c.ancestorContext.headingContext || undefined,
      };
      if (c.tableContext) {
        rawCandidate.tableContext = c.tableContext;
      }
      return cleanObject(rawCandidate) || { candidateId: c.candidateId };
    });

    const systemPrompt = `You are an expert AI element healing system for web UI automation.
Your task: Given the metadata of an original UI element that CANNOT be located on the current page, and a pool of candidate elements extracted from the current DOM, identify the single candidate MOST LIKELY to be the same logical element.

Evaluation criteria (in priority order):
1. SEMANTIC match (HIGHEST PRIORITY): Does the candidate's accessibleName or labelText closely match the original's ObjectName, accessibleName, or labelText?
   *Dynamic Text*: Dropdown/select triggers may show the currently selected value (e.g. 'Active') instead of the default placeholder/label (e.g. 'Status'). Prioritize matching the host component over exact text match.
2. FUNCTIONAL match: Does the tagName, role, id, name, or inputType match?
   *CRITICAL — Shadow-internal IDs are NOT unique*: IDs like 'shadow-container', 'inner-wrapper', 'content-slot' repeat across every instance of a web component. When multiple candidates share the same id, disambiguate by accessibleName match against the original's ObjectName. Do NOT select based on id alone.
   *CRITICAL — Dynamic IDs & Attributes*: IDs like 'cdk-overlay-X', 'mat-option-Y', or framework-generated attributes/classes containing random hashes or prefixes (e.g., '_ngcontent-...') are dynamic and change across page reloads/sessions. Do NOT penalize a mismatch on these dynamic IDs/classes; instead, focus on the static/semantic parts of the ID or class.
3. BEHAVIORAL match: Does the interactionType (click/fill/check/select) match?
4. SHADOW HOST CHAIN match (VERY IMPORTANT): The candidate's 'shadowHostChain' lists ALL custom element ancestors from outermost to innermost. The original's 'shadowDomHostTags' lists the custom element tags extracted from its XPath. Compare these two lists: the correct candidate's shadowHostChain should have the highest overlap with the original's shadowDomHostTags. A candidate nested inside the same web component hierarchy as the original is far more likely to be correct.
5. CONTEXTUAL match: Do parentTag, ancestorTagNames, landmarkRole, or headingContext align?
   *Table Context*: If the candidate has 'tableContext', verify the columnHeader matches the original's expected column context. The correct table cell will have the matching columnHeader.
   *Hierarchy Alignment*: Compare the sequence of tags in the candidate's 'ancestorTagNames' (ordered from innermost parent to HTML/BODY) with the path of tags in the original's 'fullXpath' or 'cssSelector'. A candidate whose structural tag hierarchy matches the original's tag sequence (e.g., HTML -> BODY -> DIV -> UL -> LI -> A) is extremely likely to be correct, even if container IDs or class names differ.
6. UNLABELED / ICON elements: If the original element is an icon or unlabeled (e.g. OrigTagName is SPAN, SVG, I, or class contains 'icon') and has no accessibleName/objectName/LocText, do not force a semantic match on ObjectName (as the ObjectName might be a nearby text fallback). Instead, prioritize matching on tagName, classNames/className, and DOM tag path hierarchy.

Output your response as a valid JSON object ONLY (no markdown, no explanation outside JSON):
{
  "candidateId": number,
  "confidence": number (0.0 to 1.0),
  "reason": "string (concise explanation of why this candidate was chosen)"
}`;

    const userPrompt = `Original Element Metadata:
${JSON.stringify(cleanedOriginal, null, 2)}

Candidate Pool (${cleanedCandidates.length} candidates):
${JSON.stringify(cleanedCandidates, null, 2)}

Select the single best matching candidate. Output ONLY the JSON object.`;

    // ── Write full AI request to debug file
    logger.logAIRequest(
      resolvedName || 'unknown',
      cleanedOriginal,
      cleanedCandidates,
      systemPrompt,
      userPrompt
    );

    const response = await this.openai.chat.completions.create({
      model: this.modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
    });

    const content = response?.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);

    // ── Write AI response to debug file
    logger.logAIResponse(resolvedName || 'unknown', parsed);

    return parsed;
  }
}
