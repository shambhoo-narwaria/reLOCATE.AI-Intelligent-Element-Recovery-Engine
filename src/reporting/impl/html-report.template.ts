import { StepOutcome } from './step-outcome.interface';

export class HtmlReportTemplate {
  static render(outcomes: StepOutcome[], meta: { timestamp: string; projectName: string }): string {
    const totalSteps = outcomes.length;
    const passedSteps = outcomes.filter(o => o.status === 'Passed').length;
    const failedSteps = outcomes.filter(o => o.status === 'Failed').length;
    const skippedSteps = outcomes.filter(o => o.status === 'Skipped').length;
    const healedSteps = outcomes.filter(o => o.healed).length;
    const healingSuccess = healedSteps; // Steps where healing succeeded
    
    const totalHealAttempted = outcomes.filter(o => o.healed).length;
    
    const aiInvoked = outcomes.filter(o => o.triggeredAI || (o.healed && o.reason?.includes('MCP'))).length;
    
    const healedWithConfidence = outcomes.filter(o => o.healed && o.confidence !== undefined);
    const avgConfidence = healedWithConfidence.length > 0 
      ? Math.round((healedWithConfidence.reduce((sum, o) => sum + (o.confidence || 0), 0) / healedWithConfidence.length) * 100)
      : 0;

    const ruleWeights: Record<string, number> = {
      'ObjectNameRule': 30,
      'LabelTextRule': 15,
      'RoleRule': 15,
      'AncestorPathRule': 15,
      'NearbyTextRule': 10,
      'ParentContextRule': 10,
      'DomStructureRule': 5,
      'ClassNameRule': 10,
      'VisualSimilarityRule': 20,
      'CssSelectorRule': 10,
      'HorizontalProximityRule': 5
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>reLOCATE.AI — Execution Report</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-primary: #f8fafc;
      --bg-secondary: #ffffff;
      --bg-card: #ffffff;
      --border-card: #e2e8f0;
      --text-main: #0f172a;
      --text-muted: #64748b;
      --color-primary: #2563eb;
      --color-success: #16a34a;
      --color-success-bg: #f0fdf4;
      --color-success-border: #bbf7d0;
      --color-fail: #dc2626;
      --color-fail-bg: #fef2f2;
      --color-fail-border: #fecaca;
      --color-warn: #ca8a04;
      --color-healed: #7c3aed;
      --color-healed-bg: #f5f3ff;
      --color-healed-border: #ddd6fe;
      --color-skipped: #4b5563;
      --font-display: 'Outfit', sans-serif;
      --font-mono: 'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, monospace;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg-primary);
      color: var(--text-main);
      font-family: var(--font-display);
      line-height: 1.5;
      padding: 2rem 1.5rem;
      min-height: 100vh;
    }

    .container {
      max-width: 1280px;
      margin: 0 auto;
    }

    /* HEADER */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.75rem;
      border-bottom: 1px solid var(--border-card);
      padding-bottom: 1.25rem;
    }

