import * as fs from 'fs';
import * as path from 'path';
import { StepOutcome } from './step-outcome.interface';
import { HtmlReportTemplate } from './html-report.template';

export class HtmlReportGeneratorService {
  static generate(outcomes: StepOutcome[], reportDir: string, projectName: string): string {
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const timestamp = new Date().toLocaleString();
    const htmlContent = HtmlReportTemplate.render(outcomes, {
      timestamp,
      projectName
    });

    const reportPath = path.join(reportDir, 'report.html');
    fs.writeFileSync(reportPath, htmlContent, 'utf8');
    
    console.log(`\n==================================================`);
    console.log(`[HtmlReportGeneratorService] Execution report successfully generated!`);
    console.log(`[HtmlReportGeneratorService] Report Path: file:///${reportPath.replace(/\\/g, '/')}`);
    console.log(`==================================================\n`);

    return reportPath;
  }
}