    .logo-container h1 {
      font-size: 1.8rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text-main);
    }

    .logo-container p {
      color: var(--text-muted);
      font-size: 0.85rem;
      margin-top: 0.15rem;
    }

    .meta-details {
      text-align: right;
    }

    .meta-item {
      font-size: 0.9rem;
      color: var(--text-muted);
      margin-bottom: 0.35rem;
    }

    .meta-item strong {
      color: var(--text-main);
      font-family: var(--font-mono);
    }

    /* DASHBOARD CARDS */
    .dashboard-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 1rem;
      margin-bottom: 1.75rem;
    }

    .card {
      background: var(--bg-card);
      border: 1px solid var(--border-card);
      border-radius: 10px;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      transition: all 0.2s ease-in-out;
      box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05), 0 1px 2px -1px rgba(0, 0, 0, 0.05);
      position: relative;
      overflow: hidden;
    }

    .card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: transparent;
      transition: background 0.2s ease;
    }

    .card:hover {
      transform: translateY(-2px);
      border-color: #cbd5e1;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -2px rgba(0, 0, 0, 0.05);
    }

    .card.pass::before { background: var(--color-success); }
    .card.fail::before { background: var(--color-fail); }
    .card.healed::before { background: var(--color-healed); }
    .card.conf::before { background: #8b5cf6; }

    .card-title {
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 0.5rem;
      font-weight: 600;
    }

    .card-value {
      font-size: 2rem;
      font-weight: 700;
      font-family: var(--font-mono);
      line-height: 1.1;
    }

    .card.pass .card-value { color: var(--color-success); }
    .card.fail .card-value { color: var(--color-fail); }
    .card.healed .card-value { color: var(--color-healed); }
    .card.conf .card-value { color: #6d28d9; }

    .card-subtext {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 0.5rem;
    }

    /* TOOLBAR & FILTERS */
    .filter-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: var(--bg-secondary);
      border: 1px solid var(--border-card);
      border-radius: 10px;
      padding: 0.75rem 1rem;
      margin-bottom: 1.25rem;
      gap: 1.5rem;
    }

    .search-container {
      flex: 1;
      position: relative;
    }

    .search-input {
      width: 100%;
      background: var(--bg-primary);
      border: 1px solid var(--border-card);
      border-radius: 6px;
      padding: 0.5rem 1rem 0.5rem 2.2rem;
      color: var(--text-main);
      font-family: var(--font-display);
      font-size: 0.9rem;
      outline: none;
      transition: all 0.15s ease;
    }

    .search-input:focus {
      border-color: #94a3b8;
      box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.02);
    }

    .search-icon {
      position: absolute;
      left: 0.75rem;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-muted);
      pointer-events: none;
    }

    .filter-buttons {
      display: flex;
      gap: 0.5rem;
    }

    .filter-btn {
      background: transparent;
      border: 1px solid var(--border-card);
      color: var(--text-muted);
      border-radius: 6px;
      padding: 0.4rem 0.85rem;
      font-size: 0.85rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .filter-btn:hover {
      background: #f1f5f9;
      color: var(--text-main);
    }

    .filter-btn.active {
      background: #0f172a;
      border-color: #0f172a;
      color: #ffffff;
      box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px -1px rgba(0, 0, 0, 0.1);
    }

    /* STEP LIST */
    .step-list {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .step-item {
      background: var(--bg-card);
      border: 1px solid var(--border-card);
      border-radius: 10px;
      overflow: hidden;
      transition: all 0.15s ease;
    }

    .step-item:hover {
      border-color: #cbd5e1;
    }

    .step-header {
      padding: 1rem 1.25rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      user-select: none;
    }

    .step-header:hover {
      background: rgba(0, 0, 0, 0.01);
    }

    .step-identity {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .step-number {
      font-family: var(--font-mono);
      font-weight: 600;
      color: var(--text-muted);
      font-size: 1rem;
      background: #f1f5f9;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      border: 1px solid #e2e8f0;
    }

    .step-main-info {
      display: flex;
      flex-direction: column;
    }

    .step-title {
      font-weight: 600;
      font-size: 1.05rem;
    }

    .step-action-tag {
      font-family: var(--font-mono);
      font-size: 0.7rem;
      text-transform: uppercase;
      background: #f1f5f9;
      color: var(--text-main);
      padding: 0.1rem 0.35rem;
      border-radius: 4px;
      border: 1px solid #e2e8f0;
      width: fit-content;
      margin-top: 0.25rem;
    }

    .step-status-tags {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .status-pill {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      padding: 0.2rem 0.6rem;
      border-radius: 6px;
      letter-spacing: 0.02em;
    }

    .status-pill.passed { background: var(--color-success-bg); color: var(--color-success); border: 1px solid var(--color-success-border); }
    .status-pill.failed { background: var(--color-fail-bg); color: var(--color-fail); border: 1px solid var(--color-fail-border); }
    .status-pill.skipped { background: rgba(113, 113, 122, 0.08); color: var(--color-skipped); border: 1px solid rgba(113, 113, 122, 0.15); }

    .healed-badge {
      background: var(--color-healed-bg);
      color: var(--color-healed);
      border: 1px solid var(--color-healed-border);
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      padding: 0.2rem 0.6rem;
      border-radius: 6px;
      letter-spacing: 0.02em;
    }

    .ai-invoked-badge {
      background: linear-gradient(135deg, #a855f7, #ec4899);
      color: white;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      padding: 0.2rem 0.6rem;
      border-radius: 6px;
      letter-spacing: 0.02em;
      box-shadow: 0 2px 4px rgba(168, 85, 247, 0.25);
    }

    .expand-arrow {
      color: var(--text-muted);
      transition: transform 0.2s ease;
      font-size: 1.2rem;
    }

    .step-item.expanded .expand-arrow {
      transform: rotate(180deg);
    }

    /* STEP CONTENT / EXPANDED DETAILS */
    .step-details {
      display: none;
      padding: 1.25rem;
      border-top: 1px solid var(--border-card);
      background: #f1f5f9;
      animation: slideDown 0.2s ease-out;
    }

    .step-item.expanded .step-details {
      display: block;
    }

    @keyframes slideDown {
      from { opacity: 0; transform: translateY(-8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .details-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 1.25rem;
      align-items: stretch;
    }

    /* LEFT PANELS: METRIC LABELS & LOCATORS */
    .panel-left {
      flex: 1 1 320px;
      max-width: 420px;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }

    .info-section {
      background: #ffffff;
      border: 1px solid var(--border-card);
      border-radius: 10px;
      padding: 1rem 1.25rem;
      box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.02);
    }

    .section-title {
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 0.75rem;
      font-weight: 600;
      border-bottom: 1px solid #f1f5f9;
      padding-bottom: 0.35rem;
    }

    .locator-diff-box {
      font-family: var(--font-mono);
      font-size: 0.8rem;
      padding: 0.85rem 1rem;
      border-radius: 8px;
      overflow-x: auto;
      margin-top: 0.5rem;
      border: 1px solid var(--border-card);
      display: flex;
      align-items: center;
    }

    .locator-diff-box.old {
      background: var(--color-fail-bg);
      border-color: var(--color-fail-border);
      color: #dc2626;
    }

    .locator-diff-box.old code {
      text-decoration: line-through;
      opacity: 0.85;
    }

    .locator-diff-box.new {
      background: var(--color-success-bg);
      border-color: var(--color-success-border);
      color: #16a34a;
      font-weight: 500;
    }

    .locator-label {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 0.4rem;
    }

    .diff-badge {
      display: inline-block;
      font-size: 0.65rem;
      font-weight: 700;
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
      margin-right: 0.75rem;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      flex-shrink: 0;
    }

    .diff-badge.old {
      background: var(--color-fail-bg);
      color: #dc2626;
      border: 1px solid var(--color-fail-border);
    }

    .diff-badge.new {
      background: var(--color-success-bg);
      color: #16a34a;
      border: 1px solid var(--color-success-border);
    }

    .locator-details-disclosure {
      margin-top: 0.75rem;
      background: #f8fafc;
      border: 1px dashed var(--border-card);
      border-radius: 8px;
      padding: 0.6rem 0.85rem;
    }

    .locator-details-summary {
      font-size: 0.85rem;
      color: var(--text-muted);
      cursor: pointer;
      user-select: none;
      outline: none;
      font-weight: 500;
    }

    .locator-details-summary:hover {
      color: var(--text-main);
    }

    /* AI ADVISORY BOX */
    .ai-explanation {
      background: var(--color-healed-bg);
      border: 1px solid var(--color-healed-border);
      border-radius: 10px;
      padding: 1rem 1.25rem;
    }

    .ai-explanation-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.5rem;
    }

    .ai-badge {
      background: #7c3aed;
      color: white;
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.15rem 0.5rem;
      border-radius: 4px;
      font-family: var(--font-mono);
    }

    .ai-confidence-badge {
      font-family: var(--font-mono);
      font-size: 0.85rem;
      font-weight: bold;
      color: #6d28d9;
    }

    .ai-explanation-text {
      font-size: 0.9rem;
      color: var(--text-main);
      font-style: italic;
    }

    /* ERROR REPORT BOX */
    .error-box {
      background: var(--color-fail-bg);
      border: 1px solid var(--color-fail-border);
      border-radius: 10px;
      padding: 1rem 1.25rem;
    }

    .error-title {
      font-weight: bold;
      color: #b91c1c;
      font-size: 0.9rem;
      margin-bottom: 0.5rem;
    }

    .error-message {
      font-family: var(--font-mono);
      font-size: 0.8rem;
      color: #b91c1c;
      white-space: pre-wrap;
      word-break: break-all;
    }

    /* RIGHT PANELS: IMAGES & VISUAL ANALYSIS */
    .panel-right {
      flex: 2 1 500px;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }

    .visual-comparison-box {
      display: flex;
      gap: 1rem;
      margin-top: 0.5rem;
      align-items: center;
      justify-content: center;
    }

    .visual-crop-container {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 0.75rem;
    }

    .visual-crop-container p {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-bottom: 0.5rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .visual-crop-image {
      max-height: 120px;
      max-width: 100%;
      border-radius: 4px;
      object-fit: contain;
      background: #f8fafc;
      border: 1px solid #f1f5f9;
      padding: 4px;
    }

    .visual-crop-missing {
      height: 90px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      font-size: 0.8rem;
      font-style: italic;
    }

    .jaccard-indicator {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 50%;
      width: 70px;
      height: 70px;
      flex-shrink: 0;
    }

    .jaccard-val {
      font-family: var(--font-mono);
      font-weight: 700;
      font-size: 1.05rem;
      color: #16a34a;
    }

    .jaccard-label {
      font-size: 0.6rem;
      color: var(--text-muted);
      text-transform: uppercase;
    }

    .full-screenshot-container {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 0.5rem;
      display: flex;
      justify-content: center;
      align-items: center;
      cursor: zoom-in;
      overflow: hidden;
      max-height: 480px;
      position: relative;
    }

    .full-screenshot-container img {
      max-width: 100%;
      max-height: 460px;
      border-radius: 6px;
      object-fit: contain;
      transition: transform 0.3s ease;
    }

    .full-screenshot-container:hover img {
      transform: scale(1.02);
    }

    .screenshot-overlay {
      position: absolute;
      bottom: 0.75rem;
      right: 0.75rem;
      background: rgba(15, 23, 42, 0.8);
      backdrop-filter: blur(4px);
      padding: 0.3rem 0.6rem;
      border-radius: 4px;
      font-size: 0.75rem;
      color: white;
      border: 1px solid rgba(255, 255, 255, 0.15);
    }

    /* SCORING MATRIX GRID */
    .scoring-matrix-container {
      width: 100%;
      background: #ffffff;
      border: 1px solid var(--border-card);
      border-radius: 10px;
      padding: 1.25rem;
      margin-top: 0.5rem;
      overflow-x: auto;
    }

    .matrix-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.8rem;
      text-align: left;
    }

    .matrix-table th, .matrix-table td {
      padding: 0.6rem 0.75rem;
      border-bottom: 1px solid var(--border-card);
    }

    .matrix-table th {
      background: #f8fafc;
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 0.7rem;
      letter-spacing: 0.05em;
    }

    .matrix-table tr.selected-row {
      background: #f0fdf4;
    }

    .matrix-table tr.selected-row td {
      border-top: 1px solid rgba(22, 163, 74, 0.15);
      border-bottom: 1px solid rgba(22, 163, 74, 0.15);
    }

    .cand-id-badge {
      font-family: var(--font-mono);
      font-weight: bold;
      color: var(--text-muted);
      background: #f1f5f9;
      padding: 0.15rem 0.35rem;
      border-radius: 4px;
    }

    .selected-row .cand-id-badge {
      color: #16a34a;
      background: rgba(22, 163, 74, 0.1);
    }

    .cand-tag-name {
      font-weight: 600;
      color: var(--text-main);
    }

    .cand-selector {
      font-family: var(--font-mono);
      color: var(--text-muted);
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .cand-total-score {
      font-family: var(--font-mono);
      font-weight: 700;
      font-size: 0.9rem;
      color: var(--text-main);
    }

    .selected-row .cand-total-score {
      color: #16a34a;
    }

    .matrix-cell-score {
      font-family: var(--font-mono);
      text-align: center;
      border-radius: 4px;
      font-weight: 500;
    }

    /* HEATMAP SHADING HELPERS */
    .heat-high { background: #bbf7d0; color: #166534; }
    .heat-med { background: #fef08a; color: #854d0e; }
    .heat-low { background: transparent; color: var(--text-muted); }

    /* FOOTER */
    footer {
      text-align: center;
      margin-top: 2.5rem;
      border-top: 1px solid var(--border-card);
      padding-top: 1.5rem;
      color: var(--text-muted);
      font-size: 0.85rem;
    }

    footer a {
      color: var(--color-primary);
      text-decoration: none;
    }

    /* MODAL */
    .modal {
      display: none;
      position: fixed;
      z-index: 1000;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(15, 23, 42, 0.95);
      backdrop-filter: blur(8px);
      justify-content: center;
      align-items: center;
      cursor: zoom-out;
    }

    .modal-content {
      max-width: 90%;
      max-height: 90%;
      border-radius: 8px;
      border: 2px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 0 50px rgba(0, 0, 0, 0.5);
      object-fit: contain;
    }

    .close-modal {
      position: absolute;
      top: 1.5rem;
      right: 2rem;
      font-size: 2rem;
      color: white;
      cursor: pointer;
      font-family: sans-serif;
    }

    .close-modal:hover {
      color: var(--color-fail);
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo-container">
        <h1>reLOCATE.AI</h1>
        <p>Intelligent Element Recovery Dashboard</p>
      </div>
      <div class="meta-details">
        <div class="meta-item">Project: <strong>${meta.projectName}</strong></div>
        <div class="meta-item">Timestamp: <strong>${meta.timestamp}</strong></div>
      </div>
    </header>

    <!-- METRICS PANEL -->
    <div class="dashboard-grid">
      <div class="card">
        <div class="card-title">Total Steps</div>
        <div class="card-value">${totalSteps}</div>
        <div class="card-subtext">Configured execution steps</div>
      </div>
      <div class="card pass">
        <div class="card-title">Passed</div>
        <div class="card-value">${passedSteps}</div>
        <div class="card-subtext">${totalSteps > 0 ? Math.round((passedSteps/totalSteps)*100) : 0}% of total run</div>
      </div>
      <div class="card fail">
        <div class="card-title">Failed</div>
        <div class="card-value">${failedSteps}</div>
        <div class="card-subtext">${totalSteps > 0 ? Math.round((failedSteps/totalSteps)*100) : 0}% abort rate</div>
      </div>
      <div class="card healed">
        <div class="card-title">Healed</div>
        <div class="card-value">${healedSteps}</div>
        <div class="card-subtext">${healingSuccess} recovered elements</div>
      </div>
      <div class="card conf">
        <div class="card-title">Avg Confidence</div>
        <div class="card-value">${avgConfidence}%</div>
        <div class="card-subtext">For all healed elements</div>
      </div>
      <div class="card">
        <div class="card-title">AI Invoked</div>
        <div class="card-value">${aiInvoked}</div>
        <div class="card-subtext">Reasoning layer queries</div>
      </div>
    </div>

    <!-- FILTER TOOLBAR -->
    <div class="filter-toolbar">
      <div class="search-container">
        <svg class="search-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
          <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001q.044.06.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1 1 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0"/>
        </svg>
        <input type="text" class="search-input" id="searchInput" placeholder="Search steps by element name or tag name...">
      </div>
      <div class="filter-buttons">
        <button class="filter-btn active" id="btnAll" onclick="filterSteps('all')">All</button>
        <button class="filter-btn" id="btnPassed" onclick="filterSteps('passed')">Passed</button>
        <button class="filter-btn" id="btnFailed" onclick="filterSteps('failed')">Failed</button>
        <button class="filter-btn" id="btnHealed" onclick="filterSteps('healed')">Healed</button>
      </div>
    </div>

    <!-- STEP LIST -->
    <div class="step-list" id="stepList">
      ${outcomes.map((step, idx) => {
        const stepNum = idx + 1;
        const padIndex = String(stepNum).padStart(2, '0');
        const hasScreenshot = !!step.screenshotPath;
        const hasOriginal = !!step.originalScreenshotPath;
        const hasOriginalFull = !!step.originalFullScreenshotPath;
        
        return `
      <div class="step-item" id="step-item-${stepNum}" data-status="${step.status.toLowerCase()}" data-healed="${step.healed}" data-name="${(step.objectName || '').toLowerCase()}" data-tag="${(step.topCandidates && step.topCandidates[0] ? step.topCandidates[0].tagName : '').toLowerCase()}">
        <div class="step-header" onclick="toggleExpand(${stepNum})">
          <div class="step-identity">
            <div class="step-number">${padIndex}</div>
            <div class="step-main-info">
              <span class="step-title">${step.objectName || 'Navigation Step'}</span>
              <span class="step-action-tag">${step.action}</span>
            </div>
          </div>
          <div class="step-status-tags">
            ${step.healed ? (
              step.reason?.includes('MCP')
                ? `<span class="healed-badge" style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); color: #ffffff; border: none; font-weight: 600; padding: 3px 10px; border-radius: 6px; box-shadow: 0 2px 4px rgba(99, 102, 241, 0.25);">✨ Healed by AI (MCP)</span>`
                : (step.triggeredAI ? `<span class="healed-badge" style="background: linear-gradient(135deg, #3b82f6 0%, #6366f1 100%); color: #ffffff; border: none; font-weight: 600; padding: 3px 10px; border-radius: 6px;">✨ Healed by AI</span>` : `<span class="healed-badge">Healed</span>`)
            ) : ''}
            ${(step.triggeredAI || (step.healed && step.reason?.includes('MCP'))) ? `<span class="ai-invoked-badge">AI Invoked</span>` : ''}
            <span class="status-pill ${step.status.toLowerCase()}">${step.status}</span>
            <span class="expand-arrow">▼</span>
          </div>
        </div>
        
        <div class="step-details">
          <div class="details-grid">
            
            <!-- LEFT PANEL: DETAILS & LOCATORS -->
            <div class="panel-left">
              <div class="info-section">
                <div class="section-title">Step Properties</div>
                <div style="font-size: 0.9rem; display: grid; grid-template-columns: auto 1fr; gap: 0.5rem 1rem;">
                  <span style="color: var(--text-muted)">Step Index:</span>
                  <span style="font-family: var(--font-mono)">${stepNum}</span>
                  
                  <span style="color: var(--text-muted)">Action:</span>
                  <span style="font-weight: 500">${step.action}</span>
                  
                  <span style="color: var(--text-muted)">Target Object:</span>
                  <span style="font-weight: 500; color: var(--color-primary);">${step.objectName}</span>
                </div>
              </div>

              ${step.healed ? `
              <div class="ai-explanation">
                <div class="ai-explanation-header">
                  <span class="ai-badge">${step.reason?.includes('MCP') ? 'Pure MCP AI Agent' : (step.triggeredAI ? 'AI Reasoning Model' : 'Rule Engine Choice')}</span>
                  ${step.confidence !== undefined ? `<span class="ai-confidence-badge">Confidence: ${Math.round(step.confidence * 100)}%</span>` : ''}
                </div>
                <div class="ai-explanation-text">
                  "${step.reason || 'Element resolved via high structural rules similarity.'}"
                </div>
              </div>
              ` : ''}

              ${step.errorMessage ? `
              <div class="error-box">
                <div class="error-title">Execution Error Message</div>
                <div class="error-message">${step.errorMessage}</div>
              </div>
              ` : ''}

              ${step.healed && (hasOriginal || step.topCandidates?.[0]?.candidateId !== undefined) ? `
              <div class="info-section">
                <div class="section-title">Visual Comparison Analysis</div>
                <div class="visual-comparison-box">
                  <div class="visual-crop-container">
                    <p>Template (Original)</p>
                    ${hasOriginal ? `
                    <img class="visual-crop-image" src="${step.originalScreenshotPath}" alt="Original crop template">
                    ` : `
                    <div class="visual-crop-missing">No crop template saved</div>
                    `}
                  </div>
                  
                  <!-- JACCARD SIMILARITY CONNECTOR -->
                  <div class="jaccard-indicator">
                    <span class="jaccard-val">${step.topCandidates?.[0]?.ruleScores?.['VisualSimilarityRule'] !== undefined ? Math.round((step.topCandidates[0].ruleScores['VisualSimilarityRule'] / 20) * 100) : 0}%</span>
                    <span class="jaccard-label">Visual Match</span>
                  </div>

                  <div class="visual-crop-container">
                    <p>Healed Element</p>
                    ${step.topCandidates?.[0] ? `
                    <img class="visual-crop-image" src="step-${padIndex}/step-${padIndex}-healed.png" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" alt="Healed element crop">
                    <div class="visual-crop-missing" style="display:none;">Visual crop missing</div>
                    ` : `
                    <div class="visual-crop-missing">No crop available</div>
                    `}
                  </div>
                </div>
              </div>
              ` : ''}
            </div>

            <!-- RIGHT PANEL: IMAGES & VISUAL CORPS -->
            <div class="panel-right">
              ${hasScreenshot ? `
              <div class="info-section" style="flex: 1; display: flex; flex-direction: column;">
                <div class="section-title">Live Screenshot debug</div>
                <div class="visual-comparison-box" style="flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; width: 100%;">
                  <div class="visual-crop-container" style="flex: 1; display: flex; flex-direction: column; width: 100%; max-width: 100%;">
                    <p>Live Screenshot (Highlighted)</p>
                    <div class="full-screenshot-container" onclick="openScreenshotModal('${step.screenshotPath}')" style="flex: 1; display: flex; align-items: center; justify-content: center; width: 100%; overflow: hidden; position: relative;">
                      <img src="${step.screenshotPath}" alt="Execution screenshot step ${padIndex}" style="max-width: 100%; max-height: 440px; width: auto; height: auto; object-fit: contain;">
                      <span class="screenshot-overlay">View Live</span>
                    </div>
                  </div>
                </div>
              </div>
              ` : `
              <div class="info-section" style="flex: 1; display: flex; align-items: center; justify-content: center; border-style: dashed;">
                <div style="text-align: center; color: var(--text-muted);">
                  <p>No screenshot captured for this step</p>
                </div>
              </div>
              `}
            </div>

            <!-- SCORING TABLE HEATMAP -->
            ${step.healed && step.topCandidates && step.topCandidates.length > 0 ? `
            <div class="scoring-matrix-container">
              <div class="section-title" style="margin-bottom: 0.75rem;">Rule Engine Scoring Heatmap (Top Candidates)</div>
              <table class="matrix-table">
                <thead>
                  <tr>
                    <th>Candidate</th>
                    <th>Total Score</th>
                    ${Object.keys(ruleWeights).map(rule => `
                    <th style="text-align: center;" title="${rule} (Weight: ${ruleWeights[rule]})">${rule.replace('Rule', '')}<br><span style="font-size: 0.6rem; color: var(--text-muted); font-weight: normal;">w:${ruleWeights[rule]}</span></th>
                    `).join('')}
                    <th style="text-align: center; width: 90px;">Visual Crop</th>
                  </tr>
                </thead>
                <tbody>
                  ${step.topCandidates.map((cand: any, cIdx: number) => {
                    const isSelected = cand.candidateId === step.candidateId;
                    return `
                  <tr class="${isSelected ? 'selected-row' : ''}">
                    <td>
                      <span class="cand-id-badge" title="Candidate ID">#${cand.candidateId}</span>
                      <span class="cand-tag-name">&lt;${cand.tagName}&gt;</span>
                      <div class="cand-selector" title="${cand.cssSelector}">${cand.cssSelector}</div>
                    </td>
                    <td class="cand-total-score">${cand.score.toFixed(1)}</td>
                    ${Object.keys(ruleWeights).map(rule => {
                      const weight = ruleWeights[rule] || 1;
                      const normScore = cand.ruleScores?.[rule] !== undefined ? (cand.ruleScores[rule] / weight) : 0;
                      let heatClass = 'heat-low';
                      if (normScore > 0.75) heatClass = 'heat-high';
                      else if (normScore > 0.25) heatClass = 'heat-med';
                      
                      return `
                    <td class="matrix-cell-score ${heatClass}">${Math.round(normScore * 100)}%</td>
                    `;
                    }).join('')}
                    <td style="text-align: center; vertical-align: middle; padding: 4px;">
                      <div style="display: inline-flex; justify-content: center; align-items: center; height: 32px; width: 70px; background-color: var(--card-bg-secondary); border-radius: 4px; overflow: hidden; border: 1px solid var(--border-color);">
                        <img src="step-${padIndex}/candidate-${cand.candidateId}.png" 
                             style="max-height: 30px; max-width: 66px; object-fit: contain; cursor: pointer; display: block;"
                             onclick="openScreenshotModal(this.src); event.stopPropagation();"
                             onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" 
                             alt="Crop">
                        <span style="display: none; font-size: 0.6rem; color: var(--text-muted); font-weight: normal;">N/A</span>
                      </div>
                    </td>
                  </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
            ` : ''}

          </div>
        </div>
      </div>
        `;
      }).join('')}
    </div>

    <!-- FOOTER -->
    <footer>
      <p>Report generated automatically by <a href="https://github.com/shambhoo-narwaria/reLOCATE.AI-Intelligent-Element-Recovery-Engine" target="_blank">reLOCATE.AI Element Recovery Engine</a></p>
      <p style="font-size: 0.75rem; margin-top: 0.5rem; color: var(--text-muted);">Self-Hosted DOM Fingerprint & LLM Recovery Pipeline</p>
    </footer>
  </div>

  <!-- LIGHTBOX SCREENSHOT MODAL -->
  <div class="modal" id="screenshotModal" onclick="closeScreenshotModal()">
    <span class="close-modal">&times;</span>
    <img class="modal-content" id="modalImage">
  </div>

  <script>
    function toggleExpand(stepNum) {
      const el = document.getElementById('step-item-' + stepNum);
      if (el) {
        el.classList.toggle('expanded');
      }
    }

    function openScreenshotModal(src) {
      const modal = document.getElementById('screenshotModal');
      const img = document.getElementById('modalImage');
      modal.style.display = 'flex';
      img.src = src;
      event.stopPropagation();
    }

    function closeScreenshotModal() {
      document.getElementById('screenshotModal').style.display = 'none';
    }

    let activeFilter = 'all';

    function filterSteps(filter) {
      activeFilter = filter;
      
      document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
      const activeBtnMap = {
        'all': 'btnAll',
        'passed': 'btnPassed',
        'failed': 'btnFailed',
        'healed': 'btnHealed'
      };
      const activeBtnId = activeBtnMap[filter];
      if (activeBtnId) {
        document.getElementById(activeBtnId).classList.add('active');
      }
      
      applyAllFilters();
    }

    document.getElementById('searchInput').addEventListener('input', function() {
      applyAllFilters();
    });

    function applyAllFilters() {
      const searchQuery = document.getElementById('searchInput').value.toLowerCase().trim();
      const stepItems = document.querySelectorAll('.step-item');
      
      stepItems.forEach(item => {
        const status = item.getAttribute('data-status');
        const healed = item.getAttribute('data-healed') === 'true';
        const name = item.getAttribute('data-name');
        const tag = item.getAttribute('data-tag');
        
        let matchesFilter = false;
        if (activeFilter === 'all') {
          matchesFilter = true;
        } else if (activeFilter === 'passed') {
          matchesFilter = (status === 'passed');
        } else if (activeFilter === 'failed') {
          matchesFilter = (status === 'failed');
        } else if (activeFilter === 'healed') {
          matchesFilter = healed;
        }
        
        let matchesSearch = true;
        if (searchQuery) {
          matchesSearch = name.includes(searchQuery) || tag.includes(searchQuery);
        }
        
        if (matchesFilter && matchesSearch) {
          item.style.display = 'block';
        } else {
          item.style.display = 'none';
        }
      });
    }
  </script>
</body>
</html>
`;
  }
}
